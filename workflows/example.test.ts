import { expect, test } from 'bun:test';
import { openDb } from '../src/db.ts';
import { defineWorkflow, executeRun } from '../src/engine.ts';
import { createRun } from '../src/runs.ts';
import exampleWorkflow from './example.ts';

test('example: pick-name/greet run as memoized exec steps; read-platform stays on the host', async () => {
    // Re-register defensively — the workflow registry is a process-wide singleton other test files
    // clear, so importing example.ts for its side effect isn't enough on its own.
    defineWorkflow(exampleWorkflow.name, exampleWorkflow.opts, exampleWorkflow.body);

    const db = openDb(':memory:');
    const id = createRun(db, 'example');
    expect(await executeRun(db, id)).toBe('completed');

    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual({ greeting: 'hello, world', platform: process.platform });

    // pick-name/greet run through the exec runtime (a subprocess) via the spec overload and memoize
    // like any step; read-platform is a plain closure step. This locks in the closure-default model
    // with the transitional spec overload alongside it.
    const steps = db.query(`SELECT name, kind FROM steps WHERE run_id = ? ORDER BY seq`).all(id) as {
        name: string;
        kind: string;
    }[];
    expect(steps).toEqual([
        { name: 'pick-name', kind: 'exec' },
        { name: 'greet', kind: 'exec' },
        { name: 'read-platform', kind: 'step' },
    ]);
    db.close();
}, 20_000);
