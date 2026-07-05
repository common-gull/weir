// Run lifecycle helpers (create / retry / approve / pause / resume) shared by the executor, CLI, and API.

import type { DB } from './db.ts';
import { emit, toJson } from './db.ts';
import type { RunRow } from './types.ts';

export function createRun(
  db: DB,
  workflow: string,
  input?: unknown,
  opts: { priority?: number; scheduleId?: string; logicalFireAt?: number } = {},
): string {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO runs (id, workflow, status, input, schedule_id, logical_fire_at, priority, attempt, created_at)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    workflow,
    toJson(input),
    opts.scheduleId ?? null,
    opts.logicalFireAt ?? null,
    opts.priority ?? 0,
    Date.now(),
  );
  emit(db, { runId: id, type: 'run.created', message: workflow });
  return id;
}

/** Create a run for a schedule slot, idempotent on (schedule_id, logical_fire_at). Returns id or null if the slot already exists. */
export function createScheduledRun(
  db: DB,
  workflow: string,
  scheduleId: string,
  logicalFireAt: number,
  input?: unknown,
  priority = 0,
): string | null {
  const id = crypto.randomUUID();
  const res = db
    .query(
      `INSERT INTO runs (id, workflow, status, input, schedule_id, logical_fire_at, priority, attempt, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?)
       ON CONFLICT (schedule_id, logical_fire_at) WHERE schedule_id IS NOT NULL DO NOTHING`,
    )
    .run(id, workflow, toJson(input), scheduleId, logicalFireAt, priority, Date.now());
  if ((res.changes as number) === 0) return null;
  emit(db, { runId: id, type: 'run.created', message: `${workflow} @${new Date(logicalFireAt).toISOString()}` });
  return id;
}

/**
 * Re-queue a run so it will be re-invoked. Completed steps replay from the memo, so
 * execution resumes at the first non-memoized step. If `fromStep` is given, memo rows at
 * and after that step are discarded first, so it re-runs from there.
 */
export function retryRun(db: DB, runId: string, fromStep?: string): void {
  const run = db.query(`SELECT * FROM runs WHERE id = ?`).get(runId) as RunRow | null;
  if (!run) throw new Error(`run not found: ${runId}`);

  if (fromStep) {
    const match = db
      .query(`SELECT MIN(seq) AS seq FROM steps WHERE run_id = ? AND (name = ? OR key = ?)`)
      .get(runId, fromStep, fromStep) as { seq: number | null };
    if (match.seq != null) {
      db.query(`DELETE FROM steps WHERE run_id = ? AND seq >= ?`).run(runId, match.seq);
      db.query(`DELETE FROM step_attempts WHERE run_id = ? AND seq >= ?`).run(runId, match.seq);
      emit(db, { runId, type: 'run.retry-from', message: `${fromStep} (seq ${match.seq})` });
    }
  }

  db.query(`UPDATE runs SET status = 'queued', result = NULL, error = NULL, finished_at = NULL WHERE id = ?`).run(
    runId,
  );
  emit(db, { runId, type: 'run.requeued' });
}

/** Record a human approval and re-queue the parked run so it resumes past the gate. */
export function approveRun(db: DB, runId: string, gate?: string, payload?: unknown): void {
  const run = db.query(`SELECT status FROM runs WHERE id = ?`).get(runId) as { status: string } | null;
  if (!run) throw new Error(`run not found: ${runId}`);
  if (run.status !== 'awaiting-approval') {
    throw new Error(`run ${runId} is ${run.status}, not awaiting approval`);
  }
  // Default to the gate the run actually parked on, so `waitForApproval(name)` finds it.
  let g = gate;
  if (!g) {
    const p = db.query(`SELECT value FROM kv WHERE namespace = '__pending__' AND key = ?`).get(runId) as
      | { value: string }
      | null;
    g = p ? (JSON.parse(p.value) as string) : 'human';
  }
  db.query(
    `INSERT INTO kv (namespace, key, value, expires_at, updated_at) VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(`__approval__:${runId}`, g, toJson(payload ?? true), Date.now());
  db.query(`UPDATE runs SET status = 'queued' WHERE id = ? AND status = 'awaiting-approval'`).run(runId);
  db.query(`DELETE FROM kv WHERE namespace = '__pending__' AND key = ?`).run(runId);
  emit(db, { runId, type: 'run.approved', message: g });
}

/** Hold a queued run so the executor won't claim it. Only a still-queued run can be paused. */
export function pauseRun(db: DB, runId: string): void {
  const run = db.query(`SELECT status FROM runs WHERE id = ?`).get(runId) as { status: string } | null;
  if (!run) throw new Error(`run not found: ${runId}`);
  if (run.status !== 'queued') {
    throw new Error(`run ${runId} is ${run.status}, not queued`);
  }
  db.query(`UPDATE runs SET status = 'paused' WHERE id = ? AND status = 'queued'`).run(runId);
  emit(db, { runId, type: 'run.paused' });
}

/** Re-queue a paused run so the executor can claim it again. Only a paused run can be resumed. */
export function resumeRun(db: DB, runId: string): void {
  const run = db.query(`SELECT status FROM runs WHERE id = ?`).get(runId) as { status: string } | null;
  if (!run) throw new Error(`run not found: ${runId}`);
  if (run.status !== 'paused') {
    throw new Error(`run ${runId} is ${run.status}, not paused`);
  }
  db.query(`UPDATE runs SET status = 'queued' WHERE id = ? AND status = 'paused'`).run(runId);
  emit(db, { runId, type: 'run.resumed' });
}
