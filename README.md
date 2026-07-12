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
for retries, timeouts, and concurrency; workflows take a cron schedule and a priority.

After editing, adding, or deleting a workflow file, run `weir reload` (or the ↻ button in the
UI) to pick up the change on a running daemon — schedules for removed or edited workflows are
reconciled, so a deleted schedule stops firing without a restart.

## Extending it

The engine ships no workflow adapters — tools and helpers are yours. Write one inline in the workflow
that needs it; once a second workflow needs it, put the module in `workflows/common/` and import it —
no engine edits (see AGENTS.md). To run a step in a sandbox instead of on the host, use
`ctx.containerStep`: it declares the `env` it needs (a daemon secret crosses in only when named), the
`mounts` it reads, and whether it gets network egress — see `docs/containerized-steps.md`.
