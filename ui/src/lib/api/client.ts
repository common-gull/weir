// Thin typed client over the weir engine's JSON API. The SSE live stream lives in ./sse.
import type { WorkflowSummary } from '$lib/workflows/types';
import type { RunSummary, RunDetail } from '$lib/runs/types';
import type { EventRow } from '$lib/events/types';

async function get<T>(path: string): Promise<T> {
    const r = await fetch(`/api${path}`);
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
}
async function post<T>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(`/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
}

export const api = {
    workflows: () => get<WorkflowSummary[]>('/workflows'),
    schedules: () => get<unknown[]>('/schedules'),
    runs: (q: { workflow?: string; status?: string; limit?: number } = {}) => {
        const p = new URLSearchParams();
        if (q.workflow) p.set('workflow', q.workflow);
        if (q.status) p.set('status', q.status);
        if (q.limit != null) p.set('limit', String(q.limit));
        return get<RunSummary[]>(`/runs?${p}`);
    },
    run: (id: string) => get<RunDetail>(`/runs/${id}`),
    // Paginated tail: defaults to the newest `limit` events; pass `before` (an event id) to page back.
    runEvents: (id: string, opts: { limit?: number; before?: number } = {}) => {
        const p = new URLSearchParams();
        if (opts.limit != null) p.set('limit', String(opts.limit));
        if (opts.before != null) p.set('before', String(opts.before));
        const qs = p.toString();
        return get<EventRow[]>(`/runs/${id}/events${qs ? `?${qs}` : ''}`);
    },
    reload: () => post<{ workflows: number; files: number; removed: string[] }>('/reload'),
    runWorkflow: (name: string, input?: unknown) => post<{ id: string }>(`/workflows/${name}/run`, input),
    pauseWorkflow: (name: string) => post(`/workflows/${name}/pause`),
    resumeWorkflow: (name: string) => post(`/workflows/${name}/resume`),
    retry: (id: string, from?: string) => post(`/runs/${id}/retry`, { from }),
    cancel: (id: string) => post(`/runs/${id}/cancel`),
    approve: (id: string, gate = 'human') => post(`/runs/${id}/approve`, { gate }),
};
