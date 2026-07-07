import { expect, test } from 'bun:test';
import { readRssBytes } from './rss.ts';

test('reports a live process using a positive number of bytes', () => {
    expect(readRssBytes(process.pid)).toBeGreaterThan(0);
});

test('returns 0 for a pid that resolves to no process', () => {
    // Above every plausible pid_max, so neither /proc/<pid>/statm nor `ps -p` finds a process — the
    // path a poll hits when the child has already exited.
    expect(readRssBytes(2 ** 31 - 1)).toBe(0);
});
