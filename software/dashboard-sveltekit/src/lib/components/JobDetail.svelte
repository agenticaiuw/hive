<script lang="ts">
  import JobAction from "./JobAction.svelte";
  import {
    elapsedBetween,
    formatDuration,
    formatWhen,
    isRunningStatus,
    sourceMeta,
    statusLabel,
    statusTone,
    summarizeTouches,
    type JobView,
  } from "$lib/jobs";

  let {
    job,
    loading,
    onCancel,
    onUndo,
  }: {
    job: JobView;
    loading: boolean;
    onCancel: (jobId: string) => void;
    onUndo: (jobId: string) => void;
  } = $props();

  const source = $derived(sourceMeta(job.source));
  const live = $derived(isRunningStatus(job.status));
  const steps = $derived(job.ran.length ? job.ran : job.planned);
  const succeeded = $derived(job.ran.filter((entry) => !entry.failed).length);
  const runDuration = $derived(elapsedBetween(job.createdAt, job.updatedAt));
  const touches = $derived(summarizeTouches(steps));
</script>

<article class="job-detail">
  <div class="job-detail-head">
    <div>
      <p class="micro-label">
        {job.type === "plan" ? "Plan" : "Execution"} · {source.label}
      </p>
      <h3>{job.command || "Job"}</h3>
    </div>
    <span class="status-chip {statusTone(job.status)}"
      ><i aria-hidden="true"></i>{statusLabel(job.status)}</span
    >
  </div>

  <dl class="system-list">
    <div>
      <dt>Asked by</dt>
      <dd>{source.label} — {source.hint}</dd>
    </div>
    <div>
      <dt>Started</dt>
      <dd>{formatWhen(job.createdAt) || "—"}</dd>
    </div>
    <div>
      <dt>Last update</dt>
      <dd>
        {formatWhen(job.updatedAt) || "—"}{runDuration
          ? ` · took ${formatDuration(runDuration)}`
          : ""}
      </dd>
    </div>
    <div>
      <dt>Actions</dt>
      <dd>
        {job.ran.length
          ? `${succeeded}/${job.ran.length} succeeded`
          : job.planned.length
            ? `${job.planned.length} planned`
            : live
              ? "Starting…"
              : "None recorded"}
      </dd>
    </div>
  </dl>

  {#if touches.length}
    <div class="job-touches">
      <p class="micro-label">Touched</p>
      <ul>
        {#each touches as line}<li>{line}</li>{/each}
      </ul>
    </div>
  {/if}

  {#if job.error || job.summary}
    <div class="job-result">
      <p class="micro-label">{job.error ? "Error" : "Result"}</p>
      <blockquote>{job.error || job.summary}</blockquote>
    </div>
  {/if}

  {#if loading}
    <p class="panel-empty">Loading evidence…</p>
  {:else if steps.length}
    <p class="micro-label job-evidence-head">
      {job.ran.length ? "Evidence" : "Planned steps"}
    </p>
    <ol class="event-list">
      {#each steps as entry, index}
        <JobAction {entry} {index} />
      {/each}
    </ol>
  {/if}

  {#if job.cancellable || live || job.canUndo}
    <div class="job-tools">
      {#if job.cancellable || live}
        <button type="button" class="linkish" onclick={() => onCancel(job.id)}
          >Cancel</button
        >
      {/if}
      {#if job.canUndo}
        <button type="button" class="linkish" onclick={() => onUndo(job.id)}
          >Undo</button
        >
      {/if}
    </div>
  {/if}
</article>
