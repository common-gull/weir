---
name: plan-work
description: >-
    Plan a codebase change end to end — research the code, clarify scope, split the work into small
    independently-mergeable stacked slices (≤200 lines of hand-written non-test source each), get
    human sign-off, then create linked GitHub issues (an epic plus dependency-ordered sub-issues so
    other agents pick up work in the right order). Use when the user wants to plan a feature,
    refactor, or multi-step change before writing code, or asks to "plan work", break work into
    slices/small PRs, or create tracking issues for a change.
---

# Plan work

Turn a fuzzy "we should change X" into a reviewed plan and a set of linked GitHub issues that other
agents can execute in order. Research first, slice small, get approval, then file issues.

## Invariants (never violate these)

- **A slice is independently mergeable.** Each slice must be able to land on `main` on its own
    without breaking the build or in-flight work. If a slice only makes sense once a later slice
    lands, it's mis-sliced — make it additive, gate it behind a flag/unused export, or reorder.
- **A slice is small.** Target **≤200 lines** of hand-written diff, **excluding generated files and
    tests**. If a slice is bigger, split it. Tests don't count against the budget — but they still
    ship *with* the slice.
- **Slices are stacked, not tangled.** Order them so each depends only on earlier ones. The
    dependency graph is a DAG; encode it with `--blocked-by` so the pickup order is unambiguous.
- **Facts before opinions.** Base slicing on what the code actually is (existing utilities, patterns,
    blast radius), gathered by research — not on guesses.
- **The human approves before any issue is created.** Present the plan and stop. Do not run a single
    `gh issue create` until the user explicitly says yes.
- **Every slice ships green.** Each slice includes its tests and passes `bun run check` (the weir
    gate: biome → typecheck → `bun test` → svelte-check). Note this in each issue.

## Flow

### 1. Understand

Have the conversation. Restate the goal in your own words, name the outcome, and surface obvious
constraints. Don't jump to a solution yet.

### 2. Research (delegate to Explore agents)

Launch **up to 3 `Explore` agents in parallel** (one message, multiple tool calls) to gather facts.
Give each a distinct focus, e.g.:

- Where the relevant code lives and how it's wired (entry points, call paths).
- **Existing utilities and patterns to reuse** — prefer reuse over new code; note exact paths.
- Blast radius: what else touches this, and the colocated `*.test.ts` conventions to follow.

Use one agent for a small, well-scoped change; more only when the scope is genuinely uncertain.
Optionally follow with a single `Plan` agent to pressure-test the approach and surface alternatives.

### 3. Clarify

Use **`AskUserQuestion`** for genuine forks — requirements *and* approach. Ask when the answer
changes the plan (data model, API shape, where a boundary goes). Don't ask about things you can
verify in the code or that have an obvious default; pick the default and say so.

### 4. Slice & stack

Break the work into slices that satisfy every invariant above. For each slice, decide:

- **Scope** — the one coherent thing it does.
- **Files** — the specific files it touches (from research).
- **Reuse** — existing functions/utilities it should build on, with paths.
- **Depends-on** — which earlier slice(s) must land first.
- **Size estimate** — rough hand-written non-test line count; if >200, split before presenting.

Run each slice through two gates in your head: *"Could this merge to `main` alone without breaking
anything?"* and *"Is the non-test diff under 200 lines?"* If either fails, reshape or split.

### 5. Present for review — then STOP

Show the plan in the conversation:

- **Context** — why this change, what it enables.
- **Epic** — one-line summary of the whole change.
- **Slice table** — id, title, scope, key files, depends-on, size estimate.

Then stop and ask for explicit approval. **Create nothing yet.**

### 6. Create issues (only after explicit approval)

Create the epic first, then each slice **in topological order** (a slice can only be `--blocked-by`
issues that already exist). Capture each issue number from the URL `gh` prints.

Feed each body via a `--body-file -` heredoc (avoids quoting pitfalls) and grab the number with
`${url##*/}` — the URL `gh` prints ends in the issue number.

```sh
# Epic (parent) — create first, capture its number.
epic=$(gh issue create --title "epic: <feature>" --body-file - <<'EOF'
<context + goal + the slice list>
EOF
); epic=${epic##*/}

# Slice 1 — nested under the epic, no blockers.
s1=$(gh issue create --title "feat(<scope>): slice 1 — <what>" --parent "$epic" --body-file - <<'EOF'
<slice body — see template below>
EOF
); s1=${s1##*/}

# Slice 2 — depends on slice 1.
s2=$(gh issue create --title "feat(<scope>): slice 2 — <what>" --parent "$epic" --blocked-by "$s1" --body-file - <<'EOF'
<slice body>
EOF
); s2=${s2##*/}
```

- Use `--blocked-by "$a $b"` (space-separated) when a slice depends on more than one earlier slice.
- **Leave issues unassigned.** The blocked-by graph is the pickup signal: a slice is *ready* when
    it's open and all its blockers are closed. List ready work with
    `gh issue list --state open --json number,title,body` and pick issues with no open blockers.
- Title slices as Conventional Commits (`type(scope): summary`, imperative, lowercase) so they map
    cleanly onto PR titles.
- Finish by reporting the created graph back to the user: epic number, and each slice with its
    number and blockers (e.g. `#101 → #102 → #103`).

## Slice issue body template

```md
## Context
Part of #<epic>. <one line on why this slice exists>.

## Scope
<the single coherent change this slice makes>

## Files
- `path/to/file.ts` — <what changes>

## Reuse
- `path/to/util.ts` — <existing helper to build on instead of writing new code>

## Out of scope
<what deliberately belongs to a later slice>

## Acceptance criteria
- [ ] <observable behavior / outcome>
- [ ] Ships with colocated `*.test.ts` covering the new behavior
- [ ] `bun run check` is clean (zero errors and warnings)
- [ ] Merges to `main` on its own without breaking the build or other slices

Blocked by: #<n>  ·  ≤200 lines hand-written non-test diff
```

## Repo notes

- Runtime is **Bun**; the quality gate is `bun run check`. Reference these in issues, not npm/jest.
- Adding issues to a **GitHub Projects board** (`gh issue create -p`) needs an extra token scope —
    run `gh auth refresh -s project` once first. The epic + sub-issue flow above needs only `repo`.
- **Privacy (per AGENTS.md):** keep issue titles and bodies to the public, tracked codebase
    (`src/`, `ui/`, docs). Never put private workflow names/logic, gitignored file contents, local
    paths, or secrets into issues.
