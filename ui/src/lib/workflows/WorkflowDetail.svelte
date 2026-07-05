<script lang="ts">
  import { goto } from '$app/navigation';
  import { api } from '$lib/api/client';
  import { subscribe } from '$lib/api/sse';
  import { fmtAgo } from '$lib/format';
  import { loadWorkflows } from '$lib/workflows/store.svelte';
  import type { WorkflowSummary } from '$lib/workflows/types';
  import type { RunSummary } from '$lib/runs/types';
  import type { EventRow } from '$lib/events/types';

  let { workflow }: { workflow: WorkflowSummary } = $props();

  let runs = $state<RunSummary[]>([]);
  let inputText = $state('{}');
  let error = $state<string | null>(null);
  let starting = $state(false);

  async function loadRuns() {
    runs = await api.runs({ workflow: workflow.name });
  }

  // Run a pause/resume call, then refetch the shared workflow list so the badge/button flip
  // immediately (the `schedule.*` SSE event does the same for other open tabs — see +layout.svelte).
  async function act(fn: () => Promise<unknown>) {
    error = null;
    try {
      await fn();
      await loadWorkflows();
    } catch (e) {
      error = `Action failed — ${(e as Error).message}`;
    }
  }

  async function start() {
    error = null;
    let input: unknown;
    const raw = inputText.trim();
    if (raw) {
      try {
        input = JSON.parse(raw);
      } catch (e) {
        error = `Invalid JSON — ${(e as Error).message}`;
        return;
      }
    }
    starting = true;
    try {
      const { id } = await api.runWorkflow(workflow.name, input);
      // The run id only exists after this POST returns, so navigate programmatically.
      goto(`/runs/${encodeURIComponent(id)}`);
    } catch (e) {
      error = `Failed to start — ${(e as Error).message}`;
    } finally {
      starting = false;
    }
  }

  $effect(() => {
    workflow.name; // re-run when the selected workflow changes
    loadRuns();
    const unsub = subscribe((e: EventRow) => {
      // Skip run.log (the per-line firehose) — the run list only changes on lifecycle events.
      if (e.type.startsWith('run.') && e.type !== 'run.log') loadRuns();
    });
    // SSE already refetches on run lifecycle events; keep only a slow reconciliation poll as a net.
    const iv = setInterval(loadRuns, 30000);
    return () => {
      unsub();
      clearInterval(iv);
    };
  });
</script>

<div class="head">
  <span class="dot-s s-{workflow.lastRun?.status ?? 'idle'}"></span>
  <h1>{workflow.name}</h1>
  <span class="badge">{workflow.schedule ? workflow.schedule.cron : 'manual'}</span>
  {#if workflow.schedule}
    {#if workflow.schedulePaused}
      <span class="badge paused">schedule paused</span>
      <button type="button" class="btn sm" onclick={() => act(() => api.resumeWorkflow(workflow.name))}>
        ▶ Resume schedule
      </button>
    {:else}
      <button type="button" class="btn sm" onclick={() => act(() => api.pauseWorkflow(workflow.name))}>
        ⏸ Pause schedule
      </button>
    {/if}
  {/if}
</div>
<div class="subtle">
  {workflow.capabilities.length ? workflow.capabilities.join(', ') : 'no capabilities'} · priority {workflow.priority}
</div>

<div class="panel">
  <h3>Start a run</h3>
  <label class="input-label" for="wf-input">Input JSON — leave as <code>{'{}'}</code> for none</label>
  <textarea
    id="wf-input"
    class="input-json"
    bind:value={inputText}
    spellcheck="false"
    rows="5"
    placeholder="{'{}'}"
  ></textarea>
  {#if error}<div class="input-error">{error}</div>{/if}
  <div class="actions">
    <button type="button" class="btn primary" onclick={start} disabled={starting}>
      ▶ {starting ? 'Starting…' : 'Start run'}
    </button>
  </div>
</div>

{#if Object.keys(workflow.counts).length}
  <div class="panel">
    <h3>Totals</h3>
    <div class="counts">
      {#each Object.entries(workflow.counts) as [status, count] (status)}
        <span class="count-chip"><span class="dot-s s-{status}"></span> {status} · {count}</span>
      {/each}
    </div>
  </div>
{/if}

<div class="section-title" style="padding-left:0">Previous runs</div>
<div class="timeline">
  {#each runs as r (r.id)}
    <a class="run-item" href="/runs/{encodeURIComponent(r.id)}">
      <span class="dot-s s-{r.status}"></span>
      <span class="k">{r.status}</span>
      <span class="subtle idcol">{r.id}</span>
      <span class="time">{fmtAgo(r.created_at)}</span>
    </a>
  {:else}
    <div class="empty">no runs yet — start one above</div>
  {/each}
</div>
