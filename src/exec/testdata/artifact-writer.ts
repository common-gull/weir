// Fixture step for the engine's artifact tests: writes `input.text` to `input.path` in the cwd
// (its scratch dir) so the engine can snapshot it as a declared output. The console.warn lets a test
// count how many times the subprocess actually ran (to prove a memo replay does not rebuild).
import { writeFile } from 'node:fs/promises';

export default async (input: { path: string; text: string }) => {
    console.warn('WRITE');
    await writeFile(input.path, input.text);
    return { wrote: input.path };
};
