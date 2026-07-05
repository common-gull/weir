// Read-only + operate HTTP API (Bun.serve). JSON endpoints, an SSE live event stream, POST
// action endpoints, and static serving of the built Svelte UI. Never authors workflows.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db.ts';
import { onEvent } from '../bus.ts';
import type { Executor } from '../executor.ts';
import type { Scheduler } from '../scheduler.ts';
import { allWorkflows } from '../engine.ts';
import { knownCapabilities } from '../capabilities.ts';
import { loadWorkflows } from '../loader.ts';
import { approveRun, createRun, retryRun } from '../runs.ts';

export interface ServerDeps {
    db: DB;
    executor: Executor;
    scheduler?: Scheduler;
    /** Workflow source directory — enables the reload endpoint when set. */
    workflowsDir?: string;
    uiDir?: string;
    port?: number;
}

const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
};

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json', ...CORS },
    });
}

// A route's capture group is guaranteed once its regex matched; assert that as a runtime check
// rather than a compile-time `!`, so a bad pattern surfaces instead of silently passing `undefined`.
function seg(m: RegExpMatchArray, i = 1): string {
    const v = m[i];
    if (v === undefined) throw new Error(`route segment ${i} missing`);
    return v;
}

export function createServer(deps: ServerDeps) {
    const { db, executor, scheduler, workflowsDir } = deps;
    const uiDir = deps.uiDir;

    const handlers: Array<{
        m: string;
        re: RegExp;
        fn: (req: Request, m: RegExpMatchArray, url: URL) => Response | Promise<Response>;
    }> = [];
    const on = (
        m: string,
        re: RegExp,
        fn: (req: Request, mm: RegExpMatchArray, url: URL) => Response | Promise<Response>,
    ) => handlers.push({ m, re, fn });

    on('GET', /^\/api\/workflows$/, () => {
        const rows = allWorkflows().map((wf) => {
            const last = db
                .query(
                    `SELECT id, status, created_at, finished_at FROM runs WHERE workflow = ? ORDER BY created_at DESC LIMIT 1`,
                )
                .get(wf.name);
            const counts = db
                .query(`SELECT status, COUNT(*) AS c FROM runs WHERE workflow = ? GROUP BY status`)
                .all(wf.name) as { status: string; c: number }[];
            // A scheduled workflow whose row is `enabled = 0` is paused (see Scheduler.pauseWorkflow).
            const sched = wf.opts.schedule
                ? (db.query(`SELECT enabled FROM schedules WHERE id = ?`).get(`wf:${wf.name}`) as {
                      enabled: number;
                  } | null)
                : null;
            return {
                name: wf.name,
                schedule: wf.opts.schedule ?? null,
                schedulePaused: sched ? sched.enabled === 0 : false,
                capabilities: wf.opts.capabilities ?? [],
                priority: wf.opts.priority ?? 0,
                lastRun: last ?? null,
                counts: Object.fromEntries(counts.map((c) => [c.status, c.c])),
            };
        });
        return json(rows);
    });

    on('GET', /^\/api\/schedules$/, () => json(db.query(`SELECT * FROM schedules ORDER BY next_fire_at`).all()));

    // The declared capability registry (name → description), for the UI to render alongside each
    // workflow's `capabilities`. Complete after load, since custom capabilities register on import.
    on('GET', /^\/api\/capabilities$/, () =>
        json([...knownCapabilities()].map(([name, description]) => ({ name, description }))),
    );

    on('GET', /^\/api\/runs$/, (_req, _m, url) => {
        const wf = url.searchParams.get('workflow');
        const status = url.searchParams.get('status');
        const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
        const where: string[] = [];
        const args: (string | number)[] = [];
        if (wf) {
            where.push('workflow = ?');
            args.push(wf);
        }
        if (status) {
            where.push('status = ?');
            args.push(status);
        }
        const sql = `SELECT id, workflow, status, priority, created_at, started_at, finished_at, schedule_id
                 FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC LIMIT ?`;
        args.push(limit);
        return json(db.query(sql).all(...args));
    });

    on('GET', /^\/api\/runs\/([^/]+)$/, (_req, m) => {
        const id = seg(m);
        const run = db.query(`SELECT * FROM runs WHERE id = ?`).get(id);
        if (!run) return json({ error: 'not found' }, 404);
        const steps = db.query(`SELECT * FROM steps WHERE run_id = ? ORDER BY seq`).all(id);
        const attempts = db.query(`SELECT * FROM step_attempts WHERE run_id = ? ORDER BY seq, attempt`).all(id);
        const children = db.query(`SELECT id, workflow, status FROM runs WHERE parent_run_id = ?`).all(id);
        return json({ run, steps, attempts, children });
    });

    // Paginated so a long or chatty run can't return an unbounded payload. Defaults to the newest
    // `limit` events (a tail); pass `before` (an event id) to page further back for scroll-up history.
    // Always returned oldest→newest so the UI can append/prepend without re-sorting.
    on('GET', /^\/api\/runs\/([^/]+)\/events$/, (_req, m, url) => {
        const id = seg(m);
        // Clamp to [1, 1000] and fall back to the default for a non-numeric param, so a hand-crafted
        // `?limit=abc` can't reach the query as `LIMIT NaN` (which bun:sqlite rejects with a 500).
        const limitReq = Number(url.searchParams.get('limit') ?? 200);
        const limit = Math.min(1000, Math.max(1, Number.isFinite(limitReq) ? limitReq : 200));
        const beforeReq = Number(url.searchParams.get('before') ?? 0);
        const before = Number.isFinite(beforeReq) ? beforeReq : 0;
        const rows = (
            before
                ? db
                      .query(`SELECT * FROM events WHERE run_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
                      .all(id, before, limit)
                : db.query(`SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?`).all(id, limit)
        ) as unknown[];
        rows.reverse();
        return json(rows);
    });

    // SSE live stream (optionally scoped to ?run=). Push-based: `emit()` fans each row out through the
    // in-process bus, so rows reach the browser the instant they're written. A one-shot drain on connect
    // backfills the gap since the caller's `since` cursor, and a slow interval re-drains purely as a
    // safety net for anything the push path might miss — it is NOT the primary path.
    on('GET', /^\/api\/stream$/, (req, _m, url) => {
        const runId = url.searchParams.get('run');
        // On EventSource auto-reconnect the browser replays the last id it received via the
        // Last-Event-ID header (we set `id:` on every frame below); it's the freshest resume point, so
        // prefer it over the caller's initial `since` so events emitted during the drop aren't skipped.
        let cursor = Number(req.headers.get('last-event-id') ?? 0) || 0;
        if (!cursor) cursor = Number(url.searchParams.get('since') ?? 0) || 0;
        if (!cursor) {
            const last = db
                .query(`SELECT MAX(id) AS m FROM events${runId ? ' WHERE run_id = ?' : ''}`)
                .get(...(runId ? [runId] : [])) as { m: number | null };
            cursor = last?.m ?? 0;
        }
        let iv: ReturnType<typeof setInterval>;
        let unsub = () => {};
        let closed = false;
        const enc = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                // Setting `id:` lets the browser resume via Last-Event-ID after a reconnect (see cursor above).
                const write = (row: { id: number }) => {
                    if (closed) return;
                    try {
                        controller.enqueue(enc.encode(`id: ${row.id}\ndata: ${JSON.stringify(row)}\n\n`));
                    } catch {
                        // Controller already gone. Self-clean so a connection whose cancel() never fires
                        // doesn't leak its bus subscription and keep taking work on every future emit().
                        closed = true;
                        unsub();
                        clearInterval(iv);
                    }
                };
                // Pull everything newer than the cursor straight from the DB, advancing it as we go.
                const drain = () => {
                    const rows = (
                        runId
                            ? db
                                  .query(`SELECT * FROM events WHERE id > ? AND run_id = ? ORDER BY id LIMIT 500`)
                                  .all(cursor, runId)
                            : db.query(`SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500`).all(cursor)
                    ) as { id: number }[];
                    for (const r of rows) {
                        cursor = r.id;
                        write(r);
                    }
                };
                controller.enqueue(enc.encode(`: connected\n\n`));
                // Order matters: drain first, then subscribe. Both are synchronous with no await between
                // them, so no event can slip through the gap. The cursor guards against a pushed row that
                // the drain already delivered.
                drain();
                if (closed) return; // drain saw a dead controller — don't register a doomed subscription
                unsub = onEvent((row) => {
                    if (row.id <= cursor) return;
                    if (runId && row.run_id !== runId) return;
                    cursor = row.id;
                    write(row);
                });
                iv = setInterval(drain, 10_000);
            },
            cancel() {
                closed = true;
                unsub();
                clearInterval(iv);
            },
        });
        return new Response(stream, {
            headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                ...CORS,
            },
        });
    });

    // ---- actions ----
    on('POST', /^\/api\/workflows\/([^/]+)\/run$/, async (req, m) => {
        const name = seg(m);
        const input = await req.json().catch(() => undefined);
        const id = createRun(db, name, input);
        executor.wake();
        return json({ id });
    });

    // Pause / resume a workflow's cron schedule. Only affects scheduled firing — Start run above and
    // `weir run` are unaffected. The Scheduler owns the enabled flag, so both need it wired up.
    // `changed` reports whether the flag actually flipped: false means the request was a no-op
    // (already in that state, or no schedule row for the name), so callers don't read `ok` as
    // "state applied" when nothing moved.
    on('POST', /^\/api\/workflows\/([^/]+)\/pause$/, (_req, m) => {
        if (!scheduler) return json({ error: 'scheduler unavailable' }, 503);
        return json({ ok: true, changed: scheduler.pauseWorkflow(seg(m)) });
    });

    on('POST', /^\/api\/workflows\/([^/]+)\/resume$/, (_req, m) => {
        if (!scheduler) return json({ error: 'scheduler unavailable' }, 503);
        return json({ ok: true, changed: scheduler.resumeWorkflow(seg(m)) });
    });

    on('POST', /^\/api\/runs\/([^/]+)\/retry$/, async (req, m) => {
        const body = (await req.json().catch(() => ({}))) as { from?: string };
        retryRun(db, seg(m), body.from);
        executor.wake();
        return json({ ok: true });
    });

    on('POST', /^\/api\/runs\/([^/]+)\/cancel$/, (_req, m) => {
        executor.cancel(seg(m));
        return json({ ok: true });
    });

    on('POST', /^\/api\/runs\/([^/]+)\/approve$/, async (req, m) => {
        const body = (await req.json().catch(() => ({}))) as { gate?: string; payload?: unknown };
        approveRun(db, seg(m), body.gate, body.payload);
        executor.wake();
        return json({ ok: true });
    });

    // Reload workflow files from disk and reconcile schedules — no restart needed. Serialized
    // so overlapping requests don't interleave their imports and corrupt the reload's view.
    let reloading: Promise<{ workflows: number; files: number; removed: string[] }> | undefined;
    on('POST', /^\/api\/reload$/, async () => {
        if (!workflowsDir) return json({ error: 'reload unavailable: no workflows directory configured' }, 400);
        reloading ??= (async () => {
            const { files } = await loadWorkflows(workflowsDir, { fresh: true });
            const sync = scheduler?.syncFromRegistry();
            // A removed schedule row means the next tick won't fire it; refresh runnable state.
            executor.wake();
            // Report the schedules that will stop firing (the reload's headline effect), by workflow
            // name — strip the internal `wf:` id prefix so the CLI/UI show plain names.
            const removed = (sync?.removed ?? []).map((id) => id.replace(/^wf:/, ''));
            return { workflows: allWorkflows().length, files, removed };
        })();
        try {
            return json(await reloading);
        } catch (e) {
            return json({ error: (e as Error).message }, 500);
        } finally {
            reloading = undefined;
        }
    });

    const serveOptions: ServeOptions = {
        idleTimeout: 0,
        async fetch(req: Request) {
            const url = new URL(req.url);
            if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

            for (const h of handlers) {
                if (h.m !== req.method) continue;
                const mm = url.pathname.match(h.re);
                if (mm) return h.fn(req, mm, url);
            }

            if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);

            // static UI (SPA fallback to index.html)
            if (uiDir && existsSync(uiDir)) {
                const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
                const file = Bun.file(join(uiDir, rel));
                if (await file.exists()) return new Response(file);
                return new Response(Bun.file(join(uiDir, 'index.html')));
            }
            return new Response('weir API is running. Build the UI (ui/) to serve a dashboard.', {
                headers: { 'content-type': 'text/plain' },
            });
        },
    };
    return listen(serveOptions, deps.port ?? 8099);
}

type ServeOptions = { idleTimeout: number; fetch: (req: Request) => Response | Promise<Response> };

/** Bind `desiredPort`; if it's already in use, fall back to an OS-assigned free port (0)
 *  rather than crashing — so a second daemon / an agent running weir never collides. */
function listen(options: ServeOptions, desiredPort: number) {
    try {
        return Bun.serve({ ...options, port: desiredPort });
    } catch (e) {
        const inUse = /EADDRINUSE|address already in use|in use/i.test(
            `${(e as { code?: string }).code ?? ''} ${(e as Error).message ?? ''}`,
        );
        if (desiredPort !== 0 && inUse) {
            console.warn(`weir: port ${desiredPort} is in use — binding an ephemeral port instead`);
            return Bun.serve({ ...options, port: 0 });
        }
        throw e;
    }
}
