// Run user-provided ("custom") JavaScript in an isolated child process, with portable hard
// CPU + crash isolation and a portable RSS-poll soft memory cap. For BUGGY-not-hostile code:
// a runaway loop is SIGKILLed on timeout, unbounded allocation is SIGKILLed when RSS crosses
// the cap, and a crash/throw is contained — the daemon never goes down.
//
// Portability: process spawn + SIGKILL work on Linux/macOS/Windows. The memory cap is a soft
// cap enforced by polling the child's RSS (via /proc on Linux, `ps` elsewhere) — uniform
// across OSes, reactive rather than hard, which is the right trade for non-hostile code.
//
// Use it inside a normal step so the JSON result is memoized:
//   await ctx.step('transform', () => runIsolated(userCode, input, { memoryMb: 256, timeoutMs: 5000 }))

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./isolate-runner.ts', import.meta.url));

export interface IsolateOpts {
    timeoutMs?: number; // hard CPU/wall limit → SIGKILL (default 30s)
    memoryMb?: number; // RSS soft cap → SIGKILL when exceeded
    pollMs?: number; // memory poll interval (default 150ms)
}

/** Read a process's resident memory in bytes. /proc on Linux; `ps` fallback on other Unix. */
function readRssBytes(pid: number): number {
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

export async function runIsolated(code: string, input: unknown, opts: IsolateOpts = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const proc = Bun.spawn(['bun', RUNNER], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write(JSON.stringify({ code, input }));
    proc.stdin.end();

    let killed: 'timeout' | 'memory' | null = null;
    const timer = setTimeout(() => {
        killed = 'timeout';
        proc.kill(9);
    }, timeoutMs);
    const memoryBytes = (opts.memoryMb ?? 0) * 1024 * 1024;
    const poll = opts.memoryMb
        ? setInterval(() => {
              if (readRssBytes(proc.pid) > memoryBytes) {
                  killed = 'memory';
                  proc.kill(9);
              }
          }, opts.pollMs ?? 150)
        : undefined;

    const out = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    clearTimeout(timer);
    if (poll) clearInterval(poll);

    if (killed === 'timeout') throw new Error(`isolated step timed out after ${timeoutMs}ms (killed)`);
    if (killed === 'memory') throw new Error(`isolated step exceeded ${opts.memoryMb}MB (killed)`);
    if (exit !== 0) throw new Error(`isolated step crashed (exit ${exit})`);

    let parsed: { ok: boolean; result?: unknown; error?: string };
    try {
        parsed = JSON.parse(out);
    } catch {
        throw new Error(`isolated step produced no result (exit ${exit})`);
    }
    if (!parsed.ok) throw new Error(`isolated step failed: ${parsed.error}`);
    return parsed.result;
}
