// The executor: drives queued runs with a global concurrency cap, named resource-pool
// semaphores, priority + fairness, and a boot orphan-sweep. The DB is the queue.

import type { DB } from './db.ts';
import { emit } from './db.ts';
import { CancelledError, executeRun, type RunDeps } from './engine.ts';
import type { RunRow } from './types.ts';

class Semaphore {
  private active = 0;
  private q: Array<() => void> = [];
  constructor(private max: number) {}
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = this.q.indexOf(grant);
        if (i >= 0) this.q.splice(i, 1);
        reject(new CancelledError('cancelled'));
      };
      const grant = () => {
        signal?.removeEventListener('abort', onAbort); // don't leak listeners on the run signal
        this.active++;
        resolve(() => this.release());
      };
      this.q.push(grant);
      signal?.addEventListener('abort', onAbort);
    });
  }
  private release() {
    this.active--;
    this.q.shift()?.();
  }
}

export interface ExecutorOpts {
  maxConcurrent?: number;
  pools?: Record<string, number>;
  pollMs?: number;
}

export class Executor {
  private max: number;
  private pools = new Map<string, Semaphore>();
  private active = 0;
  private running = new Map<string, AbortController>();
  private started = false;
  private poll?: ReturnType<typeof setInterval>;
  private idleWaiters: Array<() => void> = [];

  constructor(private db: DB, private opts: ExecutorOpts = {}) {
    this.max = opts.maxConcurrent ?? 4;
    for (const [name, size] of Object.entries(opts.pools ?? {})) this.pools.set(name, new Semaphore(size));
  }

  private deps(runId: string): RunDeps {
    const controller = this.running.get(runId)!;
    return {
      signal: controller.signal,
      acquire: async (pool, signal) => {
        const sem = this.pools.get(pool);
        if (!sem) return () => {}; // unconfigured pool = unbounded
        return sem.acquire(signal);
      },
      // Children run to completion in-process, within the PARENT's concurrency slot — by
      // design, not oversight. Making a child acquire its own global slot while the parent
      // holds one and blocks awaiting it would deadlock the pool once all slots hold parents.
      // Resource POOLS (e.g. llm) still bound children, since child steps acquire them too.
      // True decoupling (suspend parent, queue child) is deferred to L2.
      runChild: async (childRunId) => {
        // Link the child's cancellation to the parent's, so cancelling the parent (or
        // stop()/drain) also aborts a running child instead of hanging until it finishes.
        const childController = new AbortController();
        const parentSignal = this.running.get(runId)?.signal;
        const onParentAbort = () => childController.abort();
        parentSignal?.addEventListener('abort', onParentAbort);
        this.running.set(childRunId, childController);
        try {
          await executeRun(this.db, childRunId, this.deps(childRunId));
        } finally {
          parentSignal?.removeEventListener('abort', onParentAbort);
          this.running.delete(childRunId);
        }
        const row = this.db.query(`SELECT status, result, error FROM runs WHERE id = ?`).get(childRunId) as {
          status: string;
          result: string | null;
          error: string | null;
        };
        if (row.status !== 'completed') {
          throw new Error(`child run ${childRunId} ended ${row.status}: ${row.error ?? ''}`);
        }
        return row.result == null ? undefined : JSON.parse(row.result);
      },
    };
  }

  /** Mark runs that were mid-flight when the process died. No auto-resume — user retries. */
  sweepOrphans(): number {
    const orphans = this.db.query(`SELECT id FROM runs WHERE status = 'running'`).all() as { id: string }[];
    for (const o of orphans) emit(this.db, { runId: o.id, type: 'run.interrupted', level: 'warn' });
    const res = this.db.query(`UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'`).run(
      Date.now(),
    );
    return res.changes as number;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.sweepOrphans();
    this.poll = setInterval(() => this.tick(), this.opts.pollMs ?? 1000);
    this.tick();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.poll) clearInterval(this.poll);
    for (const c of this.running.values()) c.abort();
    await this.drain();
  }

  wake(): void {
    this.tick();
  }

  private claimNext(): RunRow | null {
    const cands = this.db
      .query(`SELECT * FROM runs WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 50`)
      .all() as RunRow[];
    if (cands.length === 0) return null;
    const runningByWf = new Map<string, number>();
    for (const r of this.db
      .query(`SELECT workflow, COUNT(*) AS c FROM runs WHERE status = 'running' GROUP BY workflow`)
      .all() as { workflow: string; c: number }[])
      runningByWf.set(r.workflow, r.c);
    // priority DESC, then fewest-in-flight for that workflow (fairness), then FIFO.
    cands.sort(
      (a, b) =>
        b.priority - a.priority ||
        (runningByWf.get(a.workflow) ?? 0) - (runningByWf.get(b.workflow) ?? 0) ||
        a.created_at - b.created_at,
    );
    const pick = cands[0]!;
    const res = this.db.query(`UPDATE runs SET status = 'running' WHERE id = ? AND status = 'queued'`).run(pick.id);
    if ((res.changes as number) === 0) return this.claimNext();
    return pick;
  }

  private tick(): void {
    if (!this.started) return;
    while (this.active < this.max) {
      const run = this.claimNext();
      if (!run) break;
      this.active++;
      this.running.set(run.id, new AbortController());
      void this.runOne(run.id);
    }
  }

  private async runOne(runId: string): Promise<void> {
    try {
      await executeRun(this.db, runId, this.deps(runId));
    } catch (e) {
      emit(this.db, { runId, type: 'executor.error', level: 'error', message: (e as Error).message });
    } finally {
      this.running.delete(runId);
      this.active--;
      if (this.active === 0 && this.running.size === 0) {
        this.idleWaiters.splice(0).forEach((w) => w());
      }
      this.tick();
    }
  }

  /** Resolve once there are no active runs. */
  drain(): Promise<void> {
    if (this.active === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Run a single run to completion synchronously (for `weir run`). */
  async runNow(runId: string): Promise<RunRow['status']> {
    this.running.set(runId, new AbortController());
    try {
      return await executeRun(this.db, runId, this.deps(runId));
    } finally {
      this.running.delete(runId);
    }
  }

  cancel(runId: string): void {
    this.running.get(runId)?.abort();
    this.db.query(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'`).run(
      Date.now(),
      runId,
    );
  }
}
