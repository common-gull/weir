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
} else if (mode === 'stderr-bigline') {
    // Stream one newline-less line in chunks over time: the parent must flush each read, not
    // accumulate the whole line, so its buffer can't grow without bound.
    const chunk = 'e'.repeat(32 * 1024);
    for (let i = 0; i < 8; i++) {
        process.stderr.write(chunk);
        await Bun.sleep(0); // yield so each chunk reaches the parent as its own read
    }
    process.stdout.write(encodeOutput({ ok: true, result: 'done' }));
} else if (mode === 'stderr-multibyte') {
    // Same as stderr-bigline but with 3-byte UTF-8 characters: the parent must cap its buffer by
    // byte count, not UTF-16 code units, or the buffer grows to ~3x maxStderrLineBytes before a flush.
    const chunk = '好'.repeat(24 * 1024); // 24Ki code units, 72 KiB
    for (let i = 0; i < 6; i++) {
        process.stderr.write(chunk);
        await Bun.sleep(0); // yield so each chunk reaches the parent as its own read
    }
    process.stdout.write(encodeOutput({ ok: true, result: 'done' }));
} else if (mode === 'frame-then-linger-stderr') {
    // Flush a valid output frame and exit at once, but leave a detached grandchild holding the stderr
    // pipe open for a while. The parent's stdout read and the child exit settle immediately, yet the
    // parent's stderr drain stays pending across a shorter timeout deadline — the late SIGKILL that
    // fires in that window must not overwrite the already-delivered frame with a timeout error. (A live
    // Bun process can't release its own stdout pipe, so a lingering grandchild is how the post-read
    // window is widened deterministically.)
    const grandchild = Bun.spawn(['bun', '-e', 'await Bun.sleep(1000)'], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'inherit',
    });
    grandchild.unref();
    await Bun.write(Bun.stdout, encodeOutput({ ok: true, result: 'flushed' }));
    process.exit(0);
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
