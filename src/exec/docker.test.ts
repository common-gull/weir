import { expect, test } from 'bun:test';
import { resolveExecEnv, withCapabilities } from '../capabilities.ts';
import type { Capability } from '../types.ts';
import { parseRepoDigest, pinnedImageRef, resolveImageDigest } from './docker.ts';
import { buildDockerArgv, dockerCapabilityMounts } from './runtime.ts';

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
        '--network',
        'none',
        '-v',
        '/scratch/run/3:/weir',
        'weir-base:node',
    ]);
});

test('buildDockerArgv forwards env by name as -e NAME and appends the cmd after the image', () => {
    const image = `img@${DIGEST}`;
    const argv = buildDockerArgv(
        { image, cmd: ['python3', '/weir/step.py'] },
        { scratch: '/s', env: { GH_TOKEN: 'secret', PATH: '/usr/bin' } },
    );
    expect(argv.slice(0, 7)).toEqual(['docker', 'run', '--rm', '--network', 'none', '-v', '/s:/weir']);
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
    expect(flat).toContain('-v /s:/weir');
    expect(flat).toContain('-v /home/u/.claude:/root/.claude');
    expect(flat).toContain('-v /data:/data:ro');
});

test('buildDockerArgv rejects a missing image', () => {
    expect(() => buildDockerArgv({ image: '' }, { scratch: '/s' })).toThrow(/requires an image/);
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

// ---- real-docker (gated: skipped when the runtime is absent, so CI stays green) ----

const HAS_DOCKER = Bun.which('docker') !== null;
const dockerTest = HAS_DOCKER ? test : test.skip;

dockerTest('resolveImageDigest rejects an image with no local repo digest', async () => {
    // A ref that isn't present locally has nothing to inspect — the real `docker image inspect` exits
    // non-zero, so resolution rejects rather than fabricating a digest. inspect never pulls: no network.
    await expect(resolveImageDigest('weir-does-not-exist:none-xyz-000')).rejects.toThrow();
});
