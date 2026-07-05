// In-process pub-sub for freshly emitted events. Lets the SSE stream push each row the instant
// it's written (see `emit()` in db.ts) instead of re-polling SQLite every 500ms — which was one
// poll per connected browser tab. The DB stays the source of truth; this is just a fast-path fan-out.

import { EventEmitter } from 'node:events';

/** The shape of an `events` row, as pushed to subscribers (matches `SELECT * FROM events`). */
export interface EmittedEvent {
  id: number;
  run_id: string | null;
  seq: number | null;
  ts: number;
  type: string;
  level: string | null;
  message: string | null;
  data: string | null;
}

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open SSE connection — don't warn as tabs multiply

export function publishEvent(row: EmittedEvent): void {
  bus.emit('event', row);
}

/** Subscribe to freshly emitted events. Returns an unsubscribe function. */
export function onEvent(fn: (row: EmittedEvent) => void): () => void {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
