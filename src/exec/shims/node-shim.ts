// Rung-1 node runtime shim. src/exec/runtime.ts spawns this as `bun node-shim.ts <module>`; it
// speaks the C1 protocol (src/exec/protocol.ts) so an author writes just `export default (input) =>
// output`. Generalizes src/tools/isolate-runner.ts from inlined code to a shipped-in module path.
// Written in portable JS (no Bun-only globals) so the same file runs under host bun today and a real
// node base image under C8 (docker) tomorrow — mirroring the substrate-independent python shim.
//
// stdout carries exactly one output frame, so user `console.*` is rerouted to the stderr log channel
// before the module loads — otherwise a stray `console.log` would corrupt the frame.

import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { decodeInput, encodeLogLine, encodeOutput, type LogLevel } from '../protocol.ts';

function emit(level: LogLevel, args: unknown[]): void {
    const message = args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
    process.stderr.write(`${encodeLogLine({ level, message })}\n`);
}

console.log = (...args) => emit('info', args);
console.info = (...args) => emit('info', args);
console.debug = (...args) => emit('debug', args);
console.warn = (...args) => emit('warn', args);
console.error = (...args) => emit('error', args);

async function run(): Promise<unknown> {
    const modulePath = process.argv[2];
    if (!modulePath) throw new Error('node shim: missing module path argument');
    const input = decodeInput(await text(process.stdin));
    const mod = await import(pathToFileURL(modulePath).href);
    if (typeof mod.default !== 'function') {
        throw new Error('step module must `export default` a function: (input) => output');
    }
    return mod.default(input);
}

try {
    process.stdout.write(encodeOutput({ ok: true, result: await run() }));
} catch (e) {
    process.stdout.write(encodeOutput({ ok: false, error: e instanceof Error ? e.message : String(e) }));
}
