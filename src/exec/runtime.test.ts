import { expect, test } from 'bun:test';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogFrame } from './protocol.ts';
import { buildArgv, type LocalStepSpec } from './runtime.ts';
import { runProtocol } from './spawn.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./testdata/${name}`, import.meta.url));

// bun is always present; python3 may not be (CI), so its end-to-end tests skip cleanly when absent.
const HAS_PYTHON = Bun.which('python3') !== null;
const pyTest = HAS_PYTHON ? test : test.skip;

test('builds a bun argv for the node runtime', () => {
    const argv = buildArgv({ runtime: 'node', module: '/abs/step.ts' });
    expect(argv[0]).toBe('bun');
    expect(argv[1]?.endsWith('node-shim.ts')).toBe(true);
    expect(argv[2]).toBe('/abs/step.ts');
});

test('builds a python3 argv for the python runtime', () => {
    const argv = buildArgv({ runtime: 'python', module: '/abs/step.py' });
    expect(argv[0]).toBe('python3');
    expect(argv[1]?.endsWith('python-shim.py')).toBe(true);
    expect(argv[2]).toBe('/abs/step.py');
});

test('resolves a relative module path to an absolute one', () => {
    const argv = buildArgv({ runtime: 'node', module: 'steps/resize.ts' });
    expect(isAbsolute(argv[2] ?? '')).toBe(true);
    expect(argv[2]).toBe(resolve('steps/resize.ts'));
});

test('rejects a missing module path', () => {
    expect(() => buildArgv({ runtime: 'node', module: '' })).toThrow(/requires a module path/);
});

test('rejects an unknown runtime (specs can arrive from untyped JSON)', () => {
    const spec = { runtime: 'ruby', module: 'x.rb' } as unknown as LocalStepSpec;
    expect(() => buildArgv(spec)).toThrow(/unknown step runtime/);
});

test('runs a node module end-to-end and routes console output to the log channel', async () => {
    const logs: LogFrame[] = [];
    const out = await runProtocol({
        argv: buildArgv({ runtime: 'node', module: fixture('node-step.ts') }),
        input: { n: 42 },
        timeoutMs: 10_000,
        onLog: (f) => logs.push(f),
    });
    // The result frame is intact, proving the module's console writes never reached stdout.
    expect(out).toEqual({ ok: true, result: { echoed: { n: 42 }, from: 'node' } });
    expect(logs).toContainEqual({ level: 'warn', message: 'heads up' });
    expect(logs.some((f) => f.level === 'info' && f.message.startsWith('processing'))).toBe(true);
}, 15_000);

test('a throwing node module returns a failure frame, not a crash', async () => {
    const out = await runProtocol({
        argv: buildArgv({ runtime: 'node', module: fixture('node-throw.ts') }),
        input: null,
        timeoutMs: 10_000,
    });
    expect(out).toEqual({ ok: false, error: 'boom from node module' });
}, 15_000);

test('a node module without a default export is rejected with a clear error', async () => {
    const out = await runProtocol({
        argv: buildArgv({ runtime: 'node', module: fixture('node-no-default.ts') }),
        input: null,
        timeoutMs: 10_000,
    });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/export default/);
}, 15_000);

test('a node module writing directly to process.stdout keeps the output frame intact', async () => {
    const logs: LogFrame[] = [];
    const out = await runProtocol({
        argv: buildArgv({ runtime: 'node', module: fixture('node-stdout-write.ts') }),
        input: { n: 1 },
        timeoutMs: 10_000,
        onLog: (f) => logs.push(f),
    });
    // A raw process.stdout write did not corrupt the frame — it was rerouted to the log channel.
    expect(out).toEqual({ ok: true, result: { echoed: { n: 1 }, from: 'node-stdout' } });
    expect(logs.some((f) => f.message.includes('raw progress-bar bytes'))).toBe(true);
}, 15_000);

test('a node module calling process.exit() still returns a structured frame', async () => {
    const out = await runProtocol({
        argv: buildArgv({ runtime: 'node', module: fixture('node-exit.ts') }),
        input: null,
        timeoutMs: 10_000,
    });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/exited the process/);
}, 15_000);

pyTest(
    'runs a python module end-to-end and routes print() to the log channel',
    async () => {
        const logs: LogFrame[] = [];
        const out = await runProtocol({
            argv: buildArgv({ runtime: 'python', module: fixture('python-step.py') }),
            input: { n: 7 },
            timeoutMs: 10_000,
            onLog: (f) => logs.push(f),
        });
        expect(out).toEqual({ ok: true, result: { echoed: { n: 7 }, from: 'python' } });
        // print() lands on stderr as a raw line, surfaced by the runner as an info log.
        expect(logs.some((f) => f.message.includes('processing from python'))).toBe(true);
    },
    15_000,
);

pyTest(
    'a python module writing directly to fd 1 keeps the output frame intact',
    async () => {
        const logs: LogFrame[] = [];
        const out = await runProtocol({
            argv: buildArgv({ runtime: 'python', module: fixture('python-stdout-write.py') }),
            input: { n: 3 },
            timeoutMs: 10_000,
            onLog: (f) => logs.push(f),
        });
        // os.write(1, ...) bypasses sys.stdout, but fd 1 is redirected — the frame stays clean.
        expect(out).toEqual({ ok: true, result: { echoed: { n: 3 }, from: 'python-fd1' } });
        expect(logs.some((f) => f.message.includes('raw bytes straight to fd 1'))).toBe(true);
    },
    15_000,
);

pyTest(
    'a python module calling sys.exit() returns a structured error frame',
    async () => {
        const out = await runProtocol({
            argv: buildArgv({ runtime: 'python', module: fixture('python-exit.py') }),
            input: null,
            timeoutMs: 10_000,
        });
        expect(out.ok).toBe(false);
        expect(out.ok === false && out.error).toMatch(/boom via sys.exit/);
    },
    15_000,
);

pyTest(
    'a python module returning NaN is rejected as an error frame, not invalid JSON',
    async () => {
        const out = await runProtocol({
            argv: buildArgv({ runtime: 'python', module: fixture('python-nan.py') }),
            input: null,
            timeoutMs: 10_000,
        });
        expect(out.ok).toBe(false);
    },
    15_000,
);
