# Containerized steps: pure vs. host

weir is moving step execution toward isolation. As that lands, one rule decides where each step
goes — and it's the rule to keep in mind when migrating a workflow:

> **Only host-touching steps belong on `ctx.runUnsafelyOnHost`. Pure and transform steps stay on
> `ctx.step`, run as exec steps in a subprocess.**

## Why it matters

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

Inside a `ctx.loop`, the same hatch is loop-scoped: use `it.runUnsafelyOnHost` (the host counterpart
of `it.step`) for a host-touching iteration step. It keeps `it.step`'s per-iteration namespacing, so
migrating `it.step` → `it.runUnsafelyOnHost` only adds the `host-exec` gate — the memo key is
unchanged and an in-flight run still replays.

See `workflows/example.ts` for a tracked, tested demonstration.
