<script lang="ts">
  let {
    id,
    label,
    value,
    tone,
    dotText,
    open,
    onToggle,
  }: {
    id: string;
    label: string;
    value: string;
    tone: "ok" | "warn" | "off";
    dotText: string;
    open: boolean;
    onToggle: () => void;
  } = $props();
</script>

<button
  class="tile {open ? 'open' : ''}"
  onclick={onToggle}
  aria-expanded={open}
  aria-controls={`tile-panel-${id}`}
  title={dotText}
>
  <span class="tile-head"
    ><i class="tile-dot {tone}" title={dotText} aria-label={dotText} role="img"
    ></i><span>{label}</span><em class="tile-chevron" aria-hidden="true">▾</em
    ></span
  >
  <span class="tile-value">{value}</span>
</button>
