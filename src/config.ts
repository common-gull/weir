// Runtime configuration. Resolved from env + an optional weir.config.json in the cwd.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface WeirConfig {
    db: string;
    workflowsDir: string;
    maxConcurrent: number;
    pools: Record<string, number>;
    port: number;
    uiDir: string;
    retentionDays: number;
    /** Content-addressed artifact store for spec-step outputs (#C4/#C6). */
    storeDir: string;
    /** Root under which each artifact-staging spec step gets an isolated scratch dir. */
    scratchDir: string;
}

export function loadConfig(cwd = process.cwd()): WeirConfig {
    let file: Partial<WeirConfig> = {};
    const p = join(cwd, 'weir.config.json');
    if (existsSync(p)) {
        try {
            file = JSON.parse(readFileSync(p, 'utf8'));
        } catch (e) {
            throw new Error(`invalid weir.config.json: ${(e as Error).message}`);
        }
    }
    return {
        db: process.env.WEIR_DB ?? file.db ?? join(cwd, 'weir.db'),
        workflowsDir: resolve(process.env.WEIR_WORKFLOWS ?? file.workflowsDir ?? join(cwd, 'workflows')),
        maxConcurrent: Number(process.env.WEIR_MAX_CONCURRENT ?? file.maxConcurrent ?? 4),
        pools: file.pools ?? { llm: 2, git: 8 },
        port: Number(process.env.WEIR_PORT ?? file.port ?? 8099),
        uiDir: resolve(process.env.WEIR_UI ?? file.uiDir ?? join(cwd, 'ui', 'build')),
        retentionDays: Number(process.env.WEIR_RETENTION_DAYS ?? file.retentionDays ?? 14),
        storeDir: resolve(process.env.WEIR_STORE ?? file.storeDir ?? join(cwd, '.weir', 'artifacts')),
        scratchDir: resolve(process.env.WEIR_SCRATCH ?? file.scratchDir ?? join(cwd, '.weir', 'scratch')),
    };
}
