import { expect, test, beforeEach } from 'bun:test';
import { openDb, type DB } from './db.ts';
import { clearRegistry, defineWorkflow } from './engine.ts';
import { Executor } from './executor.ts';
import { createRun, pauseRun, resumeRun } from './runs.ts';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  clearRegistry();
});

const statusOf = (id: string) => (db.query(`SELECT status FROM runs WHERE id = ?`).get(id) as { status: string }).status;

test('pauseRun holds a queued run; resumeRun re-queues it', () => {
  const id = createRun(db, 't');
  expect(statusOf(id)).toBe('queued');

  pauseRun(db, id);
  expect(statusOf(id)).toBe('paused');

  resumeRun(db, id);
  expect(statusOf(id)).toBe('queued');
});

test('pauseRun rejects a run that is not queued', () => {
  const id = createRun(db, 't');
  db.query(`UPDATE runs SET status = 'running' WHERE id = ?`).run(id);
  expect(() => pauseRun(db, id)).toThrow(/not queued/);
  expect(statusOf(id)).toBe('running');
});

test('resumeRun rejects a run that is not paused', () => {
  const id = createRun(db, 't');
  expect(() => resumeRun(db, id)).toThrow(/not paused/);
  expect(statusOf(id)).toBe('queued');
});

test('pauseRun/resumeRun throw when the run does not exist', () => {
  expect(() => pauseRun(db, 'nope')).toThrow(/run not found/);
  expect(() => resumeRun(db, 'nope')).toThrow(/run not found/);
});

test('the executor never claims a paused run, but runs it once resumed', async () => {
  let ran = 0;
  defineWorkflow('t', {}, async () => {
    ran++;
    return 'ok';
  });

  const ex = new Executor(db, {});
  const id = createRun(db, 't');
  pauseRun(db, id);

  ex.start();
  await ex.drain();
  expect(ran).toBe(0); // paused runs are skipped by claimNext
  expect(statusOf(id)).toBe('paused');

  resumeRun(db, id);
  ex.wake();
  await ex.drain();
  await ex.stop();

  expect(ran).toBe(1);
  expect(statusOf(id)).toBe('completed');
});
