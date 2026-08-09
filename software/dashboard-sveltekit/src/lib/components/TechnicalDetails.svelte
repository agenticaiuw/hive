<script lang="ts">
  /**
   * Layer two, and only layer two.
   *
   * Everything in here is real and worth keeping — it is what you read when the
   * hardware misbehaves — but none of it answers the question the owner asked,
   * so progressive disclosure (NN/g) puts it behind one clearly-named control.
   * The label is a noun ("Technical details"), not a bare chevron, so the scent
   * is honest about what is inside. Two levels total: this opens in place, and
   * nothing inside it opens a third.
   *
   * A native <details> is used on purpose: keyboard and screen-reader behaviour
   * come free, and it renders closed in server HTML with no JavaScript.
   */
  import Metric from "./Metric.svelte";
  import {
    bytes,
    clock,
    duration,
    stageState,
    stagesFor,
    type JsonRecord,
  } from "$lib/pipeline";

  let {
    run,
    telemetry,
    open = false,
  }: {
    run: JsonRecord;
    telemetry: JsonRecord | null;
    /** Opened by the page when a failure means the evidence is the point. */
    open?: boolean;
  } = $props();

  let toggledEvents = $state<Set<string>>(new Set());

  const stages = $derived(stagesFor(run));

  function toggleEvent(id: string) {
    const next = new Set(toggledEvents);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    toggledEvents = next;
  }
</script>

<details class="tech" {open}>
  <summary>
    <span class="tech-chevron" aria-hidden="true"></span>
    Technical details
    <span class="tech-hint">pipeline stages, audio format, event log</span>
  </summary>

  <div class="tech-body">
    <div class="stage-rail" aria-label="Pipeline stages">
      {#each stages as stage, index}
        {@const state = stageState(run, stage.id)}
        {#if index}<i
            class="stage-link {stageState(run, stages[index - 1].id) === 'done'
              ? 'done'
              : ''}"
            aria-hidden="true"
          ></i>{/if}<span
          class="stage-node {state}"
          title={`${stage.label}: ${state}`}
          aria-label={`${stage.label}: ${state}`}
          role="img"><i aria-hidden="true"></i><em>{stage.short}</em></span
        >
      {/each}
    </div>

    <div class="telemetry-grid">
      <Metric label="Payload" value={bytes(telemetry?.audioBytes) || "—"} />
      <Metric label="Duration" value={duration(telemetry?.durationMs) || "—"} />
      <Metric
        label="Sample rate"
        value={telemetry?.sampleRate
          ? `${telemetry.sampleRate.toLocaleString()} Hz`
          : "—"}
      />
      <Metric label="Format" value={telemetry?.format || "—"} />
      <Metric label="Storage" value={telemetry?.storage || "—"} />
      <Metric
        label="Input gain"
        value={telemetry?.inputGainDb != null
          ? `+${telemetry.inputGainDb} dB`
          : "—"}
      />
      <Metric label="Transcript" value={run.command || "empty"} />
      <Metric label="Run id" value={String(run.pipelineId || "—")} />
    </div>

    {#if run.delivery?.heardBecause}
      <p class="tech-note">{run.delivery.heardBecause}</p>
    {/if}

    <ol class="event-list">
      {#each run.events ?? [] as event, index}
        {@const eventId = String(event.eventId || `${event.stage}-${index}`)}
        <!-- Failed events start expanded; the set records deviations from that. -->
        {@const shown =
          (event.status === "failed") !== toggledEvents.has(eventId)}
        {@const expandable = Boolean(event.detail || event.text)}
        <li>
          <div class="event-index {event.status}">{index + 1}</div>
          <div class="event-copy">
            <button
              class="event-row"
              onclick={() => toggleEvent(eventId)}
              aria-expanded={shown}
              disabled={!expandable}
            >
              <span class="event-stage">{event.stage?.replaceAll("_", " ")}</span
              >
              <span class="event-label">{event.label}</span>
              <time>{clock(event.at)}</time>
            </button>
            {#if shown && expandable}
              {#if event.detail}<p class="event-detail">{event.detail}</p>{/if}
              {#if event.text}<blockquote>{event.text}</blockquote>{/if}
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  </div>
</details>
