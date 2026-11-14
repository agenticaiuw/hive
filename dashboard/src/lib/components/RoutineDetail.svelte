<script lang="ts">
  import {
    describeSchedule,
    formatWhen,
    statusLabel,
    type RoutineView,
  } from "$lib/jobs";
  import { runRoutineSupported } from "$lib/dataSource";

  let {
    routine,
    onRun,
  }: { routine: RoutineView; onRun: (routineId: string) => void } = $props();
</script>

<article class="job-detail">
  <div class="job-detail-head">
    <div>
      <p class="micro-label">Scheduled routine</p>
      <h3>{routine.name}</h3>
    </div>
    <span class="status-chip {routine.enabled ? 'ok' : 'off'}"
      ><i aria-hidden="true"></i>{routine.enabled
        ? describeSchedule(routine.schedule)
        : "Paused"}</span
    >
  </div>

  <dl class="system-list">
    <div><dt>Runs</dt><dd>{routine.command}</dd></div>
    <div>
      <dt>Next run</dt>
      <dd>
        {routine.enabled && routine.nextRunAt
          ? formatWhen(routine.nextRunAt)
          : "Not scheduled"}
      </dd>
    </div>
    <div>
      <dt>Last run</dt>
      <dd>
        {routine.lastRunAt
          ? `${formatWhen(routine.lastRunAt)} · ${statusLabel(routine.lastStatus)}`
          : "Never"}
      </dd>
    </div>
    <div><dt>Times run</dt><dd>{routine.runCount}</dd></div>
  </dl>

  {#if routine.lastError}
    <div class="job-result">
      <p class="micro-label">Last error</p>
      <blockquote>{routine.lastError}</blockquote>
    </div>
  {/if}

  <p class="panel-empty job-note">
    Routines run whether or not this dashboard is open. Each run shows up in the
    job list with its own evidence.
  </p>

  {#if runRoutineSupported}
    <div class="job-tools">
      <button type="button" class="linkish" onclick={() => onRun(routine.id)}
        >Run now</button
      >
    </div>
  {/if}
</article>
