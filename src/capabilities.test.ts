import { expect, test, beforeEach } from 'bun:test';
import { openDb, type DB } from './db.ts';
import { clearRegistry, defineWorkflow, executeRun } from './engine.ts';
import { createRun } from './runs.ts';
import { requireCapability, hasCapability } from './capabilities.ts';

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
