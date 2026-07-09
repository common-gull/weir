// Content-addressed artifact store: the tier-2 hand-off for bytes/files too big for the JSON memo
// (SQLite). Content lives on disk under `<storeDir>/<sha256>`, deduped by hash — identical content
// is stored once. A directory tree is archived to one tar and stored as a single blob (kind 'dir'),
// unpacked on stage-in. The `artifacts` table (see db.ts SCHEMA) records size + kind + first-seen
// time; the file on disk is the source of truth for reads.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DB } from './db.ts';

const HASH_RE = /^[0-9a-f]{64}$/;

/** Whether a stored blob is a single file's bytes ('file') or a directory tree archived as one tar
 *  ('dir'). Recorded per artifact so stage-in unpacks a directory rather than copying it as a file. */
export type ArtifactKind = 'file' | 'dir';

/** The content address (sha256 hex) of raw bytes — the key putArtifact stores them under. Exposed so
 *  a caller can content-address bytes without committing them to the store yet. */
export function artifactHash(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** Content-address a file by streaming it through the hash a chunk at a time — a large blob (a repo
 *  checkout, a tarball) is never read wholly into memory the way `artifactHash(await readFile(...))`
 *  would, so hashing it can't blow the heap. */
export async function hashFile(path: string): Promise<string> {
    const h = createHash('sha256');
    const reader = Bun.file(path).stream().getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (value) h.update(value);
        if (done) break;
    }
    return h.digest('hex');
}

/** Place `src` in the store under `hash` (atomic temp+rename so a crash mid-write can't leave a
 *  truncated file masquerading under a valid content hash) and record its row. A path source copies
 *  at the OS level — no heap buffering — so a large blob lands without being read wholly into memory;
 *  raw bytes are already in memory. Idempotent: an already-stored hash re-copies nothing (dedup). */
async function storeBlob(
    db: DB,
    storeDir: string,
    src: string | Uint8Array,
    hash: string,
    size: number,
    kind: ArtifactKind,
): Promise<void> {
    const dest = join(storeDir, hash);
    await mkdir(storeDir, { recursive: true });
    if (!existsSync(dest)) {
        const tmp = `${dest}.${crypto.randomUUID()}.tmp`;
        if (typeof src === 'string') await copyFile(src, tmp);
        else await writeFile(tmp, src);
        await rename(tmp, dest);
    }
    db.query(`INSERT OR IGNORE INTO artifacts (hash, size, kind, created_at) VALUES (?, ?, ?, ?)`).run(
        hash,
        size,
        kind,
        Date.now(),
    );
}

/** Store `src` (a file path or raw bytes) under `storeDir` and return its sha256 hex hash. A path is
 *  streamed for both the hash and the copy, so a large file stores without buffering wholly in
 *  memory. `kind` tags the blob 'file' (default) or 'dir' (a directory tar, see stageInputs).
 *  Identical content reuses the same key, so a repeat put is a no-op on disk (dedup). */
export async function putArtifact(
    db: DB,
    storeDir: string,
    src: string | Uint8Array,
    kind: ArtifactKind = 'file',
): Promise<string> {
    if (typeof src === 'string') {
        const hash = await hashFile(src);
        await storeBlob(db, storeDir, src, hash, (await stat(src)).size, kind);
        return hash;
    }
    const hash = artifactHash(src);
    await storeBlob(db, storeDir, src, hash, src.byteLength, kind);
    return hash;
}

/** Resolve the on-disk path for a stored artifact. Throws if the hash is malformed or no artifact
 *  with that hash exists. */
export function getArtifact(storeDir: string, hash: string): string {
    if (!HASH_RE.test(hash)) throw new Error(`invalid artifact hash: ${hash}`);
    const dest = join(storeDir, hash);
    if (!existsSync(dest)) throw new Error(`artifact not found: ${hash}`);
    return dest;
}

/** The recorded kind of a stored artifact — 'dir' for a directory tar that stage-in must unpack,
 *  'file' otherwise. Throws if no artifact with that hash is recorded. */
export function artifactKind(db: DB, hash: string): ArtifactKind {
    const row = db.query(`SELECT kind FROM artifacts WHERE hash = ?`).get(hash) as { kind: ArtifactKind } | null;
    if (!row) throw new Error(`artifact not found: ${hash}`);
    return row.kind;
}
