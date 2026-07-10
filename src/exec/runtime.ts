// Rungs 1 and 2 of the step-distribution ladder (docs/containerized-steps.md) — the opt-in,
// out-of-process side of `ctx.step` (the default being a host closure): map a step spec to
// the argv the C2 runner (src/exec/spawn.ts) executes. Rung-1 is a local process — a `runtime` names
// a pinned language shim (src/exec/shims/*) that speaks the C1 protocol, so an author ships just a
// module (`export default (input) => output` for node, `def step(input): return output` for python)
// and weir wires the protocol around it. Rung-2 (buildDockerArgv, below) is a `docker run` on the
// same spawn seam, with image-by-digest pinning in src/exec/docker.ts.

import { $ } from 'bun';
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ArtifactKind, artifactKind, getArtifact, hashFile, putArtifact } from '../artifacts.ts';
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

/** Resolve a step module path against the daemon cwd if it isn't already absolute, so both rungs
 *  hand the child (or the docker mount) a concrete absolute path. */
function resolveModulePath(module: string): string {
    return isAbsolute(module) ? module : resolve(module);
}

/** How weir runs a runtime's protocol shim across the ladder — one record per runtime keeps the
 *  interpreter, shim filename, base image, and container module path in a single place, shared by the
 *  local (buildArgv) and docker (buildDockerArgv) mappings so the two rungs can't drift. */
interface RuntimeSpec {
    /** Interpreter for the rung-1 local shim. Node runs on bun (always present, so CI stays green). */
    localExec: string;
    /** Interpreter baked into the rung-2 weir base image. Node's diverges from rung-1 — the base image
     *  is a real node, mirroring the shim's portable-JS design note — while python stays python3. */
    containerExec: string;
    /** Shim filename under src/exec/shims/: run from there locally, baked at /opt/weir/<shim> in the
     *  base image. */
    shim: string;
    /** Filename the author module is bind-mounted as inside the base image (under CONTAINER_WEIR_DIR).
     *  Its extension matches the runtime so the interpreter loads it as it would on the host. */
    moduleFile: string;
    /** Pinned weir base image for the runtime authoring form; dispatch (slice 4) resolves it to a
     *  digest, mirroring how an image-form step is pinned (src/exec/docker.ts). */
    image: string;
}

const RUNTIMES: Record<Runtime, RuntimeSpec> = {
    node: {
        localExec: 'bun',
        containerExec: 'node',
        shim: 'node-shim.ts',
        moduleFile: 'module.ts',
        image: 'weir-node',
    },
    python: {
        localExec: 'python3',
        containerExec: 'python3',
        shim: 'python-shim.py',
        moduleFile: 'module.py',
        image: 'weir-python',
    },
};

function runtimeSpec(runtime: Runtime): RuntimeSpec {
    // Widen to admit undefined: a spec from untyped JSON (C5) can name a runtime outside the union.
    const rt: RuntimeSpec | undefined = RUNTIMES[runtime];
    if (!rt) throw new Error(`unknown step runtime: ${JSON.stringify(runtime)}`);
    return rt;
}

/** The `[exec, shim]` prefix that runs a runtime's protocol shim locally (rung-1). */
function shimArgv(runtime: Runtime): [string, string] {
    const { localExec, shim } = runtimeSpec(runtime);
    return [localExec, shimPath(shim)];
}

/** Build the local-process command line for a rung-1 step: `<exec> <shim> <module>`. The C2 runner
 *  (`runProtocol`) owns spawning and the protocol exchange; this only assembles the argv. */
export function buildArgv(spec: LocalStepSpec): string[] {
    if (typeof spec.module !== 'string' || spec.module.length === 0) {
        throw new Error(`step runtime '${spec.runtime}' requires a module path`);
    }
    return [...shimArgv(spec.runtime), resolveModulePath(spec.module)];
}

// ---- rung-2: docker runtime (#C8) ----
//
// The container rung of the ladder. Same spawn seam as rung-1 — the C2 runner (src/exec/spawn.ts)
// runs the argv and speaks the C1 protocol over the child's stdio — but the child is a `docker run`
// rather than a local interpreter. A step is authored either as an explicit image + command (the
// image speaks the protocol itself) or, ergonomically, as the same `{ runtime, module }` as rung-1 —
// which maps to weir's pinned base image, bind-mounts the module read-only, and runs the shim baked
// into the image on it. The container is locked down by default: `--network none` (no egress) and
// only the per-step scratch dir bind-mounted at /weir, so the module sees its staged inputs and
// writes its outputs there and nothing else of the host. A `network: true` spec trades that egress
// lock for docker's default bridge — gated on the `network` capability in dispatch, not here.
// Credentials reach it the same capability-scoped way rung-1 gets them (resolveExecEnv, #C7),
// forwarded by name (`-e NAME`, so the value comes from the docker CLI's env and never lands on the
// host process table); the image is pinned by digest (src/exec/docker.ts) so a replay runs the exact
// bytes the first run did.

/** A host→container bind mount. `readonly` maps to docker's `:ro` volume suffix. */
export interface DockerMount {
    host: string;
    container: string;
    readonly?: boolean;
}

/** Fixed base directory inside every weir base image: the protocol shim is baked here and a
 *  runtime-form step's author module is bind-mounted alongside it. The shim's own deps sit one level
 *  up (e.g. /opt/protocol.ts, matching its `../` import) and stay dependency-free leaves so the
 *  container's plain interpreter can load them. */
const CONTAINER_WEIR_DIR = '/opt/weir';

/** Fields common to both docker authoring forms. */
interface DockerStepCommon {
    /** Give the container the docker default bridge network instead of `--network none`. Taken
     *  verbatim by the builder; dispatch (slice 4) is where opting in requires the `network`
     *  capability, so this stays a pure argv function. */
    network?: boolean;
    inputs?: ArtifactInput[];
    outputs?: string[];
}

/** A container step run by an explicit image + command: the image already speaks the C1 protocol. */
export interface DockerImageSpec extends DockerStepCommon {
    /** Image reference to run. Pin it by digest (`name@sha256:…`, see resolveImageDigest) so a
     *  replay runs the exact image the first run did rather than whatever the tag now points at. */
    image: string;
    /** Command run in the container; overrides the image's default. The resulting process must speak
     *  the C1 stdio protocol (read the input frame from stdin, write one output frame to stdout). */
    cmd?: string[];
}

/** A container step authored the rung-1 way — a `runtime` + `module` — but run in a container. weir
 *  supplies the pinned base image for the runtime, bind-mounts the module read-only, and invokes the
 *  shim baked into the image, so an author ships just a module and needs no protocol-aware image. */
export interface DockerRuntimeSpec extends DockerStepCommon {
    runtime: Runtime;
    /** Host path to the author's step module; a relative path resolves against the daemon cwd (as
     *  buildArgv does for a local step), then is bind-mounted read-only into the container. */
    module: string;
}

export type DockerStepSpec = DockerImageSpec | DockerRuntimeSpec;

/** Render a bind mount as docker's `-v host:container[:ro]` value. */
function mountArg(m: DockerMount): string {
    return `${m.host}:${m.container}${m.readonly ? ':ro' : ''}`;
}

/** Resolve a docker spec's runtime concern — the image, its command tail, and any weir-supplied
 *  mounts — so buildDockerArgv assembles one argv shape for both authoring forms. The image form runs
 *  `image` + `cmd` as given; the runtime form maps to the pinned base image, mounts the module
 *  read-only at a fixed path, and runs the baked shim on it (`<exec> /opt/weir/<shim> <module>`),
 *  mirroring the rung-1 `<exec> <shim> <module>` local mapping. Module and image reach the argv only
 *  as array elements — never interpolated into a shell string. */
function resolveDockerSpec(spec: DockerStepSpec): { image: string; cmd: string[]; mounts: DockerMount[] } {
    if ('runtime' in spec) {
        if (typeof spec.module !== 'string' || spec.module.length === 0) {
            throw new Error(`docker step runtime '${spec.runtime}' requires a module path`);
        }
        const { containerExec, shim, moduleFile, image } = runtimeSpec(spec.runtime);
        const host = resolveModulePath(spec.module);
        const container = `${CONTAINER_WEIR_DIR}/${moduleFile}`;
        return {
            image,
            cmd: [containerExec, `${CONTAINER_WEIR_DIR}/${shim}`, container],
            mounts: [{ host, container, readonly: true }],
        };
    }
    if (typeof spec.image !== 'string' || spec.image.length === 0) {
        throw new Error('docker step requires an image reference');
    }
    return { image: spec.image, cmd: spec.cmd ?? [], mounts: [] };
}

/** Build the `docker run` argv for a container step, in either authoring form (image+cmd, or
 *  runtime+module — see resolveDockerSpec). Pure: the per-step scratch dir (bind-mounted at /weir),
 *  the capability-scoped env (from resolveExecEnv, #C7, forwarded by name as `-e NAME` so values stay
 *  off the host process table), and any extra mounts (e.g. the claude capability's ~/.claude, see
 *  dockerCapabilityMounts) are all passed in, so the whole argv is a deterministic function of its
 *  inputs and unit-testable without Docker. Defaults to `--network none`, `--rm`, and `-i`: a step
 *  gets no egress, leaves no stopped container, and keeps stdin open so its C1 input frame reaches the
 *  module. A `network: true` spec drops `--network none` for docker's default bridge; the flag is
 *  taken verbatim, its capability gate living in dispatch (slice 4) so this stays pure. */
export function buildDockerArgv(
    spec: DockerStepSpec,
    opts: { scratch: string; env?: Record<string, string>; mounts?: DockerMount[] },
): string[] {
    const { image, cmd, mounts: specMounts } = resolveDockerSpec(spec);
    const mounts: DockerMount[] = [{ host: opts.scratch, container: '/weir' }, ...specMounts, ...(opts.mounts ?? [])];
    const mountArgs = mounts.flatMap((m) => ['-v', mountArg(m)]);
    // `-e NAME` (name only) forwards each value from the docker CLI's own environment, which the
    // spawn seam sets to this same resolved env. Emitting `-e NAME=VALUE` instead would leak secrets
    // onto the host process table (ps auxww, /proc/<pid>/cmdline) for the life of the run.
    const envArgs = Object.keys(opts.env ?? {}).flatMap((k) => ['-e', k]);
    // Locked to `--network none` (no egress) unless the spec opts into docker's default bridge.
    const networkArgs = spec.network ? [] : ['--network', 'none'];
    // `-i` keeps the container's stdin open and forwarded so the module can read its C1 input frame;
    // without it docker closes stdin immediately and every containerized step sees EOF instead.
    return ['docker', 'run', '--rm', '-i', ...networkArgs, ...mountArgs, ...envArgs, image, ...cmd];
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
// into the store afterward. A declared path that is a directory rides through the store as one tar
// blob (archived on the way out, unpacked on the way in), so a repo checkout or dependency tree is a
// single content-addressed artifact. Every declared path is confined to the scratch dir so a module
// can't read or clobber files outside it via `..` or an absolute path. A directory artifact adds two
// more vectors, both riding *inside* its tar: a symlink member (stored as a link, recreated live in a
// *different* scratch dir on stage-in, where a later read/write follows it out) and a traversing
// member name (a `..` component or an absolute path that `tar -x` could write outside the destination —
// system `tar` doesn't portably sanitize these). A symlink is refused on archive (assertNoSymlinks /
// the lstat below); both are refused again on unpack from the tar's own member list, before any member
// touches the host fs (assertBlobStagesWithin).

/** Resolve `rel` under `base`, refusing a path that escapes the scratch dir. This is the filesystem
 *  boundary for staging — the analogue of the `$`-template injection boundary for shelling out. */
function resolveWithin(base: string, rel: string): string {
    const full = resolve(base, rel);
    if (full !== base && !full.startsWith(base + sep)) {
        throw new Error(`artifact path escapes the scratch dir: ${rel}`);
    }
    return full;
}

/** Prefix for the transient tar written while content-addressing a directory output. It lives in the
 *  scratch dir (which the engine always tears down) and is excluded from any archive of that dir. */
const ARCHIVE_PREFIX = '.weir-archive-';

/** Shared message for a symlink caught inside a directory artifact, on either side of the store. */
function symlinkError(path: string): Error {
    return new Error(`directory artifact contains a symlink, which could escape the scratch dir: ${path}`);
}

/** Refuse a directory artifact that contains any symlink, anywhere under `root`. `tar -c` stores a
 *  symlink as a link (it does not follow it), and `tar -x` recreates it live on stage-in — into a
 *  *different* scratch dir, where a later read or write through it would silently escape confinement.
 *  Rejecting the whole tree keeps the store invariant "a 'dir' blob has no symlinks", so unpacking one
 *  can never plant an escaping link. `readdir(withFileTypes)` reports each entry's own type via lstat,
 *  so the walk sees a symlink as a symlink and never traverses into (dereferences) it. */
async function assertNoSymlinks(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const full = join(root, entry.name);
        if (entry.isSymbolicLink()) throw symlinkError(full);
        if (entry.isDirectory()) await assertNoSymlinks(full);
    }
}

/** Deterministic-tar a directory tree into `archive`: sorted entries and zeroed mtime/ownership so
 *  the same tree content-addresses to the same hash across runs and machines. Uncompressed — gzip's
 *  header embeds a timestamp that would perturb the bytes, and the store dedups identical blobs. The
 *  exclude (passed as one interpolated arg so Bun's `$` can't glob-expand its `*`) drops a sibling
 *  temp archive when `dir` is the scratch root itself — a whole-scratch output — so a directory never
 *  captures the very tar being written from it. Refuses a tree with any symlink first, so no escaping
 *  link is ever archived (see assertNoSymlinks). */
async function archiveDir(dir: string, archive: string): Promise<void> {
    await assertNoSymlinks(dir);
    const exclude = `--exclude=./${ARCHIVE_PREFIX}*`;
    await $`tar ${exclude} --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf ${archive} -C ${dir} .`.quiet();
}

/** Scan a tar blob's member list and refuse it if any member could escape the destination on unpack,
 *  *before* anything is extracted — so an escaping member is caught without ever being materialized on
 *  the host fs (a member extracted first and pruned after could already have been read or written
 *  through). Two vectors: a symlink member (`-tv`'s verbose listing tags one with a leading `l`,
 *  exactly as `ls -l` does; `tar -x` would recreate the link live, then a later read/write follows it
 *  out) and a traversing member name — a `..` component or an absolute path that `tar -x` could write
 *  outside the `-C` destination. `resolveWithin` confines only the *destination* dir, not the tar's own
 *  member paths, and system `tar` doesn't portably strip `..`/leading-`/` on extraction, so names are
 *  validated here rather than trusting the extractor. Defense in depth: archiveDir produces neither, so
 *  this only bites a blob that reached the store some other way. */
async function assertBlobStagesWithin(blob: string): Promise<void> {
    if ((await $`tar -tvf ${blob}`.text()).split('\n').some((line) => line.startsWith('l'))) {
        throw symlinkError(blob);
    }
    for (const name of (await $`tar -tf ${blob}`.text()).split('\n')) {
        if (name.length > 0 && (isAbsolute(name) || name.split('/').includes('..'))) {
            throw new Error(`directory artifact member escapes the scratch dir: ${name}`);
        }
    }
}

/** Copy each declared input artifact from the store into the scratch dir before the step runs. A
 *  'dir' artifact (a tar blob) is unpacked into its destination directory; a 'file' is copied. */
export async function stageInputs(db: DB, storeDir: string, scratch: string, inputs: ArtifactInput[]): Promise<void> {
    for (const { hash, path } of inputs) {
        const dest = resolveWithin(scratch, path);
        const blob = getArtifact(storeDir, hash);
        if (artifactKind(db, hash) === 'dir') {
            await assertBlobStagesWithin(blob);
            await mkdir(dest, { recursive: true });
            await $`tar -xf ${blob} -C ${dest}`.quiet();
        } else {
            await mkdir(dirname(dest), { recursive: true });
            await copyFile(blob, dest);
        }
    }
}

/** Content-address each declared output without committing it yet: stream-hash the file (or tar the
 *  directory into a scratch-local temp and hash that), returning the `path -> hash` map plus a
 *  `commit()` that copies those sources into the store and records the artifact rows. Streaming keeps
 *  a large output off the heap. Hashing mutates nothing shared, so a caller can hand the map to a host
 *  extractor and only `commit()` once it accepts the run — a rejecting extractor then leaves no orphan
 *  artifacts, the guarantee a failed step already gets on the default (frame-decode) path. */
export async function planOutputs(
    db: DB,
    storeDir: string,
    scratch: string,
    outputs: string[],
): Promise<{ map: Record<string, string>; commit: () => Promise<void> }> {
    const staged: { src: string; kind: ArtifactKind }[] = [];
    const map: Record<string, string> = {};
    for (const path of outputs) {
        const full = resolveWithin(scratch, path);
        const info = await lstat(full);
        if (info.isSymbolicLink()) {
            // `lstat`, not `stat`: a symlink output would otherwise be dereferenced — a directory link
            // makes `tar -C link .` archive the outside target's content, a read escape past confinement.
            throw new Error(`output path is a symlink, which could escape the scratch dir: ${path}`);
        }
        if (info.isDirectory()) {
            // Archive into the scratch dir, which the engine always tears down — so a rejected
            // extractor (commit never called) leaks no temp tar, mirroring the in-memory guarantee
            // the old byte-buffering path gave.
            const temp = join(scratch, `${ARCHIVE_PREFIX}${crypto.randomUUID()}.tar`);
            await archiveDir(full, temp);
            map[path] = await hashFile(temp);
            staged.push({ src: temp, kind: 'dir' });
        } else {
            map[path] = await hashFile(full);
            staged.push({ src: full, kind: 'file' });
        }
    }
    const commit = async (): Promise<void> => {
        for (const { src, kind } of staged) {
            await putArtifact(db, storeDir, src, kind);
            // Only the 'dir' branch's src is a scratch-local temp tar; a 'file' src is the step's own
            // output and must survive the commit.
            if (kind === 'dir') await rm(src, { force: true });
        }
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
