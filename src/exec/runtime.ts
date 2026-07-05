// Rung-1 of the step-distribution ladder (docs/containerized-steps.md): map a step spec to a
// local-process argv the C2 runner (src/exec/spawn.ts) executes — no Docker. A `runtime` names a
// pinned language shim (src/exec/shims/*) that speaks the C1 protocol, so an author ships just a
// module (`export default (input) => output` for node, `def step(input): return output` for python)
// and weir wires the protocol around it. The docker runtime and image-by-digest pinning are C8.

import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Runtime = 'node' | 'python';

export interface LocalStepSpec {
    runtime: Runtime;
    /** Path to the author's step module; a relative path resolves against the daemon cwd so the
     *  child always receives a concrete absolute path. */
    module: string;
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
