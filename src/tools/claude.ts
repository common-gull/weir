// CLI-first Claude adapter. Spawns the user's `claude` binary in non-interactive print
// mode and parses its stream-json output. Auth is inherited from the user's login (no API
// key). This is what the SDK did under the hood — we do it directly, one fewer dependency.

export interface ClaudeOpts {
    cwd?: string;
    model?: string;
    appendSystemPrompt?: string;
    allowedTools?: string[];
    addDirs?: string[];
    /** Default 'bypassPermissions' for autonomous runs. Outward actions are gated by weir's own capability layer, and agent work happens in an isolated worktree. */
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    settings?: string; // path to a settings.json (e.g. permission allow/deny lists)
    agents?: string; // JSON string of subagent definitions
    maxTurns?: number;
    signal?: AbortSignal;
    /** Called for each stream event (tool_use, assistant text, etc.) for live logs. */
    onEvent?: (ev: ClaudeEvent) => void;
}

export interface ClaudeEvent {
    type: string;
    subtype?: string;
    [k: string]: unknown;
}

export interface ClaudeResult {
    result: string;
    isError: boolean;
    numTurns?: number;
    events: ClaudeEvent[];
}

/**
 * Condense a stream-json event into a one-line, human-readable summary for run logs — or
 * null for events not worth surfacing. Turns the opaque "assistant" turns into what the
 * agent is actually doing (tool calls, text), so a live run reads as progress, not a stall.
 */
export function summarizeEvent(ev: ClaudeEvent): string | null {
    if (ev.type === 'assistant') {
        const content = (ev.message as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) return null;
        const parts: string[] = [];
        for (const b of content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
            if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                parts.push(b.text.trim().replace(/\s+/g, ' ').slice(0, 140));
            } else if (b?.type === 'tool_use') {
                parts.push(`⚙ ${b.name}(${summarizeToolInput(b.input)})`);
            }
        }
        return parts.length ? parts.join(' · ') : null;
    }
    if (ev.type === 'result') {
        return `finished — ${(ev.num_turns as number) ?? '?'} turns${ev.is_error ? ' (error)' : ''}`;
    }
    return null;
}

/** Pick the most telling field of a tool's input (command, path, pattern, …) for a log line. */
function summarizeToolInput(input: unknown): string {
    if (!input || typeof input !== 'object') return '';
    const o = input as Record<string, unknown>;
    const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description ?? o.prompt;
    const s = typeof pick === 'string' ? pick : JSON.stringify(o);
    return s.replace(/\s+/g, ' ').slice(0, 80);
}

export async function runClaude(prompt: string, opts: ClaudeOpts = {}): Promise<ClaudeResult> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
    else args.push('--permission-mode', 'bypassPermissions');
    if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
    for (const d of opts.addDirs ?? []) args.push('--add-dir', d);
    if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
    if (opts.settings) args.push('--settings', opts.settings);
    if (opts.agents) args.push('--agents', opts.agents);
    if (opts.maxTurns != null) args.push('--max-turns', String(opts.maxTurns));

    const proc = Bun.spawn(['claude', ...args], {
        cwd: opts.cwd,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        signal: opts.signal,
    });
    proc.stdin.write(prompt);
    proc.stdin.end();

    const events: ClaudeEvent[] = [];
    let result = '';
    let isError = false;
    let numTurns: number | undefined;

    const decoder = new TextDecoder();
    const handleLine = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        let ev: ClaudeEvent;
        try {
            ev = JSON.parse(line);
        } catch {
            return;
        }
        events.push(ev);
        opts.onEvent?.(ev);
        if (ev.type === 'result') {
            result = (ev.result as string) ?? '';
            isError = Boolean(ev.is_error);
            numTurns = ev.num_turns as number | undefined;
        }
    };

    let buf = '';
    for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
            handleLine(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
            nl = buf.indexOf('\n');
        }
    }
    buf += decoder.decode(); // flush any trailing multi-byte remainder
    handleLine(buf); // the final line (often the result) may arrive without a newline

    const code = await proc.exited;
    if (code !== 0 && !result) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`);
    }
    if (isError) throw new Error(`claude returned an error result: ${result.slice(0, 500)}`);
    return { result, isError, numTurns, events };
}
