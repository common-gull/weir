import { expect, test } from 'bun:test';
import { DEFAULT_TOOLS, doctor } from './doctor.ts';

// A cmd that no host has, so these tests don't depend on which binaries are installed.
const ABSENT = 'weir-nonexistent-tool-xyz';

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

test('docker is a registered optional tool, so its absence never aborts doctor', () => {
    const docker = DEFAULT_TOOLS.find((t) => t.cmd === 'docker');
    expect(docker).toBeDefined();
    expect(docker?.required).toBeFalsy();
});
