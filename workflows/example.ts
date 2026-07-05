import { defineWorkflow } from '../src/engine.ts';

// A minimal example. Copy this file and edit it to make your own workflow.
//
// Each `ctx.step` runs once and its result is saved, so if the run fails partway
// through, `weir retry <id>` picks up from the step that failed.
export default defineWorkflow('example', {}, async (ctx) => {
    const name = await ctx.step('pick-name', () => 'world');
    const greeting = await ctx.step('greet', () => `hello, ${name}`);

    ctx.log(greeting);
    return { greeting };
});

// To run it on a schedule, pass one in the options:
//
//   defineWorkflow('example', { schedule: { cron: '0 9 * * *' } }, async (ctx) => { ... })
