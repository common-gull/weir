// Shared types for the weir engine.

export type RunStatus =
    | 'queued'
    | 'running'
    | 'awaiting-approval'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';

/** A step memo row is terminal: it either completed (result stored) or failed (error stored). */
export type StepStatus = 'completed' | 'failed' | 'discarded';

/** What kind of ctx primitive produced a memo row. */
export type StepKind = 'step' | 'now' | 'random' | 'uuid' | 'child' | 'approval' | 'once';

export type Overlap = 'skip' | 'queue' | 'cancel-previous';
export type Catchup = 'skip' | 'catchup_once' | 'backfill';

export interface Backoff {
    type?: 'fixed' | 'exponential';
    base?: number; // ms
    factor?: number; // for exponential
    maxDelay?: number; // ms
    jitter?: boolean;
}

export interface RetryOpts {
    max: number;
    backoff?: Backoff;
}

export interface RepeatOpts<T = unknown> {
    until?: (result: T) => boolean;
    while?: (result: T) => boolean;
    every?: number; // ms between iterations
    max?: number;
}

export interface StepOpts<T = unknown> {
    key?: string; // explicit identity override
    retries?: RetryOpts;
    repeat?: RepeatOpts<T>;
    timeout?: number; // ms
    pool?: string; // resource pool to acquire
}

export interface LoopOpts<T = unknown> {
    max: number; // required hard cap — no infinite loops
    until?: (result: T) => boolean;
    while?: (result: T) => boolean;
}

export interface ScheduleDef {
    cron: string;
    tz?: string;
    input?: unknown;
    overlap?: Overlap;
    catchup?: Catchup;
    backfillMax?: number;
}

export type Capability = 'git-push' | 'gh-pr' | 'gh-comment' | 'network' | (string & {});

export interface WorkflowOpts {
    schedule?: ScheduleDef;
    capabilities?: Capability[];
    priority?: number;
    /** Called with the failure when a run ends in `failed`. */
    onFailure?: (info: { runId: string; workflow: string; error: unknown }) => void | Promise<void>;
}

/** The context handed to a workflow body. */
export interface Ctx {
    readonly runId: string;
    readonly workflow: string;
    readonly input: unknown;
    readonly capabilities: ReadonlySet<Capability>;

    step<T>(name: string, fn: (s: StepCtx) => T | Promise<T>, opts?: StepOpts<T>): Promise<T>;
    loop<T>(opts: LoopOpts<T>, body: (it: LoopCtx) => T | Promise<T>): Promise<T>;
    map<I, O>(
        items: I[],
        fn: (item: I, index: number) => O | Promise<O>,
        opts?: { concurrency?: number; pool?: string },
    ): Promise<Array<{ ok: true; value: O } | { ok: false; error: string }>>;
    child<T = unknown>(name: string, input?: unknown): Promise<T>;

    now(): number;
    random(): number;
    uuid(): string;

    state: StateApi;
    once(key: string, window: string | number): Promise<boolean>;

    waitForApproval(name: string): Promise<unknown>;
    notify(target: string, message: string): Promise<void>;
    log(message: string): void;

    /** Short-circuit the run as a no-op with a reason (records `skipped`). */
    skip(reason: string): SkipSignal;
}

export interface StateApi {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown, opts?: { ttl?: string | number }): void;
    delete(key: string): void;
}

/** Passed to a step body — carries cancellation + scoped logging. */
export interface StepCtx {
    readonly signal: AbortSignal;
    log(message: string): void;
}

/** Passed to a loop body — its steps are auto-namespaced per iteration. */
export interface LoopCtx {
    readonly index: number;
    readonly prev: unknown; // previous iteration's return value (undefined on first)
    step<T>(name: string, fn: (s: StepCtx) => T | Promise<T>, opts?: StepOpts<T>): Promise<T>;
}

export class SkipSignal {
    constructor(public readonly reason: string) {}
}

// ---- DB row shapes ----

export interface RunRow {
    id: string;
    workflow: string;
    status: RunStatus;
    input: string | null;
    result: string | null;
    error: string | null;
    parent_run_id: string | null;
    parent_seq: number | null;
    schedule_id: string | null;
    logical_fire_at: number | null;
    priority: number;
    attempt: number;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
}

export interface StepRow {
    id: number;
    run_id: string;
    seq: number;
    key: string;
    name: string;
    kind: StepKind;
    status: StepStatus;
    result: string | null;
    error: string | null;
    child_run_id: string | null;
    created_at: number;
}

export interface ScheduleRow {
    id: string;
    workflow: string;
    cron: string;
    tz: string;
    input: string | null;
    overlap: Overlap;
    catchup: Catchup;
    backfill_max: number;
    next_fire_at: number;
    last_fire_at: number | null;
    enabled: number;
    created_at: number;
}
