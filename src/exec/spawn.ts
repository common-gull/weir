// Runtime-agnostic subprocess runner for the container substrate. The caller supplies the command
// line — a local bun shim in tests, a `docker run …` invocation later (C8) — and this module owns the
// mechanics: marshal the C1 input frame to stdin, stream stderr log lines to `onLog`, collect the
// child's raw stdout, and keep the daemon alive by SIGKILLing a runaway child on an optional
// wall-clock timeout or an output-size cap. `runProcess` hands back the raw `{ exitCode, stdout,
// stderr }` for a host-side extractor to interpret (#50); `runProtocol` is the thin wrapper that
// decodes that stdout as a C1 output frame — the default. It knows nothing about runtimes or
// containers; argv construction (C3) and Docker wiring (C8) live elsewhere.
//
// Both of the child's pipes are bounded: stderr streams line-by-line — a newline-less line is flushed
// once it crosses `maxStderrLineBytes`, so the parent's line buffer can't grow without bound — and
// stdout is read against `maxOutputBytes`, so a child that streams unbounded output without retaining
// it can't buffer the parent toward an OOM even while its own resident memory stays low.
//
// The timeout is explicit-only: with no `timeoutMs` the runner arms no wall-clock timer, so the child
// runs until it exits, is aborted via `signal`, or trips the output cap — matching a host closure
// step, which has no implicit deadline either. A hard, kernel-enforced memory limit is Docker's job
// (`--memory`, see buildDockerArgv), not this runner's — the old soft RSS poll is retired.

import { decodeProcessOutput, encodeInput, type LogFrame, type OutputFrame, parseLogLine } from './protocol.ts';

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_LINE_BYTES = 1024 * 1024;

export interface RunProtocolOpts {
    /** Command line to spawn; `argv[0]` is the executable. Constructed by the caller (C3/C8). */
    argv: string[];
    /** Working directory for the child — the step's scratch dir when it stages artifacts (#C6).
     *  Undefined leaves the child in the daemon cwd. */
    cwd?: string;
    /** Value marshalled into the C1 input frame on the child's stdin. */
    input: unknown;
    /** Aborts the run and SIGKILLs the child; the returned promise rejects with the signal's reason. */
    signal?: AbortSignal;
    /** Hard wall-clock limit before SIGKILL. Omitted, no timer is armed and the child runs until it
     *  exits on its own, is aborted via `signal`, or trips the output cap — matching a host closure
     *  step, which has no implicit deadline either. */
    timeoutMs?: number;
    /** Hard cap on total stdout bytes before SIGKILL (default 16 MiB), so an unbounded producer can't
     *  buffer the parent into an OOM. */
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

/** Longest prefix of `s` whose UTF-8 encoding fits in `maxBytes`, measured in UTF-16 code units.
 *  Iterating by code point (for…of) never cuts a surrogate pair, and at least one code point is always
 *  taken so a flush loop makes progress even when the leading character alone exceeds `maxBytes`. */
function byteBoundedPrefixLen(s: string, maxBytes: number): number {
    let bytes = 0;
    let units = 0;
    for (const ch of s) {
        const cp = ch.codePointAt(0) ?? 0;
        const chBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
        if (units > 0 && bytes + chBytes > maxBytes) break;
        bytes += chBytes;
        units += ch.length;
    }
    return units;
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
        // A single read can carry the buffer well past the cap (the runtime coalesces the child's
        // writes into chunks larger than maxLineBytes), so flush in byte-bounded pieces rather than
        // emitting the whole over-cap buffer as one frame — keeping every flushed frame near the cap
        // and the retained tail under it.
        while (bufBytes > maxLineBytes) {
            const cut = byteBoundedPrefixLen(buf, maxLineBytes);
            const piece = buf.slice(0, cut);
            onLine(piece);
            buf = buf.slice(cut);
            bufBytes -= Buffer.byteLength(piece);
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

/** The raw settled output of a spawned step: its exit code and captured stdout/stderr. A host-side
 *  extractor (engine, #50) normalizes this into the step result; frame decoding is just the default. */
export interface ProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/** Spawn `argv`, marshal the C1 input frame to stdin, and return the child's raw `{ exitCode, stdout,
 *  stderr }` — leaving interpretation to the caller's extractor. Rejects only when the child is
 *  forcibly stopped: SIGKILLed on an explicit timeout or the output-size cap, or aborted via `signal`.
 *  A plain non-zero exit is NOT an error here — it's a raw material the extractor decides on. */
export async function runProcess(opts: RunProtocolOpts): Promise<ProcessResult> {
    const { argv, input, signal, onLog } = opts;
    const timeoutMs = opts.timeoutMs;
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const maxStderrLineBytes = opts.maxStderrLineBytes ?? DEFAULT_MAX_STDERR_LINE_BYTES;

    if (argv.length === 0) throw new Error('runProtocol requires a non-empty argv');
    if (signal?.aborted) throw abortError(signal);

    const inputFrame = encodeInput(input); // may throw ProtocolError for non-JSON input — before we spawn

    const proc = Bun.spawn(argv, { cwd: opts.cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: opts.env });
    try {
        proc.stdin.write(inputFrame);
        proc.stdin.end();
    } catch {
        /* the child may have exited before reading stdin */
    }

    let killed: 'timeout' | 'abort' | 'output' | null = null;
    // Explicit-only: with no timeoutMs the child gets no wall-clock deadline (a hung child is still
    // stopped by `signal` or the output cap). The engine leans on this — a container step's deadline is
    // its `opts.timeout`, enforced by the shared attempt wrapper via `signal`, not a default baked here.
    const timer =
        timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                  killed = 'timeout';
                  proc.kill(9);
              }, timeoutMs);
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
    // Accumulate a bounded stderr transcript for the end-of-run extractor while still streaming each
    // line live to `onLog`. The live log channel is unchanged; this is a separate transcript the
    // extractor may inspect (e.g. a stock image that reports results on stderr), never the log path.
    let stderr = '';
    const stderrDone = pumpLines(proc.stderr, maxStderrLineBytes, (line) => {
        if (stderr.length < maxOutputBytes) stderr += stderr ? `\n${line}` : line;
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
        // during the exit/stderr drain below — a deadline reached under event-loop lag, or an abort
        // firing after the child already flushed a valid frame — must not turn that success into a
        // spurious failure. The guards stay armed (cleared in `finally`), so a child that closes stdout
        // without exiting is still SIGKILLed by the timeout rather than awaited forever.
        const killCause = killed;
        const exit = await proc.exited;
        await stderrDone;

        if (killCause === 'timeout') throw new Error(`protocol runner timed out after ${timeoutMs}ms (killed)`);
        if (killCause === 'output') {
            throw new Error(`protocol runner produced more than ${maxOutputBytes} bytes of output (killed)`);
        }
        if (killCause === 'abort' && signal) throw abortError(signal);
        return { exitCode: exit, stdout, stderr };
    } finally {
        // Guarantee no orphan survives an untracked stream error (e.g. reader.read() throwing for a
        // reason none of the `killed` causes cover); a no-op once the child has already exited.
        proc.kill(9);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/** The frame-protocol view of {@link runProcess}: decode the child's stdout as one C1 output frame and
 *  return the settled `{ ok, result | error }` envelope. Rejects when the child never spoke the
 *  protocol at all — SIGKILLed on a limit, aborted, or exited non-zero without writing a frame. */
export async function runProtocol(opts: RunProtocolOpts): Promise<OutputFrame> {
    const { exitCode, stdout } = await runProcess(opts);
    return decodeProcessOutput(exitCode, stdout);
}
