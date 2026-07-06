// Fixture step for the engine's artifact tests: reads `input.path` from the cwd (its scratch dir)
// and returns the bytes. A declared input artifact staged in by the engine is what it reads back.
import { readFile } from 'node:fs/promises';

export default async (input: { path: string }) => ({ content: await readFile(input.path, 'utf8') });
