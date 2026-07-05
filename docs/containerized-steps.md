# Containerized steps: pure vs. host

weir is moving step execution toward isolation. As that lands, one rule decides where each step
goes — and it's the rule to keep in mind when migrating a workflow:

> **Only host-touching steps belong on `ctx.runUnsafelyOnHost`. Pure and transform steps stay on
> `ctx.step`.**

## Why it matters

`ctx.runUnsafelyOnHost` runs its closure **in-process on the host with full daemon privileges — no
isolation**. It is therefore gated on the `host-exec` capability, which a workflow must declare
explicitly:

```ts
defineWorkflow('example', { capabilities: ['host-exec'] }, async (ctx) => {
    // pure: computation only — no host access → ctx.step
    const name = await ctx.step('pick-name', () => 'world');
    const greeting = await ctx.step('greet', () => `hello, ${name}`);

    // host-touching: reads the host process → runUnsafelyOnHost (needs host-exec)
    const platform = await ctx.runUnsafelyOnHost('read-platform', () => process.platform);

    return { greeting, platform };
});
```

Both primitives share identical memo / replay / retry semantics — the only difference is the
privilege boundary. So the choice is purely about **least privilege**:

- A **pure** step (compute a value, transform data, format a string) needs nothing from the host.
  Leaving it on `ctx.step` means it can run isolated once isolation lands, and the workflow doesn't
  have to hold `host-exec` on its behalf.
- Wrapping that same pure step in `ctx.runUnsafelyOnHost` is a **regression**: it would grant the
  step `host-exec` — full daemon privilege — that it does not need, and force the whole workflow to
  declare the capability.

When migrating, split each step by this test: *does it read or mutate the host* (spawn a process,
touch the filesystem, read env/platform, open a socket)? If yes, it's a host step —
`runUnsafelyOnHost`, and declare `host-exec`. If no, it stays `ctx.step`.

See `workflows/example.ts` for a tracked, tested demonstration.
