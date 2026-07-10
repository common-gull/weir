import { expect, test } from 'bun:test';
import { openDb } from '../src/db.ts';
import { defineWorkflow, executeRun } from '../src/engine.ts';
import { createRun } from '../src/runs.ts';
import exampleWorkflow from './example.ts';

test('example: pick-name/greet/read-platform all run as memoized host-closure steps', async () => {
    // Re-register defensively — the workflow registry is a process-wide singleton other test files
    // clear, so importing example.ts for its side effect isn't enough on its own.
    defineWorkflow(exampleWorkflow.name, exampleWorkflow.opts, exampleWorkflow.body);

    const db = openDb(':memory:');
    const id = createRun(db, 'example');
    expect(await executeRun(db, id)).toBe('completed');

    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual({ greeting: 'hello, world', platform: process.platform });

    // Every step is a host closure now (the closure-default model) — container isolation is the opt-in
    // `ctx.containerStep`, exercised in src/engine.test.ts. Each memoizes like any 'step'.
    const steps = db.query(`SELECT name, kind FROM steps WHERE run_id = ? ORDER BY seq`).all(id) as {
        name: string;
        kind: string;
    }[];
    expect(steps).toEqual([
        { name: 'pick-name', kind: 'step' },
        { name: 'greet', kind: 'step' },
        { name: 'read-platform', kind: 'step' },
    ]);
    db.close();
});
