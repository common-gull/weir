// A single row from the engine's append-only `events` log (the live run stream).
export interface EventRow {
    id: number;
    run_id: string | null;
    seq: number | null;
    ts: number;
    type: string;
    level: string | null;
    message: string | null;
    data: string | null;
}
