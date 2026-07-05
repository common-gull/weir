import { expect, test, beforeEach } from 'bun:test';
import { openDb, type DB } from './db.ts';
import { clearRegistry, defineWorkflow } from './engine.ts';
import { Executor } from './executor.ts';
import { createRun } from './runs.ts';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  clearRegistry();
});

test('resource pool bounds concurrency to the pool size', async () => {
  let cur = 0;
  let max = 0;
  defineWorkflow('t', {}, async (ctx) => {
    await ctx.step(
      'work',
      async () => {
        cur++;
        max = Math.max(max, cur);
        await new Promise((r) => setTimeout(r, 25));
        cur--;
        return 1;
      },
      { pool: 'llm' },
    );
    return 'ok';
  });

  const ex = new Executor(db, { maxConcurrent: 10, pools: { llm: 2 } });
  for (let i = 0; i < 5; i++) createRun(db, 't');
  ex.start();
  await ex.drain();
  await ex.stop();

  expect(max).toBe(2); // never more than 2 in the llm pool at once
  const done = db.query(`SELECT COUNT(*) AS c FROM runs WHERE status = 'completed'`).get() as { c: number };
  expect(done.c).toBe(5);
});

test('global cap bounds total concurrent runs', async () => {
  let cur = 0;
  let max = 0;
  defineWorkflow('t', {}, async (ctx) => {
    await ctx.step('work', async () => {
      cur++;
      max = Math.max(max, cur);
      await new Promise((r) => setTimeout(r, 20));
      cur--;
      return 1;
    });
    return 'ok';
  });
  const ex = new Executor(db, { maxConcurrent: 3 });
  for (let i = 0; i < 8; i++) createRun(db, 't');
  ex.start();
  await ex.drain();
  await ex.stop();
  expect(max).toBe(3);
});

test('child workflow runs to completion and returns its result', async () => {
  defineWorkflow('double', {}, async (ctx) => (ctx.input as { x: number }).x * 2);
  defineWorkflow('parent', {}, async (ctx) => {
    const a = (await ctx.child<number>('double', { x: 21 })) as number;
    return a;
  });
  const ex = new Executor(db, {});
  const id = createRun(db, 'parent');
  expect(await ex.runNow(id)).toBe('completed');
  const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
  expect(JSON.parse(run.result)).toBe(42);
});

test('sweepOrphans marks running runs as interrupted', () => {
  const id = createRun(db, 'x');
  db.query(`UPDATE runs SET status = 'running' WHERE id = ?`).run(id);
  const ex = new Executor(db, {});
  expect(ex.sweepOrphans()).toBe(1);
  const r = db.query(`SELECT status FROM runs WHERE id = ?`).get(id) as { status: string };
  expect(r.status).toBe('interrupted');
});
