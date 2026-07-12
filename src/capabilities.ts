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
// to make its custom capability first-class instead of an unvalidated magic string. (Custom
// capabilities still *work* without registering, via the `(string & {})` member of the Capability
// type; registering just makes them discoverable.)

const registry = new Map<Capability, string>();

/** Declare a capability so it's known to the registry. Idempotent (last description wins). */
export function defineCapability(name: Capability, description: string): void {
    registry.set(name, description);
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

// Built-in capabilities. git-push/gh-pr/gh-comment no longer gate the host-side git/gh CLI adapters:
// a workflow body runs in-process in the daemon under full trust, so a check there was bypassable
// (shell out via Bun's `$`) rather than a real boundary. Their teeth are the credential-injection
// policy below (CAP_ENV) — an exec step gets a git/gh token only if it declares the matching
// capability. `network` is still enforced via requireCapability(), at the container-dispatch
// chokepoint (engine.ts), where it gates a non-bypassable network namespace.
defineCapability('git-push', 'push commits and branches to a git remote');
defineCapability('gh-pr', 'open GitHub pull requests');
defineCapability('gh-comment', 'comment on and resolve GitHub PR review threads');
// A conventional capability with no central chokepoint (there's no single place all outbound
// traffic passes through). Seeded so it's a *known* capability, for a workflow or helper tool that
// gates its own network calls — e.g. workflows/common/slack.ts gates its fetch on its 'slack' capability.
defineCapability('network', 'make arbitrary outbound network requests (self-gated; not centrally enforced)');
// A spec-declared container bind mount can expose any host path (/, the runtime socket, credential
// dirs) into a container step, escaping the sandbox — the same escalation class `network` gates, so it
// is gated the same way. Enforced in the container-step dispatch (src/engine.ts), not here.
defineCapability('container-mount', 'bind extra host paths into a container step');
