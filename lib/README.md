# lib/ — your shared code

Reusable code shared **between your workflows**: custom tools/adapters and helpers a single
workflow shouldn't own. Plain ES modules — nothing here is scanned or registered by the loader (it
only scans `workflows/`). A workflow just imports what it needs.

Three tiers, from most-shared to least:

| Where | What | Who maintains it |
| --- | --- | --- |
| `src/tools/` | Engine-shipped primitives (`gh`, `ghGraphql`, `git`, `runClaude`, …) + core adapters | weir |
| `lib/` | **Your** reusable tools + helpers, composed from those primitives | you |
| a single `workflows/*.ts` | One-off logic used by exactly one workflow, inline | you |

Rule of thumb: **write it inline first; move it to `lib/` when a second workflow needs it.** Don't
edit `src/tools/` to add a workflow feature — that's engine internals.

## A custom tool

See [`slack.ts`](./slack.ts). The pattern:

```ts
import { defineCapability, requireCapability } from '../src/capabilities.ts';

defineCapability('slack', 'post messages to Slack');      // make it first-class (see below)

export async function slackPost(text: string) {
  requireCapability('slack');                             // gate the outward action
  await fetch(process.env.SLACK_WEBHOOK_URL!, { method: 'POST', body: JSON.stringify({ text }) });
}
```

A workflow opts in by **declaring the capability**, then calling the tool in a step:

```ts
export default defineWorkflow('nightly', { capabilities: ['slack'] }, async (ctx) => {
  await ctx.step('notify', () => slackPost('done ✅'));
});
```

## Custom capabilities

Outward actions are gated by [capabilities](../src/capabilities.ts). A custom capability string
works out of the box (the `Capability` type has a `(string & {})` member), but calling
`defineCapability(name, description)` at module load makes it **first-class**:

- `weir doctor` validates it (warns on any workflow that declares an *un*declared capability),
- `weir list` marks unknown capabilities with a `?`,
- `GET /api/capabilities` lists it with its description for the UI.

Built-ins (`git-push`, `gh-pr`, `gh-comment`, `network`) are declared in `src/capabilities.ts`.

## A shared helper

See [`github.ts`](./github.ts) — GitHub review-thread helpers (`listReviewThreads`,
`replyToReviewThread`, `resolveReviewThread`, …) composed from `src/tools/gh.ts`'s generic
`gh`/`ghGraphql` primitives, used by `workflows/address-pr-comments.ts`.

## Caveat: reload

`weir reload` only cache-busts files in `workflows/`. Edits to `lib/` (like edits to
`src/tools/`) need a daemon **restart** to take effect — Bun caches modules by resolved path. Iterate
on `lib/` code with `bun test` / `weir run <wf>`, which start a fresh process each time.
