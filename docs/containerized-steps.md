# Containerized steps: pure vs. host

weir runs step bodies as relocatable subprocess modules by default, though today's exec runtime
(rung-1) isn't sandboxed from the host yet. One rule decides where each step goes regardless — and
it's the rule to keep in mind when migrating a workflow:

> **Only host-touching steps belong on `ctx.runUnsafelyOnHost`. Pure and transform steps stay on
> `ctx.step`.**

## Why it matters

`ctx.step` runs a **container step**: its body is a relocatable `(input) => output` module the exec
runtime runs in its own subprocess (`src/exec`), not an in-process closure. A closure is no longer
accepted there — passing one throws.

`ctx.runUnsafelyOnHost` runs its closure **in-process on the host with full daemon privileges — no
isolation**. It is therefore gated on the `host-exec` capability, which a workflow must declare
explicitly:

```ts
const greet = fileURLToPath(new URL('../lib/example-greet.ts', import.meta.url));

defineWorkflow('example', { capabilities: ['host-exec'] }, async (ctx) => {
    // pure: a relocatable (input) => output module, run in the exec runtime → ctx.step
    const greeting = await ctx.step('greet', { runtime: 'node', module: greet }, { input: { name: 'world' } });

    // host-touching: reads the host process → runUnsafelyOnHost (needs host-exec)
    const platform = await ctx.runUnsafelyOnHost('read-platform', () => process.platform);

    return { greeting, platform };
});
```

Both primitives memoize / replay / retry a step identically; they differ only in where the body
runs — a relocatable subprocess module (`ctx.step`) versus an in-process host closure
(`runUnsafelyOnHost`). Today's exec runtime is rung-1: the subprocess isn't yet sandboxed from the
host, so both primitives are gated on the same `host-exec` capability. Still split steps by **least
privilege**, since that's what makes the eventual isolation (docker, #C8) a drop-in capability
change instead of a rewrite:

- A **pure** step (compute a value, transform data, format a string) needs nothing from the host, so
  it belongs on `ctx.step` — a relocatable module ready to run sandboxed once real isolation lands.
- Wrapping that same pure step in `ctx.runUnsafelyOnHost` is a **regression**: it locks the step into
  an in-process closure that can never be sandboxed, even after #C8 lands.

When migrating, split each step by this test: *does it read or mutate the host* (spawn a process,
touch the filesystem, read env/platform, open a socket)? If yes, it's a host step —
`runUnsafelyOnHost`, and declare `host-exec`. If no, it stays `ctx.step` as a container step.

Inside a `ctx.loop`, `it.step` gets the same cutover: it's a container step that takes a
`{ runtime, module }` spec and rejects a closure. Host-touching iteration work moves to
`it.runUnsafelyOnHost` (the loop-scoped host hatch, gated on `host-exec`), which keeps `it.step`'s
per-iteration namespacing — migrating `it.step` → `it.runUnsafelyOnHost` leaves the memo key
unchanged, so an in-flight run still replays. `ctx.map` runs its mapper as an in-process host
closure, so it's gated on `host-exec` too — without that gate it would be a way to run host code
around the capability.

See `workflows/example.ts` for a tracked, tested demonstration.
