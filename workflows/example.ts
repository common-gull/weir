import { defineWorkflow } from '../src/engine.ts';

// A minimal example. Copy this file and edit it to make your own workflow.
//
// Each step runs once and its result is saved, so if the run fails partway through,
// `weir retry <id>` picks up from the step that failed.
//
// Two tiers of execution, both memoized identically:
//   * `ctx.step(name, spec)` is the default — an exec step. The work lives in its own module
//     (`workflows/steps/*.ts`) that weir runs in a subprocess via the runtime shim. Nothing
//     lexically captured crosses the boundary: a value the step needs is passed explicitly as
//     `input`, never closed over.
//   * `ctx.runUnsafelyOnHost` is the escape hatch for work that must touch the host directly. It
//     runs in-process with full daemon privileges (no isolation), so it is gated on the `host-exec`
//     capability declared below. Reach for it only when an exec step genuinely can't do the job.
// See docs/containerized-steps.md.
export default defineWorkflow('example', { capabilities: ['host-exec'] }, async (ctx) => {
    const name = await ctx.step<string>('pick-name', { runtime: 'node', module: './workflows/steps/pick-name.ts' });
    const greeting = await ctx.step<string>(
        'greet',
        { runtime: 'node', module: './workflows/steps/greet.ts' },
        { input: { name } },
    );

    // A host read: `process.platform` is the host process's OS, so it belongs on the escape
    // hatch, not `ctx.step`. Kept deterministic and side-effect-free.
    const platform = await ctx.runUnsafelyOnHost('read-platform', () => process.platform);

    ctx.log(`${greeting} (on ${platform})`);
    return { greeting, platform };
});

// To run it on a schedule, pass one in the options:
//
//   defineWorkflow('example', { schedule: { cron: '0 9 * * *' } }, async (ctx) => { ... })
