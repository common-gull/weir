// The stdio control envelope every step runtime speaks — the language-agnostic anchor of the
// container substrate. A step's settled `{ ok, result | error }` contract, split into three frames:
//
//   - input  (host → container, one JSON object on stdin)
//   - output (container → host, one JSON object on stdout: `{ ok, result | error }`)
//   - log    (container → host, newline-delimited JSON on stderr)
//
// Pure encode/decode only: no spawning, no argv, no runtime knowledge. A runtime in any language
// can implement it by reading one input frame and writing one output frame (plus optional logs).
// `jsonLossReason` guards the JSON boundary on the way out, so a frame carrying a value JSON can't
// preserve — a function, a Map, NaN/Infinity — is rejected at encode time rather than silently
// mangled on the wire. It lives here, not in db.ts, so this module stays a dependency-free leaf: it's
// baked verbatim into the weir-node base image and loaded by the node shim, where only the
// interpreter — no bun:sqlite, no engine code — is present.

/** Thrown when a frame is structurally malformed (bad JSON or missing/ill-typed fields). */
export class ProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProtocolError';
    }
}

// ---- input frame (host → container) ----

/** The payload delivered to a container on stdin. Wrapped so a `undefined` input is representable
 *  (bare `JSON.stringify(undefined)` yields no string) and so the frame can grow metadata later. */
export interface InputFrame {
    input: unknown;
}

export function encodeInput(input: unknown): string {
    assertFrameValue(input, 'input frame');
    return JSON.stringify({ input: input === undefined ? null : input });
}

export function decodeInput(raw: string): unknown {
    const obj = asRecord(parseJson(raw, 'input'));
    if (!obj || !('input' in obj)) {
        throw new ProtocolError('input frame must be a JSON object with an "input" field');
    }
    return obj.input;
}

// ---- output frame (container → host) ----

/** The settled result of a step: exactly one output frame a runtime shim writes to stdout. */
export type OutputFrame = { ok: true; result: unknown } | { ok: false; error: string };

export function encodeOutput(frame: OutputFrame): string {
    if (frame.ok) {
        assertFrameValue(frame.result, 'output result');
        return JSON.stringify({ ok: true, result: frame.result === undefined ? null : frame.result });
    }
    return JSON.stringify({ ok: false, error: frame.error });
}

export function decodeOutput(raw: string): OutputFrame {
    const obj = asRecord(parseJson(raw, 'output'));
    if (!obj) throw new ProtocolError('output frame must be a JSON object');
    if (obj.ok === true) {
        return { ok: true, result: obj.result === undefined ? null : obj.result };
    }
    if (obj.ok === false) {
        if (typeof obj.error !== 'string') {
            throw new ProtocolError('failed output frame must carry a string "error"');
        }
        return { ok: false, error: obj.error };
    }
    throw new ProtocolError('output frame must have a boolean "ok" field');
}

/** Decode a settled process's exit code and captured stdout as an output frame. A non-zero exit with
 *  empty stdout means the child never wrote a frame at all — distinguished from a malformed one, and
 *  reported before attempting to decode. */
export function decodeProcessOutput(exitCode: number, stdout: string): OutputFrame {
    if (exitCode !== 0 && stdout.trim() === '') {
        throw new Error(`protocol runner exited ${exitCode} without an output frame`);
    }
    return decodeOutput(stdout);
}

// ---- log convention (container → host, newline-delimited JSON on stderr) ----

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogFrame {
    level: LogLevel;
    message: string;
}

/** One log line (no trailing newline; the writer joins lines with `\n`). */
export function encodeLogLine(frame: LogFrame): string {
    return JSON.stringify({ level: frame.level, message: frame.message });
}

/** Parse a single stderr line. Returns `null` for blank lines and anything that isn't a well-formed
 *  log frame, so a container's raw diagnostics (stack traces, plain text) pass through untouched. */
export function parseLogLine(line: string): LogFrame | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    const obj = asRecord(parsed);
    if (!obj || !isLogLevel(obj.level) || typeof obj.message !== 'string') return null;
    return { level: obj.level, message: obj.message };
}

// ---- internals ----

/** Reject a value JSON can't round-trip, phrased for the frame slot it fills (`what`). This is the
 *  module's guarantee that a bad value fails at encode time instead of mangling on the wire. */
function assertFrameValue(value: unknown, what: string): void {
    const lossy = jsonLossReason(value);
    if (lossy) {
        throw new ProtocolError(`${what} holds a value JSON can't preserve (${lossy}) — send plain JSON data.`);
    }
}

/** Return a human reason if JSON would silently drop/mangle `value`, or outright fail to stringify
 *  it (e.g. a throwing custom `toJSON`), else null. Top-level `undefined` is representable (callers
 *  store or normalize it as null), so it counts as no loss. */
export function jsonLossReason(value: unknown): string | null {
    if (value === undefined) return null;
    const lossy = jsonLossReasonAt(value, new Set());
    if (lossy) return lossy;
    try {
        JSON.stringify(value);
        return null;
    } catch (e) {
        return (e as Error).message;
    }
}

function jsonLossReasonAt(v: unknown, seen: Set<object>): string | null {
    const t = typeof v;
    // NaN/Infinity are numbers JSON.stringify silently coerces to null — a loss, not lossless.
    if (t === 'number') return Number.isFinite(v as number) ? null : `a non-finite number (${v})`;
    if (v === null || t === 'string' || t === 'boolean') return null;
    if (t === 'function') return 'a function';
    if (t === 'symbol') return 'a symbol';
    if (t === 'bigint') return 'a bigint';
    if (t !== 'object') return `a ${t}`;
    const o = v as object;
    if (seen.has(o)) return 'a circular reference';
    if (o instanceof Map) return 'a Map';
    if (o instanceof Set) return 'a Set';
    // Track only the ancestors on the current path so shared (DAG) references — the same object
    // reached twice via sibling fields — aren't misread as cycles; unwind on the way back out.
    seen.add(o);
    try {
        if (Array.isArray(o)) {
            for (const item of o) {
                const r = jsonLossReasonAt(item, seen);
                if (r) return r;
            }
            return null;
        }
        // Plain object (Date → ISO string and class instances keep their data, so both pass).
        for (const k of Object.keys(o)) {
            const val = (o as Record<string, unknown>)[k];
            if (val === undefined) return `an undefined value at "${k}"`;
            const r = jsonLossReasonAt(val, seen);
            if (r) return r;
        }
        return null;
    } finally {
        seen.delete(o);
    }
}

function parseJson(raw: string, what: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        throw new ProtocolError(`${what} frame is not valid JSON`);
    }
}

function asRecord(v: unknown): Record<string, unknown> | null {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isLogLevel(v: unknown): v is LogLevel {
    return typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v);
}
