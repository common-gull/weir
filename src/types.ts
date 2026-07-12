// Shared types for the weir engine.

import type { ContainerStepSpec, InferSchemaOutput, LocalStepSpec, StandardSchemaV1 } from './exec/runtime.ts';

export type { ContainerStepSpec, InferSchemaOutput, StandardSchemaV1 } from './exec/runtime.ts';
export type { ExtractInput, Extractor } from './exec/runtime.ts';

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

/** What kind of ctx primitive produced a memo row. `container` is a `ctx.containerStep` dispatched to
 *  a digest-pinned container `run`; `exec` is the retired rung-1 subprocess kind, kept for reading rows
 *  older runs wrote. */
export type StepKind = 'step' | 'container' | 'exec' | 'now' | 'random' | 'uuid' | 'child' | 'approval' | 'once';

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
    input?: unknown; // payload for a spec step — marshalled into the exec runtime's input frame
}

/** The rung-1 local-exec spec — a module the exec runtime runs in a subprocess speaking the C1 stdio
 *  protocol. A public alias of {@link LocalStepSpec}; the `ctx.step` spec overload that once dispatched
 *  it is retired (step is closures-only now), so a spec runs out-of-process through `ctx.containerStep`. */
export type StepSpec = LocalStepSpec;

/** A container spec that declares `outputs`: after the run, the engine snapshots each declared path
 *  from the step's scratch dir (bind-mounted at `/weir`) into the artifact store and hands the
 *  workflow an {@link ExecResult}. */
export type ContainerStepSpecWithOutputs = ContainerStepSpec & { outputs: string[] };

/** A step's declared output path → the sha256 hash it was content-addressed to in the store. */
export type StepArtifacts = Record<string, string>;

/** What a spec step that declares `outputs` resolves to: the module's JSON result plus the content
 *  hashes its declared outputs were snapshotted to (also recorded in the step's memo row). */
export interface ExecResult<T = unknown> {
    result: T;
    artifacts: StepArtifacts;
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

    /** A step: `ctx.step(name, fn)` runs a closure in-process on the host, memoized/replayed/retried
     *  so a failed run resumes from it. This is the default surface for host-integration work. `step`
     *  takes a closure only — hand a spec to {@link Ctx.containerStep} to run out-of-process. */
    step<T>(name: string, fn: (s: StepCtx) => T | Promise<T>, opts?: StepOpts<T>): Promise<T>;
    /** A container step: `ctx.containerStep(name, spec)` runs `spec` as a digest-pinned container `run`
     *  child that speaks the C1 stdio protocol, memoized/replayed/retried like any step. The image is
     *  resolved to its content `sha256` digest before it runs — the step's replay identity, recorded in
     *  the memo (`steps.image_digest`) — so a resumed run executes the exact bytes the first attempt did.
     *  Declaring `outputs` resolves to the module result paired with the content hashes those outputs
     *  snapshotted to. Requires a container runtime: an unreachable daemon or an unpinnable image fails
     *  the step, with no host fallback. `network: true` opens container egress (docker's default
     *  bridge) and is the sole egress control — no capability required. A `schema`
     *  on the spec (any Standard Schema v1 validator) is asserted against the result at the extract
     *  boundary and narrows the return type to its output — a mismatch fails the step with the
     *  validator's issues. */
    containerStep<S extends StandardSchemaV1>(
        name: string,
        spec: ContainerStepSpecWithOutputs & { schema: S },
        opts?: StepOpts<InferSchemaOutput<S>>,
    ): Promise<ExecResult<InferSchemaOutput<S>>>;
    containerStep<S extends StandardSchemaV1>(
        name: string,
        spec: ContainerStepSpec & { schema: S },
        opts?: StepOpts<InferSchemaOutput<S>>,
    ): Promise<InferSchemaOutput<S>>;
    containerStep<T = unknown>(
        name: string,
        spec: ContainerStepSpecWithOutputs,
        opts?: StepOpts<T>,
    ): Promise<ExecResult<T>>;
    containerStep<T = unknown>(name: string, spec: ContainerStepSpec, opts?: StepOpts<T>): Promise<T>;
    loop<T>(opts: LoopOpts<T>, body: (it: LoopCtx) => T | Promise<T>): Promise<T>;
    /** Fan out `fn` over `items` with bounded concurrency, each invocation memoized as its own step.
     *  `fn` runs in-process on the host, like a closure {@link step}. */
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
    /** The loop-scoped counterpart of {@link Ctx.step}, auto-namespaced per iteration under
     *  `loop#L:i:name`: `it.step(name, fn)` runs a closure in-process on the host. */
    step<T>(name: string, fn: (s: StepCtx) => T | Promise<T>, opts?: StepOpts<T>): Promise<T>;
    /** The loop-scoped counterpart of {@link Ctx.containerStep}, sharing the same per-iteration
     *  `loop#L:i:name` keying as {@link LoopCtx.step}. */
    containerStep<S extends StandardSchemaV1>(
        name: string,
        spec: ContainerStepSpecWithOutputs & { schema: S },
        opts?: StepOpts<InferSchemaOutput<S>>,
    ): Promise<ExecResult<InferSchemaOutput<S>>>;
    containerStep<S extends StandardSchemaV1>(
        name: string,
        spec: ContainerStepSpec & { schema: S },
        opts?: StepOpts<InferSchemaOutput<S>>,
    ): Promise<InferSchemaOutput<S>>;
    containerStep<T = unknown>(
        name: string,
        spec: ContainerStepSpecWithOutputs,
        opts?: StepOpts<T>,
    ): Promise<ExecResult<T>>;
    containerStep<T = unknown>(name: string, spec: ContainerStepSpec, opts?: StepOpts<T>): Promise<T>;
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
    /** JSON `{path: sha256}` map of artifacts a spec step snapshotted into the store, else null. */
    artifacts: string | null;
    /** `sha256:…` image digest a container step (#C8) was pinned to — its replay identity — else null. */
    image_digest: string | null;
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
