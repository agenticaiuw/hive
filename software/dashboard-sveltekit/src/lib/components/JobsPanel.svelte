<script lang="ts">
  import JobDetail from "./JobDetail.svelte";
  import RoutineDetail from "./RoutineDetail.svelte";
  import {
    cancelJob,
    fetchJobs,
    fetchRoutines,
    loadJobDetail,
    runRoutine,
  } from "$lib/dataSource";
  import {
    formatWhen,
    isRunningStatus,
    sourceMeta,
    statusLabel,
    statusTone,
    truncate,
    type JobView,
    type RoutineView,
  } from "$lib/jobs";
  import { undoJob } from "$lib/dataSource";

  let jobs = $state<JobView[]>([]);
  let routines = $state<RoutineView[]>([]);
  let jobsNote = $state("");
  let routinesNote = $state("");
  let error = $state("");
  let loaded = $state(false);
  let sourceFilter = $state("all");
  let selectedId = $state("");
  let detailLoading = $state(false);
  // Evidence fetched lazily per job (relay backend only), keyed by job id.
  let details = $state<Record<string, JobView>>({});

  let refreshPending = false;

  export async function refresh() {
    if (refreshPending) return;
    refreshPending = true;
    try {
      const [jobsResult, routinesResult] = await Promise.allSettled([
        fetchJobs(),
        fetchRoutines(),
      ]);
      if (jobsResult.status === "fulfilled") {
        jobs = jobsResult.value.data;
        jobsNote = jobsResult.value.note;
        error = "";
      } else {
        error = jobsResult.reason?.message || "Jobs could not load.";
      }
      if (routinesResult.status === "fulfilled") {
        routines = routinesResult.value.data;
        routinesNote = routinesResult.value.note;
      }
    } finally {
      loaded = true;
      refreshPending = false;
    }
  }

  const byRecency = (a: JobView, b: JobView) =>
    Date.parse(String(b.updatedAt || b.createdAt || 0)) -
    Date.parse(String(a.updatedAt || a.createdAt || 0));

  const sources = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const job of jobs) {
      const key = job.source || "unknown";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  });

  const visible = $derived(
    sourceFilter === "all"
      ? jobs
      : jobs.filter((job) => job.source === sourceFilter),
  );
  const running = $derived(
    visible.filter((job) => isRunningStatus(job.status)).sort(byRecency),
  );
  const finished = $derived(
    visible.filter((job) => !isRunningStatus(job.status)).sort(byRecency),
  );
  const scheduled = $derived(
    [...routines].sort(
      (a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity),
    ),
  );

  const selectedRoutine = $derived(
    routines.find((routine) => `routine:${routine.id}` === selectedId) ?? null,
  );
  const baseJob = $derived(
    visible.find((job) => `job:${job.id}` === selectedId) ??
      (selectedRoutine ? null : (running[0] ?? finished[0] ?? null)),
  );
  // A lazily loaded detail supersedes the list row it was built from.
  const activeJob = $derived(baseJob ? (details[baseJob.id] ?? baseJob) : null);

  /*
   * The agent's list already carries every action and its output; the relay's
   * carries only counts. Pull the rest for whichever job is on screen, once.
   */
  $effect(() => {
    const job = baseJob;
    if (!job?.detailHref || details[job.id]) return;
    detailLoading = true;
    loadJobDetail(job)
      .then((full) => {
        details = { ...details, [job.id]: full };
      })
      .catch(() => {
        // The list row still renders; only the evidence is missing.
      })
      .finally(() => {
        detailLoading = false;
      });
  });

  async function act(run: () => Promise<unknown>) {
    try {
      await run();
      await refresh();
    } catch (actionError) {
      error =
        actionError instanceof Error ? actionError.message : "Action failed.";
    }
  }
</script>

<section class="tile-panel jobs-panel" aria-label="Jobs">
  {#if error}
    <p class="history-error">{error}</p>
  {/if}

  <div class="job-filters" role="group" aria-label="Filter by source">
    <button
      type="button"
      class="job-chip {sourceFilter === 'all' ? 'on' : ''}"
      onclick={() => (sourceFilter = "all")}>All · {jobs.length}</button
    >
    {#each sources as [key, count]}
      <button
        type="button"
        class="job-chip {sourceFilter === key ? 'on' : ''}"
        title={sourceMeta(key).hint}
        onclick={() => (sourceFilter = key)}
        >{sourceMeta(key).label} · {count}</button
      >
    {/each}
  </div>

  {#if jobsNote}
    <p class="panel-empty job-note">{jobsNote}</p>
  {/if}

  <div class="jobs-split">
    <div class="jobs-rail">
      <div class="job-group">
        <p class="job-group-head">Running <span>{running.length}</span></p>
        {#each running as job}
          <button
            type="button"
            class="history-main {`job:${job.id}` === selectedId ||
            job.id === activeJob?.id
              ? 'selected'
              : ''}"
            onclick={() => (selectedId = `job:${job.id}`)}
          >
            <strong>{truncate(job.command || "Job", 46)}</strong>
            <small
              ><i class="run-dot {statusTone(job.status)}" aria-hidden="true"
              ></i>{sourceMeta(job.source).label} · {statusLabel(job.status)} · {formatWhen(
                job.updatedAt || job.createdAt,
              )}</small
            >
          </button>
        {:else}
          <p class="panel-empty">Nothing running.</p>
        {/each}
      </div>

      <div class="job-group">
        <p class="job-group-head">Scheduled <span>{scheduled.length}</span></p>
        {#each scheduled as routine}
          <button
            type="button"
            class="history-main {`routine:${routine.id}` === selectedId
              ? 'selected'
              : ''}"
            onclick={() => (selectedId = `routine:${routine.id}`)}
          >
            <strong>{truncate(routine.name, 46)}</strong>
            <small
              >Routine{routine.enabled && routine.nextRunAt
                ? ` · next ${formatWhen(routine.nextRunAt)}`
                : " · paused"}</small
            >
          </button>
        {:else}
          <p class="panel-empty">
            {routinesNote || "No routines scheduled."}
          </p>
        {/each}
      </div>

      <div class="job-group">
        <p class="job-group-head">Finished <span>{finished.length}</span></p>
        {#each finished.slice(0, 60) as job}
          <button
            type="button"
            class="history-main {`job:${job.id}` === selectedId ||
            job.id === activeJob?.id
              ? 'selected'
              : ''}"
            onclick={() => (selectedId = `job:${job.id}`)}
          >
            <strong>{truncate(job.command || "Job", 46)}</strong>
            <small
              ><i class="run-dot {statusTone(job.status)}" aria-hidden="true"
              ></i>{sourceMeta(job.source).label} · {statusLabel(job.status)} · {formatWhen(
                job.updatedAt || job.createdAt,
              )}</small
            >
          </button>
        {:else}
          <p class="panel-empty">
            {loaded ? "No finished jobs yet." : "Loading…"}
          </p>
        {/each}
      </div>
    </div>

    <div class="jobs-main">
      {#if selectedRoutine}
        <RoutineDetail
          routine={selectedRoutine}
          onRun={(id) => act(() => runRoutine(id))}
        />
      {:else if activeJob}
        <JobDetail
          job={activeJob}
          loading={detailLoading}
          onCancel={(id) => act(() => cancelJob(id))}
          onUndo={(id) => act(() => undoJob(id))}
        />
      {:else}
        <div class="jobs-empty">
          <h3>Nothing to show yet</h3>
          <p>
            Every request — yours, scheduled, or agent-initiated — lands here
            with the actions it ran and what each one returned.
          </p>
        </div>
      {/if}
    </div>
  </div>
</section>
