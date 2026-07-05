<script lang="ts">
  import { tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '$lib/api/client';
  import { subscribe } from '$lib/api/sse';
  import { fmtTime, pretty } from '$lib/format';
  import type { RunDetail } from '$lib/runs/types';
  import type { EventRow } from '$lib/events/types';

  let { id }: { id: string } = $props();

  let detail = $state<RunDetail | null>(null);
  let events = $state<EventRow[]>([]);
  let logEl = $state<HTMLDivElement | null>(null);
  let hasOlder = $state(false);
  let loadingOlder = $state(false);

  // Only backfill the newest page on open, then live-tail — a long/chatty run's full history is
  // fetched lazily on scroll-up rather than in one unbounded payload.
  const PAGE = 200;

  // Events that change run/step status and warrant a detail refetch (lifecycle + attempts).
  const RELOAD_ON = new Set([
    'run.started', 'run.completed', 'run.failed', 'run.parked', 'run.cancelled', 'run.skipped',
    'run.paused', 'run.resumed',
    'step.attempt', 'step.retry',
  ]);

  async function load() {
    detail = await api.run(id);
  }

  // Prepend an older page of history. Over-fetch by one so an exact multiple of PAGE doesn't leave
  // a spurious "load earlier" button; the extra probe row (the oldest) is dropped from the display.
  async function loadOlder() {
    if (loadingOlder || !events.length) return;
    loadingOlder = true;
    const rid = id;
    const anchor = logEl;
    const prevHeight = anchor?.scrollHeight ?? 0;
    const prevTop = anchor?.scrollTop ?? 0;
    try {
      const older = await api.runEvents(rid, { limit: PAGE + 1, before: events[0].id });
      if (rid !== id) return;
      hasOlder = older.length > PAGE;
      const page = hasOlder ? older.slice(1) : older;
      events = [...page, ...events];
      // Keep the viewport anchored on the row the user was reading: once the prepend grows the
      // container, restore scrollTop by the height delta so the list doesn't jump.
      await tick();
      if (rid === id && anchor) anchor.scrollTop = prevTop + (anchor.scrollHeight - prevHeight);
    } finally {
      loadingOlder = false;
    }
  }

  // Run an action, then refetch this run so its new state shows immediately.
  async function act(fn: () => Promise<unknown>) {
    await fn();
    await load();
  }

  $effect(() => {
    const rid = id;
    detail = null;
    events = [];
    hasOlder = false;
    loadingOlder = false;
    load();
    let unsub = () => {};
    let cancelled = false;
    const onEvent = (e: EventRow) => {
      if (events.some((x) => x.id === e.id)) return; // dedup safety net
      // Only auto-scroll when the user is already pinned to the bottom; otherwise a live event
      // would yank them away from older history they scrolled up to read (e.g. via "load earlier").
      const pinned = !logEl || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
      events = [...events, e];
      // Only refetch the run/steps on status-changing events — NOT on every chatty `run.log`
      // line, or a talkative agent would trigger a full reload per token.
      if (RELOAD_ON.has(e.type)) load();
      if (pinned) queueMicrotask(() => logEl?.scrollTo(0, logEl.scrollHeight));
    };
    // backfill the newest page first, then live-tail from the last id (no gap, no overlap).
    // Over-fetch by one so an exact multiple of PAGE doesn't show a spurious "load earlier" button.
    api.runEvents(rid, { limit: PAGE + 1 }).then((hist) => {
      if (cancelled || rid !== id) return;
      hasOlder = hist.length > PAGE;
      events = hasOlder ? hist.slice(1) : hist;
      const since = events.length ? events[events.length - 1].id : 0;
      unsub = subscribe(onEvent, rid, since);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  });

  const run = $derived(detail?.run);
</script>

{#if !detail}
  <div class="empty">loading…</div>
{:else if run}
  <div class="head">
    <span class="dot-s s-{run.status}"></span>
    <h1>{run.workflow}</h1>
    <span class="badge">{run.status}</span>
  </div>
  <div class="subtle">{run.id} · attempt {run.attempt} · {fmtTime(run.created_at)} → {fmtTime(run.finished_at)}</div>

  <div class="actions">
    <button class="btn" onclick={() => act(() => api.retry(id))}>↻ Retry</button>
    {#if run.status === 'running' || run.status === 'queued'}
      <button class="btn" onclick={() => act(() => api.cancel(id))}>✕ Cancel</button>
    {/if}
    {#if run.status === 'queued'}
      <button class="btn" onclick={() => act(() => api.pause(id))}>⏸ Pause</button>
    {/if}
    {#if run.status === 'paused'}
      <button class="btn" onclick={() => act(() => api.resume(id))}>▶ Resume</button>
    {/if}
    {#if run.status === 'awaiting-approval'}
      <button class="btn" onclick={() => act(() => api.approve(id))}>✓ Approve</button>
    {/if}
    <button class="btn" onclick={() => api.runWorkflow(run.workflow).then((r) => goto(`/runs/${encodeURIComponent(r.id)}`))}>▶ Run again</button>
  </div>

  {#if run.input && run.input !== 'null'}
    <div class="panel"><h3>Input</h3><pre class="block">{pretty(run.input)}</pre></div>
  {/if}
  {#if run.result}
    <div class="panel"><h3>Result</h3><pre class="block">{pretty(run.result)}</pre></div>
  {/if}
  {#if run.error}
    <div class="panel"><h3 style="color:var(--fail)">Error</h3><pre class="block">{pretty(run.error)}</pre></div>
  {/if}

  <div class="section-title" style="padding-left:0">Steps</div>
  <div class="timeline">
    {#each detail.steps as s (s.id)}
      <div class="step">
        <span class="dot-s s-{s.status}"></span>
        <div>
          <div class="k">{s.key} <span class="kind">· {s.kind}</span></div>
          {#if s.result && s.kind === 'step'}<pre>{pretty(s.result)}</pre>{/if}
        </div>
        <button class="btn sm retrybtn" onclick={() => act(() => api.retry(id, s.name))}>↻ from here</button>
      </div>
    {:else}
      <div class="empty">no steps recorded yet</div>
    {/each}
  </div>

  {#if detail.children.length}
    <div class="panel">
      <h3>Sub-workflows</h3>
      {#each detail.children as c (c.id)}
        <a class="child-link" href="/runs/{encodeURIComponent(c.id)}">
          <span class="dot-s s-{c.status}"></span> {c.workflow} <span class="subtle">{c.id}</span>
        </a>
      {/each}
    </div>
  {/if}

  <div class="section-title" style="padding-left:0">Live log</div>
  <div class="logs" bind:this={logEl}>
    {#if hasOlder}
      <button class="btn sm loadmore" onclick={loadOlder} disabled={loadingOlder}>
        {loadingOlder ? 'loading…' : '↑ load earlier events'}
      </button>
    {/if}
    {#each events as e (e.id)}
      <div class="line {e.level ? 'lvl-' + e.level : ''}">
        <span class="ts">{fmtTime(e.ts)}</span>
        {e.type === 'run.log' && e.message ? e.message : e.type + (e.message ? ' — ' + e.message : '')}
      </div>
    {:else}
      <div class="subtle">waiting for events…</div>
    {/each}
  </div>
{/if}
