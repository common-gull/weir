// Rung-1 of the step-distribution ladder (docs/containerized-steps.md): map a step spec to a
// local-process argv the C2 runner (src/exec/spawn.ts) executes — no Docker. A `runtime` names a
// pinned language shim (src/exec/shims/*) that speaks the C1 protocol, so an author ships just a
// module (`export default (input) => output` for node, `def step(input): return output` for python)
// and weir wires the protocol around it. The docker runtime and image-by-digest pinning are C8.

import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getArtifact, putArtifact } from '../artifacts.ts';
import type { DB } from '../db.ts';

export type Runtime = 'node' | 'python';

/** A stored artifact (referenced by its sha256) to stage into a step's scratch dir before it runs. */
export interface ArtifactInput {
    /** sha256 of an artifact already in the store (#C4). */
    hash: string;
    /** Destination path, relative to the step's scratch dir, to copy the artifact to. */
    path: string;
}

export interface LocalStepSpec {
    runtime: Runtime;
    /** Path to the author's step module; a relative path resolves against the daemon cwd so the
     *  child always receives a concrete absolute path. */
    module: string;
    /** Stored artifacts to stage into the scratch dir before the step runs (staged by hash). */
    inputs?: ArtifactInput[];
    /** Paths, relative to the scratch dir, to snapshot into the store after the step succeeds. */
    outputs?: string[];
}

function shimPath(name: string): string {
    return fileURLToPath(new URL(`./shims/${name}`, import.meta.url));
}

/** The `[exec, shim]` prefix that runs a runtime's protocol shim. Node steps run on bun — always
 *  present so CI stays green, and the shim is portable JS a real node image can also run under C8;
 *  python steps run on python3. */
function shimArgv(runtime: Runtime): [string, string] {
    switch (runtime) {
        case 'node':
            return ['bun', shimPath('node-shim.ts')];
        case 'python':
            return ['python3', shimPath('python-shim.py')];
        default:
            // Unreachable for a well-typed spec; guards specs that arrive from untyped JSON (C5).
            throw new Error(`unknown step runtime: ${JSON.stringify(runtime)}`);
    }
}

/** Build the local-process command line for a rung-1 step: `<exec> <shim> <module>`. The C2 runner
 *  (`runProtocol`) owns spawning and the protocol exchange; this only assembles the argv. */
export function buildArgv(spec: LocalStepSpec): string[] {
    if (typeof spec.module !== 'string' || spec.module.length === 0) {
        throw new Error(`step runtime '${spec.runtime}' requires a module path`);
    }
    const module = isAbsolute(spec.module) ? spec.module : resolve(spec.module);
    return [...shimArgv(spec.runtime), module];
}

// ---- scratch staging (#C6) ----
//
// A spec step runs in its own scratch dir (the engine sets it as the child's cwd). Declared input
// artifacts are copied in from the store beforehand; declared outputs are content-addressed back
// into the store afterward. Every declared path is confined to the scratch dir so a module can't
// read or clobber files outside it via `..` or an absolute path.

/** Resolve `rel` under `base`, refusing a path that escapes the scratch dir. This is the filesystem
 *  boundary for staging — the analogue of the `$`-template injection boundary for shelling out. */
function resolveWithin(base: string, rel: string): string {
    const full = resolve(base, rel);
    if (full !== base && !full.startsWith(base + sep)) {
        throw new Error(`artifact path escapes the scratch dir: ${rel}`);
    }
    return full;
}

/** Copy each declared input artifact from the store into the scratch dir before the step runs. */
export async function stageInputs(storeDir: string, scratch: string, inputs: ArtifactInput[]): Promise<void> {
    for (const { hash, path } of inputs) {
        const dest = resolveWithin(scratch, path);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(getArtifact(storeDir, hash), dest);
    }
}

/** Snapshot each declared output path from the scratch dir into the store after the step succeeds;
 *  return the `path -> sha256` map recorded in the step's memo row. */
export async function snapshotOutputs(
    db: DB,
    storeDir: string,
    scratch: string,
    outputs: string[],
): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    for (const path of outputs) {
        map[path] = await putArtifact(db, storeDir, resolveWithin(scratch, path));
    }
    return map;
}
