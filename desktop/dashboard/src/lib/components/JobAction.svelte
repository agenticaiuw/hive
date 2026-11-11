<script lang="ts">
  import { humanizeKey, truncate, type JobActionView } from "$lib/jobs";

  let {
    entry,
    index,
  }: { entry: JobActionView; index: number } = $props();

  // Output starts closed for a step that worked and open for one that did not:
  // a failure is the reason anyone opened this job.
  let toggled = $state(false);
  const open = $derived(entry.failed !== toggled);
  const stepState = $derived(
    entry.ok === null ? "waiting" : entry.failed ? "failed" : "done",
  );
</script>

<li>
  <div class="event-index {stepState}">{index + 1}</div>
  <div class="event-copy">
    <div class="job-step-head">
      <div>
        <span class="event-stage">{entry.type.replaceAll("_", " ")}</span>
        <span class="event-label">{entry.label}</span>
      </div>
      <span class="status-chip {stepState === 'failed' ? 'warn' : stepState === 'done' ? 'ok' : 'run'}"
        ><i aria-hidden="true"></i>{entry.ok === null
          ? "Planned"
          : entry.failed
            ? "Failed"
            : "Done"}</span
      >
    </div>

    {#if entry.params.length}
      <dl class="system-list job-params">
        {#each entry.params as [key, value]}
          <div>
            <dt>{humanizeKey(key)}</dt>
            <dd>{truncate(value, 300)}</dd>
          </div>
        {/each}
      </dl>
    {/if}

    {#if entry.message}
      <p class="event-detail">{entry.message}</p>
    {/if}

    {#if entry.output.length}
      <div class="job-output">
        <div class="job-output-head">
          <span class="micro-label"
            >Output · {entry.output.map(([name]) => name).join(" + ")}</span
          >
          <button
            type="button"
            class="linkish"
            onclick={() => (toggled = !toggled)}
            aria-expanded={open}>{open ? "Hide" : "Show"}</button
          >
        </div>
        {#if open}
          {#each entry.output as [name, text]}
            <pre class="job-output-body" data-stream={name}>{text}</pre>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
</li>
