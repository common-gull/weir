// Content-addressed artifact store: the tier-2 hand-off for bytes/files too big for the JSON memo
// (SQLite). Content lives on disk under `<storeDir>/<sha256>`, deduped by hash — identical content
// is stored once. The `artifacts` table (see db.ts SCHEMA) records size + first-seen time; the file
// on disk is the source of truth for reads.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DB } from './db.ts';

const HASH_RE = /^[0-9a-f]{64}$/;

/** The content address (sha256 hex) of raw bytes — the key putArtifact stores them under. Exposed so
 *  a caller can content-address bytes without committing them to the store yet. */
export function artifactHash(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** Store `src` (a file path or raw bytes) under `storeDir` and return its sha256 hex hash.
 *  Identical content reuses the same key, so a repeat put is a no-op on disk (dedup). */
export async function putArtifact(db: DB, storeDir: string, src: string | Uint8Array): Promise<string> {
    const bytes = typeof src === 'string' ? await readFile(src) : src;
    const hash = artifactHash(bytes);
    const dest = join(storeDir, hash);
    await mkdir(storeDir, { recursive: true });
    if (!existsSync(dest)) {
        // Write to a unique temp then rename: an atomic swap so a crash mid-write can't leave a
        // truncated file masquerading under a valid content hash.
        const tmp = `${dest}.${crypto.randomUUID()}.tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, dest);
    }
    db.query(`INSERT OR IGNORE INTO artifacts (hash, size, created_at) VALUES (?, ?, ?)`).run(
        hash,
        bytes.byteLength,
        Date.now(),
    );
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
