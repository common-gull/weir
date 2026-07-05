import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clearRegistry, getWorkflow, allWorkflows } from './engine.ts';
import { loadWorkflows } from './loader.ts';

const ENGINE = pathToFileURL(resolve(import.meta.dir, 'engine.ts')).href;

let dir: string;
beforeEach(() => {
  clearRegistry();
  dir = mkdtempSync(join(tmpdir(), 'weir-wf-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const wfFile = (name: string, cron: string | null) =>
  `import { defineWorkflow } from ${JSON.stringify(ENGINE)};\n` +
  `defineWorkflow(${JSON.stringify(name)}, ${cron ? `{ schedule: { cron: ${JSON.stringify(cron)} } }` : '{}'}, async () => 1);\n`;

test('loads every workflow file in the directory', async () => {
  writeFileSync(join(dir, 'a.ts'), wfFile('a', '* * * * *'));
  writeFileSync(join(dir, 'b.ts'), wfFile('b', null));
  const { files } = await loadWorkflows(dir);
  expect(files).toBe(2);
  expect(allWorkflows().map((w) => w.name).sort()).toEqual(['a', 'b']);
});

test('fresh reload picks up an edited file (cache-busted re-import)', async () => {
  const f = join(dir, 'a.ts');
  writeFileSync(f, wfFile('a', '* * * * *'));
  await loadWorkflows(dir);
  expect(getWorkflow('a')!.opts.schedule?.cron).toBe('* * * * *');

  writeFileSync(f, wfFile('a', '0 * * * *')); // edit the schedule on disk
  const { removed } = await loadWorkflows(dir, { fresh: true });
  expect(removed).toEqual([]);
  expect(getWorkflow('a')!.opts.schedule?.cron).toBe('0 * * * *');
});

test('fresh reload evicts a workflow whose file was deleted', async () => {
  writeFileSync(join(dir, 'a.ts'), wfFile('a', null));
  writeFileSync(join(dir, 'b.ts'), wfFile('b', null));
  await loadWorkflows(dir);

  unlinkSync(join(dir, 'b.ts'));
  const { removed } = await loadWorkflows(dir, { fresh: true });
  expect(removed).toEqual(['b']);
  expect(getWorkflow('a')).toBeDefined();
  expect(getWorkflow('b')).toBeUndefined();
});

test('fresh reload keeps an unchanged file without evicting it', async () => {
  writeFileSync(join(dir, 'a.ts'), wfFile('a', '* * * * *'));
  await loadWorkflows(dir);
  // No edits: the reload must not evict the still-present workflow, and reports it as a live file.
  const { files, removed } = await loadWorkflows(dir, { fresh: true });
  expect(files).toBe(1);
  expect(removed).toEqual([]);
  expect(getWorkflow('a')).toBeDefined();
});

// When the copy can't be staged (read-only dir), an edited-but-still-present file must be
// preserved, not evicted — the reload simply can't observe the edit. Needs real perms (root
// bypasses them), so skip when running as root.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
test.skipIf(isRoot)('read-only dir reload preserves the workflow it cannot re-import', async () => {
  const f = join(dir, 'a.ts');
  writeFileSync(f, wfFile('a', '* * * * *'));
  await loadWorkflows(dir);

  writeFileSync(f, wfFile('a', '0 * * * *')); // edit on disk...
  chmodSync(dir, 0o500); // ...then make the dir read-only so the cache-bust copy can't be staged
  try {
    const { removed } = await loadWorkflows(dir, { fresh: true });
    expect(removed).toEqual([]); // must NOT evict a workflow it just couldn't re-scan
    expect(getWorkflow('a')).toBeDefined();
    // The edit can't be picked up without a cache-bust copy — the prior definition survives.
    expect(getWorkflow('a')!.opts.schedule?.cron).toBe('* * * * *');
  } finally {
    chmodSync(dir, 0o700); // restore so afterEach can clean up
  }
});
