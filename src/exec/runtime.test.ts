import { $ } from 'bun';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { putArtifact } from '../artifacts.ts';
import { type DB, openDb } from '../db.ts';
import type { LogFrame } from './protocol.ts';
import {
    buildArgv,
    buildDockerArgv,
    type DockerStepSpec,
    type LocalStepSpec,
    planOutputs,
    snapshotOutputs,
    stageInputs,
} from './runtime.ts';
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

// ---- scratch staging (#C6): directory artifacts + streaming hashes ----

async function withStaging(fn: (env: { db: DB; store: string; a: string; b: string }) => Promise<void>): Promise<void> {
    const db = openDb(':memory:');
    const store = await mkdtemp(join(tmpdir(), 'weir-store-'));
    const a = await mkdtemp(join(tmpdir(), 'weir-scratch-a-'));
    const b = await mkdtemp(join(tmpdir(), 'weir-scratch-b-'));
    try {
        await fn({ db, store, a, b });
    } finally {
        db.close();
        await Promise.all([a, b, store].map((d) => rm(d, { recursive: true, force: true })));
    }
}

/** A directory outside every scratch dir, standing in for a symlink escape's target. */
async function withOutsideDir(fn: (outside: string) => Promise<void>): Promise<void> {
    const outside = await mkdtemp(join(tmpdir(), 'weir-outside-'));
    try {
        await fn(outside);
    } finally {
        await rm(outside, { recursive: true, force: true });
    }
}

test('a directory output round-trips through the store with a stable content hash', async () => {
    await withStaging(async ({ db, store, a, b }) => {
        await mkdir(join(a, 'repo/sub'), { recursive: true });
        await writeFile(join(a, 'repo/a.txt'), 'alpha');
        await writeFile(join(a, 'repo/sub/b.txt'), 'beta');

        const map = await snapshotOutputs(db, store, a, ['repo']);
        expect(map.repo).toMatch(/^[0-9a-f]{64}$/);

        // Deterministic archive: the same tree content-addresses to the same hash (so it dedups).
        const again = await snapshotOutputs(db, store, a, ['repo']);
        expect(again.repo).toBe(map.repo);

        // Unpacking into a fresh scratch reproduces the tree byte-for-byte.
        await stageInputs(db, store, b, [{ hash: map.repo ?? '', path: 'repo' }]);
        expect(await readFile(join(b, 'repo/a.txt'), 'utf8')).toBe('alpha');
        expect(await readFile(join(b, 'repo/sub/b.txt'), 'utf8')).toBe('beta');
    });
});

test('a file output round-trips alongside directory artifacts', async () => {
    await withStaging(async ({ db, store, a, b }) => {
        await writeFile(join(a, 'data.bin'), 'plain bytes');
        const map = await snapshotOutputs(db, store, a, ['data.bin']);

        await stageInputs(db, store, b, [{ hash: map['data.bin'] ?? '', path: 'copy.bin' }]);
        expect(await readFile(join(b, 'copy.bin'), 'utf8')).toBe('plain bytes');
    });
});

test('a rejected plan (commit never called) leaks no temp archive in the scratch dir', async () => {
    await withStaging(async ({ db, store, a }) => {
        await mkdir(join(a, 'tree'), { recursive: true });
        await writeFile(join(a, 'tree/f.txt'), 'x');
        // plan without commit models an extractor rejecting the run: the temp tar rides inside the
        // scratch dir, which the engine tears down, so nothing is orphaned in the store.
        const { map } = await planOutputs(db, store, a, ['tree']);
        expect(map.tree).toMatch(/^[0-9a-f]{64}$/);
        expect(db.query(`SELECT COUNT(*) AS c FROM artifacts`).get()).toEqual({ c: 0 });
    });
});

test('a whole-scratch output does not capture the transient tar written from it', async () => {
    await withStaging(async ({ db, store, a }) => {
        await writeFile(join(a, 'only.txt'), 'content');
        // Archiving '.' writes its temp tar into the same dir; the exclude must keep it out, so the
        // hash stays deterministic rather than folding in a half-written archive.
        const first = await snapshotOutputs(db, store, a, ['.']);
        const second = await snapshotOutputs(db, store, a, ['.']);
        expect(second['.']).toBe(first['.']);
    });
});

test('staging still rejects a directory artifact whose declared path escapes the scratch dir', async () => {
    await withStaging(async ({ db, store, a, b }) => {
        await mkdir(join(a, 'tree'), { recursive: true });
        await writeFile(join(a, 'tree/f.txt'), 'x');
        const map = await snapshotOutputs(db, store, a, ['tree']);

        await expect(stageInputs(db, store, b, [{ hash: map.tree ?? '', path: '../escape' }])).rejects.toThrow(
            /escapes the scratch dir/,
        );
        await expect(snapshotOutputs(db, store, a, ['../escape'])).rejects.toThrow(/escapes the scratch dir/);
    });
});

test('archiving a directory output containing a symlink is refused, so no link enters the store', async () => {
    await withOutsideDir(async (outside) => {
        await withStaging(async ({ db, store, a }) => {
            await writeFile(join(outside, 'secret'), 'top secret');
            await mkdir(join(a, 'tree'), { recursive: true });
            await writeFile(join(a, 'tree/real.txt'), 'ok');
            await symlink(outside, join(a, 'tree/escape'));

            await expect(snapshotOutputs(db, store, a, ['tree'])).rejects.toThrow(/symlink/);
            // Nothing was committed: the tree never became a stage-in-able blob.
            expect(db.query(`SELECT COUNT(*) AS c FROM artifacts`).get()).toEqual({ c: 0 });
        });
    });
});

test('a declared output that is itself a symlink to a directory is refused (no dereference on archive)', async () => {
    await withOutsideDir(async (outside) => {
        await withStaging(async ({ db, store, a }) => {
            await writeFile(join(outside, 'secret'), 'top secret');
            await symlink(outside, join(a, 'linkdir'));
            await expect(snapshotOutputs(db, store, a, ['linkdir'])).rejects.toThrow(/symlink/);
        });
    });
});

test('staging refuses a directory blob carrying a symlink, closing the escape on unpack', async () => {
    await withOutsideDir(async (outside) => {
        await withStaging(async ({ db, store, a, b }) => {
            await writeFile(join(outside, 'secret'), 'top secret');
            // A 'dir' blob the guarded archive path would never produce: a raw tar carrying a live
            // symlink to a dir outside every scratch. Modelling a blob that reached the store elsewise.
            await mkdir(join(a, 'tree'), { recursive: true });
            await symlink(outside, join(a, 'tree/escape'));
            const tar = join(a, 'evil.tar');
            await $`tar -cf ${tar} -C ${join(a, 'tree')} .`.quiet();
            const hash = await putArtifact(db, store, tar, 'dir');

            await expect(stageInputs(db, store, b, [{ hash, path: 'tree' }])).rejects.toThrow(/symlink/);
            // The link never materialized under the scratch dir, so the outside secret stays unreachable.
            expect(existsSync(join(b, 'tree/escape'))).toBe(false);
            expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('top secret');
        });
    });
});

test('staging refuses a directory blob whose member escapes via a traversing path', async () => {
    await withStaging(async ({ db, store, a, b }) => {
        // A 'dir' blob the guarded archive path would never produce: a hand-built tar whose member name
        // climbs out of the destination with `..`. `-P` on create keeps the `..` in the stored name;
        // system tar doesn't portably strip it on extract, so the guard must reject it from the listing.
        await mkdir(join(a, 'payload'), { recursive: true });
        await writeFile(join(a, 'payload/loot.txt'), 'pwned');
        const tar = join(a, 'slip.tar');
        await $`tar -P -cf ${tar} -C ${join(a, 'payload')} ${'../payload/loot.txt'}`.quiet();
        const hash = await putArtifact(db, store, tar, 'dir');

        await expect(stageInputs(db, store, b, [{ hash, path: 'tree' }])).rejects.toThrow(/escapes the scratch dir/);
        // Nothing was extracted, so no member climbed out of the destination onto the host.
        expect(existsSync(join(b, 'tree'))).toBe(false);
    });
});
