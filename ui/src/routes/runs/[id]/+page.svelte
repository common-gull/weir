<script lang="ts">
  import { page } from '$app/state';
  import RunDetail from '$lib/runs/RunDetail.svelte';

  const id = $derived(page.params.id);
</script>

<RunDetail {id} />
