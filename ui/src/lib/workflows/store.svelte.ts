// Shared workflow list. The root layout (sidebar) keeps it fresh off the SSE stream; the
// /workflows/[name] route reads it to resolve :name without a second fetch. Rune state in a
// .svelte.ts module is one live source shared across every importer.
import { api } from '$lib/api/client';
import type { WorkflowSummary } from '$lib/workflows/types';

export const workflows = $state<{ list: WorkflowSummary[] }>({ list: [] });

export async function loadWorkflows(): Promise<void> {
    workflows.list = await api.workflows();
}
