import { expect, test } from 'bun:test';
import { runIsolated } from './isolate.ts';

test('normal custom JS computes and returns a JSON result', async () => {
    const r = await runIsolated('export default (i) => ({ doubled: i.x * 2 })', { x: 21 }, { timeoutMs: 10_000 });
    expect(r).toEqual({ doubled: 42 });
});

test('async custom JS is awaited', async () => {
    const code = 'export default async (i) => { await new Promise(r=>setTimeout(r,10)); return i + 1; }';
    expect(await runIsolated(code, 41, { timeoutMs: 10_000 })).toBe(42);
});

test('infinite loop is killed by the timeout (daemon survives)', async () => {
    const start = Date.now();
    await expect(runIsolated('export default () => { while (true) {} }', null, { timeoutMs: 1000 })).rejects.toThrow(
        /timed out/,
    );
    expect(Date.now() - start).toBeLessThan(6000);
    // main process is obviously still running to make this assertion:
    expect(1 + 1).toBe(2);
});

test('runaway allocation is killed by the RSS memory cap', async () => {
    const code = 'export default () => { const a=[]; while(true){ a.push(new Array(1e6).fill(7)); } }';
    await expect(runIsolated(code, null, { memoryMb: 128, timeoutMs: 20_000, pollMs: 100 })).rejects.toThrow(
        /exceeded 128MB/,
    );
}, 25_000);

test('a throw inside custom JS becomes a clean step error', async () => {
    await expect(
        runIsolated('export default () => { throw new Error("nope") }', null, { timeoutMs: 10_000 }),
    ).rejects.toThrow(/isolated step failed: nope/);
});

test('non-function default is rejected clearly', async () => {
    await expect(runIsolated('export default 42', null, { timeoutMs: 10_000 })).rejects.toThrow(
        /must .export default. a function/,
    );
});
