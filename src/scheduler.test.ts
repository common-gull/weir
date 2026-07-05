import { expect, test, beforeEach } from 'bun:test';
import { openDb, type DB } from './db.ts';
import { clearRegistry, defineWorkflow } from './engine.ts';
import { Scheduler } from './scheduler.ts';
import { createRun } from './runs.ts';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  clearRegistry();
});

const runCount = (wf: string) =>
  (db.query(`SELECT COUNT(*) AS c FROM runs WHERE workflow = ?`).get(wf) as { c: number }).c;

const T0 = Date.UTC(2026, 0, 1, 0, 0, 30);

test('on-time: one due slot creates exactly one run', () => {
  let clock = T0;
  defineWorkflow('w', { schedule: { cron: '* * * * *' } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  s.syncFromRegistry();
  clock = Date.UTC(2026, 0, 1, 0, 1, 5);
  expect(s.tick()).toBe(1);
  expect(runCount('w')).toBe(1);
});

test('downtime + catchup_once: many missed slots -> exactly one run', () => {
  let clock = T0;
  defineWorkflow('w', { schedule: { cron: '* * * * *', catchup: 'catchup_once' } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  s.syncFromRegistry();
  clock = Date.UTC(2026, 0, 1, 0, 5, 30); // down ~4.5 min
  expect(s.tick()).toBe(1);
});

test('downtime + skip: no runs, but next_fire_at advances past now', () => {
  let clock = T0;
  defineWorkflow('w', { schedule: { cron: '* * * * *', catchup: 'skip' } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  s.syncFromRegistry();
  clock = Date.UTC(2026, 0, 1, 0, 5, 30);
  expect(s.tick()).toBe(0);
  const row = db.query(`SELECT next_fire_at FROM schedules WHERE workflow = 'w'`).get() as { next_fire_at: number };
  expect(row.next_fire_at).toBeGreaterThan(clock);
});

test('downtime + backfill: one run per missed slot', () => {
  let clock = T0;
  defineWorkflow('w', { schedule: { cron: '* * * * *', catchup: 'backfill', backfillMax: 10 } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  s.syncFromRegistry();
  clock = Date.UTC(2026, 0, 1, 0, 5, 30); // slots :01 :02 :03 :04 :05 = 5
  expect(s.tick()).toBe(5);
});

test('catchup_once after long downtime fires the MOST-RECENT missed slot, not a stale one', () => {
  let clock = T0;
  defineWorkflow('w', { schedule: { cron: '* * * * *', catchup: 'catchup_once', backfillMax: 3 } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  s.syncFromRegistry(); // next = 00:01
  clock = Date.UTC(2026, 0, 1, 0, 10, 30); // ~9 missed slots, well past backfillMax
  expect(s.tick()).toBe(1);
  const run = db.query(`SELECT logical_fire_at FROM runs WHERE workflow = 'w'`).get() as { logical_fire_at: number };
  expect(run.logical_fire_at).toBe(Date.UTC(2026, 0, 1, 0, 10, 0)); // most-recent, not ~00:04
  const sched = db.query(`SELECT last_fire_at FROM schedules WHERE workflow = 'w'`).get() as { last_fire_at: number };
  expect(sched.last_fire_at).toBe(Date.UTC(2026, 0, 1, 0, 10, 0));
});

test('overlap skip: an active run of the same workflow blocks a new fire', () => {
  let clock = T0;
  defineWorkflow('w', { schedule: { cron: '* * * * *', overlap: 'skip' } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  s.syncFromRegistry();
  createRun(db, 'w'); // an active (queued) run exists
  clock = Date.UTC(2026, 0, 1, 0, 1, 5);
  expect(s.tick()).toBe(0);
  expect(runCount('w')).toBe(1); // only the manual one
});

test('stale schedule is removed when the workflow drops its schedule (fixes runs on restart)', () => {
  let clock = T0;
  defineWorkflow('w', { schedule: { cron: '* * * * *' } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  s.syncFromRegistry();
  expect(db.query(`SELECT COUNT(*) AS c FROM schedules WHERE id = 'wf:w'`).get()).toEqual({ c: 1 });

  // Simulate an edited-on-disk reload: same workflow, no schedule anymore.
  clearRegistry();
  defineWorkflow('w', {}, async () => 1);
  const res = s.syncFromRegistry();
  expect(res.removed).toEqual(['wf:w']);

  // The stale row is gone, so a later tick past its old slot fires nothing.
  clock = Date.UTC(2026, 0, 1, 0, 5, 30);
  expect(s.tick()).toBe(0);
  expect(db.query(`SELECT COUNT(*) AS c FROM schedules`).get()).toEqual({ c: 0 });
});

test('stale schedule is removed when the workflow is deleted from disk', () => {
  const clock = T0;
  defineWorkflow('gone', { schedule: { cron: '* * * * *' } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  s.syncFromRegistry();
  clearRegistry(); // file deleted → not re-registered on reload
  const res = s.syncFromRegistry();
  expect(res.removed).toEqual(['wf:gone']);
  expect(runCount('gone')).toBe(0);
});

test('syncFromRegistry keeps live schedules and reports upserts', () => {
  const clock = T0;
  defineWorkflow('keep', { schedule: { cron: '* * * * *' } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  const res = s.syncFromRegistry();
  expect(res.upserted).toEqual(['wf:keep']);
  expect(res.removed).toEqual([]);
  expect(db.query(`SELECT COUNT(*) AS c FROM schedules WHERE id = 'wf:keep'`).get()).toEqual({ c: 1 });
});

test('unsatisfiable cron (Feb 30) is rejected without touching the DB or crashing sync', () => {
  const clock = T0;
  defineWorkflow('never', { schedule: { cron: '0 0 30 2 *' } }, async () => 1); // Feb 30 never occurs
  const s = new Scheduler(db, undefined, () => clock);
  // Parses fine but never fires: syncFromRegistry must reject it instead of throwing on INSERT.
  const res = s.syncFromRegistry();
  expect(res.upserted).toEqual([]);
  expect(db.query(`SELECT COUNT(*) AS c FROM schedules`).get()).toEqual({ c: 0 });
  const ev = db.query(`SELECT message FROM events WHERE type = 'schedule.invalid'`).get() as { message: string };
  expect(ev.message).toContain('never');
});

test('start() survives an unsatisfiable cron instead of crashing the daemon on boot', () => {
  const clock = T0;
  defineWorkflow('never', { schedule: { cron: '0 0 31 2 *' } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  expect(() => s.start()).not.toThrow();
  s.stop();
  expect(db.query(`SELECT COUNT(*) AS c FROM schedules`).get()).toEqual({ c: 0 });
});

test('rare-but-valid leap-day cron is accepted and scheduled (not misreported as invalid)', () => {
  const clock = T0;
  defineWorkflow('feb29', { schedule: { cron: '0 0 29 2 *' } }, async () => 1); // fires only on Feb 29
  const s = new Scheduler(db, undefined, () => clock);
  const res = s.syncFromRegistry();
  expect(res.upserted).toEqual(['wf:feb29']);
  const row = db.query(`SELECT next_fire_at FROM schedules WHERE id = 'wf:feb29'`).get() as { next_fire_at: number };
  expect(row.next_fire_at).toBe(Date.UTC(2028, 1, 29, 0, 0, 0)); // next Feb 29 after 2026-01-01
  expect(db.query(`SELECT COUNT(*) AS c FROM events WHERE type = 'schedule.invalid'`).get()).toEqual({ c: 0 });
});

test('a transiently-invalid cron on reload keeps the existing row instead of deleting it', () => {
  let clock = T0;
  defineWorkflow('w', { schedule: { cron: '* * * * *' } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  s.syncFromRegistry();
  // Disable the live schedule, mimicking operator state we must not lose.
  db.query(`UPDATE schedules SET enabled = 0 WHERE id = 'wf:w'`).run();

  // Reload with a typo'd/unsatisfiable cron: the row must survive (no delete, no resurrection).
  clearRegistry();
  defineWorkflow('w', { schedule: { cron: '0 0 30 2 *' } }, async () => 1);
  const res = s.syncFromRegistry();
  expect(res.removed).toEqual([]);
  const row = db.query(`SELECT enabled FROM schedules WHERE id = 'wf:w'`).get() as { enabled: number };
  expect(row.enabled).toBe(0); // persisted state preserved, not silently reset to enabled

  // Fixing the cron on a later reload keeps it disabled — no silent resurrection.
  clearRegistry();
  clock = Date.UTC(2026, 0, 1, 0, 5, 30);
  defineWorkflow('w', { schedule: { cron: '* * * * *' } }, async () => 1);
  s.syncFromRegistry();
  expect((db.query(`SELECT enabled FROM schedules WHERE id = 'wf:w'`).get() as { enabled: number }).enabled).toBe(0);
});

test('no drift: next_fire_at stays aligned to the cron grid', () => {
  let clock = T0;
  defineWorkflow('w', { schedule: { cron: '*/5 * * * *' } }, async () => 1);
  const s = new Scheduler(db, undefined, () => clock);
  s.syncFromRegistry();
  // tick slightly late several times; slots must remain on :00 :05 :10 ...
  for (const m of [5, 10, 15]) {
    clock = Date.UTC(2026, 0, 1, 0, m, 3); // 3s late each time
    s.tick();
    const row = db.query(`SELECT next_fire_at FROM schedules WHERE workflow = 'w'`).get() as { next_fire_at: number };
    expect(new Date(row.next_fire_at).getUTCSeconds()).toBe(0);
    expect(new Date(row.next_fire_at).getUTCMinutes() % 5).toBe(0);
  }
});
