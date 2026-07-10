# Containerized steps

weir runs a step body one of two ways, and the default is deliberate: **a step is a host closure
unless you opt it into a container.**

```ts
// default: a closure, run in-process on the host — memoized, replayed, retried
const platform = await ctx.step('read-platform', () => process.platform);

// opt-in: a relocatable module, run out-of-process via the exec runtime
const name = await ctx.step('pick-name', { runtime: 'node', module: './workflows/steps/pick-name.ts' });
```

Both forms share identical memo / replay / retry semantics — a failed run resumes from either — and
both consume a step `seq` the same way, so a closure and a spec key interchangeably under replay. What
differs is *where the body runs and what it can reach*, and that is the whole point of the split.

## The default is a host closure

`ctx.step(name, fn)` runs `fn` in-process on the host with the daemon's privileges. This is the home
for host reads and integrations — spawn a process, touch the filesystem, read `process.platform`, call
a tool in `src/tools/`. There is no capability just to run a closure on the host; the host is where the
daemon already lives. Specific *outward* actions are gated on their own capabilities at their
chokepoints (`git-push`, `gh-pr`, `gh-comment`, `network`; see `src/capabilities.ts`), not on running
code as such.

Keep a closure body deterministic across a retry — pull nondeterminism through `ctx.now` / `ctx.random`
/ `ctx.uuid` (which are memoized) so a resumed run replays the same values it first recorded.

## Opt-in isolation: the step-distribution ladder

When a step should run *out of process* — for isolation, or to ship a relocatable unit that doesn't
close over the workflow's lexical scope — hand `ctx.step` a spec instead of a function. weir routes it
to the exec runtime (`src/exec`), which runs the body as a child that speaks a small stdio protocol
(C1) over its stdin/stdout. Because the body crosses a process boundary, a value it needs is passed
**explicitly** as `input`, never captured from the enclosing closure:

```ts
const greeting = await ctx.step('greet', { runtime: 'node', module: './workflows/steps/greet.ts' }, {
    input: { name },
});
```

The exec runtime maps a spec to an argv along a two-rung ladder (`src/exec/runtime.ts`), both rungs
sharing one spawn seam (`src/exec/spawn.ts`) and the same protocol:

- **Rung 1 — local process.** A `runtime` names a pinned language shim (`src/exec/shims/*`) that speaks
  the protocol, so an author ships just a module — `export default (input) => output` for `node`,
  `def step(input): return output` for `python` — and weir wires the protocol around it. This rung is a
  plain subprocess running as the daemon's user; it is **not yet sandboxed from the host**, so its only
  isolation lever is the capability-scoped env below. It exists as the ergonomic, always-available form
  (node runs on `bun`, so CI needs no Docker).
- **Rung 2 — docker** *(design; not yet wired into dispatch — the argv builder, digest pinning, and
  capability mounts are built and unit-tested, but nothing routes a step to them yet; see below)*. The
  same spawn seam, but the child is a `docker run`. This is the rung that actually sandboxes: a
  locked-down network, a single bind-mounted scratch dir, and a digest-pinned image (below). A step is
  authored either as an explicit `image` + `cmd` (the image speaks the protocol itself) or,
  ergonomically, as the same `{ runtime, module }` as rung 1 — which maps to weir's pinned base image
  (`weir-node` / `weir-python`), bind-mounts the module read-only at `/opt/weir`, and runs the baked
  shim on it. Either way the author ships just a module and needs no protocol-aware image.

The dedicated surface for the container rung is `ctx.containerStep`, and **it hasn't landed — so rung 2
is not reachable from a workflow yet.** What ships today is a transitional `StepSpec` overload on
`ctx.step` that routes only to **rung 1**: `ctx.step(name, spec)`, dispatched by `typeof` (a function is
a host closure, an object is a spec). That `StepSpec` is the local `{ runtime, module }` form only — it
carries no `image`, `cmd`, or `network` field — so a docker spec handed to `ctx.step` is a type error,
not a container step. The rung-2 machinery above (`src/exec/runtime.ts`, `src/exec/docker.ts`) is built
and unit-tested against the design this section describes, but nothing dispatches to it until
`ctx.containerStep` wires it in. Inside `ctx.loop`, `it.step` takes the same two forms with the loop's
per-iteration keying.

The container rung is built on four properties, each a lever a workflow can reason about.

### Digest-pinned replay

An image reference is resolved to its canonical `sha256:…` content digest before it runs
(`src/exec/docker.ts`) and the digest is recorded in the step's memo row (`steps.image_digest`) — the
same artifact-hash-in-memo discipline the scratch store uses. That digest is the step's replay
identity: a resumed run executes the exact image bytes the first attempt did, even if the tag has since
moved. weir reads the digest from an already-present image rather than pulling, so pinning never touches
the network.

### Capability-scoped env

A step never inherits the daemon's full environment — that would hand every child every token the
daemon holds. Instead weir builds a minimal env from the step's *ambient* capability grants
(`resolveExecEnv` in `src/capabilities.ts`): a small non-secret operational baseline (`PATH`, `HOME`,
locale/`TZ`, `TMPDIR`, the proxy vars) plus only the credential vars the declared capabilities name —
e.g. `git-push` authorizes `GH_TOKEN` / `GITHUB_TOKEN` / `SSH_AUTH_SOCK`. A step that declares no
credential capability therefore sees none of the daemon's secrets.

For a docker step the same resolved env is forwarded **by name** (`-e NAME`, not `-e NAME=VALUE`): the
value comes from the docker CLI's own environment and never lands on the host process table (`ps auxww`,
`/proc/<pid>/cmdline`) for the life of the run. A capability may also open a bind mount — the `claude`
capability mounts the host's `~/.claude` read-only so a containerized `claude` step reuses the host
login; read-only, so a compromised image can't rewrite credentials or plant a settings hook.

### Gated network

A docker step gets `--network none` — no egress — by default. A `network: true` spec trades that for
docker's default bridge. The argv builder itself takes the flag verbatim and stays a pure,
Docker-free-testable function of its inputs; the capability gate for opting in lives one layer up, in
dispatch. That gate is **not yet wired** — no code checks the `network` capability today
(`requireCapability` is called only for `git-push`, `gh-pr`, and `gh-comment`), because the docker
dispatch it would live in doesn't exist yet — so declaring or omitting `network` is not an egress
control until the container rung is dispatched (`ctx.containerStep`).

### Scratch staging and content-addressed I/O

A spec may declare `inputs` and `outputs`. The step then runs in its own scratch dir (bind-mounted at
`/weir` for a container): declared input artifacts are copied in from the content-addressed store
beforehand, and declared output paths are snapshotted back into it afterward, each addressed by its
sha256 and returned to the workflow as a `path -> hash` map (also recorded in the memo). Every declared
path is confined to the scratch dir — a `..` or absolute path that escapes it is refused — so a module
can read and write only its own staged inputs and outputs, nothing else of the host.

## Host-side output extractors

By default a spec module speaks the C1 protocol: it reads one input frame from stdin and writes one
`{ ok, result }` frame to stdout, which weir decodes. That forces every image to carry a protocol shim.
An optional `extract` on the spec lifts that requirement — a control-plane `(raw) => result` function
weir runs on the host after the step's process exits:

```ts
type ExtractInput = { exitCode: number; stdout: string; stderr: string; artifacts: Record<string, string> };
type Extractor = (raw: ExtractInput) => unknown; // returns the step result; throws to fail the step

ctx.step('encode', {
    runtime: 'node',
    module: './workflows/steps/encode.ts',
    outputs: ['out/result.json'],
    extract: ({ exitCode, stderr, artifacts }) => {
        if (exitCode !== 0) throw new Error(stderr);
        return { output: artifacts['out/result.json'] }; // the content hash the output was addressed to
    },
});
```

`extract` **defaults to the frame decoder**, so a protocol-speaking step never sees it and existing
steps are unchanged — the knob is opt-in, only touched when pointing at a non-conforming image. The
default decoder fails the step on a non-zero exit with no frame, a malformed frame, or an `{ ok:false }`
frame, exactly as before.

Two properties make this safe and dependable:

- **It parses, never evaluates.** The extractor receives the process's captured output as *data* — never
  a shell or `eval` into the sandbox. Adaptation runs in the trusted host plane; the container stays
  untrusted, and interpreting its output is the trusted side's job. It's also the natural home for
  boundary schema validation — assert the result matches the declared output shape, once, on return.
- **Prefer file/artifact output over stdout-scraping.** An extractor keyed on a declared `outputs` file
  (`out/result.json`, content-addressed and handed back in `raw.artifacts`) is far more robust than
  parsing free-form stdout, which mixes with a stock tool's own chatter. The live **logs** channel
  (streamed stderr during the run) is unchanged — `extract` is end-of-run result normalization only,
  never the log path.

## See also

`workflows/example.ts` is a tracked, tested demonstration: a host-closure step and rung-1 exec steps
side by side.
