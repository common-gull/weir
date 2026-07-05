// Loads workflow definition files from a directory into the registry.
//
// Reload semantics (`fresh: true`): Bun caches ES modules by their resolved real path and
// ignores query strings / fragments / symlinks, so a plain re-import of an edited file will
// NOT re-run it. To pick up on-disk edits without a restart, we import a throwaway copy placed
// beside the original (same directory, so its relative imports still resolve) under a name that
// is unique for the whole process — a path Bun has already cached never re-executes. Workflows
// from files that were deleted are then evicted so their schedules can be reconciled away.
//
// Two consequences of the copy trick are handled here:
//   * Each cache-busted import leaks a module into Bun's registry for the process's life, so we
//     hash each file and skip re-importing byte-identical ones — a reload only re-executes (and
//     leaks) files that actually changed.
//   * If the copy can't be staged (read-only dir, full disk) a plain re-import is a cached no-op
//     that won't re-register the file's workflows. We remember which names each file defined so
//     that fallback can report them as still-live, instead of the reconciler evicting them.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { onRegister, retainWorkflows } from './engine.ts';

const WORKFLOW_FILE = /\.(ts|js|mjs)$/;
/** Prefix for the throwaway copies a reload imports; excluded from scans and swept on reload. */
const RELOAD_PREFIX = '.weir-reload.';

/** Monotonic across the process so every reload copy gets a path Bun hasn't cached yet. */
let reloadSeq = 0;

/** Per source file (by absolute path): the content hash we last imported and the workflow names
 *  that import registered. Lets a reload skip unchanged files and preserve the workflows of a
 *  file it couldn't re-scan. */
interface FileState {
  hash: string;
  names: Set<string>;
}
const fileState = new Map<string, FileState>();

export interface LoadResult {
  /** Number of workflow files imported. */
  files: number;
  /** Names of workflows evicted because their files no longer exist (only on `fresh`). */
  removed: string[];
}

export async function loadWorkflows(dir: string, opts: { fresh?: boolean } = {}): Promise<LoadResult> {
  const fresh = opts.fresh ?? false;
  if (!existsSync(dir)) {
    // A fresh reload of a now-missing directory reconciles the registry to empty. Forget prior
    // per-file state so the directory reappearing re-imports cleanly.
    fileState.clear();
    return { files: 0, removed: fresh ? retainWorkflows(new Set()) : [] };
  }

  const entries = readdirSync(dir).filter(
    (f) => WORKFLOW_FILE.test(f) && !f.endsWith('.test.ts') && !f.startsWith(RELOAD_PREFIX),
  );
  if (fresh) sweepReloadTemps(dir); // remove any copies leaked by a prior crash

  const seen = new Set<string>();
  const present = new Set<string>();
  let files = 0;
  for (const f of entries) {
    const orig = join(dir, f);
    for (const name of await importFile(orig, f, fresh)) seen.add(name);
    present.add(orig);
    files++;
  }
  // Drop remembered state for files no longer on disk so a re-added file re-imports.
  for (const key of [...fileState.keys()]) if (!present.has(key)) fileState.delete(key);

  const removed = fresh ? retainWorkflows(seen) : [];
  return { files, removed };
}

/** Import one workflow file, returning the workflow names it defines. */
async function importFile(orig: string, file: string, fresh: boolean): Promise<Set<string>> {
  const buf = readFileSync(orig);
  const h = hash(buf);

  if (!fresh) {
    const names = await captureImport(pathToFileURL(orig).href);
    fileState.set(orig, { hash: h, names });
    return names;
  }

  const prev = fileState.get(orig);
  if (prev && prev.hash === h) return prev.names; // byte-identical — already loaded, don't re-import

  const { names, imported } = await freshImport(orig, file, buf);
  // Only record the new hash when we actually re-executed the file; a cached-no-op fallback keeps
  // the old hash so a later reload (once the copy can be staged) still retries the edit.
  if (imported) fileState.set(orig, { hash: h, names });
  return names;
}

/**
 * Cache-bust import of a changed/new file: write a uniquely-named copy beside the original and
 * import that so Bun re-executes it. Returns the registered names and whether a fresh execution
 * actually happened (false when we had to fall back to a cached no-op import).
 */
async function freshImport(orig: string, file: string, buf: Buffer): Promise<{ names: Set<string>; imported: boolean }> {
  const copy = join(orig, '..', `${RELOAD_PREFIX}${reloadSeq++}.${file}`);
  let staged = true;
  try {
    writeFileSync(copy, buf);
  } catch {
    staged = false;
  }
  if (!staged) {
    // Couldn't stage a copy (e.g. read-only dir). A plain re-import of an already-loaded file is a
    // cached no-op — it won't re-register, so preserve the file's last-known names rather than let
    // the reconciler evict them. A genuinely new file isn't cached yet, so it does execute here.
    const names = await captureImport(pathToFileURL(orig).href);
    if (names.size > 0) return { names, imported: true };
    return { names: fileState.get(orig)?.names ?? names, imported: false };
  }
  try {
    return { names: await captureImport(pathToFileURL(copy).href), imported: true };
  } finally {
    rmSync(copy, { force: true });
  }
}

/** Import `href` and return the set of workflow names registered while it executed. */
async function captureImport(href: string): Promise<Set<string>> {
  const names = new Set<string>();
  const off = onRegister((name) => names.add(name));
  try {
    await import(href);
  } finally {
    off();
  }
  return names;
}

function hash(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

function sweepReloadTemps(dir: string): void {
  for (const f of readdirSync(dir)) {
    if (f.startsWith(RELOAD_PREFIX)) rmSync(join(dir, f), { force: true });
  }
}
