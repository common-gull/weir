// Content-addressed artifact store: the tier-2 hand-off for bytes/files too big for the JSON memo
// (SQLite). Content lives on disk under `<storeDir>/<sha256>`, deduped by hash — identical content
// is stored once. A directory tree is archived to one tar and stored as a single blob (kind 'dir'),
// unpacked on stage-in. The `artifacts` table (see db.ts SCHEMA) records size + kind + first-seen
// time; the file on disk is the source of truth for reads.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/** Record a stored blob's row — size + kind + first-seen time, keyed by content hash. Idempotent
 *  (INSERT OR IGNORE) so a repeat put of already-stored content leaves the original row untouched. */
function recordArtifact(db: DB, hash: string, size: number, kind: ArtifactKind): void {
    db.query(`INSERT OR IGNORE INTO artifacts (hash, size, kind, created_at) VALUES (?, ?, ?, ?)`).run(
        hash,
        size,
        kind,
        Date.now(),
    );
}

/** Store `src` (a file path or raw bytes) under `storeDir` and return its sha256 hex hash. A path
 *  source is copied into a private temp and then hashed *from that copy*, so the bytes landed under
 *  `hash` are provably the ones it names: hashing the source and copying it in two independent passes
 *  could store bytes that no longer match `hash` if the source is mutated (or read inconsistently)
 *  between them, corrupting the content-addressing dedup and integrity rely on. Copying at the OS
 *  level keeps a large file off the heap; an atomic temp+rename means a crash mid-write can't leave a
 *  truncated file under a valid hash. `kind` tags the blob 'file' (default) or 'dir' (a directory tar,
 *  see stageInputs). Identical content reuses the same key, so a repeat put is a no-op on disk. */
export async function putArtifact(
    db: DB,
    storeDir: string,
    src: string | Uint8Array,
    kind: ArtifactKind = 'file',
): Promise<string> {
    await mkdir(storeDir, { recursive: true });
    if (typeof src === 'string') {
        const tmp = join(storeDir, `${crypto.randomUUID()}.tmp`);
        await copyFile(src, tmp);
        const hash = await hashFile(tmp);
        const size = (await stat(tmp)).size;
        const dest = join(storeDir, hash);
        // Rename the just-hashed copy into place, or drop it if the content is already stored — either
        // way the store keeps one file per hash and leaves no stray temp behind.
        if (existsSync(dest)) await rm(tmp, { force: true });
        else await rename(tmp, dest);
        recordArtifact(db, hash, size, kind);
        return hash;
    }
    // Raw bytes are already in memory: the buffer hashed is the buffer written, so no second read can
    // diverge from `hash`.
    const hash = artifactHash(src);
    const dest = join(storeDir, hash);
    if (!existsSync(dest)) {
        const tmp = `${dest}.${crypto.randomUUID()}.tmp`;
        await writeFile(tmp, src);
        await rename(tmp, dest);
    }
    recordArtifact(db, hash, src.byteLength, kind);
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
