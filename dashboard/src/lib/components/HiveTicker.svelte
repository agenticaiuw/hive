<script lang="ts">
  import { HIVE_SOURCE_COLOR, fmtAge, type HiveEvent } from "$lib/hive";

  let { events, now }: { events: HiveEvent[]; now: number } = $props();

  const list = $derived(
    events
      .slice()
      .sort((a, b) => b.at - a.at)
      .slice(0, 120),
  );
</script>

<div class="hv-ticker" aria-label="Event ticker, all sources, chronological">
  {#if !list.length}
    <span class="hv-mut">no events yet</span>
  {/if}
  {#each list as e (e.seq)}
    <div class="hv-tick">
      <span class="hv-tick-age" class:fresh={now - e.at < 12000}>{fmtAge(now - e.at)}</span>
      <span class="hv-tick-src">
        <span
          class="hv-dot"
          style="background: {HIVE_SOURCE_COLOR[e.source] || HIVE_SOURCE_COLOR.system}"
        ></span>{e.source}
      </span>
      <span class="hv-tick-text" title={e.text}>{e.text}</span>
    </div>
  {/each}
</div>
