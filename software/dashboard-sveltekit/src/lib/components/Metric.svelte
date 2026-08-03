<script lang="ts">
  let { label, value }: { label: string; value: string } = $props();
</script>

<div class="metric"><span>{label}</span><strong>{value}</strong></div>
