<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import '../app.css';
  import { api } from '$lib/api/client';
  import { subscribe } from '$lib/api/sse';
  import { fmtAgo } from '$lib/format';
  import { workflows, loadWorkflows } from '$lib/workflows/store.svelte';
  import type { RunSummary } from '$lib/runs/types';
  import type { EventRow } from '$lib/events/types';

  let { children }: { children: Snippet } = $props();

  // Cap the sidebar list at the newest runs so a busy engine can't grow it unbounded. The run id is
  // a random UUID (no chronological cursor), so there is deliberately no "load older" paging.
  const RUN_LIMIT = 50;

  let runs = $state<RunSummary[]>([]);
  let fWorkflow = $state('');
  let fStatus = $state('');
  let reloading = $state(false);
  let drawerOpen = $state(false);

  let theme = $state((document.documentElement.dataset.theme ?? 'light') as 'light' | 'dark');

  // Active selection derives from the URL, so deep links and back/forward light up the right row.
  const params = $derived(page.params as Record<string, string | undefined>);
  const activeWorkflow = $derived(params.name);
  const activeRun = $derived(params.id);

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    // Persisting is best-effort — storage can be blocked; the theme still applies this session.
    try {
      localStorage.setItem('weir-theme', theme);
    } catch {
      /* storage unavailable */
    }
  }

  async function loadRuns() {
    runs = await api.runs({ workflow: fWorkflow || undefined, status: fStatus || undefined, limit: RUN_LIMIT });
  }

  async function reload() {
    reloading = true;
    try {
      await api.reload();
      await Promise.all([loadWorkflows(), loadRuns()]);
    } catch (e) {
      alert(`reload failed: ${(e as Error).message}`);
    } finally {
      reloading = false;
    }
  }

  $effect(() => {
    // Must not read fWorkflow/fStatus here: doing so would rebind this effect and rebuild the SSE
    // subscription on every filter change. The filter effect below owns the runs fetch.
    loadWorkflows();
    const unsub = subscribe((e: EventRow) => {
      // run.log fires once per workflow log line (a chatty run's firehose) and never changes the
      // sidebar list or workflow summaries — refetch only on run lifecycle events, not every line.
      if (e.type.startsWith('run.') && e.type !== 'run.log') {
        loadRuns();
        loadWorkflows();
      } else if (e.type.startsWith('schedule.')) {
        // pause/resume (and reload's schedule sync) change the workflow summaries, not the run list.
        loadWorkflows();
      }
    });
    // The SSE subscription above already refetches on run lifecycle events, so no fast poll is
    // needed. A slow reconciliation poll stays purely as a safety net for events missed offline.
    const iv = setInterval(loadRuns, 30000);
    return () => {
      unsub();
      clearInterval(iv);
    };
  });

  // reload runs when filters change
  $effect(() => {
    fWorkflow;
    fStatus;
    loadRuns();
  });

  // Selecting a nav link navigates, which closes the off-canvas drawer on narrow screens.
  $effect(() => {
    page.url.pathname;
    drawerOpen = false;
  });
</script>

<div class="app {drawerOpen ? 'drawer-open' : ''}">
  <button
    type="button"
    class="btn sm hamburger"
    aria-label="Toggle navigation"
    aria-expanded={drawerOpen}
    onclick={() => (drawerOpen = !drawerOpen)}
  >
    {drawerOpen ? '✕' : '☰'}
  </button>
  <button type="button" class="scrim" tabindex="-1" aria-label="Close navigation" onclick={() => (drawerOpen = false)}></button>
  <div class="sidebar">
    <div class="brand">
      <span class="brandname">weir</span>
      <button type="button" class="btn sm" style="margin-left: auto" onclick={toggleTheme} title="Toggle light / dark paper" aria-label="Toggle light or dark theme">
        {theme === 'dark' ? '☀' : '☾'}
      </button>
      <button type="button" class="btn sm" onclick={reload} disabled={reloading} title="Reload workflow files from disk">
        {reloading ? '…' : '↻ reload'}
      </button>
    </div>

    <div class="section-title">Workflows</div>
    {#each workflows.list as w (w.name)}
      <a class="wf {activeWorkflow === w.name ? 'active' : ''}" href="/workflows/{encodeURIComponent(w.name)}">
        <div class="name">
          <span>{w.name}</span>
          <span class="chev">›</span>
        </div>
        <div class="meta">
          {w.schedule ? w.schedule.cron : 'manual'}{w.schedulePaused ? ' · paused' : ''}{w.capabilities.length
            ? ` · ${w.capabilities.join(',')}`
            : ''}
        </div>
      </a>
    {/each}

    <div class="section-title">Runs</div>
    <div class="filters">
      <select bind:value={fWorkflow}>
        <option value="">all workflows</option>
        {#each workflows.list as w (w.name)}<option value={w.name}>{w.name}</option>{/each}
      </select>
      <select bind:value={fStatus}>
        <option value="">any status</option>
        {#each ['queued', 'running', 'completed', 'failed', 'awaiting-approval', 'cancelled', 'interrupted'] as s}
          <option value={s}>{s}</option>
        {/each}
      </select>
    </div>
    <div class="runs">
      {#each runs as r (r.id)}
        <a class="run-row {activeRun === r.id ? 'active' : ''}" href="/runs/{encodeURIComponent(r.id)}">
          <span class="dot-s s-{r.status}"></span>
          <span class="wfname">{r.workflow}</span>
          <span class="time">{fmtAgo(r.created_at)}</span>
        </a>
      {:else}
        <div class="empty">no runs yet</div>
      {/each}
      {#if runs.length >= RUN_LIMIT}
        <div class="runs-hint">showing latest {RUN_LIMIT}</div>
      {/if}
    </div>
  </div>

  <div class="main">
    {@render children()}
  </div>
</div>
