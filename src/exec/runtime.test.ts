import { expect, test } from 'bun:test';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogFrame } from './protocol.ts';
import { buildArgv, buildDockerArgv, type DockerStepSpec, type LocalStepSpec } from './runtime.ts';
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

// ---- buildDockerArgv: runtime-form spec (#58) ----

test('the node runtime form maps to the weir base image and runs the baked shim on a ro-mounted module', () => {
    const argv = buildDockerArgv({ runtime: 'node', module: '/abs/step.ts' }, { scratch: '/scratch/7' });
    expect(argv).toEqual([
        'docker',
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '-v',
        '/scratch/7:/weir',
        '-v',
        '/abs/step.ts:/opt/weir/module.ts:ro',
        'weir-node',
        'node',
        '/opt/weir/node-shim.ts',
        '/opt/weir/module.ts',
    ]);
});

test('the python runtime form maps to weir-python and the python shim', () => {
    const argv = buildDockerArgv({ runtime: 'python', module: '/abs/step.py' }, { scratch: '/s' });
    expect(argv.slice(-5)).toEqual([
        '/abs/step.py:/opt/weir/module.py:ro',
        'weir-python',
        'python3',
        '/opt/weir/python-shim.py',
        '/opt/weir/module.py',
    ]);
});

test('the runtime form resolves a relative module path to an absolute mount host', () => {
    const argv = buildDockerArgv({ runtime: 'node', module: 'steps/resize.ts' }, { scratch: '/s' });
    expect(argv).toContain(`${resolve('steps/resize.ts')}:/opt/weir/module.ts:ro`);
    // the container-side module path stays fixed; only the host side of the mount varies.
    expect(argv[argv.length - 1]).toBe('/opt/weir/module.ts');
});

test('the runtime form rejects a missing module path', () => {
    expect(() => buildDockerArgv({ runtime: 'node', module: '' }, { scratch: '/s' })).toThrow(/requires a module path/);
});

test('the runtime form rejects an unknown runtime (specs can arrive from untyped JSON)', () => {
    const spec = { runtime: 'ruby', module: 'x.rb' } as unknown as DockerStepSpec;
    expect(() => buildDockerArgv(spec, { scratch: '/s' })).toThrow(/unknown step runtime/);
});

// ---- buildDockerArgv: network flag (#58) ----

test('network:true drops --network none for the docker default bridge (image form)', () => {
    const argv = buildDockerArgv({ image: 'img', network: true }, { scratch: '/s' });
    expect(argv).not.toContain('--network');
    expect(argv).not.toContain('none');
    // the rest of the lockdown defaults are untouched.
    expect(argv.slice(0, 4)).toEqual(['docker', 'run', '--rm', '-i']);
    expect(argv).toContain('-v');
    expect(argv).toContain('/s:/weir');
});

test('network:true drops --network none for the runtime form too', () => {
    const argv = buildDockerArgv({ runtime: 'node', module: '/a/s.ts', network: true }, { scratch: '/s' });
    expect(argv).not.toContain('--network');
});

test('the network flag defaults off, keeping --network none', () => {
    const image = buildDockerArgv({ image: 'img' }, { scratch: '/s' });
    const runtime = buildDockerArgv({ runtime: 'node', module: '/a/s.ts' }, { scratch: '/s' });
    expect(image.slice(4, 6)).toEqual(['--network', 'none']);
    expect(runtime.slice(4, 6)).toEqual(['--network', 'none']);
});

test('image and module reach the argv as standalone elements, never shell-interpolated', () => {
    // A host module path carrying shell metacharacters stays a single `-v` element; the injection
    // boundary is the argv array, so it is never spliced into a command string.
    const nasty = '/a b/step.ts; rm -rf /';
    const argv = buildDockerArgv({ runtime: 'node', module: nasty }, { scratch: '/s' });
    expect(argv).toContain(`${nasty}:/opt/weir/module.ts:ro`);
    // the image name is likewise one element, even pinned by digest.
    const image = `img@sha256:${'a'.repeat(64)}`;
    expect(buildDockerArgv({ image, cmd: ['echo', 'hi'] }, { scratch: '/s' })).toContain(image);
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
