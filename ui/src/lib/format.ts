// Display formatters shared across the run and workflow views.

/** Compact "Ns / Nm / Nh ago" for a past epoch-ms timestamp. */
export function fmtAgo(t: number): string {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
}

/** Local wall-clock time for an epoch-ms timestamp, or an em dash when absent. */
export function fmtTime(t: number | null): string {
    return t ? new Date(t).toLocaleTimeString() : '—';
}

/** Pretty-print a JSON string with 2-space indent; pass non-JSON through unchanged. */
export function pretty(s: string | null): string {
    if (s == null) return '';
    try {
        return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
        return s;
    }
}
