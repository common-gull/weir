import { expect, test, beforeEach } from 'bun:test';
import { openDb, pruneHistory, assertSerializable, type DB } from './db.ts';
import { clearRegistry, defineWorkflow, executeRun } from './engine.ts';
import { createRun } from './runs.ts';

let db: DB;
beforeEach(() => {
    db = openDb(':memory:');
    clearRegistry();
});

test('pruneHistory removes terminal runs older than the window and keeps recent ones', async () => {
    defineWorkflow('t', {}, async (ctx) => {
        await ctx.step('s', () => 1);
        return 'ok';
    });

    const oldId = createRun(db, 't');
    await executeRun(db, oldId);
    // backdate the old run to 30 days ago
    const longAgo = Date.now() - 30 * 86_400_000;
    db.query(`UPDATE runs SET finished_at = ? WHERE id = ?`).run(longAgo, oldId);

    const recentId = createRun(db, 't');
    await executeRun(db, recentId);

    const res = pruneHistory(db, { days: 14 });
    expect(res.runs).toBe(1);

    expect(db.query(`SELECT COUNT(*) AS c FROM runs WHERE id = ?`).get(oldId)).toEqual({ c: 0 });
    expect(db.query(`SELECT COUNT(*) AS c FROM steps WHERE run_id = ?`).get(oldId)).toEqual({ c: 0 });
    expect(db.query(`SELECT COUNT(*) AS c FROM events WHERE run_id = ?`).get(oldId)).toEqual({ c: 0 });
    // recent run untouched
    expect(db.query(`SELECT COUNT(*) AS c FROM runs WHERE id = ?`).get(recentId)).toEqual({ c: 1 });
});

test('assertSerializable rejects values JSON would silently drop, and passes plain data', () => {
    expect(() => assertSerializable({ cb: () => {} }, 's')).toThrow(/function/);
    expect(() => assertSerializable({ a: undefined }, 's')).toThrow(/undefined value/);
    expect(() => assertSerializable(new Map([['a', 1]]), 's')).toThrow(/Map/);
    expect(() => assertSerializable({ n: new Set([1]) }, 's')).toThrow(/Set/);
    expect(() => assertSerializable({ n: 1n }, 's')).toThrow(/bigint/);
    // NaN/Infinity are numbers JSON.stringify silently turns into null — must be rejected, not passed
    expect(() => assertSerializable(NaN, 's')).toThrow(/non-finite/);
    expect(() => assertSerializable({ r: Infinity }, 's')).toThrow(/non-finite/);
    expect(() => assertSerializable([-Infinity], 's')).toThrow(/non-finite/);
    // plain JSON (incl. Date → ISO string, nested arrays/objects) passes
    expect(() => assertSerializable({ a: 1, b: [1, 'x', { c: true }], d: new Date(0) }, 's')).not.toThrow();
    expect(() => assertSerializable(undefined, 's')).not.toThrow(); // "no result" is fine
});

test('newest-first run listing is served by ix_runs_created without a temp b-tree sort', () => {
    const plan = db.query(`EXPLAIN QUERY PLAN SELECT id FROM runs ORDER BY created_at DESC LIMIT 50`).all() as {
        detail: string;
    }[];
    const detail = plan.map((r) => r.detail).join('\n');
    expect(detail).toContain('ix_runs_created');
    expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY');
});

test('pruneHistory clears expired kv', () => {
    db.query(`INSERT INTO kv (namespace, key, value, expires_at, updated_at) VALUES ('n','k','1',?,?)`).run(
        Date.now() - 1000,
        Date.now(),
    );
    pruneHistory(db, { days: 14 });
    expect(db.query(`SELECT COUNT(*) AS c FROM kv`).get()).toEqual({ c: 0 });
});
