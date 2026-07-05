// SQLite persistence layer (bun:sqlite, WAL). Single file `weir.db`.
//
// Cardinal rule: transactions wrap ONLY short, pure-DB mutations — never an `await`.
// bun:sqlite is synchronous; a transaction that spans an await would freeze every worker.

import { Database } from 'bun:sqlite';
import { publishEvent } from './bus.ts';

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS workflows (
  name         TEXT PRIMARY KEY,
  schedule     TEXT,
  capabilities TEXT,
  registered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  status          TEXT NOT NULL,
  input           TEXT,
  result          TEXT,
  error           TEXT,
  parent_run_id   TEXT,
  parent_seq      INTEGER,
  schedule_id     TEXT,
  logical_fire_at INTEGER,
  priority        INTEGER NOT NULL DEFAULT 0,
  attempt         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS ix_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS ix_runs_created ON runs(created_at);
CREATE INDEX IF NOT EXISTS ix_runs_workflow ON runs(workflow, created_at);
CREATE INDEX IF NOT EXISTS ix_runs_parent ON runs(parent_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_child ON runs(parent_run_id, parent_seq)
  WHERE parent_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_slot ON runs(schedule_id, logical_fire_at)
  WHERE schedule_id IS NOT NULL;

-- The memo log. One row per settled ctx primitive call. Retry-from-failure reads this.
CREATE TABLE IF NOT EXISTS steps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  result       TEXT,
  error        TEXT,
  child_run_id TEXT,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_steps_seq ON steps(run_id, seq);
CREATE INDEX IF NOT EXISTS ix_steps_key ON steps(run_id, key);
CREATE INDEX IF NOT EXISTS ix_steps_run_status ON steps(run_id, status);

-- Per-attempt observability (retries/repeats). NOT memo.
CREATE TABLE IF NOT EXISTS step_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  attempt     INTEGER NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_attempts ON step_attempts(run_id, seq);

CREATE TABLE IF NOT EXISTS schedules (
  id           TEXT PRIMARY KEY,
  workflow     TEXT NOT NULL,
  cron         TEXT NOT NULL,
  tz           TEXT NOT NULL DEFAULT 'UTC',
  input        TEXT,
  overlap      TEXT NOT NULL DEFAULT 'skip',
  catchup      TEXT NOT NULL DEFAULT 'skip',
  backfill_max INTEGER NOT NULL DEFAULT 24,
  next_fire_at INTEGER NOT NULL,
  last_fire_at INTEGER,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sched_due ON schedules(enabled, next_fire_at);

-- Durable cross-run key/value state (rate-limits, dedup, checkpoints).
CREATE TABLE IF NOT EXISTS kv (
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);

-- Append-only event stream powering the live UI + per-step logs.
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT,
  seq     INTEGER,
  ts      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  level   TEXT,
  message TEXT,
  data    TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_run ON events(run_id, id);

-- Content-addressed artifact store metadata. Bytes too big for the JSON memo live on disk under
-- the store dir keyed by their sha256; this row records size + when first stored. See artifacts.ts.
CREATE TABLE IF NOT EXISTS artifacts (
  hash       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export type DB = Database;

export function openDb(path: string): DB {
    const db = new Database(path, { create: true });
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA busy_timeout = 5000');
    db.run('PRAGMA foreign_keys = ON');
    db.run(SCHEMA);
    return db;
}

/** Run `fn` inside an IMMEDIATE transaction. `fn` MUST be pure/synchronous DB work. */
export function tx<T>(db: DB, fn: () => T): T {
    const wrapped = db.transaction(fn);
    return wrapped();
}

// ---- small JSON helpers (the memo boundary is JSON) ----

export function toJson(value: unknown): string | null {
    if (value === undefined) return null;
    return JSON.stringify(value);
}

export function fromJson<T = unknown>(s: string | null): T | undefined {
    if (s == null) return undefined;
    return JSON.parse(s) as T;
}

/** Assert a value survives JSON without silently losing data; throw naming the offending step. */
export function assertSerializable(value: unknown, label: string): void {
    const lossy = jsonLossReason(value);
    if (lossy) {
        throw new Error(`step "${label}" returned a value JSON can't preserve (${lossy}) — return plain JSON data.`);
    }
}

/** Return a human reason if JSON would silently drop/mangle `value`, or outright fail to stringify
 *  it (e.g. a throwing custom `toJSON`), else null. Top-level `undefined` is representable (callers
 *  store or normalize it as null), so it counts as no loss. */
export function jsonLossReason(value: unknown): string | null {
    if (value === undefined) return null;
    const lossy = jsonLossReasonAt(value, new Set());
    if (lossy) return lossy;
    try {
        JSON.stringify(value);
        return null;
    } catch (e) {
        return (e as Error).message;
    }
}

function jsonLossReasonAt(v: unknown, seen: Set<object>): string | null {
    const t = typeof v;
    // NaN/Infinity are numbers JSON.stringify silently coerces to null — a loss, not lossless.
    if (t === 'number') return Number.isFinite(v as number) ? null : `a non-finite number (${v})`;
    if (v === null || t === 'string' || t === 'boolean') return null;
    if (t === 'function') return 'a function';
    if (t === 'symbol') return 'a symbol';
    if (t === 'bigint') return 'a bigint';
    if (t !== 'object') return `a ${t}`;
    const o = v as object;
    if (seen.has(o)) return 'a circular reference';
    if (o instanceof Map) return 'a Map';
    if (o instanceof Set) return 'a Set';
    // Track only the ancestors on the current path so shared (DAG) references — the same object
    // reached twice via sibling fields — aren't misread as cycles; unwind on the way back out.
    seen.add(o);
    try {
        if (Array.isArray(o)) {
            for (const item of o) {
                const r = jsonLossReasonAt(item, seen);
                if (r) return r;
            }
            return null;
        }
        // Plain object (Date → ISO string and class instances keep their data, so both pass).
        for (const k of Object.keys(o)) {
            const val = (o as Record<string, unknown>)[k];
            if (val === undefined) return `an undefined value at "${k}"`;
            const r = jsonLossReasonAt(val, seen);
            if (r) return r;
        }
        return null;
    } finally {
        seen.delete(o);
    }
}

const TERMINAL = `('completed','failed','cancelled','interrupted')`;

/** Delete terminal runs (and their steps/attempts/events) finished before the retention
 *  window, plus expired kv and orphaned events. Keeps the store bounded. */
export function pruneHistory(db: DB, opts: { days?: number } = {}): { runs: number; events: number } {
    const cutoff = Date.now() - (opts.days ?? 14) * 86_400_000;
    return tx(db, () => {
        const old = db
            .query(`SELECT id FROM runs WHERE status IN ${TERMINAL} AND finished_at IS NOT NULL AND finished_at < ?`)
            .all(cutoff) as { id: string }[];
        for (const r of old) {
            db.query(`DELETE FROM events WHERE run_id = ?`).run(r.id);
            db.query(`DELETE FROM step_attempts WHERE run_id = ?`).run(r.id);
            db.query(`DELETE FROM steps WHERE run_id = ?`).run(r.id);
            db.query(`DELETE FROM runs WHERE id = ?`).run(r.id);
        }
        db.query(`DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(Date.now());
        const orphan = db
            .query(`DELETE FROM events WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM runs) AND ts < ?`)
            .run(cutoff);
        return { runs: old.length, events: orphan.changes as number };
    });
}

export function emit(
    db: DB,
    ev: { runId?: string | null; seq?: number | null; type: string; level?: string; message?: string; data?: unknown },
): void {
    const ts = Date.now();
    const data = ev.data === undefined ? null : JSON.stringify(ev.data);
    const res = db
        .query(`INSERT INTO events (run_id, seq, ts, type, level, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(ev.runId ?? null, ev.seq ?? null, ts, ev.type, ev.level ?? null, ev.message ?? null, data);
    // Fan the just-written row out to live SSE subscribers immediately (no 500ms poll gap). We build
    // the row from the same values rather than re-reading it — the id is the row we just inserted.
    publishEvent({
        id: Number(res.lastInsertRowid),
        run_id: ev.runId ?? null,
        seq: ev.seq ?? null,
        ts,
        type: ev.type,
        level: ev.level ?? null,
        message: ev.message ?? null,
        data,
    });
}
