// Git adapter (Bun.$). Local-only by default; `push` requires the 'git-push' capability.

import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { requireCapability } from '../capabilities.ts';
import type { Capability } from '../types.ts';

export function isGitUrl(spec: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(spec);
}

/**
 * Run `git -C <dir>` with raw args, returning trimmed stdout. The escape hatch workflows use to
 * drive git directly rather than growing a bespoke helper here for every operation; pass
 * `capability` for anything that writes to a remote (e.g. 'git-push').
 */
export async function git(dir: string, args: string[], opts: { capability?: Capability } = {}): Promise<string> {
  if (opts.capability) requireCapability(opts.capability);
  return (await $`git -C ${dir} ${args}`.text()).trim();
}

/** A local path passes through; a URL is shallow-cloned into `cacheDir` and reused. */
export async function resolveRepo(spec: string, cacheDir: string): Promise<string> {
  if (!isGitUrl(spec)) return spec;
  const name = basename(spec).replace(/\.git$/, '');
  const dest = `${cacheDir}/${name}`;
  if (!existsSync(dest)) {
    await $`mkdir -p ${cacheDir}`.quiet();
    await $`git clone --depth 1 ${spec} ${dest}`.quiet();
  }
  return dest;
}

export async function addWorktree(baseRepo: string, dir: string, branch: string): Promise<void> {
  const branchExists = (await $`git -C ${baseRepo} branch --list ${branch}`.text()).trim() !== '';
  if (branchExists) await $`git -C ${baseRepo} worktree add ${dir} ${branch}`.quiet();
  else await $`git -C ${baseRepo} worktree add -b ${branch} ${dir}`.quiet();
}

/** Worktree on a NEW branch rooted at an explicit start point (e.g. `origin/main`). */
export async function addWorktreeFrom(
  baseRepo: string,
  dir: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await $`git -C ${baseRepo} worktree add -b ${branch} ${dir} ${startPoint}`.quiet();
}

export async function hasRemote(dir: string, remote = 'origin'): Promise<boolean> {
  return (await $`git -C ${dir} remote`.text()).split('\n').map((l) => l.trim()).includes(remote);
}

/** Fetch the remote so branch-off points reflect its latest state. */
export async function fetchRemote(dir: string, remote = 'origin'): Promise<void> {
  await $`git -C ${dir} fetch ${remote}`.quiet();
}

/** The remote's default branch (e.g. "main"), detected rather than assumed. */
export async function defaultBranch(dir: string, remote = 'origin'): Promise<string> {
  const sym = (await $`git -C ${dir} symbolic-ref --quiet refs/remotes/${remote}/HEAD`.nothrow().text()).trim();
  if (sym) return sym.replace(`refs/remotes/${remote}/`, '');
  const shown = await $`git -C ${dir} remote show ${remote}`.nothrow().text();
  const m = /HEAD branch:\s*(\S+)/.exec(shown);
  if (m?.[1] && m[1] !== '(unknown)') return m[1];
  return currentBranch(dir);
}

export async function removeWorktree(baseRepo: string, dir: string): Promise<void> {
  await $`git -C ${baseRepo} worktree remove --force ${dir}`.nothrow().quiet();
}

export async function hasChanges(dir: string): Promise<boolean> {
  return (await $`git -C ${dir} status --porcelain`.text()).trim() !== '';
}

export async function commitAll(dir: string, message: string): Promise<boolean> {
  await $`git -C ${dir} add -A`.quiet();
  if ((await $`git -C ${dir} diff --cached --name-only`.text()).trim() === '') return false;
  await $`git -C ${dir} commit -m ${message}`.quiet();
  return true;
}

/** Diff of a branch against its base (what the agent changed). */
export async function diffAgainst(dir: string, base = 'main'): Promise<string> {
  return (await $`git -C ${dir} diff ${base}...HEAD`.text());
}

export async function currentBranch(dir: string): Promise<string> {
  return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** Merge `branch` into the base repo's default branch locally (never pushes). */
export async function mergeToMain(baseRepo: string, branch: string, base = 'main'): Promise<void> {
  await $`git -C ${baseRepo} checkout ${base}`.quiet();
  await $`git -C ${baseRepo} merge --no-ff -m ${'merge ' + branch} ${branch}`.quiet();
}

/** Push — gated on the 'git-push' capability (default-deny). */
export async function push(dir: string, remote = 'origin', branch?: string): Promise<void> {
  requireCapability('git-push');
  const b = branch ?? (await currentBranch(dir));
  await $`git -C ${dir} push ${remote} ${b}`.quiet();
}
