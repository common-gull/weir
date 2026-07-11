# weir

A small workflow engine that runs on your machine. Workflows are plain TypeScript functions;
step results are persisted so a failed run resumes from the step that failed. Backend in `src/`,
SvelteKit UI in `ui/`. Runs as a single Bun process.

This file is the source of truth for how to work in this repo. When you change a convention, tool,
or command, update it here in the same change so it never drifts from reality.

## Runtime & tooling

- Runtime is **Bun**, not Node. Use `bun`/`bunx`, Bun APIs (`bun:sqlite`, `Bun.serve`), and
  `bun test` — do not reach for npm/yarn, jest, vitest, or Node-only APIs.
- TypeScript is `strict` with `noUncheckedIndexedAccess`. Keep it type-clean — Biome enforces no
  `any` and no non-null assertions (`!`); narrow with a guard or destructuring default instead.
- Shell out through Bun's `$` tagged template (`` $`gh ${args}` ``): it escapes interpolations, so
  pass args as arrays/values — never hand-built command strings, and never feed untrusted input to
  `.raw`. This is the injection boundary; don't defeat it.
- Don't use deprecated APIs. Biome's `noDeprecatedImports` catches deprecated *imports*, but not
  deprecated *methods* on external types — e.g. Bun's `Database.exec` (use `.run`). If a doc or your
  editor marks a symbol `@deprecated`, switch to the replacement in the same change.

## Quality checks

Run the full gate from the repo root after **every** change and make it pass before moving on:

```sh
bun run check       # biome (lint+format) → typecheck → bun test → UI svelte-check
```

Or the pieces individually: `bun run lint` (Biome), `bun run typecheck`, `bun test`, `bun run
check:ui` (svelte-check). Use `bun run lint:fix` to auto-apply formatting and safe lint fixes. CI
runs these same steps. The gate must stay fully clean — zero errors **and** warnings.

Biome formats and lints TS/JS/CSS (4-space, single quotes; config in `biome.json`), plus basic
linting of `.svelte`/`.html` via `html.experimentalFullSupportEnabled` — that coverage is partial,
so **svelte-check owns full `.svelte` type-checking**. CSS is linted but not formatted (Biome
balloons the hand-written stylesheet). `ui` is a Bun workspace, so root scripts reach it with
`--filter` — never `cd` into it.

## Testing

- Tests are colocated as `*.test.ts` next to the code they cover; run with `bun test`.
- Add or update tests in the same change as the code — new behavior ships with a test.

## Comments

- Keep comments minimal. Prefer clear names and small functions over narration.
- When a comment is warranted, explain **why** (intent, a non-obvious constraint, a tradeoff) —
  never restate **what** the code plainly does.
- Comments describe the codebase, not a work session. Do not leave notes about an agent's process,
  TODOs for the reader, or "changed X to Y" history — that belongs in the commit, not the source.

## Commits & pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages **and** PR
  titles: `type(scope): summary` — e.g. `feat(engine): resume from failed step`,
  `fix(cron): handle DST rollover`, `refactor`, `test`, `docs`, `chore`.
- Keep the summary imperative and lowercase.

## Privacy — do not leak local or internal details

The user's real workflows and shared code are personal and gitignored (`workflows/*` except
`example.ts` and its step modules under `workflows/steps/`, plus `*.db`, `.weir/`, `.env`). Shared
workflow helpers live under `workflows/common/` and are covered by that same `workflows/*` rule.
Treat their contents as private.

- Never commit or track personal files: keep changes to tracked, generic code (`src/`, `ui/`,
  `workflows/example.ts`, `workflows/steps/`, docs). Do not add real workflows, shared workflow
  helpers, databases, or secrets.
- Never expose internal specifics — private workflow names/logic, gitignored file contents, local
  paths, host details, credentials — in **commit messages, PR titles/descriptions, or issues**.
  Describe changes in terms of the public, tracked code only.

## Where things are

- `src/` — engine core: `engine.ts`, `executor.ts`, `scheduler.ts`, `cron.ts`, `runs.ts`, `db.ts`,
  `capabilities.ts`, `api/server.ts`, `cli.ts`.
- `src/tools/` — generic primitives usable by workflows (`git`, `gh`, `claude`, `fs`, `notify`, …).
- `workflows/` — workflow definitions (only `example.ts`, its test, and the exec-step modules under
  `workflows/steps/` are tracked). Each workflow's entrypoint is a top-level `*.ts`; its own helpers
  live in a sibling folder (e.g. `workflows/<name>/`), and helpers shared across workflows live in
  `workflows/common/`. The loader scans only top-level `workflows/*.ts`, so neither subfolder is
  loaded as a workflow.
- `ui/` — SvelteKit web UI.

Outward actions are gated by capabilities (`src/capabilities.ts`); declare new ones with
`defineCapability` rather than bypassing the gate.

## Configuration

Runtime config resolves in `src/config.ts` as `process.env.WEIR_X ?? weir.config.json ?? default`.
Knobs include the DB path, ports, artifact/scratch dirs, and:

- `WEIR_CONTAINER_RUNTIME` (default `docker`) — the container runtime binary for container steps.
  Set it to any docker-CLI-compatible binary (`podman`, `nerdctl`) to run `ctx.containerStep` on that
  runtime with no `docker` symlink. It's argv[0] for both `<bin> run` and the digest-resolving
  `<bin> image inspect`; unset, behavior is exactly today's `docker`.

## Workflow helpers & custom tools

Three tiers, most-shared to least:

| Where | What |
| --- | --- |
| `src/tools/` | Engine-shipped primitives (`gh`, `ghGraphql`, `git`, `runClaude`, …). weir owns these — don't edit them to add a workflow feature. |
| `workflows/common/` | Your reusable helpers/tools, composed from those primitives, shared across workflows. |
| a workflow's own folder / inline | Logic used by exactly one workflow — inline in its entrypoint, or split into a sibling `workflows/<name>/` folder. |

Rule of thumb: **write it inline first; move it to the workflow's own folder when the entrypoint
gets big, and to `workflows/common/` once a second workflow needs it.**

A **custom tool** that performs an outward action declares a capability and gates on it — see
`workflows/common/slack.ts`:

```ts
import { defineCapability, requireCapability } from '../../src/capabilities.ts';

defineCapability('slack', 'post messages to Slack'); // first-class: known to doctor/list/API
export async function slackPost(text: string) {
  requireCapability('slack');                        // gate the outward action
  await fetch(process.env.SLACK_WEBHOOK_URL, { method: 'POST', body: JSON.stringify({ text }) });
}
```

A custom capability works even unregistered (the `Capability` type has a `(string & {})` member),
but `defineCapability` makes it first-class: validated by `weir doctor`, shown by `weir list`, and
listed at `GET /api/capabilities`.

**Reload caveat:** `weir reload` only cache-busts top-level `workflows/*.ts`. Edits to helpers
(`workflows/common/`, a workflow's subfolder) or `src/` need a daemon **restart** — Bun caches
modules by resolved path. Iterate with `bun test` / `weir run <wf>`, which start a fresh process.
