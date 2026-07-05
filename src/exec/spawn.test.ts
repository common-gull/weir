import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { LogFrame } from './protocol.ts';
import { runProtocol } from './spawn.ts';

const SHIM = fileURLToPath(new URL('./testdata/echo-shim.ts', import.meta.url));
const argv = ['bun', SHIM];

test('marshals input to an output envelope over the C1 protocol', async () => {
    const out = await runProtocol({ argv, input: { x: 21, tags: ['a', 'b'] }, timeoutMs: 10_000 });
    expect(out).toEqual({ ok: true, result: { x: 21, tags: ['a', 'b'] } });
});

test('undefined input round-trips as a null result', async () => {
    const out = await runProtocol({ argv, input: undefined, timeoutMs: 10_000 });
    expect(out).toEqual({ ok: true, result: null });
});

test('streams structured stderr log frames to onLog', async () => {
    const logs: LogFrame[] = [];
    const out = await runProtocol({
        argv,
        input: { mode: 'logs' },
        timeoutMs: 10_000,
        onLog: (f) => logs.push(f),
    });
    expect(out.ok).toBe(true);
    expect(logs).toEqual([
        { level: 'debug', message: 'debug from shim' },
        { level: 'info', message: 'info from shim' },
        { level: 'warn', message: 'warn from shim' },
        { level: 'error', message: 'error from shim' },
    ]);
});

test('raw stderr diagnostics surface as info frames rather than being dropped', async () => {
    const logs: LogFrame[] = [];
    await runProtocol({ argv, input: { mode: 'raw' }, timeoutMs: 10_000, onLog: (f) => logs.push(f) });
    expect(logs).toEqual([{ level: 'info', message: 'raw diagnostic, not a protocol frame' }]);
});

test('a huge newline-less stderr line is flushed in bounded chunks, not accumulated whole', async () => {
    const logs: LogFrame[] = [];
    const out = await runProtocol({
        argv,
        input: { mode: 'stderr-bigline' },
        timeoutMs: 10_000,
        maxStderrLineBytes: 16 * 1024,
        onLog: (f) => logs.push(f),
    });
    expect(out).toEqual({ ok: true, result: 'done' });
    // Arrives as several flushed frames, so the parent's buffer never held the whole line, and
    // nothing is dropped: the pieces reconstruct the original.
    expect(logs.length).toBeGreaterThan(1);
    expect(logs.map((f) => f.message).join('')).toBe('e'.repeat(8 * 32 * 1024));
});

test('a failed output frame is returned, not thrown', async () => {
    const out = await runProtocol({ argv, input: { mode: 'fail', message: 'boom' }, timeoutMs: 10_000 });
    expect(out).toEqual({ ok: false, error: 'boom' });
});

test('a runaway child is SIGKILLed on the timeout and the daemon survives', async () => {
    const start = Date.now();
    await expect(runProtocol({ argv, input: { mode: 'hang' }, timeoutMs: 500 })).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(1 + 1).toBe(2); // this process is plainly still alive to make the assertion
});

test('a child that floods stdout is SIGKILLed by the output-size cap', async () => {
    const start = Date.now();
    await expect(
        runProtocol({ argv, input: { mode: 'flood' }, maxOutputBytes: 256 * 1024, timeoutMs: 10_000 }),
    ).rejects.toThrow(/more than 262144 bytes of output/);
    expect(Date.now() - start).toBeLessThan(5000);
});

test('an abort signal kills the child and rejects with its reason', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('cancelled by caller')), 150);
    await expect(runProtocol({ argv, input: { mode: 'hang' }, timeoutMs: 10_000, signal: ac.signal })).rejects.toThrow(
        /cancelled by caller/,
    );
});

test('an already-aborted signal rejects before spawning', async () => {
    await expect(
        runProtocol({ argv, input: null, signal: AbortSignal.abort(new Error('pre-aborted')) }),
    ).rejects.toThrow(/pre-aborted/);
});

test('a child that exits without an output frame is a runner error', async () => {
    await expect(runProtocol({ argv, input: { mode: 'crash' }, timeoutMs: 10_000 })).rejects.toThrow(
        /without an output frame/,
    );
});

test('an empty argv is rejected before spawning', async () => {
    await expect(runProtocol({ argv: [], input: null })).rejects.toThrow(/non-empty argv/);
});

test('input JSON a frame can not carry is rejected before spawning', async () => {
    await expect(runProtocol({ argv, input: { cb: () => {} }, timeoutMs: 10_000 })).rejects.toThrow(/function/);
});

test('a runaway allocation is SIGKILLed by the RSS memory cap', async () => {
    await expect(
        runProtocol({ argv, input: { mode: 'oom' }, memoryMb: 128, pollMs: 100, timeoutMs: 20_000 }),
    ).rejects.toThrow(/exceeded 128MB/);
}, 25_000);
