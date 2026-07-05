// Protocol-honoring bun fixture for src/exec/spawn.test.ts. Reads one C1 input frame from stdin and
// writes one output frame to stdout, branching on `input.mode` so the runner's log, timeout, memory,
// failure, and crash paths can be driven without a container runtime. This is a stand-in for the
// argv a real runtime (C3/C8) would supply — the runner never inspects it, only speaks the protocol.

import { decodeInput, encodeLogLine, encodeOutput, type LogLevel } from '../protocol.ts';

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

function log(level: LogLevel, message: string): void {
    process.stderr.write(`${encodeLogLine({ level, message })}\n`);
}

const input = decodeInput(await Bun.stdin.text());
const mode = isRecord(input) ? input.mode : undefined;

if (mode === 'hang') {
    let spin = 0;
    while (spin >= 0) spin += 1; // busy loop, never writes output → parent SIGKILLs it on the timeout
} else if (mode === 'oom') {
    const chunks: unknown[] = [];
    for (;;) chunks.push(new Array(1_000_000).fill(7)); // grow RSS → parent SIGKILLs it on the cap
} else if (mode === 'flood') {
    const chunk = 'x'.repeat(128 * 1024);
    // Stream stdout without retaining it: own RSS stays low, so only the parent's output cap stops us.
    for (;;) {
        process.stdout.write(chunk);
        await Bun.sleep(0); // yield so bytes flush to the parent, which trips its cap and SIGKILLs us
    }
} else if (mode === 'crash') {
    process.exit(3); // exit non-zero without ever writing an output frame
} else {
    if (mode === 'logs') {
        for (const level of ['debug', 'info', 'warn', 'error'] as const) log(level, `${level} from shim`);
    } else if (mode === 'raw') {
        process.stderr.write('raw diagnostic, not a protocol frame\n');
    }
    if (mode === 'fail') {
        const message = isRecord(input) && typeof input.message === 'string' ? input.message : 'shim failure';
        process.stdout.write(encodeOutput({ ok: false, error: message }));
    } else {
        process.stdout.write(encodeOutput({ ok: true, result: input }));
    }
}
