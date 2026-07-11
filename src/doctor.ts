// Startup preflight: verify the CLIs a workflow set depends on exist (and optionally meet a
// minimum version). Fail loud rather than deep inside a run.

import { $ } from 'bun';

export interface ToolCheck {
    cmd: string;
    versionArg?: string;
    required?: boolean;
}

export interface DoctorResult {
    ok: boolean;
    lines: string[];
}

export const DEFAULT_TOOLS: ToolCheck[] = [
    { cmd: 'claude', versionArg: '--version', required: true },
    { cmd: 'git', versionArg: '--version', required: true },
    { cmd: 'gh', versionArg: '--version', required: false },
    { cmd: 'node', versionArg: '--version', required: false },
    { cmd: 'tar', versionArg: '--version', required: false },
];

// Container runtimes weir can nudge toward when the configured one is absent, most-preferred first.
// Podman leads because it's the rootless drop-in most hosts reach for when docker is missing.
export const RUNTIME_ALTERNATIVES = ['podman', 'nerdctl', 'docker'];

// The CLI checklist for a given container runtime: the always-needed host tools plus the configured
// runtime binary. The runtime is optional — a host-only workflow set never launches a container step.
export function toolsForRuntime(runtime: string): ToolCheck[] {
    return [...DEFAULT_TOOLS, { cmd: runtime, versionArg: '--version', required: false }];
}

export async function doctor(
    tools: ToolCheck[] = DEFAULT_TOOLS,
    runtime?: string,
    alternatives: string[] = RUNTIME_ALTERNATIVES,
): Promise<DoctorResult> {
    const lines: string[] = [];
    let ok = true;
    let runtimeMissing = false;
    for (const t of tools) {
        if (!(await commandExists(t.cmd))) {
            const msg = `✗ ${t.cmd} not found${t.required ? ' (REQUIRED)' : ' (optional)'}`;
            lines.push(msg);
            if (t.required) ok = false;
            if (t.cmd === runtime) runtimeMissing = true;
            continue;
        }
        let version = '';
        if (t.versionArg) {
            const v = await $`${t.cmd} ${t.versionArg}`.nothrow().quiet();
            version = v.stdout.toString().trim().split('\n')[0] ?? '';
        }
        lines.push(`✓ ${t.cmd} ${version}`);
    }
    // Nudge, don't auto-fallback: if the configured runtime is absent but a known alternative is
    // installed, point the user at WEIR_CONTAINER_RUNTIME so they opt in explicitly.
    if (runtime && runtimeMissing) {
        const alt = await firstPresent(alternatives.filter((a) => a !== runtime));
        if (alt) {
            lines.push(`  ↳ ${alt} is installed — set WEIR_CONTAINER_RUNTIME=${alt} to run container steps on it`);
        }
    }
    return { ok, lines };
}

async function commandExists(cmd: string): Promise<boolean> {
    return (await $`which ${cmd}`.nothrow().quiet()).exitCode === 0;
}

async function firstPresent(cmds: string[]): Promise<string | undefined> {
    for (const cmd of cmds) {
        if (await commandExists(cmd)) return cmd;
    }
    return undefined;
}
