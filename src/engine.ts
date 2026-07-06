// The engine: defineWorkflow + the `ctx` surface + the memo-based run driver.
//
// Durability model (Level 1 + retry-from-failure): a workflow body is re-invoked from the
// top on retry. Every ctx primitive call consumes a monotonic `seq`; SUCCESSFUL calls write
// a memo row keyed by (run, seq). On re-invocation a completed memo row short-circuits the
// call (returns the stored result) so execution fast-forwards to the first non-memoized
// (i.e. previously-failed or never-reached) step. Failures are NOT memoized — that is
// exactly why the failed step re-runs on retry.
//
// Determinism rule: keep nondeterminism inside step bodies or behind ctx.now/random/uuid
// (which ARE memoized). A memo hit whose key doesn't match the current call is a divergence
// and throws rather than silently corrupting history.

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { assertSerializable, emit, fromJson, toJson, tx } from './db.ts';
import { requireCapability, resolveExecEnv, withCapabilities } from './capabilities.ts';
import { buildArgv, snapshotOutputs, stageInputs } from './exec/runtime.ts';
import { runProtocol } from './exec/spawn.ts';
import {
    SkipSignal,
    type Capability,
    type Ctx,
    type LoopCtx,
    type LoopOpts,
    type RunRow,
    type StepArtifacts,
    type StepCtx,
    type StepKind,
    type StepOpts,
    type StepRow,
    type StepSpec,
    type WorkflowOpts,
} from './types.ts';

export interface WorkflowDef {
    name: string;
    opts: WorkflowOpts;
    body: (ctx: Ctx, input: unknown) => unknown | Promise<unknown>;
}

const registry = new Map<string, WorkflowDef>();

/** Observers notified whenever a workflow (re)registers — lets a reload track which names
 *  the current on-disk files define, so it can prune workflows whose files were removed. */
const registerListeners = new Set<(name: string) => void>();

export function defineWorkflow(
    name: string,
    opts: WorkflowOpts,
    body: (ctx: Ctx, input: unknown) => unknown | Promise<unknown>,
): WorkflowDef;
export function defineWorkflow(
    name: string,
    body: (ctx: Ctx, input: unknown) => unknown | Promise<unknown>,
): WorkflowDef;
export function defineWorkflow(
    name: string,
    a: WorkflowOpts | ((ctx: Ctx, input: unknown) => unknown | Promise<unknown>),
    b?: (ctx: Ctx, input: unknown) => unknown | Promise<unknown>,
): WorkflowDef {
    const opts: WorkflowOpts = typeof a === 'function' ? {} : a;
    const body = typeof a === 'function' ? a : b;
    if (!body) throw new Error(`defineWorkflow(${name}): a body function is required`);
    const def: WorkflowDef = { name, opts, body };
    registry.set(name, def);
    for (const l of registerListeners) l(name);
    return def;
}

export function getWorkflow(name: string): WorkflowDef | undefined {
    return registry.get(name);
}
export function allWorkflows(): WorkflowDef[] {
    return [...registry.values()];
}
export function clearRegistry(): void {
    registry.clear();
}

/** Register a listener called with each workflow name as it registers; returns an unsubscribe. */
export function onRegister(fn: (name: string) => void): () => void {
    registerListeners.add(fn);
    return () => registerListeners.delete(fn);
}

/** Drop every registered workflow whose name isn't in `keep`. Returns the removed names.
 *  Used by reload to evict workflows whose source files were deleted on disk. */
export function retainWorkflows(keep: Set<string>): string[] {
    const removed = [...registry.keys()].filter((name) => !keep.has(name));
    for (const name of removed) registry.delete(name);
    return removed;
}

// ---- signals ----

/** Thrown to pause a run at a human-approval gate (not a failure). */
export class ParkSignal extends Error {
    constructor(public readonly gate: string) {
        super(`awaiting approval: ${gate}`);
    }
}
export class DeterminismError extends Error {}
export class CancelledError extends Error {}

/** The error thrown when a container-step surface (`ctx.step` / `it.step`) is handed a closure
 *  instead of a spec: names the two supported paths (the exec runtime, or the host hatch) so the
 *  message tells the caller exactly where the code should move. */
function closureStepError(surface: string, name: string, hostHatch: string): Error {
    return new Error(
        `${surface}("${name}", fn): closure steps no longer run in-process. Pass a StepSpec ` +
            `{ runtime, module } to run it in the exec runtime, or use ${hostHatch} ` +
            `(gated on 'host-exec') for host-touching work.`,
    );
}

export interface RunDeps {
    /** Acquire a slot in a named resource pool; returns a release fn. */
    acquire?(pool: string, signal: AbortSignal): Promise<() => void>;
    /** Cancellation signal for the whole run. */
    signal?: AbortSignal;
    /** Recursively execute a child run to completion and return its result. */
    runChild?(childRunId: string): Promise<unknown>;
    /** Content-addressed artifact store dir (#C4) for spec-step outputs. Defaults under `.weir/`. */
    storeDir?: string;
    /** Root under which each artifact-staging spec step gets an isolated scratch dir. */
    scratchDir?: string;
}

interface Replay {
    seq: number;
    ordinals: Map<string, number>;
    memoBySeq: Map<number, StepRow>;
    loopOrd: number;
    mapOrd: number;
}

function loadMemo(db: DB, runId: string): Map<number, StepRow> {
    const rows = db
        .query(`SELECT * FROM steps WHERE run_id = ? AND status = 'completed' ORDER BY seq`)
        .all(runId) as StepRow[];
    const m = new Map<number, StepRow>();
    for (const r of rows) m.set(r.seq, r);
    return m;
}

function writeMemo(
    db: DB,
    runId: string,
    seq: number,
    key: string,
    name: string,
    kind: StepKind,
    result: unknown,
    childRunId?: string | null,
    artifacts?: StepArtifacts | null,
): void {
    db.query(
        `INSERT INTO steps (run_id, seq, key, name, kind, status, result, error, child_run_id, artifacts, created_at)
     VALUES (?, ?, ?, ?, ?, 'completed', ?, NULL, ?, ?, ?)`,
    ).run(
        runId,
        seq,
        key,
        name,
        kind,
        toJson(result),
        childRunId ?? null,
        artifacts ? toJson(artifacts) : null,
        Date.now(),
    );
}

function computeBackoff(attempt: number, b: NonNullable<StepOpts['retries']>['backoff']): number {
    const base = b?.base ?? 200;
    const type = b?.type ?? 'exponential';
    let d = type === 'fixed' ? base : base * (b?.factor ?? 2) ** attempt;
    if (b?.maxDelay) d = Math.min(d, b.maxDelay);
    if (b?.jitter) d = d * (0.5 + Math.random() * 0.5);
    return Math.round(d);
}

const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (ms <= 0) return resolve();
        let t: ReturnType<typeof setTimeout>;
        const onAbort = () => {
            clearTimeout(t);
            reject(new CancelledError('cancelled'));
        };
        t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort); // don't leak listeners on the run signal
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort);
    });

/**
 * Execute (or replay) a run to a terminal or parked state. Mutates the run row's status.
 * Returns the resulting status.
 */
export async function executeRun(db: DB, runId: string, deps: RunDeps = {}): Promise<RunRow['status']> {
    const run = db.query(`SELECT * FROM runs WHERE id = ?`).get(runId) as RunRow | null;
    if (!run) throw new Error(`run not found: ${runId}`);

    const def = registry.get(run.workflow);
    if (!def) {
        finishRun(db, runId, 'failed', undefined, { message: `workflow not registered: ${run.workflow}` });
        emit(db, { runId, type: 'run.failed', level: 'error', message: `workflow not registered: ${run.workflow}` });
        return 'failed';
    }

    db.query(`UPDATE runs SET status = 'running', started_at = ?, attempt = attempt + 1 WHERE id = ?`).run(
        Date.now(),
        runId,
    );
    emit(db, { runId, type: 'run.started', message: run.workflow });

    const state: Replay = { seq: 0, ordinals: new Map(), memoBySeq: loadMemo(db, runId), loopOrd: 0, mapOrd: 0 };
    const signal = deps.signal ?? new AbortController().signal;
    const input = fromJson(run.input);
    const caps = new Set<Capability>((def.opts.capabilities ?? []) as Capability[]);

    const ctx = buildCtx(db, def, run, input, caps, state, deps, signal);

    try {
        const result = await withCapabilities({ workflow: def.name, caps }, () =>
            Promise.resolve(def.body(ctx, input)),
        );
        if (result instanceof SkipSignal) {
            finishRun(db, runId, 'completed', { skipped: true, reason: result.reason });
            emit(db, { runId, type: 'run.skipped', message: result.reason });
            return 'completed';
        }
        assertSerializable(result, `workflow:${run.workflow}`);
        finishRun(db, runId, 'completed', result);
        emit(db, { runId, type: 'run.completed', data: result });
        return 'completed';
    } catch (e) {
        if (e instanceof ParkSignal) {
            kvSet(db, '__pending__', runId, e.gate); // remember which gate we're parked on
            db.query(`UPDATE runs SET status = 'awaiting-approval' WHERE id = ?`).run(runId);
            emit(db, { runId, type: 'run.parked', message: e.gate });
            return 'awaiting-approval';
        }
        if (e instanceof CancelledError) {
            finishRun(db, runId, 'cancelled', undefined, { message: 'cancelled' });
            emit(db, { runId, type: 'run.cancelled' });
            return 'cancelled';
        }
        const err = { message: (e as Error).message, stack: (e as Error).stack };
        finishRun(db, runId, 'failed', undefined, err);
        emit(db, { runId, type: 'run.failed', level: 'error', message: err.message });
        if (def.opts.onFailure) {
            try {
                await def.opts.onFailure({ runId, workflow: run.workflow, error: e });
            } catch (hookErr) {
                emit(db, { runId, type: 'onFailure.error', level: 'error', message: (hookErr as Error).message });
            }
        }
        return 'failed';
    }
}

function finishRun(db: DB, runId: string, status: RunRow['status'], result?: unknown, error?: unknown): void {
    db.query(`UPDATE runs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?`).run(
        status,
        result === undefined ? null : toJson(result),
        error === undefined ? null : toJson(error),
        Date.now(),
        runId,
    );
}

function buildCtx(
    db: DB,
    def: WorkflowDef,
    run: RunRow,
    input: unknown,
    caps: Set<Capability>,
    state: Replay,
    deps: RunDeps,
    signal: AbortSignal,
): Ctx {
    const runId = run.id;

    // Core memoized primitive shared by step/now/random/uuid/child/approval.
    async function memoized<T>(
        kind: StepKind,
        name: string,
        key: string,
        produce: (seq: number) => Promise<{ value: T; childRunId?: string; artifacts?: StepArtifacts }>,
    ): Promise<T> {
        if (signal.aborted) throw new CancelledError('cancelled');
        const seq = state.seq++;
        const hit = state.memoBySeq.get(seq);
        if (hit) {
            if (hit.key !== key) {
                throw new DeterminismError(
                    `nondeterministic replay at seq ${seq}: memo has "${hit.key}" but code produced "${key}". ` +
                        `Did the workflow change, or is there nondeterminism outside a step?`,
                );
            }
            return fromJson<T>(hit.result) as T;
        }
        const { value, childRunId, artifacts } = await produce(seq);
        assertSerializable(value, key);
        writeMemo(db, runId, seq, key, name, kind, value, childRunId, artifacts);
        return value;
    }

    async function runStepBody<T>(
        seq: number,
        key: string,
        _name: string,
        fn: (s: StepCtx) => T | Promise<T>,
        opts: StepOpts<T>,
    ): Promise<T> {
        const stepCtx: StepCtx = {
            signal,
            log: (m: string) => emit(db, { runId, seq, type: 'step.log', message: m }),
        };

        const runOnce = async (attempt: number): Promise<T> => {
            const attemptRow = db
                .query(
                    `INSERT INTO step_attempts (run_id, seq, attempt, status, started_at) VALUES (?, ?, ?, 'running', ?) RETURNING id`,
                )
                .get(runId, seq, attempt, Date.now()) as { id: number };
            emit(db, { runId, seq, type: 'step.attempt', message: `${key} #${attempt}` });

            let release: (() => void) | undefined;
            let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            signal.addEventListener('abort', onAbort);
            const localCtx: StepCtx = { signal: controller.signal, log: stepCtx.log };
            try {
                if (opts.pool && deps.acquire) release = await deps.acquire(opts.pool, signal);
                let p = Promise.resolve(fn(localCtx));
                if (opts.timeout) {
                    p = Promise.race([
                        p,
                        new Promise<never>((_, rej) => {
                            timeoutTimer = setTimeout(() => {
                                controller.abort();
                                rej(new Error(`step "${key}" timed out after ${opts.timeout}ms`));
                            }, opts.timeout);
                        }),
                    ]);
                }
                const value = await p;
                db.query(`UPDATE step_attempts SET status = 'succeeded', finished_at = ? WHERE id = ?`).run(
                    Date.now(),
                    attemptRow.id,
                );
                return value;
            } catch (err) {
                db.query(`UPDATE step_attempts SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
                    toJson({ message: (err as Error).message }),
                    Date.now(),
                    attemptRow.id,
                );
                throw err;
            } finally {
                if (timeoutTimer) clearTimeout(timeoutTimer); // clear on success too, not just abort
                signal.removeEventListener('abort', onAbort);
                release?.();
            }
        };

        // retry (inner) wrapped by repeat (outer)
        const withRetry = async (): Promise<T> => {
            const max = opts.retries?.max ?? 0;
            let attempt = 0;
            for (;;) {
                try {
                    return await runOnce(attempt);
                } catch (err) {
                    if (err instanceof CancelledError) throw err;
                    if (attempt >= max) throw err;
                    const d = computeBackoff(attempt, opts.retries?.backoff);
                    emit(db, { runId, seq, type: 'step.retry', message: `${key} retry in ${d}ms`, level: 'warn' });
                    await sleep(d, signal);
                    attempt++;
                }
            }
        };

        if (!opts.repeat) return withRetry();

        // repeat: re-run while predicate holds, capped by max
        let result!: T;
        let iters = 0;
        const cap = opts.repeat.max ?? Infinity;
        for (;;) {
            result = await withRetry();
            iters++;
            const cont = (opts.repeat.until && !opts.repeat.until(result)) || opts.repeat.while?.(result);
            if (!cont || iters >= cap) break;
            if (opts.repeat.every) await sleep(opts.repeat.every, signal);
        }
        return result;
    }

    const stepImpl = <T>(
        name: string,
        fn: (s: StepCtx) => T | Promise<T>,
        opts: StepOpts<T> = {},
        keyOverride?: string,
    ) => {
        const ord = bump(state.ordinals, keyOverride ?? name);
        const key = opts.key ?? keyOverride ?? `${name}#${ord}`;
        return memoized<T>('step', name, key, async (seq) => ({
            value: await runStepBody(seq, key, name, fn, opts),
        }));
    };

    // Exec-runtime step (rung-1): run the module in a subprocess (C2) via a runtime-specific argv
    // (C3) rather than in-process on the host. Streamed log lines surface as step.log events like the
    // in-process host step's log channel. When the spec declares inputs/outputs the step runs in an isolated
    // scratch dir (#C6): declared input artifacts are staged in from the store beforehand and declared
    // outputs snapshotted back into it afterward, their `path -> hash` map returned alongside the
    // module's JSON result. The scratch dir is torn down once outputs are safely content-addressed.
    async function runExecStep(
        seq: number,
        spec: StepSpec,
        opts: StepOpts,
    ): Promise<{ result: unknown; artifacts: StepArtifacts }> {
        const inputs = spec.inputs ?? [];
        const outputs = spec.outputs ?? [];
        const storeDir = deps.storeDir ?? join(process.cwd(), '.weir', 'artifacts');
        let scratch: string | undefined;
        try {
            if (inputs.length > 0 || outputs.length > 0) {
                scratch = join(deps.scratchDir ?? join(process.cwd(), '.weir', 'scratch'), runId, String(seq));
                await mkdir(scratch, { recursive: true });
                await stageInputs(storeDir, scratch, inputs);
            }
            const out = await runProtocol({
                argv: buildArgv(spec),
                cwd: scratch,
                input: opts.input,
                // Only the daemon env vars the workflow's declared capabilities authorize — never the
                // daemon's full environment. See resolveExecEnv for the capability → var policy.
                env: resolveExecEnv(),
                signal,
                timeoutMs: opts.timeout,
                onLog: (f) => emit(db, { runId, seq, type: 'step.log', level: f.level, message: f.message }),
            });
            if (!out.ok) throw new Error(out.error);
            const artifacts =
                scratch && outputs.length > 0 ? await snapshotOutputs(db, storeDir, scratch, outputs) : {};
            return { result: out.result, artifacts };
        } finally {
            if (scratch) await rm(scratch, { recursive: true, force: true });
        }
    }

    const execStepImpl = (name: string, spec: StepSpec, opts: StepOpts, keyOverride?: string): Promise<unknown> => {
        // A rung-1 exec step spawns an arbitrary module in a subprocess on the host with no
        // isolation — the same unsandboxed host-code-execution privilege as runUnsafelyOnHost — so
        // gate it on the same 'host-exec' capability. Like runUnsafelyOnHost, the gate runs before
        // any ordinal/seq is consumed, so a denied call throws without touching replay state.
        requireCapability('host-exec');
        // `keyOverride` carries a loop's per-iteration namespacing (`loop#L:i:name`) so a spec step
        // inside `ctx.loop` keys identically to the closure `it.step` it replaces.
        const ord = bump(state.ordinals, keyOverride ?? name);
        const key = opts.key ?? keyOverride ?? `${name}#${ord}`;
        // A spec declaring outputs resolves to { result, artifacts }; otherwise the bare module result
        // (backward-compatible). The artifacts map is also mirrored into the memo's `artifacts` column.
        const wantsArtifacts = (spec.outputs?.length ?? 0) > 0;
        return memoized('exec', name, key, async (seq) => {
            const { result, artifacts } = await runExecStep(seq, spec, opts);
            return wantsArtifacts ? { value: { result, artifacts }, artifacts } : { value: result };
        });
    };

    // Shared by `ctx.step` and loop-scoped `it.step`: container-by-default dispatch where a spec
    // routes to the exec runtime and a closure is rejected loudly (no silent in-process fallback),
    // so host-touching work moves to the gated escape hatch named by `hostHatch`. The throw fires
    // before any seq is consumed, so it never corrupts replay.
    const makeStepDispatch =
        (surface: string, hostHatch: string, keyOverride?: (name: string) => string) =>
        (name: string, arg2: ((s: StepCtx) => unknown) | StepSpec, opts: StepOpts = {}): Promise<unknown> => {
            if (typeof arg2 === 'function') throw closureStepError(surface, name, hostHatch);
            return execStepImpl(name, arg2, opts, keyOverride?.(name));
        };

    const ctx: Ctx = {
        runId,
        workflow: def.name,
        input,
        capabilities: caps,

        step: makeStepDispatch('ctx.step', 'ctx.runUnsafelyOnHost') as Ctx['step'],

        // The host escape hatch: identical in-process execution to `step`, gated loudly on
        // 'host-exec'. The gate runs before any seq is consumed, so a denied call throws without
        // touching replay state.
        runUnsafelyOnHost: (name, fn, opts) => {
            requireCapability('host-exec');
            return stepImpl(name, fn, opts);
        },

        loop: async <T>(opts: LoopOpts<T>, bodyFn: (it: LoopCtx) => T | Promise<T>): Promise<T> => {
            const loopId = state.loopOrd++;
            const base = `loop#${loopId}`;
            let prev: unknown;
            let result!: T;
            for (let i = 0; i < opts.max; i++) {
                const it: LoopCtx = {
                    index: i,
                    prev,
                    step: makeStepDispatch(
                        'it.step',
                        'it.runUnsafelyOnHost',
                        (name) => `${base}:${i}:${name}`,
                    ) as LoopCtx['step'],
                    runUnsafelyOnHost: (name, fn, o) => {
                        requireCapability('host-exec');
                        return stepImpl(name, fn, o, `${base}:${i}:${name}`);
                    },
                };
                result = await Promise.resolve(bodyFn(it));
                prev = result;
                const done = opts.until?.(result) || (opts.while && !opts.while(result));
                if (done) break;
            }
            return result;
        },

        map: async (items, fn, opts = {}) => {
            // `fn` runs in-process on the host (each item wrapped in an in-process step), the same
            // unsandboxed privilege as runUnsafelyOnHost — so gate `map` on 'host-exec' too. Without
            // this, `map` would be a way to run host closures around the capability. The gate runs
            // before any ordinal/seq is consumed, so a denied call throws without touching replay.
            requireCapability('host-exec');
            const mapId = state.mapOrd++;
            const base = `map#${mapId}`;
            const conc = Math.max(1, opts.concurrency ?? 8);
            let active = 0;
            const gate: Array<() => void> = [];
            const acquireLocal = () =>
                new Promise<void>((res) => {
                    if (active < conc) {
                        active++;
                        res();
                    } else
                        gate.push(() => {
                            active++;
                            res();
                        });
                });
            const releaseLocal = () => {
                active--;
                gate.shift()?.();
            };
            // Invoke in index order so each item's step gets a stable seq (memo alignment).
            const promises = items.map((item, i) =>
                stepImpl(
                    `${base}[${i}]`,
                    async () => {
                        await acquireLocal();
                        try {
                            return { ok: true as const, value: await fn(item, i) };
                        } catch (e) {
                            return { ok: false as const, error: (e as Error).message };
                        } finally {
                            releaseLocal();
                        }
                    },
                    { pool: opts.pool },
                    `${base}[${i}]`,
                ),
            );
            return Promise.all(promises);
        },

        child: async <T>(name: string, childInput?: unknown): Promise<T> => {
            const ord = bump(state.ordinals, `child:${name}`);
            const key = `child:${name}#${ord}`;
            return memoized<T>('child', name, key, async (seq) => {
                if (!deps.runChild) throw new Error(`child workflows require an executor (ctx.child "${name}")`);
                // Idempotent child creation keyed by (parent_run_id, parent_seq).
                const childId = crypto.randomUUID();
                db.query(
                    `INSERT INTO runs (id, workflow, status, input, parent_run_id, parent_seq, priority, attempt, created_at)
           VALUES (?, ?, 'queued', ?, ?, ?, 0, 0, ?)
           ON CONFLICT (parent_run_id, parent_seq) WHERE parent_run_id IS NOT NULL DO NOTHING`,
                ).run(childId, name, toJson(childInput), runId, seq, Date.now());
                const childRow = db
                    .query(`SELECT id FROM runs WHERE parent_run_id = ? AND parent_seq = ?`)
                    .get(runId, seq) as {
                    id: string;
                };
                const value = (await deps.runChild(childRow.id)) as T;
                return { value, childRunId: childRow.id };
            });
        },

        now: () => syncMemo(db, runId, state, 'now', 'now', () => Date.now()),
        random: () => syncMemo(db, runId, state, 'random', 'random', () => Math.random()),
        uuid: () => syncMemo(db, runId, state, 'uuid', 'uuid', () => crypto.randomUUID()),

        state: {
            get: <T>(key: string) => kvGet<T>(db, def.name, key),
            set: (key, value, o) => kvSet(db, def.name, key, value, o?.ttl),
            delete: (key) => kvDelete(db, def.name, key),
        },
        once: (key, window) => {
            // Memoized like now/random: the claim happens once and its boolean is replayed on
            // retry, so `once()` gating a memoized step doesn't misalign seqs / break replay.
            const ord = bump(state.ordinals, `once:${key}`);
            const memoKey = `once:${key}#${ord}`;
            const ttl = typeof window === 'number' ? window : parseDuration(window);
            return memoized('once', key, memoKey, async () => ({
                value: kvClaimOnce(db, def.name, `once:${key}`, ttl),
            }));
        },

        waitForApproval: async (name: string) => {
            const ord = bump(state.ordinals, `approval:${name}`);
            const key = `approval:${name}#${ord}`;
            return memoized('approval', name, key, async () => {
                const payload = kvGetRaw(db, `__approval__:${runId}`, name);
                if (payload === undefined) throw new ParkSignal(name);
                kvDelete(db, `__approval__:${runId}`, name);
                return { value: fromJson(payload) };
            });
        },

        notify: async (target: string, message: string) => {
            emit(db, { runId, type: 'notify', message: `${target}: ${message}` });
        },
        log: (message: string) => emit(db, { runId, type: 'run.log', message }),
        skip: (reason: string) => new SkipSignal(reason),
    };

    return ctx;
}

// A memoized synchronous value (now/random/uuid). Consumes a seq like any primitive.
function syncMemo<T>(db: DB, runId: string, state: Replay, kind: StepKind, name: string, produce: () => T): T {
    const seq = state.seq++;
    const hit = state.memoBySeq.get(seq);
    if (hit) return fromJson(hit.result) as T;
    const value = produce();
    writeMemo(db, runId, seq, name, name, kind, value);
    return value;
}

function bump(m: Map<string, number>, k: string): number {
    const n = m.get(k) ?? 0;
    m.set(k, n + 1);
    return n;
}

// ---- kv helpers ----

function kvGetRaw(db: DB, ns: string, key: string): string | null | undefined {
    const row = db.query(`SELECT value, expires_at FROM kv WHERE namespace = ? AND key = ?`).get(ns, key) as {
        value: string | null;
        expires_at: number | null;
    } | null;
    if (!row) return undefined;
    if (row.expires_at != null && row.expires_at <= Date.now()) {
        kvDelete(db, ns, key);
        return undefined;
    }
    return row.value;
}
function kvGet<T>(db: DB, ns: string, key: string): T | undefined {
    const raw = kvGetRaw(db, ns, key);
    return raw === undefined ? undefined : (fromJson<T>(raw) as T);
}
function kvSet(db: DB, ns: string, key: string, value: unknown, ttl?: string | number): void {
    const expires = ttl == null ? null : Date.now() + (typeof ttl === 'number' ? ttl : parseDuration(ttl));
    db.query(
        `INSERT INTO kv (namespace, key, value, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).run(ns, key, toJson(value), expires, Date.now());
}
function kvDelete(db: DB, ns: string, key: string): void {
    db.query(`DELETE FROM kv WHERE namespace = ? AND key = ?`).run(ns, key);
}

/** Atomically claim a rate-limit slot: returns true only for the first caller in the window. */
function kvClaimOnce(db: DB, ns: string, key: string, ttlMs: number): boolean {
    return tx(db, () => {
        const now = Date.now();
        db.query(`DELETE FROM kv WHERE namespace = ? AND key = ? AND expires_at IS NOT NULL AND expires_at <= ?`).run(
            ns,
            key,
            now,
        );
        const res = db
            .query(
                `INSERT INTO kv (namespace, key, value, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (namespace, key) DO NOTHING`,
            )
            .run(ns, key, toJson(now), now + ttlMs, now);
        return (res.changes as number) === 1;
    });
}

export function parseDuration(s: string): number {
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(s.trim());
    if (!m) throw new Error(`invalid duration: ${s}`);
    const [, numStr = '', unit = ''] = m;
    const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    if (mult === undefined) throw new Error(`invalid duration: ${s}`);
    return parseFloat(numStr) * mult;
}
