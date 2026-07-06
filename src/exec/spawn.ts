// Runtime-agnostic subprocess runner that speaks the C1 stdio protocol (src/exec/protocol.ts) to an
// injected argv. The caller supplies the command line — a local bun shim in tests, a `docker run …`
// invocation later (C8) — and this module owns the mechanics: marshal the input frame to stdin,
// stream stderr log lines to `onLog`, collect the single output frame from stdout, and keep the
// daemon alive by SIGKILLing a runaway child on a hard timeout, an output-size cap, or an optional
// RSS cap. It knows nothing about runtimes or containers; argv construction (C3) and Docker wiring
// (C8) live elsewhere.
//
// Both of the child's pipes are bounded, not just its RSS: stderr streams line-by-line — a
// newline-less line is flushed once it crosses `maxStderrLineBytes`, so the parent's line buffer
// can't grow without bound — and stdout is read against `maxOutputBytes`. The RSS poll alone can't
// catch a child that streams unbounded output without retaining it — its own resident memory stays
// low while it buffers the parent toward an OOM — so the daemon caps both pipes directly.
//
// The RSS poll reuses src/tools/isolate.ts's soft, portable memory cap (reactive, not enforced by
// the kernel) that trades a hard guarantee for uniform behavior across OSes — the right call for
// buggy, not hostile, code.

import { readRssBytes } from '../tools/isolate.ts';
import { decodeOutput, encodeInput, type LogFrame, type OutputFrame, parseLogLine } from './protocol.ts';

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_LINE_BYTES = 1024 * 1024;

export interface RunProtocolOpts {
    /** Command line to spawn; `argv[0]` is the executable. Constructed by the caller (C3/C8). */
    argv: string[];
    /** Value marshalled into the C1 input frame on the child's stdin. */
    input: unknown;
    /** Aborts the run and SIGKILLs the child; the returned promise rejects with the signal's reason. */
    signal?: AbortSignal;
    /** Hard wall-clock limit before SIGKILL (default 30s). */
    timeoutMs?: number;
    /** Soft RSS cap in MB; when the child's resident memory crosses it, SIGKILL. */
    memoryMb?: number;
    /** RSS poll interval when `memoryMb` is set (default 150ms). */
    pollMs?: number;
    /** Hard cap on total stdout bytes before SIGKILL (default 16 MiB). Bounds the output frame the
     *  RSS cap can't: a child that streams output without retaining it stays under `memoryMb`. */
    maxOutputBytes?: number;
    /** Per-line cap on the stderr buffer (default 1 MiB). A newline-less line is flushed once it
     *  crosses this, so a runaway or adversarial child can't grow the parent's buffer without bound. */
    maxStderrLineBytes?: number;
    /** Receives each stderr line as a log frame; unstructured lines arrive as info-level frames. */
    onLog?: (frame: LogFrame) => void;
    /** Environment for the child. When set it *replaces* the daemon's env (Bun does not merge), so the
     *  caller decides exactly what the subprocess can see — see `resolveExecEnv` for the capability
     *  policy. Omitted, the child inherits the daemon's full environment (the runner's raw default). */
    env?: Record<string, string>;
}

/** Split a byte stream into lines and hand each to `onLine` (a trailing partial line is emitted too).
 *  A newline-less line is flushed once it grows past `maxLineBytes`, so the buffer stays bounded and
 *  an adversarial child can't buffer the parent toward an OOM. */
async function pumpLines(
    stream: ReadableStream<Uint8Array>,
    maxLineBytes: number,
    onLine: (line: string) => void,
): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Bound the buffer by UTF-8 byte count, not buf.length (UTF-16 code units): one multi-byte
    // character is a single code unit but up to 4 bytes, so a code-unit cap would let the buffer grow
    // to several times maxLineBytes. While we only append, `value.byteLength` is the exact byte count;
    // once a newline lets us drop leading lines, recompute the shrunk tail's byte size.
    let bufBytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        bufBytes += value.byteLength;
        let nl = buf.indexOf('\n');
        if (nl !== -1) {
            while (nl !== -1) {
                onLine(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
                nl = buf.indexOf('\n');
            }
            bufBytes = Buffer.byteLength(buf);
        }
        if (bufBytes > maxLineBytes) {
            onLine(buf);
            buf = '';
            bufBytes = 0;
        }
    }
    const tail = buf + decoder.decode();
    if (tail) onLine(tail);
}

/** Read a byte stream to text, but stop and invoke `onOverflow` once accumulated bytes exceed `cap`.
 *  Bounds stdout the way pumpLines bounds stderr, so an unbounded producer can't buffer the parent
 *  into an OOM; the accumulated string never grows past `cap` (the overflowing chunk is dropped). */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number, onOverflow: () => void): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > cap) {
                onOverflow();
                break;
            }
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        reader.releaseLock();
    }
    return text + decoder.decode();
}

function forwardLog(line: string, onLog: (frame: LogFrame) => void): void {
    const frame = parseLogLine(line);
    if (frame) {
        onLog(frame);
    } else if (line.trim()) {
        // Raw diagnostics (stack traces, tool chatter) aren't dropped — surface them at info level.
        onLog({ level: 'info', message: line });
    }
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error('protocol runner aborted');
}

/** Spawn `argv`, exchange one input frame for one output frame over the C1 protocol, and return the
 *  decoded output envelope. Rejects instead when the child never speaks the protocol: SIGKILLed on
 *  the timeout or RSS cap, aborted via `signal`, or exited without a frame. */
export async function runProtocol(opts: RunProtocolOpts): Promise<OutputFrame> {
    const { argv, input, signal, memoryMb, onLog } = opts;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const maxStderrLineBytes = opts.maxStderrLineBytes ?? DEFAULT_MAX_STDERR_LINE_BYTES;

    if (argv.length === 0) throw new Error('runProtocol requires a non-empty argv');
    if (signal?.aborted) throw abortError(signal);

    const inputFrame = encodeInput(input); // may throw ProtocolError for non-JSON input — before we spawn

    const proc = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: opts.env });
    try {
        proc.stdin.write(inputFrame);
        proc.stdin.end();
    } catch {
        /* the child may have exited before reading stdin */
    }

    let killed: 'timeout' | 'memory' | 'abort' | 'output' | null = null;
    const timer = setTimeout(() => {
        killed = 'timeout';
        proc.kill(9);
    }, timeoutMs);
    const memoryBytes = (memoryMb ?? 0) * 1024 * 1024;
    const poll = memoryMb
        ? setInterval(() => {
              if (readRssBytes(proc.pid) > memoryBytes) {
                  killed = 'memory';
                  proc.kill(9);
              }
          }, opts.pollMs ?? 150)
        : undefined;
    const onAbort = () => {
        killed = 'abort';
        proc.kill(9);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Always drain stderr, even without an onLog, so a chatty child can't deadlock on a full pipe.
    // stderrDone isn't awaited until stdout drains and the child exits — potentially seconds later — so
    // guard the pump on both fronts. A throwing log sink is caught per line so it neither aborts
    // draining nor rejects the promise; the trailing .catch keeps a stray stream-read error from
    // becoming an unhandled rejection (which would crash the daemon) during that unawaited window.
    const stderrDone = pumpLines(proc.stderr, maxStderrLineBytes, (line) => {
        if (!onLog) return;
        try {
            forwardLog(line, onLog);
        } catch {
            /* best-effort diagnostics: a failing log sink must not tear down the run */
        }
    }).catch(() => undefined);

    try {
        const stdout = await readCapped(proc.stdout, maxOutputBytes, () => {
            killed = 'output';
            proc.kill(9);
        });
        // Freeze the kill cause the instant we hold the complete stdout frame. A kill that only trips
        // during the exit/stderr drain below — a deadline reached under event-loop lag, an abort, an RSS
        // poll firing after the child already flushed a valid frame — must not turn that success into a
        // spurious failure. The guards stay armed (cleared in `finally`), so a child that closes stdout
        // without exiting is still SIGKILLed by the timeout rather than awaited forever.
        const killCause = killed;
        const exit = await proc.exited;
        await stderrDone;

        if (killCause === 'timeout') throw new Error(`protocol runner timed out after ${timeoutMs}ms (killed)`);
        if (killCause === 'memory') throw new Error(`protocol runner exceeded ${memoryMb}MB (killed)`);
        if (killCause === 'output') {
            throw new Error(`protocol runner produced more than ${maxOutputBytes} bytes of output (killed)`);
        }
        if (killCause === 'abort' && signal) throw abortError(signal);
        if (exit !== 0 && stdout.trim() === '') {
            throw new Error(`protocol runner exited ${exit} without an output frame`);
        }
        return decodeOutput(stdout);
    } finally {
        // Guarantee no orphan survives an untracked stream error (e.g. reader.read() throwing for a
        // reason none of the `killed` causes cover); a no-op once the child has already exited.
        proc.kill(9);
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        signal?.removeEventListener('abort', onAbort);
    }
}
