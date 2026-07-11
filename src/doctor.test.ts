import { expect, test } from 'bun:test';
import { doctor, toolsForRuntime } from './doctor.ts';

// A cmd that no host has, so these tests don't depend on which binaries are installed.
const ABSENT = 'weir-nonexistent-tool-xyz';
// `git` is a required tool, so it's guaranteed present wherever the suite runs — a stable stand-in
// for "an installed runtime" without depending on docker/podman being on the test host.
const PRESENT = 'git';

test('a missing optional tool is reported but not fatal', async () => {
    const r = await doctor([{ cmd: ABSENT, required: false }]);
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toContain('optional');
    expect(r.lines[0]).toContain(ABSENT);
});

test('a missing required tool fails the check', async () => {
    const r = await doctor([{ cmd: ABSENT, required: true }]);
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toContain('REQUIRED');
});

test('the configured container runtime is appended as an optional check', () => {
    const runtime = toolsForRuntime('podman').find((t) => t.cmd === 'podman');
    expect(runtime).toBeDefined();
    expect(runtime?.required).toBeFalsy();
});

test('doctor reports the configured runtime by name', async () => {
    // Absent-but-named keeps this host-independent: doctor still names the runtime it checked.
    const r = await doctor(toolsForRuntime('podman'), 'podman');
    expect(r.ok).toBe(true);
    expect(r.lines.some((l) => l.includes('podman'))).toBe(true);
});

test('a missing configured runtime nudges toward an installed alternative', async () => {
    const r = await doctor([{ cmd: ABSENT, required: false }], ABSENT, [PRESENT]);
    expect(r.lines.some((l) => l.includes(`WEIR_CONTAINER_RUNTIME=${PRESENT}`))).toBe(true);
});

test('no nudge fires when the configured runtime is present', async () => {
    const r = await doctor(toolsForRuntime(PRESENT), PRESENT, [ABSENT]);
    expect(r.lines.some((l) => l.includes('WEIR_CONTAINER_RUNTIME'))).toBe(false);
});

test('no nudge fires when no alternative is installed', async () => {
    const r = await doctor([{ cmd: ABSENT, required: false }], ABSENT, ['also-not-real-xyz']);
    expect(r.lines.some((l) => l.includes('WEIR_CONTAINER_RUNTIME'))).toBe(false);
});
