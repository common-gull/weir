// Filesystem adapter for mechanical (non-agent) workflows: backup + retention/cleanup.

import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { readdir, stat, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** tar.gz one or more directories into `destDir/<prefix>-<stamp>.tgz`. Returns the archive path. */
export async function backup(dirs: string[], destDir: string, prefix: string, stamp: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const archive = join(destDir, `${prefix}-${stamp}.tgz`);
  await $`tar -czf ${archive} ${dirs}`.quiet();
  return archive;
}

/** Delete files in `dir` matching `prefix`, keeping the newest `keep`. Returns removed paths. */
export async function pruneOld(dir: string, prefix: string, keep: number): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = (await readdir(dir)).filter((f) => f.startsWith(prefix));
  const withTime = await Promise.all(
    entries.map(async (f) => ({ f, m: (await stat(join(dir, f))).mtimeMs })),
  );
  withTime.sort((a, b) => b.m - a.m);
  const removed: string[] = [];
  for (const { f } of withTime.slice(keep)) {
    await unlink(join(dir, f));
    removed.push(join(dir, f));
  }
  return removed;
}
