# weir

A small workflow engine that runs on your machine. Workflows are plain TypeScript functions —
control flow is `if`/`while`/`try`, and the whole thing runs as a single Bun process.

Each step's result is saved as it runs, so when a workflow fails partway through, retrying it
resumes from the step that failed instead of starting over.

## Requirements

- [Bun](https://bun.sh)
- Whatever CLIs your workflows call (`git`, `gh`, `claude`, …) on your PATH

## Setup

```sh
bun install          # installs workspace deps (root + ui)
bun run build:ui     # build the web UI the daemon serves
```

## Usage

```sh
bun run src/cli.ts start          # scheduler + workers + web UI at http://127.0.0.1:8099
bun run src/cli.ts run example    # run a workflow once
bun run src/cli.ts list           # list workflows
bun run src/cli.ts retry <id>     # re-run, resuming from the failed step
bun run src/cli.ts approve <id>   # approve a run waiting at a human gate
bun run src/cli.ts reload         # reload workflow files on a running daemon (no restart)
bun test                          # run the tests
```

## Writing a workflow

Add a `.ts` file to `workflows/`. See `workflows/example.ts` for the shape — steps take options
for retries, timeouts, and concurrency; workflows take a cron schedule, capabilities, and priority.

After editing, adding, or deleting a workflow file, run `weir reload` (or the ↻ button in the
UI) to pick up the change on a running daemon — schedules for removed or edited workflows are
reconciled, so a deleted schedule stops firing without a restart.

## Extending it

`src/tools/` ships generic primitives (`runClaude`, …). To add your own
reusable tools/helpers or share code between workflows, put modules in `workflows/common/` and
import them — no engine edits (see AGENTS.md). Outward actions are gated by capabilities; declare a custom one with
`defineCapability(name, description)` (from `src/capabilities.ts`) to make it first-class — validated
by `weir doctor`, shown by `weir list` and `GET /api/capabilities`.
