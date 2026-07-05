// The stdio control envelope every step runtime speaks — the language-agnostic anchor of the
// container substrate. Generalized from the `{ ok, result | error }` contract the isolate runner
// writes on stdout (`src/tools/isolate-runner.ts`), split into three frames:
//
//   - input  (host → container, one JSON object on stdin)
//   - output (container → host, one JSON object on stdout: `{ ok, result | error }`)
//   - log    (container → host, newline-delimited JSON on stderr)
//
// Pure encode/decode only: no spawning, no argv, no runtime knowledge. A runtime in any language
// can implement it by reading one input frame and writing one output frame (plus optional logs).
// `assertSerializable` (from db.ts) guards the JSON boundary on the way out, so a frame that can't
// survive JSON is rejected at encode time rather than silently mangled on the wire.

import { assertSerializable } from '../db.ts';

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
    assertSerializable(input, 'input');
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

/** The settled result of a step, mirroring the isolate runner's stdout contract. */
export type OutputFrame = { ok: true; result: unknown } | { ok: false; error: string };

export function encodeOutput(frame: OutputFrame): string {
    if (frame.ok) {
        assertSerializable(frame.result, 'output result');
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
