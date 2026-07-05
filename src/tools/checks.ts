// Deterministic checks adapter: runs `npm run <name>` if it's a package.json script, else
// `make <name>` if it's a Makefile target. Missing checks are skipped. Runs OUTSIDE the
// agent so the gate isn't the agent grading its own homework.

import { $ } from 'bun';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CheckResult {
  ok: boolean;
  output: string;
  ran: string[];
  failed: string[];
}

function scripts(projectDir: string): Record<string, string> {
  const p = join(projectDir, 'package.json');
  if (!existsSync(p)) return {};
  try {
    return (JSON.parse(readFileSync(p, 'utf8')).scripts ?? {}) as Record<string, string>;
  } catch {
    return {};
  }
}

function makefileTargets(projectDir: string): Set<string> {
  const p = join(projectDir, 'Makefile');
  if (!existsSync(p)) return new Set();
  const out = new Set<string>();
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^([a-zA-Z0-9_.-]+):/.exec(line);
    if (m) out.add(m[1]!);
  }
  return out;
}

export async function runChecks(
  projectDir: string,
  names: string[] = ['lint', 'test'],
  log?: (m: string) => void,
): Promise<CheckResult> {
  const s = scripts(projectDir);
  const mk = makefileTargets(projectDir);
  const ran: string[] = [];
  const failed: string[] = [];
  let output = '';

  for (const name of names) {
    let cmd: string[] | null = null;
    if (s[name]) cmd = ['npm', 'run', name];
    else if (mk.has(name)) cmd = ['make', name];
    if (!cmd) {
      log?.(`check "${name}" not found — skipping`);
      continue;
    }
    ran.push(name);
    log?.(`running check: ${name}`);
    const res = await $`${cmd}`.cwd(projectDir).nothrow().quiet();
    const text = `$ ${cmd.join(' ')}\n${res.stdout.toString()}${res.stderr.toString()}`;
    output += text + '\n';
    if (res.exitCode !== 0) {
      failed.push(name);
      log?.(`check "${name}" FAILED (exit ${res.exitCode})`);
    }
  }
  return { ok: failed.length === 0, output: output.trim(), ran, failed };
}
