// SSE subscription to the engine's live event stream (the push side of ./client).
import type { EventRow } from '$lib/events/types';

/** Subscribe to the global (or per-run) event stream. Pass `since` (last seen event id) to
 *  avoid missing events between a historical fetch and the stream connecting. */
export function subscribe(onEvent: (e: EventRow) => void, runId?: string, since?: number): () => void {
  const params = new URLSearchParams();
  if (runId) params.set('run', runId);
  if (since != null) params.set('since', String(since));
  const es = new EventSource(`/api/stream?${params}`);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {
      /* ignore heartbeats */
    }
  };
  return () => es.close();
}
