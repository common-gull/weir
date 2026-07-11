import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecEnv, withCapabilities } from '../capabilities.ts';
import type { Capability } from '../types.ts';
import { parseRepoDigest, pinnedImageRef, resolveImageDigest } from './docker.ts';
import { buildDockerArgv, dockerCapabilityMounts, dockerImageRef } from './runtime.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const withCaps = <T>(caps: Capability[], fn: () => T): T =>
    withCapabilities({ workflow: 'wf', caps: new Set(caps) }, fn);

// ---- buildDockerArgv (pure argv assembly) ----

test('buildDockerArgv defaults to no network and mounts the scratch dir at /weir', () => {
    const argv = buildDockerArgv({ image: 'weir-base:node' }, { scratch: '/scratch/run/3' });
    expect(argv).toEqual([
        'docker',
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '-v',
        '/scratch/run/3:/weir:Z',
        'weir-base:node',
    ]);
});

test('buildDockerArgv forwards env by name as -e NAME and appends the cmd after the image', () => {
    const image = `img@${DIGEST}`;
    const argv = buildDockerArgv(
        { image, cmd: ['python3', '/weir/step.py'] },
        { scratch: '/s', env: { GH_TOKEN: 'secret', PATH: '/usr/bin' } },
    );
    expect(argv.slice(0, 8)).toEqual(['docker', 'run', '--rm', '-i', '--network', 'none', '-v', '/s:/weir:Z']);
    const eIdx = argv.indexOf('-e');
    // name-only references — docker reads the value from its own env, so no secret lands in argv.
    expect(argv.slice(eIdx, eIdx + 4)).toEqual(['-e', 'GH_TOKEN', '-e', 'PATH']);
    expect(argv).not.toContain('GH_TOKEN=secret');
    // the image (pinned by digest) then its command tail close the argv.
    expect(argv.slice(-3)).toEqual([image, 'python3', '/weir/step.py']);
});

test('buildDockerArgv adds extra mounts, read-only ones with a :ro suffix', () => {
    const flat = buildDockerArgv(
        { image: 'img' },
        {
            scratch: '/s',
            mounts: [
                { host: '/home/u/.claude', container: '/root/.claude' },
                { host: '/data', container: '/data', readonly: true },
            ],
        },
    ).join(' ');
    expect(flat).toContain('-v /s:/weir:Z');
    expect(flat).toContain('-v /home/u/.claude:/root/.claude');
    expect(flat).toContain('-v /data:/data:ro');
});

test('buildDockerArgv rejects a missing image', () => {
    expect(() => buildDockerArgv({ image: '' }, { scratch: '/s' })).toThrow(/requires an image/);
});

test('buildDockerArgv runs the `image` override (a pinned digest) in place of the resolved image', () => {
    // Dispatch pins the runtime form's base image to a digest and hands it back via `image`; the
    // module still bind-mounts at /opt/weir, but the container runs the exact pinned bytes.
    const pinned = `weir-node@${DIGEST}`;
    const argv = buildDockerArgv({ runtime: 'node', module: '/w/step.ts' }, { scratch: '/s', image: pinned });
    expect(argv).toContain(pinned);
    expect(argv).not.toContain('weir-node');
    // the module mount survives the override
    expect(argv.join(' ')).toContain('/w/step.ts:/opt/weir/module.ts:ro');
});

test('dockerImageRef returns the named image for the image form and the base image for the runtime form', () => {
    expect(dockerImageRef({ image: 'alpine:3.20' })).toBe('alpine:3.20');
    expect(dockerImageRef({ runtime: 'node', module: '/w/step.ts' })).toBe('weir-node');
    expect(dockerImageRef({ runtime: 'python', module: '/w/step.py' })).toBe('weir-python');
});

test('cap-scoped env from resolveExecEnv flows into the docker argv (C7)', () => {
    const source = { PATH: '/usr/bin', GH_TOKEN: 'ghs_secret', UNRELATED: 'x' };
    const env = withCaps(['gh-pr'], () => resolveExecEnv(source));
    const flat = buildDockerArgv({ image: 'img' }, { scratch: '/s', env }).join(' ');
    // gh-pr authorizes GH_TOKEN; PATH is the operational baseline; UNRELATED is neither → withheld.
    // Forwarded by name, so the secret value never appears in the argv.
    expect(flat).toContain('-e GH_TOKEN');
    expect(flat).not.toContain('ghs_secret');
    expect(flat).toContain('-e PATH');
    expect(flat).not.toContain('UNRELATED');
});

test('a container step declaring no credential capability carries no daemon secret into the argv (C7)', () => {
    // The negative of the case above and the docker-boundary analog of the rung-1 "secret-free env"
    // guarantee: with no credential capability, resolveExecEnv withholds the daemon's GH_TOKEN, so it's
    // never named on the container's argv — neither by `-e NAME` nor by value. Only the operational
    // baseline (PATH) rides along. Should env-forwarding ever leak a secret regardless of grants, this
    // fails alongside the capabilities.test.ts gate.
    const source = { PATH: '/usr/bin', GH_TOKEN: 'ghs_secret', UNRELATED: 'x' };
    const env = withCaps([], () => resolveExecEnv(source));
    const flat = buildDockerArgv({ image: 'img' }, { scratch: '/s', env }).join(' ');
    expect(flat).not.toContain('GH_TOKEN');
    expect(flat).not.toContain('ghs_secret');
    expect(flat).not.toContain('UNRELATED');
    expect(flat).toContain('-e PATH');
});

// ---- dockerCapabilityMounts (ambient capability → mounts) ----

test('dockerCapabilityMounts is empty without the claude capability', () => {
    const mounts = withCaps([], dockerCapabilityMounts);
    expect(mounts).toEqual([]);
});

test('the claude capability mounts ~/.claude read-only into the container', () => {
    const mounts = withCaps(['claude'], dockerCapabilityMounts);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.container).toBe('/root/.claude');
    expect(mounts[0]?.host.endsWith('.claude')).toBe(true);
    // read-only so a compromised step image can't plant a hook or rewrite credentials on the host.
    expect(mounts[0]?.readonly).toBe(true);
});

// ---- digest parsing / pinning (pure strings) ----

test('parseRepoDigest extracts the digest from a RepoDigests JSON array', () => {
    expect(parseRepoDigest(`["alpine@${DIGEST}"]`)).toBe(DIGEST);
});

test('parseRepoDigest extracts the digest from a bare repo@digest line', () => {
    expect(parseRepoDigest(`registry.example.com/lib/alpine@${DIGEST}\n`)).toBe(DIGEST);
});

test('parseRepoDigest throws when the ref carries no repo digest', () => {
    expect(() => parseRepoDigest('[]')).toThrow(/no sha256 repo digest/);
    expect(() => parseRepoDigest('null')).toThrow(/no sha256 repo digest/);
});

test('pinnedImageRef replaces a tag with the digest', () => {
    expect(pinnedImageRef('alpine:3.20', DIGEST)).toBe(`alpine@${DIGEST}`);
});

test('pinnedImageRef pins an untagged ref', () => {
    expect(pinnedImageRef('alpine', DIGEST)).toBe(`alpine@${DIGEST}`);
});

test('pinnedImageRef preserves a registry port while replacing the tag', () => {
    expect(pinnedImageRef('registry:5000/lib/alpine:3.20', DIGEST)).toBe(`registry:5000/lib/alpine@${DIGEST}`);
});

test('pinnedImageRef is idempotent on an already-pinned ref', () => {
    expect(pinnedImageRef(`alpine@${DIGEST}`, DIGEST)).toBe(`alpine@${DIGEST}`);
});

// ---- resolveImageDigest: configurable runtime binary (#79) ----

test('resolveImageDigest invokes the given runtime binary as argv[0] and parses its output', async () => {
    // A stand-in container binary: whatever args it receives, it emits a RepoDigests array exactly as
    // `<runtime> image inspect` would. Using it as `runtime` proves resolveImageDigest shells out to
    // the passed binary (argv[0]) rather than a hardcoded `docker` — no real docker/podman needed.
    const dir = await mkdtemp(join(tmpdir(), 'weir-runtime-'));
    try {
        const bin = join(dir, 'fake-runtime');
        await writeFile(bin, `#!/bin/sh\necho '["repo@${DIGEST}"]'\n`);
        await chmod(bin, 0o755);
        expect(await resolveImageDigest('repo:tag', bin)).toBe(DIGEST);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ---- real-docker (gated: skipped when the runtime is absent, so CI stays green) ----

const HAS_DOCKER = Bun.which('docker') !== null;
const dockerTest = HAS_DOCKER ? test : test.skip;

dockerTest('resolveImageDigest rejects an image with no local repo digest', async () => {
    // A ref that isn't present locally has nothing to inspect — the real `docker image inspect` exits
    // non-zero, so resolution rejects rather than fabricating a digest. inspect never pulls: no network.
    await expect(resolveImageDigest('weir-does-not-exist:none-xyz-000')).rejects.toThrow();
});
