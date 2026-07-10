// Per-workflow capability guardrail (replaces the SDK's canUseTool). Default-deny: a
// workflow must declare a capability (e.g. 'git-push', 'gh-pr') for its steps to perform
// that outward action. The current workflow's grants are exposed ambiently via
// AsyncLocalStorage so the CLI adapters can enforce without threading ctx everywhere.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Capability } from './types.ts';

interface CapStore {
    workflow: string;
    caps: Set<Capability>;
}

const als = new AsyncLocalStorage<CapStore>();

export class CapabilityError extends Error {
    constructor(cap: Capability, workflow: string) {
        super(
            `workflow "${workflow}" attempted a "${cap}" action without the capability. ` +
                `Add \`capabilities: ['${cap}']\` to its definition to allow it.`,
        );
        this.name = 'CapabilityError';
    }
}

/** Run `fn` with the given workflow's capabilities in scope. */
export function withCapabilities<T>(store: CapStore, fn: () => T): T {
    return als.run(store, fn);
}

export function hasCapability(cap: Capability): boolean {
    return als.getStore()?.caps.has(cap) ?? false;
}

/** Throw unless the current workflow declared `cap`. Call this at the top of an outward action. */
export function requireCapability(cap: Capability): void {
    const store = als.getStore();
    if (!store) throw new Error(`requireCapability("${cap}") called outside a workflow run`);
    if (!store.caps.has(cap)) throw new CapabilityError(cap, store.workflow);
}

export function currentWorkflow(): string | undefined {
    return als.getStore()?.workflow;
}

// ---- capability registry ----
// A declared set of capability names + human descriptions. The built-ins are seeded below; a
// user's custom tool (e.g. under `workflows/common/`) calls `defineCapability(...)` at import time
// to make its custom capability first-class — known to `weir doctor`/`list` and the API/UI —
// instead of an unvalidated magic string. (Custom capabilities still *work* without registering,
// via the `(string & {})` member of the Capability type; registering just makes them discoverable.)

const registry = new Map<Capability, string>();

/** Declare a capability so it's known to doctor/list/the UI. Idempotent (last description wins). */
export function defineCapability(name: Capability, description: string): void {
    registry.set(name, description);
}

/** All declared capabilities, name → description. Complete only after workflows (and their helper
 *  imports) have loaded, since custom capabilities register when their module is imported. */
export function knownCapabilities(): ReadonlyMap<Capability, string> {
    return registry;
}

export function isKnownCapability(name: Capability): boolean {
    return registry.has(name);
}

/** Capabilities a workflow declares that aren't in the registry — surfaced as warnings, not
 *  errors (an unregistered capability still enforces; it's just undocumented). Structurally typed
 *  so this stays free of an engine import (avoids a cycle). */
export function unknownCapabilities(
    workflows: readonly { readonly name: string; readonly opts: { readonly capabilities?: readonly Capability[] } }[],
): { workflow: string; capability: Capability }[] {
    const out: { workflow: string; capability: Capability }[] = [];
    for (const wf of workflows) {
        for (const cap of wf.opts.capabilities ?? []) {
            if (!registry.has(cap)) out.push({ workflow: wf.name, capability: cap });
        }
    }
    return out;
}

// Built-in capabilities, each enforced via requireCapability() at its chokepoint(s): the CLI
// adapters in src/tools for git/gh.
defineCapability('git-push', 'push commits and branches to a git remote');
defineCapability('gh-pr', 'open GitHub pull requests');
defineCapability('gh-comment', 'comment on and resolve GitHub PR review threads');
// A conventional capability with no central chokepoint (there's no single place all outbound
// traffic passes through). Seeded so it's a *known* capability, for a workflow or helper tool that
// gates its own network calls — e.g. workflows/common/slack.ts gates its fetch on its 'slack' capability.
defineCapability('network', 'make arbitrary outbound network requests (self-gated; not centrally enforced)');

// ---- exec-step env policy ----
// The capability declaration doubles as the credential-injection policy for exec-step subprocesses
// (issue #30). A rung-1 exec step would otherwise inherit the daemon's *entire* environment — every
// token the daemon holds — so instead we hand the child a minimal env built from its ambient grants:
// only the credential vars its declared capabilities name, plus a tiny operational baseline. A step
// that declares no credential capability therefore sees none of the daemon's secrets. This is the
// process runtime's only isolation lever; network-namespace isolation and secret mounts are Docker's
// (C8).

/** Each capability → the daemon env vars it authorizes forwarding to a step's subprocess. A
 *  capability not listed here (e.g. network) contributes no credentials of its own. */
const CAP_ENV: Partial<Record<Capability, readonly string[]>> = {
    'gh-pr': ['GH_TOKEN', 'GITHUB_TOKEN'],
    'gh-comment': ['GH_TOKEN', 'GITHUB_TOKEN'],
    'git-push': ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK'],
};

/** Non-secret operational vars passed through unconditionally, regardless of declared capabilities.
 *  None names a credential, so forwarding them leaks no grant — but existing steps rely on them, and
 *  withholding them silently changes behavior rather than protecting a secret (the child already runs
 *  as the daemon's user with full filesystem access — the process runtime has no fs sandbox, that's
 *  Docker's job, C8 — so withholding any of these only breaks tooling). Specifically:
 *  - PATH: without it the runtime interpreter (bun/python3) can't even be located.
 *  - HOME: git/ssh and the runtimes resolve their per-user config and caches through it — ~/.gitconfig
 *    (user identity, credential.helper, the safe.directory allowlist git now requires),
 *    ~/.ssh/known_hosts, ~/.config/gh, ~/.bun — so a step declaring git-push would forward the
 *    credential yet still fail to run git.
 *  - LANG/LC_ALL/TZ: locale- and timezone-dependent output (collation, number/date formatting) that an
 *    existing step may parse; dropping them shifts the child to the C/POSIX locale and system TZ.
 *  - TMPDIR: the scratch location a step expects.
 *  - HTTP(S)_PROXY/NO_PROXY (both cases, since tools disagree on casing): outbound routing — without it
 *    a step that holds 'network' loses connectivity in a proxied deployment despite holding the cap. */
const BASE_EXEC_ENV: readonly string[] = [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TZ',
    'TMPDIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
];

/** Build the minimal environment for an exec-step subprocess from the *ambient* capability grants
 *  (the set `withCapabilities` opened for the running workflow). Copies from `source` (the daemon env
 *  by default) only the operational baseline plus the credential vars the declared capabilities
 *  authorize — so a step that declares nothing inherits none of the daemon's secrets. */
export function resolveExecEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
    const env: Record<string, string> = {};
    const pass = (name: string) => {
        const value = source[name];
        if (value !== undefined) env[name] = value;
    };
    for (const name of BASE_EXEC_ENV) pass(name);
    for (const cap of Object.keys(CAP_ENV) as Capability[]) {
        if (!hasCapability(cap)) continue;
        for (const name of CAP_ENV[cap] ?? []) pass(name);
    }
    return env;
}
