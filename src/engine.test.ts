import { afterEach, expect, test, beforeEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getArtifact } from './artifacts.ts';
import { openDb, type DB } from './db.ts';
import { clearRegistry, defineWorkflow, executeRun, type RunDeps } from './engine.ts';
import { approveRun, createRun, retryRun } from './runs.ts';

let db: DB;
const tmpDirs: string[] = [];
beforeEach(() => {
    db = openDb(':memory:');
    clearRegistry();
});
afterEach(async () => {
    for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Fresh store + scratch dirs threaded to a run so its spec-step artifacts land somewhere the test
 *  can inspect; cleaned up in afterEach. */
async function artifactDeps(): Promise<RunDeps> {
    const storeDir = await mkdtemp(join(tmpdir(), 'weir-store-'));
    const scratchDir = await mkdtemp(join(tmpdir(), 'weir-scratch-'));
    tmpDirs.push(storeDir, scratchDir);
    return { storeDir, scratchDir };
}

const nodeStep = fileURLToPath(new URL('./exec/testdata/node-step.ts', import.meta.url));
const nodeEnv = fileURLToPath(new URL('./exec/testdata/node-env.ts', import.meta.url));
const writer = fileURLToPath(new URL('./exec/testdata/artifact-writer.ts', import.meta.url));
const reader = fileURLToPath(new URL('./exec/testdata/artifact-reader.ts', import.meta.url));
const exitWriter = fileURLToPath(new URL('./exec/testdata/exit-writer.ts', import.meta.url));

// Run `fn` with sentinel secrets planted in the daemon env (resolveExecEnv reads process.env), then
// restore — so an exec step's observed env can be asserted against what the policy actually forwards.
async function withDaemonSecrets<T>(fn: () => Promise<T>): Promise<T> {
    const prev = { GH_TOKEN: process.env.GH_TOKEN, WEIR_ENV_SNOOP: process.env.WEIR_ENV_SNOOP };
    process.env.GH_TOKEN = 'gh-secret-xyz';
    process.env.WEIR_ENV_SNOOP = 'daemon-only';
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

const stepNames = (runId: string) =>
    (db.query(`SELECT key FROM steps WHERE run_id = ? ORDER BY seq`).all(runId) as { key: string }[]).map((r) => r.key);

test('retry-from-failure: completed steps do not re-run; execution resumes at the failure', async () => {
    const ran: string[] = [];
    let failReview = true;
    defineWorkflow('t', { capabilities: ['host-exec'] }, async (ctx) => {
        await ctx.runUnsafelyOnHost('a', () => {
            ran.push('a');
            return 1;
        });
        await ctx.runUnsafelyOnHost('b', () => {
            ran.push('b');
            return 2;
        });
        await ctx.runUnsafelyOnHost('c', () => {
            ran.push('c');
            if (failReview) throw new Error('boom');
            return 3;
        });
        await ctx.runUnsafelyOnHost('d', () => {
            ran.push('d');
            return 4;
        });
        return 'ok';
    });

    const id = createRun(db, 't');
    expect(await executeRun(db, id)).toBe('failed');
    expect(ran).toEqual(['a', 'b', 'c']); // failed at c, d never reached
    expect(stepNames(id)).toEqual(['a#0', 'b#0']); // only successes memoized

    // Fix the condition and retry — a & b must NOT re-run.
    ran.length = 0;
    failReview = false;
    retryRun(db, id);
    expect(await executeRun(db, id)).toBe('completed');
    expect(ran).toEqual(['c', 'd']); // resumed at c
    expect(stepNames(id)).toEqual(['a#0', 'b#0', 'c#0', 'd#0']);
});

test('ctx.now() is memoized: stable across a retry', async () => {
    const observed: number[] = [];
    let boom = true;
    defineWorkflow('t', { capabilities: ['host-exec'] }, async (ctx) => {
        const n = ctx.now();
        observed.push(n);
        await ctx.runUnsafelyOnHost('x', () => {
            if (boom) throw new Error('x');
            return 1;
        });
        return n;
    });
    const id = createRun(db, 't');
    await executeRun(db, id);
    const first = observed[0];
    expect(first).toBeDefined();
    boom = false;
    retryRun(db, id);
    await executeRun(db, id);
    expect(observed[1]).toBe(first); // same wall-clock on replay
});

test('ctx.loop: bounded auto-iteration, fails twice then succeeds -> exactly 3 iterations', async () => {
    let attempts = 0;
    defineWorkflow('t', { capabilities: ['host-exec'] }, async (ctx) => {
        const out = await ctx.loop({ max: 5, until: (r: { ok: boolean }) => r.ok }, async (it) => {
            const ok = (await it.runUnsafelyOnHost('try', () => {
                attempts++;
                return attempts >= 3;
            })) as boolean;
            return { ok };
        });
        return out;
    });
    const id = createRun(db, 't');
    expect(await executeRun(db, id)).toBe('completed');
    expect(attempts).toBe(3);
    expect(stepNames(id)).toEqual(['loop#0:0:try', 'loop#0:1:try', 'loop#0:2:try']);
});

test('ctx.map: per-item isolation — one item fails, the rest succeed', async () => {
    defineWorkflow('t', { capabilities: ['host-exec'] }, async (ctx) => {
        return ctx.map([0, 1, 2, 3, 4], (n) => {
            if (n === 3) throw new Error('bad');
            return n * 10;
        });
    });
    const id = createRun(db, 't');
    expect(await executeRun(db, id)).toBe('completed');
    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    const res = JSON.parse(run.result);
    expect(res).toEqual([
        { ok: true, value: 0 },
        { ok: true, value: 10 },
        { ok: true, value: 20 },
        { ok: false, error: 'bad' },
        { ok: true, value: 40 },
    ]);
});

test('ctx.map: denied without the host-exec capability — mapper never runs, no seq consumed', async () => {
    let ran = false;
    defineWorkflow('nomap', {}, async (ctx) => {
        return ctx.map([1, 2, 3], (n) => {
            ran = true;
            return n;
        });
    });
    const id = createRun(db, 'nomap');
    expect(await executeRun(db, id)).toBe('failed'); // map runs host closures → needs host-exec
    expect(ran).toBe(false); // gate throws before any item's mapper runs
    const run = db.query(`SELECT error FROM runs WHERE id = ?`).get(id) as { error: string };
    expect(run.error).toContain('host-exec');
    expect(stepNames(id)).toEqual([]); // no seq consumed on a denied call
});

test('ctx.once: rate-limit window — first true, second false', async () => {
    const results: boolean[] = [];
    defineWorkflow('t', {}, async (ctx) => {
        results.push(await ctx.once('remind:repoX', '1h'));
        return results;
    });
    await executeRun(db, createRun(db, 't'));
    await executeRun(db, createRun(db, 't')); // different run, same window
    expect(results).toEqual([true, false]);
});

test('ctx.once is atomic: concurrent runs -> exactly one claim', async () => {
    const results: boolean[] = [];
    defineWorkflow('t', {}, async (ctx) => {
        results.push(await ctx.once('slot', '1h'));
        return 1;
    });
    // fire many runs "at once"
    await Promise.all(Array.from({ length: 8 }, () => executeRun(db, createRun(db, 't'))));
    expect(results.filter((x) => x).length).toBe(1); // exactly one winner
});

test('skip: workflow returns ctx.skip -> completed with skipped result', async () => {
    defineWorkflow('t', {}, async (ctx) => ctx.skip('nothing to do'));
    const id = createRun(db, 't');
    expect(await executeRun(db, id)).toBe('completed');
    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual({ skipped: true, reason: 'nothing to do' });
});

test('retry --from: discards memo at/after a step so it re-runs', async () => {
    const ran: string[] = [];
    defineWorkflow('t', { capabilities: ['host-exec'] }, async (ctx) => {
        await ctx.runUnsafelyOnHost('a', () => {
            ran.push('a');
            return 1;
        });
        await ctx.runUnsafelyOnHost('b', () => {
            ran.push('b');
            return 2;
        });
        await ctx.runUnsafelyOnHost('c', () => {
            ran.push('c');
            return 3;
        });
        return 'ok';
    });
    const id = createRun(db, 't');
    await executeRun(db, id);
    expect(ran).toEqual(['a', 'b', 'c']);

    ran.length = 0;
    retryRun(db, id, 'b'); // rewind to b
    await executeRun(db, id);
    expect(ran).toEqual(['b', 'c']); // a stayed memoized, b & c re-ran
});

test('ctx.once() is memoized: a retry replays the same claim result (no seq drift)', async () => {
    const seen: boolean[] = [];
    let boom = true;
    defineWorkflow('t', { capabilities: ['host-exec'] }, async (ctx) => {
        const first = (await ctx.once('slot', '1h')) as boolean;
        seen.push(first);
        if (first) await ctx.runUnsafelyOnHost('gated', () => 1); // a memoized step behind the once() gate
        await ctx.runUnsafelyOnHost('after', () => {
            if (boom) throw new Error('x');
            return 2;
        });
        return first;
    });
    const id = createRun(db, 't');
    expect(await executeRun(db, id)).toBe('failed'); // once→true, gated runs, after throws
    boom = false;
    retryRun(db, id);
    expect(await executeRun(db, id)).toBe('completed'); // once replays true → gate + seqs align
    expect(seen).toEqual([true, true]); // NOT [true, false]
});

test('approveRun resumes the parked gate by name and rejects non-parked runs', async () => {
    defineWorkflow('t', { capabilities: ['host-exec'] }, async (ctx) => {
        await ctx.runUnsafelyOnHost('before', () => 1);
        const payload = await ctx.waitForApproval('deploy'); // gate name != default 'human'
        return { approved: payload };
    });
    const id = createRun(db, 't');
    expect(await executeRun(db, id)).toBe('awaiting-approval');
    approveRun(db, id); // no explicit gate → resolves to the parked 'deploy'
    expect(await executeRun(db, id)).toBe('completed');
    expect(JSON.parse((db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string }).result)).toEqual(
        {
            approved: true,
        },
    );
    expect(() => approveRun(db, id)).toThrow(/not awaiting approval/); // completed run can't be re-approved
});

test('runUnsafelyOnHost: denied without the host-exec capability, naming it', async () => {
    let ran = false;
    defineWorkflow('nohost', {}, async (ctx) => {
        await ctx.runUnsafelyOnHost('touch', () => {
            ran = true;
            return 1;
        });
        return 'ok';
    });
    const id = createRun(db, 'nohost');
    expect(await executeRun(db, id)).toBe('failed');
    expect(ran).toBe(false); // gate throws before the closure runs
    const run = db.query(`SELECT error FROM runs WHERE id = ?`).get(id) as { error: string };
    expect(run.error).toContain('host-exec');
    expect(stepNames(id)).toEqual([]); // no seq consumed on a denied call
});

test('runUnsafelyOnHost: granted -> runs in-process with step-identical memo/replay', async () => {
    const ran: string[] = [];
    let boom = true;
    defineWorkflow('host', { capabilities: ['host-exec'] }, async (ctx) => {
        await ctx.runUnsafelyOnHost('a', () => {
            ran.push('a');
            return 1;
        });
        await ctx.runUnsafelyOnHost('b', () => {
            ran.push('b');
            if (boom) throw new Error('boom');
            return 2;
        });
        return 'ok';
    });
    const id = createRun(db, 'host');
    expect(await executeRun(db, id)).toBe('failed');
    expect(ran).toEqual(['a', 'b']);
    expect(stepNames(id)).toEqual(['a#0']); // host step memoized like any 'step'

    ran.length = 0;
    boom = false;
    retryRun(db, id);
    expect(await executeRun(db, id)).toBe('completed');
    expect(ran).toEqual(['b']); // memoized host step replays, does not re-run
    expect(stepNames(id)).toEqual(['a#0', 'b#0']);
});

test('ctx.step(fn): a closure is rejected loudly — no in-process fallback, no seq consumed', async () => {
    let ran = false;
    defineWorkflow('closurestep', { capabilities: ['host-exec'] }, async (ctx) => {
        // The closure overload is gone at the type level; a JS caller that still passes a function
        // hits the runtime guard rather than silently running in-process.
        const step = ctx.step as unknown as (name: string, fn: () => unknown) => Promise<unknown>;
        await step('legacy', () => {
            ran = true;
            return 1;
        });
        return 'ok';
    });
    const id = createRun(db, 'closurestep');
    expect(await executeRun(db, id)).toBe('failed');
    expect(ran).toBe(false); // the guard throws before the closure could run
    const run = db.query(`SELECT error FROM runs WHERE id = ?`).get(id) as { error: string };
    expect(run.error).toContain('runUnsafelyOnHost'); // points the caller at the host hatch
    expect(stepNames(id)).toEqual([]); // thrown before any seq/memo is consumed
});

test('loop it.runUnsafelyOnHost: denied without host-exec, no seq consumed', async () => {
    let ran = false;
    defineWorkflow('loopnohost', {}, async (ctx) => {
        await ctx.loop({ max: 3, until: () => true }, async (it) => {
            await it.runUnsafelyOnHost('touch', () => {
                ran = true;
                return 1;
            });
        });
        return 'ok';
    });
    const id = createRun(db, 'loopnohost');
    expect(await executeRun(db, id)).toBe('failed');
    expect(ran).toBe(false); // gate throws before the closure runs
    const run = db.query(`SELECT error FROM runs WHERE id = ?`).get(id) as { error: string };
    expect(run.error).toContain('host-exec');
    expect(stepNames(id)).toEqual([]);
});

test('loop it.runUnsafelyOnHost: granted -> per-iteration key identical to it.step', async () => {
    let attempts = 0;
    defineWorkflow('loophost', { capabilities: ['host-exec'] }, async (ctx) => {
        return ctx.loop({ max: 5, until: (r: { ok: boolean }) => r.ok }, async (it) => {
            const ok = (await it.runUnsafelyOnHost('try', () => {
                attempts++;
                return attempts >= 3;
            })) as boolean;
            return { ok };
        });
    });
    const id = createRun(db, 'loophost');
    expect(await executeRun(db, id)).toBe('completed');
    expect(attempts).toBe(3);
    // Same key shape as it.step, so migrating it.step -> it.runUnsafelyOnHost is replay-stable.
    expect(stepNames(id)).toEqual(['loop#0:0:try', 'loop#0:1:try', 'loop#0:2:try']);
});

test('it.step(fn): a closure in a loop is rejected loudly — no in-process fallback, no seq consumed', async () => {
    let ran = false;
    defineWorkflow('loopclosure', { capabilities: ['host-exec'] }, async (ctx) => {
        await ctx.loop({ max: 3, until: () => true }, async (it) => {
            // The closure overload is gone at the type level; a JS caller that still passes a function
            // hits the runtime guard rather than silently running in-process (a host-exec bypass).
            const step = it.step as unknown as (name: string, fn: () => unknown) => Promise<unknown>;
            await step('legacy', () => {
                ran = true;
                return 1;
            });
        });
        return 'ok';
    });
    const id = createRun(db, 'loopclosure');
    expect(await executeRun(db, id)).toBe('failed');
    expect(ran).toBe(false); // the guard throws before the closure could run
    const run = db.query(`SELECT error FROM runs WHERE id = ?`).get(id) as { error: string };
    expect(run.error).toContain('it.runUnsafelyOnHost'); // points the caller at the loop host hatch
    expect(stepNames(id)).toEqual([]); // thrown before any seq/memo is consumed
});

test('it.step spec: runs a container step per iteration in the exec runtime', async () => {
    defineWorkflow('loopexec', { capabilities: ['host-exec'] }, async (ctx) =>
        ctx.loop({ max: 2 }, (it) => it.step('run', { runtime: 'node', module: nodeStep }, { input: { i: it.index } })),
    );
    const id = createRun(db, 'loopexec');
    expect(await executeRun(db, id)).toBe('completed');

    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual({ echoed: { i: 1 }, from: 'node' }); // loop returns the last iteration

    // Each iteration memoized under the 'exec' kind with the loop's per-iteration key.
    const steps = db.query(`SELECT kind, key FROM steps WHERE run_id = ? ORDER BY seq`).all(id) as {
        kind: string;
        key: string;
    }[];
    expect(steps).toEqual([
        { kind: 'exec', key: 'loop#0:0:run' },
        { kind: 'exec', key: 'loop#0:1:run' },
    ]);
}, 20_000);

test('ctx.step spec: denied without the host-exec capability, no subprocess spawned, no seq consumed', async () => {
    defineWorkflow('nohostexec', {}, async (ctx) => {
        await ctx.step('run-node', { runtime: 'node', module: nodeStep }, { input: { n: 42 } });
        return 'ok';
    });
    const id = createRun(db, 'nohostexec');
    expect(await executeRun(db, id)).toBe('failed'); // gate throws before spawning the module
    const run = db.query(`SELECT error FROM runs WHERE id = ?`).get(id) as { error: string };
    expect(run.error).toContain('host-exec');
    expect(stepNames(id)).toEqual([]); // no seq consumed on a denied call
    // No subprocess ran, so no step.log events were emitted by the module.
    const logs = db.query(`SELECT count(*) AS c FROM events WHERE run_id = ? AND type = 'step.log'`).get(id) as {
        c: number;
    };
    expect(logs.c).toBe(0);
});

test('ctx.step spec: runs a node module in a subprocess and memoizes its JSON result', async () => {
    defineWorkflow('exec', { capabilities: ['host-exec'] }, async (ctx) =>
        ctx.step('run-node', { runtime: 'node', module: nodeStep }, { input: { n: 42 } }),
    );
    const id = createRun(db, 'exec');
    expect(await executeRun(db, id)).toBe('completed');

    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual({ echoed: { n: 42 }, from: 'node' });

    // Memoized under the 'exec' kind with the same key shape as a closure step.
    const step = db.query(`SELECT kind, key FROM steps WHERE run_id = ?`).get(id) as { kind: string; key: string };
    expect(step).toEqual({ kind: 'exec', key: 'run-node#0' });

    // Container logs (console.warn in the module) surface as step.log events.
    const logs = db.query(`SELECT message FROM events WHERE run_id = ? AND type = 'step.log'`).all(id) as {
        message: string;
    }[];
    expect(logs.some((l) => l.message === 'heads up')).toBe(true);
}, 15_000);

test('ctx.step spec: a retry replays the memoized exec result without re-running the subprocess', async () => {
    let boom = true;
    defineWorkflow('exec', { capabilities: ['host-exec'] }, async (ctx) => {
        const r = await ctx.step('run-node', { runtime: 'node', module: nodeStep }, { input: { n: 1 } });
        await ctx.runUnsafelyOnHost('after', () => {
            if (boom) throw new Error('boom');
            return 2;
        });
        return r;
    });
    const id = createRun(db, 'exec');
    expect(await executeRun(db, id)).toBe('failed'); // exec step runs once, then `after` throws

    const logCount = () =>
        (db.query(`SELECT count(*) AS c FROM events WHERE run_id = ? AND type = 'step.log'`).get(id) as { c: number })
            .c;
    const before = logCount();
    expect(before).toBeGreaterThan(0);

    boom = false;
    retryRun(db, id);
    expect(await executeRun(db, id)).toBe('completed');

    // No new subprocess ran — the exec memo replayed, so no fresh step.log events were emitted.
    expect(logCount()).toBe(before);
    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual({ echoed: { n: 1 }, from: 'node' });
}, 20_000);

test('ctx.step spec: a step with no credential capability runs with a secret-free env', async () => {
    await withDaemonSecrets(async () => {
        defineWorkflow('exec', { capabilities: ['host-exec'] }, (ctx) =>
            ctx.step('probe-env', { runtime: 'node', module: nodeEnv }),
        );
        const id = createRun(db, 'exec');
        expect(await executeRun(db, id)).toBe('completed');
        const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
        // The child sees neither the gh token nor the arbitrary daemon var — only the PATH baseline.
        expect(JSON.parse(run.result)).toEqual({ GH_TOKEN: null, SNOOP: null, hasPath: true });
    });
}, 15_000);

test('ctx.step spec: a step declaring gh-pr receives GH_TOKEN (only) in its env', async () => {
    await withDaemonSecrets(async () => {
        defineWorkflow('exec', { capabilities: ['host-exec', 'gh-pr'] }, (ctx) =>
            ctx.step('probe-env', { runtime: 'node', module: nodeEnv }),
        );
        const id = createRun(db, 'exec');
        expect(await executeRun(db, id)).toBe('completed');
        const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
        // gh-pr forwards GH_TOKEN, but no other daemon secret rides along.
        expect(JSON.parse(run.result)).toEqual({ GH_TOKEN: 'gh-secret-xyz', SNOOP: null, hasPath: true });
    });
}, 15_000);

test('retryRun --from matches step names exactly (no substring over-delete)', async () => {
    const ran: string[] = [];
    defineWorkflow('t', { capabilities: ['host-exec'] }, async (ctx) => {
        await ctx.runUnsafelyOnHost('redeploy-check', () => {
            ran.push('redeploy-check');
            return 1;
        });
        await ctx.runUnsafelyOnHost('deploy', () => {
            ran.push('deploy');
            return 2;
        });
        return 'ok';
    });
    const id = createRun(db, 't');
    await executeRun(db, id);
    ran.length = 0;
    retryRun(db, id, 'deploy'); // must NOT rewind the earlier 'redeploy-check'
    await executeRun(db, id);
    expect(ran).toEqual(['deploy']);
});

test('exec artifacts: declared outputs are content-addressed into the store and recorded in the memo', async () => {
    const deps = await artifactDeps();
    defineWorkflow('produce', { capabilities: ['host-exec'] }, async (ctx) =>
        ctx.step(
            'make',
            { runtime: 'node', module: writer, outputs: ['out.txt'] },
            { input: { path: 'out.txt', text: 'hello-artifact' } },
        ),
    );
    const id = createRun(db, 'produce');
    expect(await executeRun(db, id, deps)).toBe('completed');

    // The path -> hash map is recorded in the step's memo row (the additive `artifacts` column).
    const step = db.query(`SELECT artifacts FROM steps WHERE run_id = ?`).get(id) as { artifacts: string };
    const map = JSON.parse(step.artifacts) as Record<string, string>;
    const hash = map['out.txt'] ?? '';
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // The bytes live in the store under that hash, and the workflow saw { result, artifacts }.
    expect(await readFile(getArtifact(deps.storeDir ?? '', hash), 'utf8')).toBe('hello-artifact');
    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual({ result: { wrote: 'out.txt' }, artifacts: { 'out.txt': hash } });
}, 20_000);

test('exec artifacts: a downstream step receives declared input artifacts staged into its scratch', async () => {
    const deps = await artifactDeps();
    defineWorkflow('chain', { capabilities: ['host-exec'] }, async (ctx) => {
        const a = await ctx.step(
            'make',
            { runtime: 'node', module: writer, outputs: ['out.txt'] },
            { input: { path: 'out.txt', text: 'chained-bytes' } },
        );
        // Declare the produced hash as an input of the next step, staged in under a new name.
        return ctx.step(
            'use',
            { runtime: 'node', module: reader, inputs: [{ hash: a.artifacts['out.txt'] ?? '', path: 'in.txt' }] },
            { input: { path: 'in.txt' } },
        );
    });
    const id = createRun(db, 'chain');
    expect(await executeRun(db, id, deps)).toBe('completed');

    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual({ content: 'chained-bytes' });
}, 20_000);

test('exec artifacts: re-running an identical step replays the stored artifact instead of rebuilding', async () => {
    const deps = await artifactDeps();
    let boom = true;
    defineWorkflow('rebuild', { capabilities: ['host-exec'] }, async (ctx) => {
        const a = await ctx.step(
            'make',
            { runtime: 'node', module: writer, outputs: ['out.txt'] },
            { input: { path: 'out.txt', text: 'once' } },
        );
        await ctx.runUnsafelyOnHost('gate', () => {
            if (boom) throw new Error('boom');
            return 1;
        });
        return a;
    });
    const id = createRun(db, 'rebuild');
    expect(await executeRun(db, id, deps)).toBe('failed'); // writer runs once, then `gate` throws

    const writes = () =>
        (
            db
                .query(`SELECT count(*) AS c FROM events WHERE run_id = ? AND type = 'step.log' AND message = 'WRITE'`)
                .get(id) as { c: number }
        ).c;
    expect(writes()).toBe(1);
    const step0 = db.query(`SELECT artifacts FROM steps WHERE run_id = ? AND key = 'make#0'`).get(id) as {
        artifacts: string;
    };
    const hash = (JSON.parse(step0.artifacts) as Record<string, string>)['out.txt'] ?? '';

    boom = false;
    retryRun(db, id);
    expect(await executeRun(db, id, deps)).toBe('completed');

    // The writer subprocess did NOT run again — the memo replayed the stored artifact by hash.
    expect(writes()).toBe(1);
    expect(existsSync(getArtifact(deps.storeDir ?? '', hash))).toBe(true);
    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual({ result: { wrote: 'out.txt' }, artifacts: { 'out.txt': hash } });
}, 20_000);

test('ctx.step extract: a custom extractor bridges a non-frame, non-zero-exit process into a result', async () => {
    const deps = await artifactDeps();
    defineWorkflow('bridge', { capabilities: ['host-exec'] }, async (ctx) =>
        ctx.step(
            'stock',
            {
                runtime: 'node',
                module: exitWriter,
                outputs: ['out.json'],
                // The stock process exits 2 and never returns a protocol result; the host adapts its raw
                // output (exit code + captured artifact + raw stdout) into the step result rather than
                // letting the default frame decoder fail it. It PARSES data — no eval, no shell.
                extract: ({ exitCode, stdout, artifacts }) => ({
                    exitCode,
                    sawStdout: stdout.length > 0,
                    artifact: artifacts['out.json'],
                }),
            },
            { input: { path: 'out.json', text: 'payload', code: 2 } },
        ),
    );
    const id = createRun(db, 'bridge');
    expect(await executeRun(db, id, deps)).toBe('completed');

    const step = db.query(`SELECT artifacts FROM steps WHERE run_id = ?`).get(id) as { artifacts: string };
    const hash = (JSON.parse(step.artifacts) as Record<string, string>)['out.json'] ?? '';
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Outputs are declared, so the step resolves to { result, artifacts }; `result` is the extractor's
    // return, proving the engine surfaced the non-zero exit and the content-addressed artifact to it.
    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual({
        result: { exitCode: 2, sawStdout: true, artifact: hash },
        artifacts: { 'out.json': hash },
    });
    expect(await readFile(getArtifact(deps.storeDir ?? '', hash), 'utf8')).toBe('payload');
}, 20_000);

test('ctx.step extract: without an extractor, the default frame decoder still fails that same process', async () => {
    const deps = await artifactDeps();
    defineWorkflow('nobridge', { capabilities: ['host-exec'] }, async (ctx) =>
        ctx.step(
            'stock',
            { runtime: 'node', module: exitWriter, outputs: ['out.json'] },
            {
                input: { path: 'out.json', text: 'payload', code: 2 },
            },
        ),
    );
    const id = createRun(db, 'nobridge');
    // Byte-identical to today: the shim's failure frame fails the step under the default decoder.
    expect(await executeRun(db, id, deps)).toBe('failed');
    const run = db.query(`SELECT error FROM runs WHERE id = ?`).get(id) as { error: string };
    expect(JSON.parse(run.error).message).toContain('exited the process before returning a result');
    // The default decoder rejects the failed run before the store is touched, so the output the shim
    // wrote (out.json) is never content-addressed — no orphan artifact rows from a failed step.
    const count = db.query(`SELECT COUNT(*) AS n FROM artifacts`).get() as { n: number };
    expect(count.n).toBe(0);
}, 20_000);

test('ctx.step extract: an extractor that throws fails the step with its own error', async () => {
    defineWorkflow('reject', { capabilities: ['host-exec'] }, async (ctx) =>
        ctx.step(
            'run',
            {
                runtime: 'node',
                module: nodeStep,
                extract: ({ stdout }) => {
                    throw new Error(`extractor rejected ${stdout.length} bytes`);
                },
            },
            { input: { n: 1 } },
        ),
    );
    const id = createRun(db, 'reject');
    expect(await executeRun(db, id)).toBe('failed');
    const run = db.query(`SELECT error FROM runs WHERE id = ?`).get(id) as { error: string };
    expect(JSON.parse(run.error).message).toContain('extractor rejected');
}, 15_000);
