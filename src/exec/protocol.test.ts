import { expect, test } from 'bun:test';
import {
    decodeInput,
    decodeOutput,
    encodeInput,
    encodeLogLine,
    encodeOutput,
    type OutputFrame,
    parseLogLine,
    ProtocolError,
} from './protocol.ts';

test('input frame round-trips plain JSON data', () => {
    for (const v of [null, 0, 'x', true, [1, 'x', { c: true }], { a: 1, b: [2] }]) {
        expect(decodeInput(encodeInput(v))).toEqual(v);
    }
});

test('encodeInput normalizes undefined to null so the frame is a valid string', () => {
    const raw = encodeInput(undefined);
    expect(JSON.parse(raw)).toEqual({ input: null });
    expect(decodeInput(raw)).toBeNull();
});

test('encodeInput rejects values JSON would silently drop', () => {
    expect(() => encodeInput({ cb: () => {} })).toThrow(/function/);
    expect(() => encodeInput(new Map([['a', 1]]))).toThrow(/Map/);
});

test('encode rejects NaN/Infinity instead of silently coercing them to null', () => {
    expect(() => encodeInput(NaN)).toThrow(/non-finite/);
    expect(() => encodeInput({ rate: Infinity })).toThrow(/non-finite/);
    expect(() => encodeOutput({ ok: true, result: -Infinity })).toThrow(/non-finite/);
    expect(() => encodeOutput({ ok: true, result: { avg: NaN } })).toThrow(/non-finite/);
});

test('encode failures are ProtocolErrors framed for the slot, not "returned"', () => {
    expect(() => encodeInput({ cb: () => {} })).toThrow(ProtocolError);
    expect(() => encodeInput({ cb: () => {} })).not.toThrow(/returned/);
    expect(() => encodeOutput({ ok: true, result: new Map() })).toThrow(ProtocolError);
});

test('decodeInput rejects malformed input frames', () => {
    expect(() => decodeInput('not json')).toThrow(ProtocolError);
    expect(() => decodeInput('[]')).toThrow(/"input" field/);
    expect(() => decodeInput('42')).toThrow(/"input" field/);
    expect(() => decodeInput('{"nope":1}')).toThrow(/"input" field/);
});

test('output frame round-trips success and failure', () => {
    const frames: OutputFrame[] = [
        { ok: true, result: { n: 1, xs: [1, 2] } },
        { ok: true, result: null },
        { ok: false, error: 'boom' },
    ];
    for (const f of frames) {
        expect(decodeOutput(encodeOutput(f))).toEqual(f);
    }
});

test('encodeOutput normalizes an undefined result to null', () => {
    expect(decodeOutput(encodeOutput({ ok: true, result: undefined }))).toEqual({ ok: true, result: null });
});

test('encodeOutput rejects a non-serializable result', () => {
    expect(() => encodeOutput({ ok: true, result: { s: new Set([1]) } })).toThrow(/Set/);
});

test('decodeOutput reads the plain output frame a runtime shim writes', () => {
    // Byte-for-byte what a shim (src/exec/shims/*) emits on stdout.
    expect(decodeOutput('{"ok":true,"result":42}')).toEqual({ ok: true, result: 42 });
    expect(decodeOutput('{"ok":false,"error":"bad input frame"}')).toEqual({
        ok: false,
        error: 'bad input frame',
    });
});

test('decodeOutput rejects malformed output frames', () => {
    expect(() => decodeOutput('not json')).toThrow(/valid JSON/);
    expect(() => decodeOutput('[]')).toThrow(/JSON object/);
    expect(() => decodeOutput('{"result":1}')).toThrow(/boolean "ok"/);
    expect(() => decodeOutput('{"ok":"yes"}')).toThrow(/boolean "ok"/);
    expect(() => decodeOutput('{"ok":false}')).toThrow(/string "error"/);
    expect(() => decodeOutput('{"ok":false,"error":42}')).toThrow(/string "error"/);
});

test('log lines round-trip across every level', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        expect(parseLogLine(encodeLogLine({ level, message: 'hi' }))).toEqual({ level, message: 'hi' });
    }
});

test('parseLogLine treats non-frame stderr as raw passthrough (null)', () => {
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('   ')).toBeNull();
    expect(parseLogLine('Error: something threw\n    at foo')).toBeNull();
    expect(parseLogLine('{"message":"no level"}')).toBeNull();
    expect(parseLogLine('{"level":"trace","message":"unknown level"}')).toBeNull();
    expect(parseLogLine('{"level":"info","message":123}')).toBeNull();
    expect(parseLogLine('["info","not an object"]')).toBeNull();
});

test('parseLogLine tolerates surrounding whitespace', () => {
    expect(parseLogLine('  {"level":"warn","message":"spaced"}  ')).toEqual({ level: 'warn', message: 'spaced' });
});
