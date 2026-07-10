import { defineWorkflow } from '../src/engine.ts';
import greet from './steps/greet.ts';
import pickName from './steps/pick-name.ts';

// A minimal example. Copy this file and edit it to make your own workflow.
//
// Each step runs once and its result is saved, so if the run fails partway through,
// `weir retry <id>` picks up from the step that failed.
//
// `ctx.step(name, fn)` is the default: a closure that runs in-process on the host, so host reads and
// integrations go straight here. To run a step out-of-process in a locked-down container instead, opt
// in with `ctx.containerStep(name, { image, ... })` (or `{ runtime, module }`) — that form crosses a
// process boundary, so a value it needs is passed explicitly as `input` rather than closed over. See
// docs/containerized-steps.md.
export default defineWorkflow('example', async (ctx) => {
    const name = await ctx.step('pick-name', () => pickName());
    const greeting = await ctx.step('greet', () => greet({ name }));

    // A host read: `process.platform` is the host process's OS, so it runs as a plain closure step.
    // Kept deterministic and side-effect-free.
    const platform = await ctx.step('read-platform', () => process.platform);

    ctx.log(`${greeting} (on ${platform})`);
    return { greeting, platform };
});

// To run it on a schedule, pass one in the options:
//
//   defineWorkflow('example', { schedule: { cron: '0 9 * * *' } }, async (ctx) => { ... })
