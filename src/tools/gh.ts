// GitHub CLI adapter (`gh`, --json). Outward actions gated by capabilities.

import { $ } from 'bun';
import { requireCapability } from '../capabilities.ts';
import type { Capability } from '../types.ts';

/**
 * Run `gh` with raw args and return stdout. The escape hatch a workflow uses to drive GitHub
 * directly rather than growing a bespoke helper here for every operation. Pass `capability` for
 * anything that writes — it's enforced against the running workflow's grants (ambient, via ALS),
 * so gating works even though the call originates in the workflow.
 */
export async function gh(args: string[], opts: { capability?: Capability } = {}): Promise<string> {
    if (opts.capability) requireCapability(opts.capability);
    return await $`gh ${args}`.text();
}

/**
 * Run a GraphQL query/mutation via `gh api graphql`, returning its `data`. String vars are sent
 * as `-f` (raw), numbers/booleans as `-F` (typed, so `Int!`/`Boolean!` variables bind correctly).
 * Throws on a GraphQL `errors` payload. Mutations pass `capability` to gate the write.
 */
export async function ghGraphql<T = unknown>(
    query: string,
    vars: Record<string, string | number | boolean> = {},
    opts: { capability?: Capability } = {},
): Promise<T> {
    if (opts.capability) requireCapability(opts.capability);
    const fields: string[] = ['-f', `query=${query}`];
    for (const [k, v] of Object.entries(vars)) fields.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`);
    // gh exits non-zero when the response carries an `errors` payload (and on auth/network failure),
    // so run with .nothrow() and inspect the output ourselves — otherwise Bun's shell throws a noisy
    // ShellError before we can surface the curated messages below.
    const res = await $`gh api graphql ${fields}`.nothrow().quiet();
    const out = res.stdout.toString();
    let parsed: { data?: T; errors?: unknown[] };
    try {
        parsed = JSON.parse(out) as { data?: T; errors?: unknown[] };
    } catch {
        // Non-JSON output means gh failed before producing a GraphQL response (bad auth, no network, …).
        const detail = res.stderr.toString().trim() || out.trim() || `exit ${res.exitCode}`;
        throw new Error(`gh api graphql failed: ${detail.slice(0, 500)}`);
    }
    if (parsed.errors?.length) throw new Error(`gh graphql error: ${JSON.stringify(parsed.errors).slice(0, 500)}`);
    if (res.exitCode !== 0) {
        const detail = res.stderr.toString().trim() || `exit ${res.exitCode}`;
        throw new Error(`gh api graphql failed: ${detail.slice(0, 500)}`);
    }
    return parsed.data as T;
}

export interface PullRequest {
    number: number;
    title: string;
    url: string;
    headRefName: string;
    headRefOid?: string;
    baseRefName?: string;
    isDraft: boolean;
    reviewDecision: string | null;
    updatedAt: string;
    author?: { login: string } | null;
}

export interface Issue {
    number: number;
    title: string;
    body: string;
    url: string;
    labels: { name: string }[];
    updatedAt: string;
    author?: { login: string } | null;
}

let cachedLogin: Promise<string> | undefined;

/**
 * The authenticated `gh` user's login, cached for the process. Used to trust only self-authored
 * content (issues/PRs) so scheduled workflows can't be steered by a third party's text.
 */
export function currentLogin(): Promise<string> {
    cachedLogin ??= $`gh api user -q .login`.text().then(
        (out) => {
            const login = out.trim();
            if (!login) throw new Error('gh api user returned no login');
            return login;
        },
        (err) => {
            cachedLogin = undefined; // never memoize a failure — let the next call retry
            throw err;
        },
    );
    return cachedLogin;
}

export async function listMyPrs(repo?: string): Promise<PullRequest[]> {
    const fields = 'number,title,url,headRefName,isDraft,reviewDecision,updatedAt';
    const args = ['pr', 'list', '--author', '@me', '--state', 'open', '--json', fields];
    if (repo) args.push('--repo', repo);
    const out = await $`gh ${args}`.text();
    return JSON.parse(out) as PullRequest[];
}

/**
 * Open PRs in a repo, with the head SHA so a reviewer can dedup revisions. By default returns
 * every author's PRs; pass `author` (e.g. '@me') to narrow server-side to a single author.
 * `limit` caps how many are returned (default 100); without it `gh` silently caps at 30.
 */
export async function listOpenPrs(
    repo: string,
    opts: { author?: string; limit?: number } = {},
): Promise<PullRequest[]> {
    const limit = opts.limit ?? 100;
    if (limit < 1) return [];
    const fields = 'number,title,url,headRefName,headRefOid,baseRefName,isDraft,reviewDecision,updatedAt,author';
    const args = ['pr', 'list', '--repo', repo, '--state', 'open', '--json', fields, '--limit', String(limit)];
    if (opts.author) args.push('--author', opts.author);
    const out = await $`gh ${args}`.text();
    return JSON.parse(out) as PullRequest[];
}

/**
 * Open issues in a repo (gh's `issue list` excludes PRs). Optionally narrowed to a `label` and/or
 * an `author` (e.g. '@me' to restrict to your own issues).
 */
export async function listIssues(
    repo: string,
    opts: { limit?: number; label?: string; author?: string } = {},
): Promise<Issue[]> {
    const limit = opts.limit ?? 20;
    if (limit < 1) return []; // `gh` rejects `--limit 0`; a non-positive limit means "nothing"
    const fields = 'number,title,body,url,labels,updatedAt,author';
    const args = ['issue', 'list', '--repo', repo, '--state', 'open', '--json', fields, '--limit', String(limit)];
    if (opts.label) args.push('--label', opts.label);
    if (opts.author) args.push('--author', opts.author);
    const out = await $`gh ${args}`.text();
    return JSON.parse(out) as Issue[];
}

/** The unified diff of a PR, for review. */
export async function prDiff(repo: string, number: number): Promise<string> {
    return await $`gh pr diff ${number} --repo ${repo}`.text();
}

/** The "owner/name" slug for a repo working dir, or null if it has no GitHub remote. */
export async function repoSlug(dir: string): Promise<string | null> {
    const out = await $`gh repo view --json nameWithOwner -q .nameWithOwner`.cwd(dir).nothrow().text();
    return out.trim() || null;
}

export async function prComment(repo: string, number: number, body: string): Promise<void> {
    requireCapability('gh-comment');
    await $`gh pr comment ${number} --repo ${repo} --body ${body}`.quiet();
}

export async function prCreate(
    repo: string,
    opts: { title: string; body: string; head: string; base?: string; draft?: boolean },
): Promise<string> {
    requireCapability('gh-pr');
    const args = ['pr', 'create', '--repo', repo, '--title', opts.title, '--body', opts.body, '--head', opts.head];
    if (opts.base) args.push('--base', opts.base);
    if (opts.draft) args.push('--draft');
    return (await $`gh ${args}`.text()).trim();
}

/** Dependabot alerts for a repo (requires appropriate gh auth scope). */
export async function securityAlerts(repo: string): Promise<unknown[]> {
    const out = await $`gh api ${`/repos/${repo}/dependabot/alerts?state=open`}`.nothrow().text();
    try {
        return JSON.parse(out) as unknown[];
    } catch {
        return [];
    }
}
