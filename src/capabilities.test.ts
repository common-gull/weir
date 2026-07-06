import { expect, test, beforeEach } from 'bun:test';
import { openDb, type DB } from './db.ts';
import { clearRegistry, defineWorkflow, executeRun } from './engine.ts';
import { createRun } from './runs.ts';
import {
    hasCapability,
    knownCapabilities,
    requireCapability,
    resolveExecEnv,
    withCapabilities,
} from './capabilities.ts';

// A synthetic daemon env: a secret a capability names (GH_TOKEN) plus one nothing names (WEIR_SNOOP).
const daemonEnv = { PATH: '/usr/bin', GH_TOKEN: 'gh-secret', WEIR_SNOOP: 'daemon-only' };
const resolveWith = (caps: string[]) =>
    withCapabilities({ workflow: 'w', caps: new Set(caps) }, () => resolveExecEnv(daemonEnv));

let db: DB;
beforeEach(() => {
    db = openDb(':memory:');
    clearRegistry();
});

test('outward action denied when the workflow lacks the capability', async () => {
    defineWorkflow('nogrant', {}, async (ctx) => {
        await ctx.step('push', () => {
            requireCapability('git-push');
            return 1;
        });
        return 'ok';
    });
    const id = createRun(db, 'nogrant');
    expect(await executeRun(db, id)).toBe('failed');
    const run = db.query(`SELECT error FROM runs WHERE id = ?`).get(id) as { error: string };
    expect(run.error).toContain('git-push');
});

test('outward action allowed when the workflow declares the capability', async () => {
    let allowed = false;
    defineWorkflow('grant', { capabilities: ['git-push'] }, async (ctx) => {
        await ctx.step('push', () => {
            requireCapability('git-push');
            allowed = hasCapability('git-push');
            return 1;
        });
        return 'ok';
    });
    const id = createRun(db, 'grant');
    expect(await executeRun(db, id)).toBe('completed');
    expect(allowed).toBe(true);
});

test('host-exec is a discoverable built-in capability', () => {
    expect(knownCapabilities().has('host-exec')).toBe(true);
});

test('resolveExecEnv withholds daemon secrets from a step declaring no credential capability', () => {
    // host-exec authorizes spawning host code, not inheriting credentials — so its env is baseline-only.
    const env = resolveWith(['host-exec']);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.WEIR_SNOOP).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin'); // the operational baseline still passes through
});

test('resolveExecEnv forwards only the credential vars a declared capability names', () => {
    const env = resolveWith(['host-exec', 'gh-pr']);
    expect(env.GH_TOKEN).toBe('gh-secret'); // gh-pr authorizes GH_TOKEN…
    expect(env.WEIR_SNOOP).toBeUndefined(); // …but nothing else the daemon holds
    expect(env.PATH).toBe('/usr/bin');
});

test('resolveExecEnv skips a capability whose named vars are absent from the daemon env', () => {
    // SSH_AUTH_SOCK isn't in the source, so git-push adds no empty/undefined entry for it.
    const env = withCapabilities({ workflow: 'w', caps: new Set(['git-push']) }, () =>
        resolveExecEnv({ PATH: '/usr/bin', GH_TOKEN: 'gh-secret' }),
    );
    expect('SSH_AUTH_SOCK' in env).toBe(false);
    expect(env.GH_TOKEN).toBe('gh-secret');
});
