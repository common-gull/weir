<script lang="ts">
  import { page } from '$app/state';
  import WorkflowDetail from '$lib/workflows/WorkflowDetail.svelte';
  import { workflows } from '$lib/workflows/store.svelte';

  const name = $derived(page.params.name);
  // The root layout keeps the workflow list loaded for every route; resolve :name against it.
  const workflow = $derived(workflows.list.find((w) => w.name === name) ?? null);
</script>

{#if workflow}
  {#key workflow.name}
    <WorkflowDetail {workflow} />
  {/key}
{:else if workflows.list.length}
  <div class="empty">No workflow named “{name}”.</div>
{:else}
  <div class="empty">loading…</div>
{/if}
