import { $ } from 'bun';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getArtifact } from './artifacts.ts';
import { openDb, type DB } from './db.ts';
import { clearRegistry, defineWorkflow, executeRun, type RunDeps } from './engine.ts';
import { approveRun, createRun, retryRun } from './runs.ts';
import type { Ctx, StandardSchemaV1 } from './types.ts';

let db: DB;
const tmpDirs: string[] = [];
beforeEach(() => {
    db = openDb(':memory:');
    clearRegistry();
});
afterEach(async () => {
    for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Fresh store + scratch dirs threaded to a run so a container step's scratch/outputs land in a temp
 *  dir the test controls (never the repo's .weir/); cleaned up in afterEach. */
async function containerDeps(): Promise<RunDeps> {
    const storeDir = await mkdtemp(join(tmpdir(), 'weir-store-'));
    const scratchDir = await mkdtemp(join(tmpdir(), 'weir-scratch-'));
    tmpDirs.push(storeDir, scratchDir);
    return { storeDir, scratchDir };
}

/** Insert a completed container-step memo row directly. A run whose seqs are already memoized
 *  fast-forwards past them on replay and never resolves an image — so this exercises the replay path
 *  (and lets the image_digest/artifacts columns be asserted) with no docker daemon at all. */
function seedContainerMemo(
    runId: string,
    seq: number,
    key: string,
    name: string,
    result: unknown,
    imageDigest: string,
    artifacts?: Record<string, string>,
): void {
    db.query(
        `INSERT INTO steps (run_id, seq, key, name, kind, status, result, artifacts, image_digest, created_at)
         VALUES (?, ?, ?, ?, 'container', 'completed', ?, ?, ?, ?)`,
    ).run(
        runId,
        seq,
        key,
        name,
        JSON.stringify(result),
        artifacts ? JSON.stringify(artifacts) : null,
        imageDigest,
        Date.now(),
    );
}

// Plant sentinel secrets in the daemon env (which resolveExecEnv reads) for the duration of `fn`, then
// restore — so a container step's observed env can be asserted against what the capability policy forwards.
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
    defineWorkflow('t', async (ctx) => {
        await ctx.step('a', () => {
            ran.push('a');
            return 1;
        });
        await ctx.step('b', () => {
            ran.push('b');
            return 2;
        });
        await ctx.step('c', () => {
            ran.push('c');
            if (failReview) throw new Error('boom');
            return 3;
        });
        await ctx.step('d', () => {
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
    defineWorkflow('t', async (ctx) => {
        const n = ctx.now();
        observed.push(n);
        await ctx.step('x', () => {
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
    defineWorkflow('t', async (ctx) => {
        const out = await ctx.loop({ max: 5, until: (r: { ok: boolean }) => r.ok }, async (it) => {
            const ok = (await it.step('try', () => {
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
    defineWorkflow('t', async (ctx) => {
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

test('ctx.map: runs without any capability declaration', async () => {
    let ran = 0;
    defineWorkflow('nomap', {}, async (ctx) => {
        return ctx.map([1, 2, 3], (n) => {
            ran++;
            return n * 2;
        });
    });
    const id = createRun(db, 'nomap');
    expect(await executeRun(db, id)).toBe('completed'); // map needs no capability
    expect(ran).toBe(3);
    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual([
        { ok: true, value: 2 },
        { ok: true, value: 4 },
        { ok: true, value: 6 },
    ]);
    expect(stepNames(id)).toEqual(['map#0[0]', 'map#0[1]', 'map#0[2]']); // each item memoized as its own step
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
    defineWorkflow('t', async (ctx) => {
        await ctx.step('a', () => {
            ran.push('a');
            return 1;
        });
        await ctx.step('b', () => {
            ran.push('b');
            return 2;
        });
        await ctx.step('c', () => {
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
    defineWorkflow('t', async (ctx) => {
        const first = (await ctx.once('slot', '1h')) as boolean;
        seen.push(first);
        if (first) await ctx.step('gated', () => 1); // a memoized step behind the once() gate
        await ctx.step('after', () => {
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
    defineWorkflow('t', async (ctx) => {
        await ctx.step('before', () => 1);
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

test('ctx.step(fn): a closure runs in-process with memo/replay identical to any step', async () => {
    const ran: string[] = [];
    let boom = true;
    defineWorkflow('host', async (ctx) => {
        await ctx.step('a', () => {
            ran.push('a');
            return 1;
        });
        await ctx.step('b', () => {
            ran.push('b');
            if (boom) throw new Error('boom');
            return 2;
        });
        return 'ok';
    });
    const id = createRun(db, 'host');
    expect(await executeRun(db, id)).toBe('failed');
    expect(ran).toEqual(['a', 'b']);
    expect(stepNames(id)).toEqual(['a#0']); // closure step memoized like any 'step'

    ran.length = 0;
    boom = false;
    retryRun(db, id);
    expect(await executeRun(db, id)).toBe('completed');
    expect(ran).toEqual(['b']); // memoized closure step replays, does not re-run
    expect(stepNames(id)).toEqual(['a#0', 'b#0']);
});

test('ctx.step: a closure dispatches to an in-process step (kind "step")', async () => {
    defineWorkflow('closurestep', async (ctx) => ctx.step('run', () => 42));
    const id = createRun(db, 'closurestep');
    expect(await executeRun(db, id)).toBe('completed');
    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toBe(42);
    // A closure is dispatched by typeof to the in-process path: kind 'step', same key shape as a spec.
    const step = db.query(`SELECT kind, key FROM steps WHERE run_id = ?`).get(id) as { kind: string; key: string };
    expect(step).toEqual({ kind: 'step', key: 'run#0' });
});

test('it.step(fn): a loop closure memoizes and replays across a retry, keyed per iteration', async () => {
    let runs = 0;
    let boom = true;
    defineWorkflow('loophost', async (ctx) => {
        await ctx.loop({ max: 2, until: () => true }, async (it) => {
            await it.step('work', () => {
                runs++;
                return it.index;
            });
        });
        await ctx.step('after', () => {
            if (boom) throw new Error('boom');
            return 'done';
        });
        return 'ok';
    });
    const id = createRun(db, 'loophost');
    expect(await executeRun(db, id)).toBe('failed'); // the loop closure runs, then `after` throws
    expect(runs).toBe(1); // until:()=>true breaks after the first iteration
    expect(stepNames(id)).toEqual(['loop#0:0:work']); // per-iteration `loop#L:i:name` key, unchanged

    boom = false;
    retryRun(db, id);
    expect(await executeRun(db, id)).toBe('completed');
    expect(runs).toBe(1); // the memoized loop closure replayed — did NOT re-run
    expect(stepNames(id)).toEqual(['loop#0:0:work', 'after#0']);
});

test('retryRun --from matches step names exactly (no substring over-delete)', async () => {
    const ran: string[] = [];
    defineWorkflow('t', async (ctx) => {
        await ctx.step('redeploy-check', () => {
            ran.push('redeploy-check');
            return 1;
        });
        await ctx.step('deploy', () => {
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

// ---- containerStep (rung-2 docker) ----

test('ctx.step / it.step reject a spec argument, pointing at ctx.containerStep', async () => {
    // The polarity flip: ctx.step is closures-only. A spec (an object, not a function) is
    // ctx.containerStep's job now, so the dispatch throws for it — a runtime guard, over the type ban,
    // for an untyped-JS caller. The message names containerStep.
    defineWorkflow('specreject', async (ctx) => ctx.step('run', { image: 'alpine' } as unknown as () => unknown));
    const top = createRun(db, 'specreject');
    expect(await executeRun(db, top)).toBe('failed');
    const topErr = JSON.parse((db.query(`SELECT error FROM runs WHERE id = ?`).get(top) as { error: string }).error);
    expect(topErr.message).toMatch(/containerStep/);

    // Same guard on the loop-scoped it.step.
    defineWorkflow('loopreject', async (ctx) =>
        ctx.loop({ max: 1 }, (it) => it.step('run', { image: 'alpine' } as unknown as () => unknown)),
    );
    const loop = createRun(db, 'loopreject');
    expect(await executeRun(db, loop)).toBe('failed');
    const loopErr = JSON.parse((db.query(`SELECT error FROM runs WHERE id = ?`).get(loop) as { error: string }).error);
    expect(loopErr.message).toMatch(/containerStep/);
});

test('containerStep: network:true without the network capability fails before touching docker', async () => {
    // The capability gate is the FIRST thing dispatch does, ahead of image resolution — so an
    // undeclared `network` fails loudly without a daemon in reach (this test needs no docker).
    defineWorkflow('needsnet', {}, (ctx) => ctx.containerStep('go', { image: 'alpine', network: true }));
    const id = createRun(db, 'needsnet');
    expect(await executeRun(db, id)).toBe('failed');
    const err = JSON.parse((db.query(`SELECT error FROM runs WHERE id = ?`).get(id) as { error: string }).error);
    expect(err.message).toMatch(/network/);
    // Gate precedes image resolution, and a failed step isn't memoized — so nothing was recorded.
    const n = db.query(`SELECT COUNT(*) AS n FROM steps WHERE run_id = ?`).get(id) as { n: number };
    expect(n.n).toBe(0);
});

test('containerStep: a completed memo replays top-level and per-iteration with no docker', async () => {
    // Seed each container step as a completed memo, then run: dispatch fast-forwards past all three
    // seqs, so resolveImageDigest/docker are never reached. Proves replay, per-iteration namespacing,
    // and that the image_digest + artifacts columns round-trip through the memo.
    defineWorkflow('replay', async (ctx) => {
        const built = await ctx.containerStep('build', { image: 'alpine:3.20', outputs: ['out.txt'] });
        const last = await ctx.loop({ max: 2 }, (it) => it.containerStep('shard', { image: 'busybox' }));
        return { built, last };
    });
    const id = createRun(db, 'replay');
    const digest = `sha256:${'a'.repeat(64)}`;
    // A step declaring outputs stored { result, artifacts } as its memo value; the plain ones stored a
    // bare result. The artifacts column mirrors the map independently.
    seedContainerMemo(id, 0, 'build#0', 'build', { result: { ok: true }, artifacts: { 'out.txt': 'beef' } }, digest, {
        'out.txt': 'beef',
    });
    seedContainerMemo(id, 1, 'loop#0:0:shard', 'shard', 0, digest);
    seedContainerMemo(id, 2, 'loop#0:1:shard', 'shard', 1, digest);

    expect(await executeRun(db, id)).toBe('completed');

    const rows = db
        .query(`SELECT key, kind, image_digest, artifacts FROM steps WHERE run_id = ? ORDER BY seq`)
        .all(id) as { key: string; kind: string; image_digest: string | null; artifacts: string | null }[];
    // Per-iteration namespacing preserved on replay — a mismatched key would raise a DeterminismError.
    expect(rows.map((r) => r.key)).toEqual(['build#0', 'loop#0:0:shard', 'loop#0:1:shard']);
    expect(rows.every((r) => r.kind === 'container')).toBe(true);
    expect(rows.every((r) => r.image_digest === digest)).toBe(true);
    expect(JSON.parse(rows[0]?.artifacts ?? 'null')).toEqual({ 'out.txt': 'beef' });

    const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
    expect(JSON.parse(run.result)).toEqual({
        built: { result: { ok: true }, artifacts: { 'out.txt': 'beef' } },
        last: 1,
    });
});

test('containerStep: routes through the retry/attempt machinery identically top-level and loop-scoped (no docker)', async () => {
    // With no daemon reachable, resolveImageDigest rejects inside the attempt thunk — the kind of
    // transient failure retries exist for — so the shared wrapper's retry loop drives real attempts with
    // no container. Before this slice the container path bypassed runStepBody: it recorded zero
    // step_attempts and never retried, so this asserts the newly-shared machinery on both keying paths.
    const retries = { max: 2, backoff: { type: 'fixed' as const, base: 1 } };
    defineWorkflow('ctop', {}, (ctx) => ctx.containerStep('go', { image: 'alpine' }, { retries }));
    defineWorkflow('cloop', {}, (ctx) =>
        ctx.loop({ max: 1 }, (it) => it.containerStep('go', { image: 'alpine' }, { retries })),
    );

    const attemptsOf = async (wf: string) => {
        const id = createRun(db, wf);
        expect(await executeRun(db, id)).toBe('failed');
        // A failed step is never memoized — the retries left no `steps` row on either path.
        expect((db.query(`SELECT COUNT(*) AS n FROM steps WHERE run_id = ?`).get(id) as { n: number }).n).toBe(0);
        return db.query(`SELECT attempt, status FROM step_attempts WHERE run_id = ? ORDER BY attempt`).all(id) as {
            attempt: number;
            status: string;
        }[];
    };

    const top = await attemptsOf('ctop');
    expect(top.map((a) => a.attempt)).toEqual([0, 1, 2]); // retries.max=2 → 3 attempts, all recorded
    expect(top.every((a) => a.status === 'failed')).toBe(true);
    expect(await attemptsOf('cloop')).toEqual(top); // loop-scoped container step records attempts identically
});

test('containerStep: acquires its declared pool through the shared wrapper (no docker)', async () => {
    // The pool is acquired in the attempt wrapper before the thunk runs, so a step that then fails (no
    // daemon) still proves the container path now flows through pool acquisition — it did not before.
    const acquired: string[] = [];
    let released = 0;
    const deps: RunDeps = {
        acquire: async (pool) => {
            acquired.push(pool);
            return () => {
                released++;
            };
        },
    };
    defineWorkflow('cpool', {}, (ctx) => ctx.containerStep('go', { image: 'alpine' }, { pool: 'ci' }));
    const id = createRun(db, 'cpool');
    expect(await executeRun(db, id, deps)).toBe('failed');
    expect(acquired).toEqual(['ci']); // acquired once (no retries) via runStepBody's wrapper
    expect(released).toBe(1); // and released in the wrapper's finally
});

/** A hand-rolled Standard Schema v1 validator — the structural `~standard` interface zod/valibot/arktype
 *  all expose, so weir needs no library to validate against one. */
function schema<Output>(
    validate: StandardSchemaV1<unknown, Output>['~standard']['validate'],
): StandardSchemaV1<unknown, Output> {
    return { '~standard': { version: 1, vendor: 'test', validate } };
}

// Compile-time proof (#64) that a `schema` on the spec narrows containerStep's return type — never
// invoked, checked by `bun run typecheck`. Each local is typed `number`, which compiles only if the
// step's result was narrowed to the schema's `{ count: number }` output rather than left `unknown`.
async function _schemaNarrowsReturnType(ctx: Ctx, s: StandardSchemaV1<unknown, { count: number }>) {
    const bare: number = (await ctx.containerStep('bare', { image: 'x', schema: s })).count;
    const withOutputs: number = (await ctx.containerStep('out', { image: 'x', outputs: ['o'], schema: s })).result
        .count;
    const looped: number = (await ctx.loop({ max: 1 }, (it) => it.containerStep('l', { image: 'x', schema: s }))).count;
    return { bare, withOutputs, looped };
}
void _schemaNarrowsReturnType;

// ---- containerStep: spec-declared env & mounts (#88), docker-free via a fake runtime ----

/** A stand-in container runtime that needs no docker daemon: its `image inspect` branch emits a
 *  RepoDigests array so the step pins, and its `run` branch records the argv it was invoked with (each
 *  as an `ARGV\t…` line) plus the values of the forwarded `$FOO` and `$PATH` env — proving what reached
 *  the CLI's own environment rather than only the argv — then emits a C1 output frame so the step
 *  completes. The capture path is baked into the script because runProcess replaces the child's env,
 *  leaving no channel to pass it in. */
async function fakeRuntime(dir: string, capture: string): Promise<string> {
    const bin = join(dir, 'fake-runtime');
    const digest = `sha256:${'a'.repeat(64)}`;
    await writeFile(
        bin,
        `#!/bin/sh
if [ "$1" = image ]; then echo '["repo@${digest}"]'; exit 0; fi
{ printf 'ARGV\\t%s\\n' "$@"; printf 'ENV_FOO\\t%s\\n' "$FOO"; printf 'ENV_PATH\\t%s\\n' "$PATH"; } > '${capture}'
printf '%s' '{"ok":true,"result":{"ran":true}}'
`,
    );
    await chmod(bin, 0o755);
    return bin;
}

test('containerStep: forwards spec-declared env and mounts into the container run (no docker)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weir-runtime-'));
    tmpDirs.push(dir);
    const capture = join(dir, 'capture.txt');
    const deps: RunDeps = { ...(await containerDeps()), containerRuntime: await fakeRuntime(dir, capture) };

    defineWorkflow('envmounts', {}, (ctx) =>
        ctx.containerStep('go', {
            image: 'repo:tag',
            env: { FOO: 'bar-value' },
            mounts: [{ host: '/host/data', container: '/data', readonly: true }],
        }),
    );
    const id = createRun(db, 'envmounts');
    expect(await executeRun(db, id, deps)).toBe('completed');

    const lines = (await readFile(capture, 'utf8')).split('\n').filter(Boolean);
    const argv = lines.filter((l) => l.startsWith('ARGV\t')).map((l) => l.slice('ARGV\t'.length));
    const envFoo = lines.find((l) => l.startsWith('ENV_FOO\t'))?.slice('ENV_FOO\t'.length);

    // The declared mount rides (after the weir scratch mount) as its own `-v host:container:ro` pair.
    const mi = argv.indexOf('/host/data:/data:ro');
    expect(mi).toBeGreaterThan(-1);
    expect(argv[mi - 1]).toBe('-v');
    // The declared env is forwarded by name (`-e FOO`), never as a `FOO=value` argv element…
    expect(argv[argv.indexOf('FOO') - 1]).toBe('-e');
    expect(argv.some((a) => a.includes('bar-value'))).toBe(false);
    // …and its value reaches the runtime CLI's own environment, so the name-only flag resolves.
    expect(envFoo).toBe('bar-value');
});

test('containerStep: spec-declared env cannot override the capability/baseline env (PATH)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weir-runtime-'));
    tmpDirs.push(dir);
    const capture = join(dir, 'capture.txt');
    const deps: RunDeps = { ...(await containerDeps()), containerRuntime: await fakeRuntime(dir, capture) };

    // A step that tries to set PATH must not win: that env is also the daemon's own for the runtime CLI,
    // so an override would repoint the daemon's bare-name spawn of the container runtime to an
    // attacker-planted binary. resolveExecEnv's PATH (the daemon's) stays authoritative.
    defineWorkflow('envclash', {}, (ctx) =>
        ctx.containerStep('go', { image: 'repo:tag', env: { PATH: '/attacker/dir' } }),
    );
    const id = createRun(db, 'envclash');
    expect(await executeRun(db, id, deps)).toBe('completed');

    const envPath = (await readFile(capture, 'utf8'))
        .split('\n')
        .find((l) => l.startsWith('ENV_PATH\t'))
        ?.slice('ENV_PATH\t'.length);
    expect(envPath).not.toBe('/attacker/dir');
    expect(envPath).toBe(process.env.PATH);
});

// ---- real-docker (gated: skipped when the daemon is absent, so CI stays green) ----

const HAS_DOCKER = Bun.which('docker') !== null;
const dockerTest = HAS_DOCKER ? test : test.skip;

dockerTest(
    'containerStep: runs a pinned container, records its digest, needs no capability',
    async () => {
        // A local image with a repo digest to pin against (inspect never pulls). Skip if the pull can't run
        // (offline) — the point here is dispatch + pinning, not the network.
        try {
            await $`docker pull busybox:latest`.quiet();
        } catch {
            return;
        }
        const deps = await containerDeps();
        // A shell one-liner that speaks the C1 protocol: emit one output frame on stdout (the step needs
        // no input, and runProcess tolerates a child that exits before draining stdin). Absolute
        // `/bin/sh` + the `printf` builtin, since dispatch forwards the host PATH into the container as
        // `-e PATH`. No capability is declared and the default is --network none, so this doubles as
        // proof a sandboxed step needs no capability at all.
        const cmd = ['/bin/sh', '-c', 'printf %s \'{"ok":true,"result":{"from":"container"}}\''];
        defineWorkflow('run', {}, (ctx) => ctx.containerStep('go', { image: 'busybox:latest', cmd }));
        const id = createRun(db, 'run');
        expect(await executeRun(db, id, deps)).toBe('completed');

        const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
        expect(JSON.parse(run.result)).toEqual({ from: 'container' });

        // The engine wrote the resolved content digest into the memo — the step's replay identity.
        const step = db.query(`SELECT kind, image_digest FROM steps WHERE run_id = ?`).get(id) as {
            kind: string;
            image_digest: string | null;
        };
        expect(step.kind).toBe('container');
        expect(step.image_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    },
    60_000,
);

dockerTest(
    'containerStep: an unpinnable image fails the step loudly (no host fallback)',
    async () => {
        // No local repo digest to read → resolveImageDigest rejects → the step fails; nothing lets it
        // silently fall back to a host process.
        defineWorkflow('bad', {}, (ctx) => ctx.containerStep('go', { image: 'weir-does-not-exist:none-xyz-000' }));
        const id = createRun(db, 'bad');
        expect(await executeRun(db, id)).toBe('failed');
        // A failed step isn't memoized.
        const n = db.query(`SELECT COUNT(*) AS n FROM steps WHERE run_id = ?`).get(id) as { n: number };
        expect(n.n).toBe(0);
    },
    30_000,
);

dockerTest(
    'containerStep: declared outputs are content-addressed into the store and recorded in the memo',
    async () => {
        // The success store-commit path for the docker runtime, end-to-end through the engine: the
        // container writes a declared output into its /weir scratch and emits a C1 frame; the engine
        // snapshots that output into the store and records the path -> hash map in the memo.
        try {
            await $`docker pull busybox:latest`.quiet();
        } catch {
            return;
        }
        const deps = await containerDeps();
        const cmd = [
            '/bin/sh',
            '-c',
            'printf hello-artifact > /weir/out.txt; printf %s \'{"ok":true,"result":{"wrote":"out.txt"}}\'',
        ];
        defineWorkflow('produce', {}, (ctx) =>
            ctx.containerStep('make', { image: 'busybox:latest', cmd, outputs: ['out.txt'] }),
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
    },
    60_000,
);

dockerTest(
    'containerStep: a failing step declaring outputs orphans no artifacts',
    async () => {
        // Outputs are planned (hashed) but committed only after extraction succeeds, so a non-zero exit
        // with no frame fails the decode before the store is ever touched — the docker-runtime analogue of
        // the exec path's deferred-commit guarantee. The output is written but the run rejects, so nothing
        // is committed.
        try {
            await $`docker pull busybox:latest`.quiet();
        } catch {
            return;
        }
        const deps = await containerDeps();
        const cmd = ['/bin/sh', '-c', 'printf wrote-but-rejected > /weir/out.txt; exit 1'];
        defineWorkflow('reject', {}, (ctx) =>
            ctx.containerStep('make', { image: 'busybox:latest', cmd, outputs: ['out.txt'] }),
        );
        const id = createRun(db, 'reject');
        expect(await executeRun(db, id, deps)).toBe('failed');
        // A failed step isn't memoized, and its declared output was never committed to the store.
        const steps = db.query(`SELECT COUNT(*) AS n FROM steps WHERE run_id = ?`).get(id) as { n: number };
        expect(steps.n).toBe(0);
        const artifacts = db.query(`SELECT COUNT(*) AS n FROM artifacts`).get() as { n: number };
        expect(artifacts.n).toBe(0);
    },
    60_000,
);

dockerTest(
    'containerStep: a daemon secret reaches the container env only under the matching capability',
    async () => {
        // The docker-runtime analogue of the deleted subprocess env tests. Dispatch resolves the
        // capability-scoped env (resolveExecEnv, #C7) and forwards it by name (`-e NAME`), so a
        // daemon-held secret enters the container only when a declared capability authorizes its var.
        // The two halves are unit-tested (capabilities.test.ts gates the vars; runtime.test.ts forwards
        // them by name only) — this proves the composition end-to-end, inside a real container.
        try {
            await $`docker pull busybox:latest`.quiet();
        } catch {
            return;
        }
        // The container reports its own view of two daemon-planted vars: GH_TOKEN (which gh-pr names) and
        // WEIR_ENV_SNOOP (which no capability names). An unforwarded var expands to the empty string.
        const probe = [
            '/bin/sh',
            '-c',
            'printf \'{"ok":true,"result":{"GH_TOKEN":"%s","SNOOP":"%s"}}\' "$GH_TOKEN" "$WEIR_ENV_SNOOP"',
        ];
        await withDaemonSecrets(async () => {
            // No credential capability: the container sees neither the gh token nor the arbitrary daemon var.
            defineWorkflow('nocap', {}, (ctx) => ctx.containerStep('probe', { image: 'busybox:latest', cmd: probe }));
            const bare = createRun(db, 'nocap');
            expect(await executeRun(db, bare, await containerDeps())).toBe('completed');
            const bareRun = db.query(`SELECT result FROM runs WHERE id = ?`).get(bare) as { result: string };
            expect(JSON.parse(bareRun.result)).toEqual({ GH_TOKEN: '', SNOOP: '' });

            // gh-pr authorizes GH_TOKEN (only); the unnamed WEIR_ENV_SNOOP still never rides along.
            defineWorkflow('ghpr', { capabilities: ['gh-pr'] }, (ctx) =>
                ctx.containerStep('probe', { image: 'busybox:latest', cmd: probe }),
            );
            const scoped = createRun(db, 'ghpr');
            expect(await executeRun(db, scoped, await containerDeps())).toBe('completed');
            const scopedRun = db.query(`SELECT result FROM runs WHERE id = ?`).get(scoped) as { result: string };
            expect(JSON.parse(scopedRun.result)).toEqual({ GH_TOKEN: 'gh-secret-xyz', SNOOP: '' });
        });
    },
    90_000,
);

dockerTest(
    'containerStep: repeat re-runs the container per iteration, each recorded as an attempt',
    async () => {
        // The success-path proof that a container step honors `repeat`: a fresh container runs per
        // iteration (a host-side `while` counter caps it), and each run lands its own step_attempts row.
        try {
            await $`docker pull busybox:latest`.quiet();
        } catch {
            return;
        }
        const deps = await containerDeps();
        let runs = 0;
        const cmd = ['/bin/sh', '-c', 'printf %s \'{"ok":true,"result":42}\''];
        defineWorkflow('crepeat', {}, (ctx) =>
            ctx.containerStep('go', { image: 'busybox:latest', cmd }, { repeat: { max: 5, while: () => ++runs < 3 } }),
        );
        const id = createRun(db, 'crepeat');
        expect(await executeRun(db, id, deps)).toBe('completed');
        expect(runs).toBe(3); // `while` stops the repeat once the host counter reaches 3

        const attempts = db.query(`SELECT status FROM step_attempts WHERE run_id = ?`).all(id) as { status: string }[];
        expect(attempts.length).toBe(3); // one container run — one attempt — per repeat iteration
        expect(attempts.every((a) => a.status === 'succeeded')).toBe(true);
        const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
        expect(JSON.parse(run.result)).toBe(42); // the last iteration's result is what memoizes
    },
    60_000,
);

dockerTest(
    'containerStep: a declared schema validates the boundary result — passes clean, fails with issue text',
    async () => {
        // End-to-end through a real container: the module emits a C1 frame, the default decoder returns
        // its result, and the spec's `schema` is asserted on that value at the extract boundary. A passing
        // value flows through; a failing one rejects the step with the validator's issue and commits nothing.
        try {
            await $`docker pull busybox:latest`.quiet();
        } catch {
            return;
        }
        const positiveN = schema<{ n: number }>((v) => {
            const n = (v as { n?: unknown } | null)?.n;
            return typeof n === 'number' && n > 0
                ? { value: { n } }
                : { issues: [{ message: 'must be positive', path: ['n'] }] };
        });
        const frame = (n: number) => ['/bin/sh', '-c', `printf %s '{"ok":true,"result":{"n":${n}}}'`];

        defineWorkflow('okschema', {}, (ctx) =>
            ctx.containerStep('go', { image: 'busybox:latest', cmd: frame(3), schema: positiveN }),
        );
        const ok = createRun(db, 'okschema');
        expect(await executeRun(db, ok, await containerDeps())).toBe('completed');
        const okRun = db.query(`SELECT result FROM runs WHERE id = ?`).get(ok) as { result: string };
        expect(JSON.parse(okRun.result)).toEqual({ n: 3 });

        defineWorkflow('badschema', {}, (ctx) =>
            ctx.containerStep('go', { image: 'busybox:latest', cmd: frame(-1), schema: positiveN }),
        );
        const bad = createRun(db, 'badschema');
        expect(await executeRun(db, bad, await containerDeps())).toBe('failed');
        const err = JSON.parse((db.query(`SELECT error FROM runs WHERE id = ?`).get(bad) as { error: string }).error);
        expect(err.message).toContain('schema validation failed');
        expect(err.message).toContain('n: must be positive'); // path-qualified, actionable
        // A schema failure isn't memoized — the step re-runs on retry like any other failure.
        expect((db.query(`SELECT COUNT(*) AS n FROM steps WHERE run_id = ?`).get(bad) as { n: number }).n).toBe(0);
    },
    60_000,
);

dockerTest(
    'containerStep: a spec-declared env var and bind mount reach a real container',
    async () => {
        // End-to-end proof of the #88 additive bridge: an author-declared `env` and `mounts` on the spec
        // reach a real container run alongside the capability path. The container reports its view of the
        // declared var and reads a file from the declared read-only mount.
        try {
            await $`docker pull busybox:latest`.quiet();
        } catch {
            return;
        }
        const host = await mkdtemp(join(tmpdir(), 'weir-mount-'));
        tmpDirs.push(host);
        await writeFile(join(host, 'note.txt'), 'mounted-bytes');
        // Absolute `/bin/sh` + `/bin/cat`, since dispatch forwards the host PATH into the container as
        // `-e PATH` — a bare `cat` wouldn't resolve to busybox's applet (see the daemon-secret test).
        const cmd = [
            '/bin/sh',
            '-c',
            'printf \'{"ok":true,"result":{"env":"%s","file":"%s"}}\' "$FOO" "$(/bin/cat /mnt/note.txt)"',
        ];
        defineWorkflow('em', {}, (ctx) =>
            ctx.containerStep('go', {
                image: 'busybox:latest',
                cmd,
                env: { FOO: 'explicit-value' },
                // `relabel: 'shared'` keeps the read under an enforcing SELinux policy (a no-op when off).
                mounts: [{ host, container: '/mnt', readonly: true, relabel: 'shared' }],
            }),
        );
        const id = createRun(db, 'em');
        expect(await executeRun(db, id, await containerDeps())).toBe('completed');
        const run = db.query(`SELECT result FROM runs WHERE id = ?`).get(id) as { result: string };
        expect(JSON.parse(run.result)).toEqual({ env: 'explicit-value', file: 'mounted-bytes' });
    },
    90_000,
);
