# Containerized steps: pure vs. host

weir runs step bodies as relocatable subprocess modules by default, though today's exec runtime
(rung-1) isn't sandboxed from the host yet. One rule decides where each step goes regardless — and
it's the rule to keep in mind when migrating a workflow:

> **Only host-touching steps belong on `ctx.runUnsafelyOnHost`. Pure and transform steps stay on
> `ctx.step`, run as exec steps in a subprocess.**

## Why it matters

`ctx.step` runs a **container step**: its body is a relocatable `(input) => output` module the exec
runtime runs in its own subprocess (`src/exec`), not an in-process closure. A closure is no longer
accepted there — passing one throws.

`ctx.runUnsafelyOnHost` runs its closure **in-process on the host with full daemon privileges — no
isolation**. It is therefore gated on the `host-exec` capability, which a workflow must declare
explicitly:

```ts
defineWorkflow('example', { capabilities: ['host-exec'] }, async (ctx) => {
    // pure: computation only — no host access → ctx.step, dispatched to the exec runtime (a
    // subprocess). Each module lives in its own file; a value it needs is passed as `input`,
    // never closed over, since nothing lexical crosses the subprocess boundary.
    const name = await ctx.step<string>('pick-name', { runtime: 'node', module: './workflows/steps/pick-name.ts' });
    const greeting = await ctx.step<string>(
        'greet',
        { runtime: 'node', module: './workflows/steps/greet.ts' },
        { input: { name } },
    );

    // host-touching: reads the host process → runUnsafelyOnHost (needs host-exec)
    const platform = await ctx.runUnsafelyOnHost('read-platform', () => process.platform);

    return { greeting, platform };
});
```

Both primitives share identical memo / replay / retry semantics. What separates them is the
isolation boundary weir is building toward: `ctx.step` is the seam that will gain a real sandbox,
while `ctx.runUnsafelyOnHost` is the permanent host hatch that never does. So the choice is about
**least privilege as isolation lands**:

- A **pure** step (compute a value, transform data, format a string) needs nothing from the host, so
  route it through `ctx.step` — the path that gets sandboxed. Once isolation lands it runs sequestered
  from the host and the workflow no longer needs `host-exec` on its behalf. (A rung-1 exec step
  *today* still spawns an unsandboxed host subprocess — the same privilege as `runUnsafelyOnHost` — so
  it is gated on `host-exec` for now; that requirement falls away only when isolation does.)
- Wrapping that same pure step in `ctx.runUnsafelyOnHost` is a **regression**: it pins the step to
  full daemon privilege permanently, forgoing the isolation `ctx.step` is on track to gain.

When migrating, split each step by this test: *does it read or mutate the host* (spawn a process,
touch the filesystem, read env/platform, open a socket)? If yes, it's a host step —
`runUnsafelyOnHost`, and declare `host-exec`. If no, it's a pure step: give it its own module under
`workflows/steps/` and route it through `ctx.step` as an exec spec.

Inside a `ctx.loop`, `it.step` gets the same cutover: it's a container step that takes a
`{ runtime, module }` spec and rejects a closure. Host-touching iteration work moves to
`it.runUnsafelyOnHost` (the loop-scoped host hatch, gated on `host-exec`), which keeps `it.step`'s
per-iteration namespacing — migrating `it.step` → `it.runUnsafelyOnHost` leaves the memo key
unchanged, so an in-flight run still replays. `ctx.map` runs its mapper as an in-process host
closure, so it's gated on `host-exec` too — without that gate it would be a way to run host code
around the capability.

See `workflows/example.ts` for a tracked, tested demonstration.
