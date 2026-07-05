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

const DEFAULT_TOOLS: ToolCheck[] = [
  { cmd: 'claude', versionArg: '--version', required: true },
  { cmd: 'git', versionArg: '--version', required: true },
  { cmd: 'gh', versionArg: '--version', required: false },
  { cmd: 'node', versionArg: '--version', required: false },
  { cmd: 'tar', versionArg: '--version', required: false },
];

export async function doctor(tools: ToolCheck[] = DEFAULT_TOOLS): Promise<DoctorResult> {
  const lines: string[] = [];
  let ok = true;
  for (const t of tools) {
    const which = await $`which ${t.cmd}`.nothrow().quiet();
    if (which.exitCode !== 0) {
      const msg = `✗ ${t.cmd} not found${t.required ? ' (REQUIRED)' : ' (optional)'}`;
      lines.push(msg);
      if (t.required) ok = false;
      continue;
    }
    let version = '';
    if (t.versionArg) {
      const v = await $`${t.cmd} ${t.versionArg}`.nothrow().quiet();
      version = v.stdout.toString().trim().split('\n')[0] ?? '';
    }
    lines.push(`✓ ${t.cmd} ${version}`);
  }
  return { ok, lines };
}
