import { defineWorkflow } from '../src/engine.ts';

// A minimal example. Copy this file and edit it to make your own workflow.
//
// Each step runs once and its result is saved, so if the run fails partway through,
// `weir retry <id>` picks up from the step that failed.
//
// `ctx.step(name, fn)` is the default: a closure that runs in-process on the host, so host reads
// and integrations go straight here. A step can also take an exec spec — `ctx.step(name, { runtime,
// module })` — to run its body as a subprocess module under `workflows/steps/*.ts`; that form
// crosses a process boundary, so a value the module needs is passed explicitly as `input` rather
// than closed over.
export default defineWorkflow('example', async (ctx) => {
    const name = await ctx.step<string>('pick-name', { runtime: 'node', module: './workflows/steps/pick-name.ts' });
    const greeting = await ctx.step<string>(
        'greet',
        { runtime: 'node', module: './workflows/steps/greet.ts' },
        { input: { name } },
    );

    // A host read: `process.platform` is the host process's OS, so it runs as a plain closure step.
    // Kept deterministic and side-effect-free.
    const platform = await ctx.step('read-platform', () => process.platform);

    ctx.log(`${greeting} (on ${platform})`);
    return { greeting, platform };
});

// To run it on a schedule, pass one in the options:
//
//   defineWorkflow('example', { schedule: { cron: '0 9 * * *' } }, async (ctx) => { ... })
