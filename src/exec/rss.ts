// The reactive memory probe behind the exec runner's soft RSS cap (spawn.ts). A portable, best-effort
// read of a process's resident set — reactive, not kernel-enforced — that trades a hard guarantee for
// uniform behavior across OSes: the right call for buggy, not hostile, code. A real kernel-enforced
// limit is Docker's job (C8).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Read a process's resident memory in bytes. /proc on Linux; `ps` fallback on other Unix. Returns 0
 *  when the process is gone or unreadable, so a poll treats a vanished child as using no memory. */
export function readRssBytes(pid: number): number {
    try {
        const resident = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/)[1]);
        if (Number.isFinite(resident)) return resident * 4096;
    } catch {
        /* not Linux, or gone */
    }
    try {
        const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
            stdio: ['ignore', 'pipe', 'ignore'],
        })
            .toString()
            .trim();
        return Number(out) * 1024;
    } catch {
        return 0;
    }
}
