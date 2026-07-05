// Durable cron scheduler. Drift-free (next fire computed from the cron definition, not
// now+interval), timezone-correct, idempotent per slot, with overlap + catch-up policies.

import type { DB } from './db.ts';
import { emit, toJson, fromJson } from './db.ts';
import { nextFire } from './cron.ts';
import { allWorkflows } from './engine.ts';
import { createScheduledRun } from './runs.ts';
import type { ScheduleRow } from './types.ts';

/** A tick landing within this window of a slot counts as "on time" (not a missed catch-up). */
const ON_TIME_MS = 90_000;

/** Host's local IANA timezone — schedules mean local time unless a schedule overrides `tz`. */
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Validate `cron` by actually computing its first fire time strictly after `now` in `tz`.
 * `nextFire` both parses AND searches for a real occurrence, so this rejects an impossible-but-
 * well-formed expression (e.g. Feb 30) that a parse-only check would let through — the very
 * crash this guard exists to prevent — while still accepting rare-but-valid crons like Feb 29
 * (nextFire's window reaches far enough to find them). Returns a human-readable reason on
 * failure, or the computed next-fire timestamp on success (reused by the INSERT so the cron is
 * parsed once).
 */
function validateCron(cron: unknown, tz: string, now: number): string | number {
    if (typeof cron !== 'string' || !cron.trim()) return "schedule is missing a 'cron' expression";
    try {
        return nextFire(cron, tz, now);
    } catch (e) {
        return `invalid cron "${cron}" — ${(e as Error).message}`;
    }
}

export class Scheduler {
    private timer?: ReturnType<typeof setInterval>;
    private started = false;

    constructor(
        private db: DB,
        private onFire?: () => void,
        private now: () => number = Date.now,
    ) {}

    /**
     * Reconcile schedule rows with the current registry: upsert one per workflow that declares
     * `schedule`, and DELETE any workflow-derived (`wf:`) row whose workflow no longer declares
     * one (schedule removed, or file deleted). Without the delete, a stale schedule keeps firing
     * across restarts and reloads. Returns the ids added/updated/removed.
     */
    syncFromRegistry(): { upserted: string[]; removed: string[] } {
        const desired = new Set<string>();
        for (const wf of allWorkflows()) {
            const s = wf.opts.schedule;
            if (!s) continue;
            const id = `wf:${wf.name}`;
            const tz = s.tz ?? LOCAL_TZ;
            const existing = this.db.query(`SELECT id FROM schedules WHERE id = ?`).get(id);

            // A workflow with a missing/malformed/unsatisfiable cron must not reach the DB (NOT NULL
            // cron) or the tick loop (nextFire throws) — either would take down the whole daemon.
            // Report it and skip the upsert. But if a valid row already exists, keep it in `desired`
            // so the reconcile sweep below won't DELETE it: a transient typo — or a rare cron whose
            // next fire is momentarily past nextFire's search horizon — must not destroy persisted
            // state (`enabled`, `last_fire_at`) and silently resurrect a disabled schedule once fixed.
            // On success `validated` doubles as the first fire time, threaded into the INSERT below.
            const validated = validateCron(s.cron, tz, this.now());
            if (typeof validated === 'string') {
                emit(this.db, { type: 'schedule.invalid', level: 'error', message: `${wf.name}: ${validated}` });
                if (existing) desired.add(id);
                continue;
            }

            desired.add(id);
            if (existing) {
                this.db
                    .query(
                        `UPDATE schedules SET workflow = ?, cron = ?, tz = ?, input = ?, overlap = ?, catchup = ?, backfill_max = ? WHERE id = ?`,
                    )
                    .run(
                        wf.name,
                        s.cron,
                        tz,
                        toJson(s.input),
                        s.overlap ?? 'skip',
                        s.catchup ?? 'skip',
                        s.backfillMax ?? 24,
                        id,
                    );
            } else {
                this.db
                    .query(
                        `INSERT INTO schedules (id, workflow, cron, tz, input, overlap, catchup, backfill_max, next_fire_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        id,
                        wf.name,
                        s.cron,
                        tz,
                        toJson(s.input),
                        s.overlap ?? 'skip',
                        s.catchup ?? 'skip',
                        s.backfillMax ?? 24,
                        validated,
                        this.now(),
                    );
            }
        }

        // Remove workflow-derived schedules no longer backed by a scheduling workflow. Scoped to
        // the `wf:` prefix so any future non-workflow schedule rows are left untouched.
        const removed: string[] = [];
        const stale = this.db.query(`SELECT id FROM schedules WHERE id LIKE 'wf:%'`).all() as { id: string }[];
        for (const { id } of stale) {
            if (desired.has(id)) continue;
            this.db.query(`DELETE FROM schedules WHERE id = ?`).run(id);
            emit(this.db, { type: 'schedule.removed', message: id });
            removed.push(id);
        }
        return { upserted: [...desired], removed };
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        this.syncFromRegistry();
        this.timer = setInterval(() => this.tick(), 1000);
        this.tick();
    }

    stop(): void {
        this.started = false;
        if (this.timer) clearInterval(this.timer);
    }

    /**
     * Pause a workflow's schedule: the tick loop only selects `enabled = 1` rows, so flipping the
     * flag stops scheduled firing while leaving `next_fire_at`/`last_fire_at` intact. Manual runs
     * (`weir run`, the UI's Start run) don't go through the scheduler and keep working. Returns
     * whether the flag actually changed — false if already paused or there's no schedule row.
     */
    pauseWorkflow(name: string): boolean {
        return this.setScheduleEnabled(name, false);
    }

    /**
     * Resume a paused schedule. `next_fire_at` was left where it was, so the next tick applies the
     * workflow's catch-up policy to any slots missed while paused (default `skip`: advance past now
     * without a backlog).
     */
    resumeWorkflow(name: string): boolean {
        return this.setScheduleEnabled(name, true);
    }

    private setScheduleEnabled(name: string, on: boolean): boolean {
        const res = this.db
            .query(`UPDATE schedules SET enabled = ? WHERE id = ? AND enabled = ?`)
            .run(on ? 1 : 0, `wf:${name}`, on ? 0 : 1);
        if ((res.changes as number) === 0) return false;
        emit(this.db, { type: on ? 'schedule.resumed' : 'schedule.paused', message: name });
        return true;
    }

    /** Evaluate all due schedules once. Returns the number of runs created. */
    tick(): number {
        const now = this.now();
        const due = this.db
            .query(`SELECT * FROM schedules WHERE enabled = 1 AND next_fire_at <= ?`)
            .all(now) as ScheduleRow[];
        let created = 0;
        for (const s of due) created += this.fireSchedule(s, now);
        if (created > 0) this.onFire?.();
        return created;
    }

    private fireSchedule(s: ScheduleRow, now: number): number {
        // Advance through every slot at or before `now`, then move next_fire_at to the first
        // future slot in ONE atomic compare-and-swap (no drift, no double fire). Track the
        // most-recent slot (for last_fire_at / catchup_once) and keep a bounded window of the
        // latest slots (for backfill) — never the stale oldest ones.
        const firstSlot = s.next_fire_at;
        let cur = s.next_fire_at;
        let lastSlot = firstSlot;
        let count = 0;
        const recent: number[] = [];
        while (cur <= now) {
            lastSlot = cur;
            recent.push(cur);
            if (recent.length > s.backfill_max) recent.shift();
            count++;
            cur = nextFire(s.cron, s.tz, cur);
        }
        if (count === 0) return 0;
        const newNext = cur;
        const res = this.db
            .query(`UPDATE schedules SET next_fire_at = ?, last_fire_at = ? WHERE id = ? AND next_fire_at = ?`)
            .run(newNext, lastSlot, s.id, s.next_fire_at);
        if ((res.changes as number) === 0) return 0; // lost the CAS

        // Decide which slots actually produce runs.
        let toRun: number[];
        const missed = count > 1 || now - firstSlot > ON_TIME_MS;
        if (!missed) {
            toRun = [lastSlot]; // normal on-time single fire
        } else {
            switch (s.catchup) {
                case 'skip':
                    toRun = [];
                    emit(this.db, { type: 'schedule.skipped-missed', message: `${s.workflow}: ${count} slot(s)` });
                    break;
                case 'catchup_once':
                    toRun = [lastSlot]; // the most-recent missed slot, not a stale middle one
                    break;
                case 'backfill':
                    toRun = recent;
                    break;
                default:
                    toRun = [lastSlot];
            }
        }

        let created = 0;
        const input = fromJson(s.input);
        // Backfill deliberately materializes every missed slot, so it bypasses the overlap gate.
        const honorOverlap = !(missed && s.catchup === 'backfill');
        for (const slot of toRun) {
            if (honorOverlap && !this.overlapAllows(s)) {
                emit(this.db, { type: 'schedule.overlap-skip', message: s.workflow });
                continue;
            }
            const id = createScheduledRun(this.db, s.workflow, s.id, slot, input);
            if (id) created++;
        }
        return created;
    }

    private overlapAllows(s: ScheduleRow): boolean {
        if (s.overlap === 'queue') return true;
        const active = this.db
            .query(`SELECT id FROM runs WHERE workflow = ? AND status IN ('queued','running','awaiting-approval')`)
            .all(s.workflow) as { id: string }[];
        if (active.length === 0) return true;
        if (s.overlap === 'cancel-previous') {
            for (const a of active)
                this.db
                    .query(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?`)
                    .run(Date.now(), a.id);
            return true;
        }
        return false; // skip
    }
}
