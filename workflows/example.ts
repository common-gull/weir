import { defineWorkflow } from '../src/engine.ts';

// A minimal example. Copy this file and edit it to make your own workflow.
//
// Each `ctx.step` runs once and its result is saved, so if the run fails partway
// through, `weir retry <id>` picks up from the step that failed.
//
// Pure, side-effect-free work stays on `ctx.step`. Only a step that must touch the host
// directly uses `ctx.runUnsafelyOnHost`, which runs in-process with full daemon privileges
// (no isolation) — so it is gated on the `host-exec` capability declared below. Never wrap a
// pure step in the host hatch: that grants privilege it doesn't need. See
// docs/containerized-steps.md.
export default defineWorkflow('example', { capabilities: ['host-exec'] }, async (ctx) => {
    const name = await ctx.step('pick-name', () => 'world');
    const greeting = await ctx.step('greet', () => `hello, ${name}`);

    // A host read: `process.platform` is the host process's OS, so it belongs on the escape
    // hatch, not `ctx.step`. Kept deterministic and side-effect-free.
    const platform = await ctx.runUnsafelyOnHost('read-platform', () => process.platform);

    ctx.log(`${greeting} (on ${platform})`);
    return { greeting, platform };
});

// To run it on a schedule, pass one in the options:
//
//   defineWorkflow('example', { schedule: { cron: '0 9 * * *' } }, async (ctx) => { ... })
