// Rung-1 node runtime shim. src/exec/runtime.ts spawns this as `bun node-shim.ts <module>`; it
// speaks the C1 protocol (src/exec/protocol.ts) so an author writes just `export default (input) =>
// output`. Generalizes src/tools/isolate-runner.ts from inlined code to a shipped-in module path.
// Written in portable JS (no Bun-only globals) so the same file runs under host bun today and a real
// node base image under C8 (docker) tomorrow — mirroring the substrate-independent python shim.
//
// stdout carries exactly one output frame, so everything the step writes to stdout — console.* and
// direct process.stdout writes alike — is rerouted to the stderr log channel before the module loads;
// otherwise a stray write would corrupt the frame. Writes that bypass the JS stream (a native addon,
// or a child that inherits fd 1) can't be intercepted in-process; the container owns that under C8.

import { writeSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { decodeInput, encodeLogLine, encodeOutput, type LogLevel, type OutputFrame } from '../protocol.ts';

function emit(level: LogLevel, args: unknown[]): void {
    const message = args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
    process.stderr.write(`${encodeLogLine({ level, message })}\n`);
}

console.log = (...args) => emit('info', args);
console.info = (...args) => emit('info', args);
console.debug = (...args) => emit('debug', args);
console.warn = (...args) => emit('warn', args);
console.error = (...args) => emit('error', args);

// Progress bars, custom loggers, and libraries write straight to process.stdout, bypassing console.*;
// route those to the log channel too. Honour the optional write callback so a caller awaiting it (a
// backpressure-aware writer) isn't left hanging.
process.stdout.write = ((chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown): boolean => {
    emit('info', [typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()]);
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (typeof callback === 'function') (callback as () => void)();
    return true;
}) as typeof process.stdout.write;

// The output frame goes straight to fd 1, bypassing the rerouted stream above. A `settled` guard plus
// an exit hook guarantee exactly one frame even when the step calls process.exit() before run()
// resolves — otherwise the runner would see empty stdout and a bare non-zero exit, not a frame.
let settled = false;
function writeFrame(frame: OutputFrame): void {
    if (settled) return;
    const encoded = encodeOutput(frame); // may throw for a lossy result — settled stays false so the catch can retry
    settled = true;
    writeSync(1, encoded);
}

process.on('exit', () => writeFrame({ ok: false, error: 'step exited the process before returning a result' }));

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
    writeFrame({ ok: true, result: await run() });
} catch (e) {
    writeFrame({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
