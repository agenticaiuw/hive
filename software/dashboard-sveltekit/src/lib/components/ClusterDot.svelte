<script lang="ts">
  // The short label is only rendered on exception; the accessible name always
  // carries the full sentence.
  let {
    short,
    state,
    text,
  }: { short: string; state: "ok" | "off" | "warn"; text: string } = $props();
</script>

<span class="cluster-dot {state}" title={text} aria-label={text} role="img"
  ><i aria-hidden="true"></i>{#if state !== "ok"}<em>{short}</em>{/if}</span
>
