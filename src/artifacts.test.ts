import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactHash, artifactKind, getArtifact, hashFile, putArtifact } from './artifacts.ts';
import { type DB, openDb } from './db.ts';

let db: DB;
let dir: string;

beforeEach(async () => {
    db = openDb(':memory:');
    dir = await mkdtemp(join(tmpdir(), 'weir-artifacts-'));
});
afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
});

test('put/get round-trips raw bytes and records size', async () => {
    const bytes = new TextEncoder().encode('hello artifact');
    const hash = await putArtifact(db, dir, bytes);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const path = getArtifact(dir, hash);
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);

    const row = db.query(`SELECT size, created_at FROM artifacts WHERE hash = ?`).get(hash) as {
        size: number;
        created_at: number;
    };
    expect(row.size).toBe(bytes.byteLength);
    expect(row.created_at).toBeGreaterThan(0);
});

test('stores a file path by reading its bytes', async () => {
    const file = join(dir, 'input.txt');
    await writeFile(file, 'from a file');
    const hash = await putArtifact(db, dir, file);
    expect(await readFile(getArtifact(dir, hash), 'utf8')).toBe('from a file');
});

test('identical content dedups to one key, one file, one row', async () => {
    const first = await putArtifact(db, dir, new TextEncoder().encode('same'));
    const second = await putArtifact(db, dir, new TextEncoder().encode('same'));
    expect(second).toBe(first);
    // exactly one artifact file on disk, and no leftover temp files
    expect(readdirSync(dir)).toEqual([first]);
    expect(db.query(`SELECT COUNT(*) AS c FROM artifacts`).get()).toEqual({ c: 1 });
});

test('different content hashes to different keys', async () => {
    const a = await putArtifact(db, dir, new TextEncoder().encode('one'));
    const b = await putArtifact(db, dir, new TextEncoder().encode('two'));
    expect(a).not.toBe(b);
    expect(existsSync(getArtifact(dir, a))).toBe(true);
    expect(db.query(`SELECT COUNT(*) AS c FROM artifacts`).get()).toEqual({ c: 2 });
});

test('getArtifact throws for an unknown hash and a malformed one', () => {
    expect(() => getArtifact(dir, 'a'.repeat(64))).toThrow(/not found/);
    expect(() => getArtifact(dir, 'not-a-hash')).toThrow(/invalid/);
});

test('hashFile streams a multi-chunk file to the same hash as buffering it whole', async () => {
    // Larger than a single stream chunk, so a correct stream hash must fold every chunk in — the
    // property that lets a large blob hash without being read wholly into memory.
    const bytes = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const file = join(dir, 'big.bin');
    await writeFile(file, bytes);
    expect(await hashFile(file)).toBe(artifactHash(bytes));
});

test('records the artifact kind and artifactKind reads it back', async () => {
    const fileHash = await putArtifact(db, dir, new TextEncoder().encode('plain'));
    expect(artifactKind(db, fileHash)).toBe('file');

    const dirHash = await putArtifact(db, dir, new TextEncoder().encode('a tar blob'), 'dir');
    expect(artifactKind(db, dirHash)).toBe('dir');

    expect(() => artifactKind(db, 'b'.repeat(64))).toThrow(/not found/);
});
