import { fileURLToPath } from 'node:url';
import { defineWorkflow } from '../src/engine.ts';

// A minimal example. Copy this file and edit it to make your own workflow.
//
// Each step runs once and its result is saved, so if the run fails partway through,
// `weir retry <id>` picks up from the step that failed.
//
// `ctx.step` is a container step: its body is a relocatable `(input) => output` module the exec
// runtime runs in its own subprocess (lib/example-greet.ts here), not an in-process closure. Pure,
// side-effect-free work belongs there. Only a step that must touch the host directly uses
// `ctx.runUnsafelyOnHost`, which runs in-process with full daemon privileges (no isolation) — so
// both are gated on the `host-exec` capability declared below. Never wrap pure work in the host
// hatch: that grants privilege it doesn't need. See docs/containerized-steps.md.
const greet = fileURLToPath(new URL('../lib/example-greet.ts', import.meta.url));

export default defineWorkflow('example', { capabilities: ['host-exec'] }, async (ctx) => {
    const greeting = await ctx.step<string>('greet', { runtime: 'node', module: greet }, { input: { name: 'world' } });

    // A host read: `process.platform` is the host process's OS, so it belongs on the escape
    // hatch, not `ctx.step`. Kept deterministic and side-effect-free.
    const platform = await ctx.runUnsafelyOnHost('read-platform', () => process.platform);

    ctx.log(`${greeting} (on ${platform})`);
    return { greeting, platform };
});

// To run it on a schedule, pass one in the options:
//
//   defineWorkflow('example', { schedule: { cron: '0 9 * * *' } }, async (ctx) => { ... })
