#!/usr/bin/env bun
// weir CLI. Commands: start | run | retry | approve | reload | list | runs | doctor.

import { existsSync } from 'node:fs';
import { openDb, pruneHistory, type DB } from './db.ts';
import { Executor } from './executor.ts';
import { Scheduler } from './scheduler.ts';
import { createServer } from './api/server.ts';
import { allWorkflows } from './engine.ts';
import { knownCapabilities, unknownCapabilities } from './capabilities.ts';
import { loadWorkflows } from './loader.ts';
import { approveRun, createRun, retryRun } from './runs.ts';
import { loadConfig, type WeirConfig } from './config.ts';
import { doctor } from './doctor.ts';

function makeExecutor(db: DB, cfg: WeirConfig): Executor {
    return new Executor(db, {
        maxConcurrent: cfg.maxConcurrent,
        pools: cfg.pools,
        storeDir: cfg.storeDir,
        scratchDir: cfg.scratchDir,
        containerRuntime: cfg.containerRuntime,
    });
}

async function cmdStart(cfg: WeirConfig): Promise<void> {
    const health = await doctor();
    console.log(health.lines.join('\n'));
    if (!health.ok) {
        console.error('doctor: required tools missing — aborting.');
        process.exit(1);
    }
    const db = openDb(cfg.db);
    const { files } = await loadWorkflows(cfg.workflowsDir);
    console.log(`loaded ${files} workflow file(s) → ${allWorkflows().length} workflow(s)`);
    for (const u of unknownCapabilities(allWorkflows())) {
        console.warn(
            `⚠ workflow "${u.workflow}" declares undeclared capability "${u.capability}" — still enforced; defineCapability() it to document (see AGENTS.md)`,
        );
    }

    const executor = makeExecutor(db, cfg);
    const scheduler = new Scheduler(db, () => executor.wake());
    const server = createServer({
        db,
        executor,
        scheduler,
        workflowsDir: cfg.workflowsDir,
        uiDir: cfg.uiDir,
        port: cfg.port,
    });
    // Record the port we actually bound (may differ from cfg.port after the busy-port fallback) so
    // `weir reload` from another process can find this daemon instead of guessing cfg.port.
    if (server.port) setDaemonPort(db, server.port);
    executor.start();
    scheduler.start();

    // bound the store: prune old history on start and hourly
    const prune = () => {
        const r = pruneHistory(db, { days: cfg.retentionDays });
        if (r.runs || r.events) console.log(`pruned ${r.runs} old run(s), ${r.events} orphan event(s)`);
    };
    prune();
    const pruneIv = setInterval(prune, 3_600_000);

    console.log(`weir daemon up`);
    console.log(`  db:        ${cfg.db}`);
    console.log(`  workflows: ${cfg.workflowsDir}`);
    console.log(`  pools:     ${JSON.stringify(cfg.pools)} (max ${cfg.maxConcurrent})`);
    console.log(`  UI/API:    http://127.0.0.1:${server.port}`);
    if (cfg.port !== 0 && server.port !== cfg.port) {
        console.log(`  note:      requested port ${cfg.port} was busy — using ${server.port}`);
    }

    const shutdown = async () => {
        console.log('\nshutting down…');
        clearInterval(pruneIv);
        scheduler.stop();
        await executor.stop();
        server.stop();
        clearDaemonPort(db); // don't leave a stale port for a later `weir reload` to chase
        db.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

async function cmdRun(cfg: WeirConfig, workflow: string, inputArg?: string): Promise<void> {
    const db = openDb(cfg.db);
    await loadWorkflows(cfg.workflowsDir);
    const input = inputArg ? JSON.parse(inputArg) : undefined;
    const id = createRun(db, workflow, input);
    const ex = makeExecutor(db, cfg);
    const status = await ex.runNow(id);
    reportRun(db, id, status);
    process.exit(status === 'completed' ? 0 : 1);
}

async function cmdRetry(cfg: WeirConfig, runId: string, from?: string): Promise<void> {
    const db = openDb(cfg.db);
    await loadWorkflows(cfg.workflowsDir);
    retryRun(db, runId, from);
    const status = await makeExecutor(db, cfg).runNow(runId);
    reportRun(db, runId, status);
    process.exit(status === 'completed' ? 0 : 1);
}

async function cmdApprove(cfg: WeirConfig, runId: string, gate?: string): Promise<void> {
    const db = openDb(cfg.db);
    await loadWorkflows(cfg.workflowsDir);
    approveRun(db, runId, gate);
    const status = await makeExecutor(db, cfg).runNow(runId);
    reportRun(db, runId, status);
    process.exit(status === 'completed' ? 0 : 1);
}

/** The `kv` slot where a running daemon records the port it actually bound. */
const PORT_NS = '__runtime__';
const PORT_KEY = 'port';

function setDaemonPort(db: DB, port: number): void {
    db.query(
        `INSERT INTO kv (namespace, key, value, expires_at, updated_at) VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(PORT_NS, PORT_KEY, String(port), Date.now());
}

function clearDaemonPort(db: DB): void {
    db.query(`DELETE FROM kv WHERE namespace = ? AND key = ?`).run(PORT_NS, PORT_KEY);
}

/** The port a running daemon last bound (from the db), falling back to the configured port. */
function resolveDaemonPort(cfg: WeirConfig): number {
    if (!existsSync(cfg.db)) return cfg.port;
    try {
        const db = openDb(cfg.db);
        try {
            const row = db.query(`SELECT value FROM kv WHERE namespace = ? AND key = ?`).get(PORT_NS, PORT_KEY) as {
                value: string | null;
            } | null;
            const port = Number(row?.value);
            if (Number.isInteger(port) && port > 0) return port;
        } finally {
            db.close();
        }
    } catch {
        // fall through to the configured port
    }
    return cfg.port;
}

/** Tell a running daemon to reload workflow files and reconcile schedules (no restart). */
async function cmdReload(cfg: WeirConfig): Promise<void> {
    const port = resolveDaemonPort(cfg);
    const url = `http://127.0.0.1:${port}/api/reload`;
    let res: Response;
    try {
        res = await fetch(url, { method: 'POST' });
    } catch {
        console.error(`could not reach a weir daemon at ${url} — is 'weir start' running?`);
        process.exit(1);
    }
    const body = (await res.json().catch(() => ({}))) as {
        workflows?: number;
        files?: number;
        removed?: string[];
        error?: string;
    };
    if (!res.ok) {
        console.error(`reload failed: ${body.error ?? res.status}`);
        process.exit(1);
    }
    console.log(`reloaded ${body.files ?? 0} file(s) → ${body.workflows ?? 0} workflow(s)`);
    if (body.removed?.length) console.log(`removed schedule(s): ${body.removed.join(', ')}`);
    process.exit(0);
}

function reportRun(db: DB, id: string, status: string): void {
    const run = db.query(`SELECT workflow, result, error FROM runs WHERE id = ?`).get(id) as {
        workflow: string;
        result: string | null;
        error: string | null;
    };
    console.log(`run ${id} (${run.workflow}) → ${status}`);
    if (run.result) console.log(`  result: ${run.result}`);
    if (run.error) console.log(`  error:  ${run.error}`);
}

function cmdList(cfg: WeirConfig): Promise<void> {
    return loadWorkflows(cfg.workflowsDir).then(() => {
        const known = knownCapabilities();
        for (const wf of allWorkflows()) {
            const sched = wf.opts.schedule ? ` [${wf.opts.schedule.cron}]` : '';
            const list = wf.opts.capabilities ?? [];
            const caps = list.length ? ` {${list.map((c) => (known.has(c) ? c : `${c}?`)).join(',')}}` : '';
            console.log(`${wf.name}${sched}${caps}`);
        }
        if (unknownCapabilities(allWorkflows()).length) {
            console.log('\n? = capability not declared via defineCapability() — see AGENTS.md');
        }
    });
}

function cmdRuns(cfg: WeirConfig): void {
    const db = openDb(cfg.db);
    const rows = db
        .query(`SELECT id, workflow, status, created_at FROM runs ORDER BY created_at DESC LIMIT 20`)
        .all() as { id: string; workflow: string; status: string; created_at: number }[];
    for (const r of rows) {
        console.log(`${new Date(r.created_at).toISOString()}  ${r.status.padEnd(16)}  ${r.workflow}  ${r.id}`);
    }
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const cfg = loadConfig();
    switch (cmd) {
        case 'start':
            return cmdStart(cfg);
        case 'run':
            if (!rest[0]) return usage();
            return cmdRun(cfg, rest[0], rest[1]);
        case 'retry': {
            if (!rest[0]) return usage();
            const fi = rest.indexOf('--from');
            return cmdRetry(cfg, rest[0], fi >= 0 ? rest[fi + 1] : undefined);
        }
        case 'approve':
            if (!rest[0]) return usage();
            return cmdApprove(cfg, rest[0], rest[1]);
        case 'reload':
            return cmdReload(cfg);
        case 'list':
            return cmdList(cfg);
        case 'runs':
            return cmdRuns(cfg);
        // biome-ignore lint/suspicious/noFallthroughSwitchClause: process.exit() below is terminal
        case 'doctor': {
            const r = await doctor();
            console.log(r.lines.join('\n'));
            // Capability validation needs the registry populated, so load workflows (and their
            // helper imports) first, then flag any declared-but-undeclared capabilities.
            await loadWorkflows(cfg.workflowsDir);
            const unknown = unknownCapabilities(allWorkflows());
            if (unknown.length) {
                console.log('');
                for (const u of unknown) console.log(`⚠ ${u.workflow}: undeclared capability "${u.capability}"`);
            }
            process.exit(r.ok ? 0 : 1);
        }
        default:
            return usage();
    }
}

function usage(): void {
    console.log(`weir — local workflow engine

  weir start                     run scheduler + workers + API/UI (daemon)
  weir run <workflow> [json]     run one workflow now
  weir retry <runId> [--from s]  re-run (resumes at the failed step; --from rewinds)
  weir approve <runId> [gate]    approve a parked run and resume it
  weir reload                    reload workflow files on a running daemon (no restart)
  weir list                      list registered workflows
  weir runs                      recent runs
  weir doctor                    check required CLIs`);
    process.exit(1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
