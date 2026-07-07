// Rungs 1 and 2 of the step-distribution ladder (docs/containerized-steps.md): map a step spec to
// the argv the C2 runner (src/exec/spawn.ts) executes. Rung-1 is a local process — a `runtime` names
// a pinned language shim (src/exec/shims/*) that speaks the C1 protocol, so an author ships just a
// module (`export default (input) => output` for node, `def step(input): return output` for python)
// and weir wires the protocol around it. Rung-2 (buildDockerArgv, below) is a `docker run` on the
// same spawn seam, with image-by-digest pinning in src/exec/docker.ts.

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactHash, getArtifact, putArtifact } from '../artifacts.ts';
import { hasCapability } from '../capabilities.ts';
import type { DB } from '../db.ts';

export type Runtime = 'node' | 'python';

/** A stored artifact (referenced by its sha256) to stage into a step's scratch dir before it runs. */
export interface ArtifactInput {
    /** sha256 of an artifact already in the store (#C4). */
    hash: string;
    /** Destination path, relative to the step's scratch dir, to copy the artifact to. */
    path: string;
}

/** What a host-side extractor (#50) receives: a step's raw process output plus the `path -> hash` map
 *  of its content-addressed outputs. It runs in the trusted control plane after the step exits and
 *  PARSES this data — never eval/shells it — turning whatever the process emitted into the step result. */
export interface ExtractInput {
    exitCode: number;
    stdout: string;
    stderr: string;
    artifacts: Record<string, string>;
}

/** A `(raw) => result` normalizer run on the host once a step's process exits: it returns the step
 *  result (or a promise of one, e.g. for async boundary validation), or throws/rejects to fail the
 *  step. Defaults to the C1 frame decoder, so a protocol-speaking step needs none; an author
 *  targeting a stock image supplies one to bridge its native output. */
export type Extractor = (raw: ExtractInput) => unknown | Promise<unknown>;

export interface LocalStepSpec {
    runtime: Runtime;
    /** Path to the author's step module; a relative path resolves against the daemon cwd so the
     *  child always receives a concrete absolute path. */
    module: string;
    /** Stored artifacts to stage into the scratch dir before the step runs (staged by hash). */
    inputs?: ArtifactInput[];
    /** Paths, relative to the scratch dir, to snapshot into the store after the step succeeds. */
    outputs?: string[];
    /** Host-side output normalizer (#50). Omitted, the step's stdout is decoded as a C1 output frame
     *  (the default). Provide one to adapt a step whose process emits something else natively. */
    extract?: Extractor;
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

// ---- rung-2: docker runtime (#C8) ----
//
// The container rung of the ladder. Same spawn seam as rung-1 — the C2 runner (src/exec/spawn.ts)
// runs the argv and speaks the C1 protocol over the child's stdio — but the child is a `docker run`
// rather than a local interpreter. The container is locked down by default: `--network none` (no
// egress) and only the per-step scratch dir bind-mounted at /weir, so the module sees its staged
// inputs and writes its outputs there and nothing else of the host. Credentials reach it the same
// capability-scoped way rung-1 gets them (resolveExecEnv, #C7), forwarded by name (`-e NAME`, so the
// value comes from the docker CLI's env and never lands on the host process table); the image is
// pinned by digest (src/exec/docker.ts) so a replay runs the exact bytes the first run did.

/** A host→container bind mount. `readonly` maps to docker's `:ro` volume suffix. */
export interface DockerMount {
    host: string;
    container: string;
    readonly?: boolean;
}

export interface DockerStepSpec {
    /** Image reference to run. Pin it by digest (`name@sha256:…`, see resolveImageDigest) so a
     *  replay runs the exact image the first run did rather than whatever the tag now points at. */
    image: string;
    /** Command run in the container; overrides the image's default. The resulting process must speak
     *  the C1 stdio protocol (read the input frame from stdin, write one output frame to stdout). */
    cmd?: string[];
    inputs?: ArtifactInput[];
    outputs?: string[];
}

/** Render a bind mount as docker's `-v host:container[:ro]` value. */
function mountArg(m: DockerMount): string {
    return `${m.host}:${m.container}${m.readonly ? ':ro' : ''}`;
}

/** Build the `docker run` argv for a container step. Pure: the per-step scratch dir (bind-mounted at
 *  /weir), the capability-scoped env (from resolveExecEnv, #C7, forwarded by name as `-e NAME` so
 *  values stay off the host process table), and any
 *  extra mounts (e.g. the claude capability's ~/.claude, see dockerCapabilityMounts) are all passed
 *  in, so the whole argv is a deterministic function of its inputs and unit-testable without Docker.
 *  Defaults to `--network none`, `--rm`, and `-i`: a step gets no egress, leaves no stopped
 *  container, and keeps stdin open so its C1 input frame reaches the module. */
export function buildDockerArgv(
    spec: DockerStepSpec,
    opts: { scratch: string; env?: Record<string, string>; mounts?: DockerMount[] },
): string[] {
    if (typeof spec.image !== 'string' || spec.image.length === 0) {
        throw new Error('docker step requires an image reference');
    }
    const mounts: DockerMount[] = [{ host: opts.scratch, container: '/weir' }, ...(opts.mounts ?? [])];
    const mountArgs = mounts.flatMap((m) => ['-v', mountArg(m)]);
    // `-e NAME` (name only) forwards each value from the docker CLI's own environment, which the
    // spawn seam sets to this same resolved env. Emitting `-e NAME=VALUE` instead would leak secrets
    // onto the host process table (ps auxww, /proc/<pid>/cmdline) for the life of the run.
    const envArgs = Object.keys(opts.env ?? {}).flatMap((k) => ['-e', k]);
    // `-i` keeps the container's stdin open and forwarded so the module can read its C1 input frame;
    // without it docker closes stdin immediately and every containerized step sees EOF instead.
    return [
        'docker',
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        ...mountArgs,
        ...envArgs,
        spec.image,
        ...(spec.cmd ?? []),
    ];
}

/** Extra bind mounts a step's *ambient* capabilities open into its container, mirroring how
 *  resolveExecEnv (#C7) forwards capability-scoped env. The `claude` capability mounts the host's
 *  ~/.claude into the container so a containerized `claude` step reuses the host login — a
 *  deliberately longer-lived hole (host credentials cross the isolation boundary) the capability
 *  gates. The mount is read-only: the login only needs to be read, and a writable path back to
 *  ~/.claude would let a compromised image plant a settings.json hook or rewrite credentials on the
 *  host. Kept separate from buildDockerArgv so that stays a pure function of its arguments. */
export function dockerCapabilityMounts(): DockerMount[] {
    const mounts: DockerMount[] = [];
    if (hasCapability('claude'))
        mounts.push({ host: join(homedir(), '.claude'), container: '/root/.claude', readonly: true });
    return mounts;
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

/** Content-address each declared output without committing it yet: read the bytes and compute the
 *  sha256, returning the `path -> hash` map plus a `commit()` that writes those bytes into the store
 *  and records the artifact rows. Hashing mutates nothing shared, so a caller can hand the map to a
 *  host extractor and only `commit()` once it accepts the run — a rejecting extractor then leaves no
 *  orphan artifacts, the guarantee a failed step already gets on the default (frame-decode) path. */
export async function planOutputs(
    db: DB,
    storeDir: string,
    scratch: string,
    outputs: string[],
): Promise<{ map: Record<string, string>; commit: () => Promise<void> }> {
    const staged: { bytes: Uint8Array }[] = [];
    const map: Record<string, string> = {};
    for (const path of outputs) {
        const bytes = await readFile(resolveWithin(scratch, path));
        map[path] = artifactHash(bytes);
        staged.push({ bytes });
    }
    const commit = async (): Promise<void> => {
        for (const { bytes } of staged) await putArtifact(db, storeDir, bytes);
    };
    return { map, commit };
}

/** Snapshot each declared output path from the scratch dir into the store after the step succeeds;
 *  return the `path -> sha256` map recorded in the step's memo row. */
export async function snapshotOutputs(
    db: DB,
    storeDir: string,
    scratch: string,
    outputs: string[],
): Promise<Record<string, string>> {
    const { map, commit } = await planOutputs(db, storeDir, scratch, outputs);
    await commit();
    return map;
}
