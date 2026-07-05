import { expect, test, beforeEach } from 'bun:test';
import { openDb, type DB } from './db.ts';
import { clearRegistry, defineWorkflow, executeRun } from './engine.ts';
import { approveRun, createRun, retryRun } from './runs.ts';

let db: DB;
beforeEach(() => {
    db = openDb(':memory:');
    clearRegistry();
});

const stepNames = (runId: string) =>
    (db.query(`SELECT key FROM steps WHERE run_id = ? ORDER BY seq`).all(runId) as { key: string }[]).map((r) => r.key);

test('retry-from-failure: completed steps do not re-run; execution resumes at the failure', async () => {
    const ran: string[] = [];
    let failReview = true;
    defineWorkflow('t', {}, async (ctx) => {
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
    defineWorkflow('t', {}, async (ctx) => {
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
    defineWorkflow('t', {}, async (ctx) => {
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
    defineWorkflow('t', {}, async (ctx) => {
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
    defineWorkflow('t', {}, async (ctx) => {
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
    defineWorkflow('t', {}, async (ctx) => {
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
    defineWorkflow('t', {}, async (ctx) => {
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
    expect(stepNames(id)).toEqual(['a#0']); // host step memoized like any 'step'

    ran.length = 0;
    boom = false;
    retryRun(db, id);
    expect(await executeRun(db, id)).toBe('completed');
    expect(ran).toEqual(['b']); // memoized host step replays, does not re-run
    expect(stepNames(id)).toEqual(['a#0', 'b#0']);
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

test('retryRun --from matches step names exactly (no substring over-delete)', async () => {
    const ran: string[] = [];
    defineWorkflow('t', {}, async (ctx) => {
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
