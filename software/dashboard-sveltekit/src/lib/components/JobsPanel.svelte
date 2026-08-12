<script lang="ts">
  import { onMount } from "svelte";
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
    isAwaitingApproval,
    isRunningStatus,
    statusLabel,
    statusTone,
    truncate,
    type JobView,
    type RoutineView,
  } from "$lib/jobs";
  import { deviceTagsFor } from "$lib/hiveFeed.js";
  import { undoJob } from "$lib/dataSource";

  let jobs = $state<JobView[]>([]);
  let routines = $state<RoutineView[]>([]);
  let jobsNote = $state("");
  let routinesNote = $state("");
  let error = $state("");
  let loaded = $state(false);
  let deviceFilter = $state("all");
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

  onMount(() => {
    void refresh();
    // A running job changes every few seconds; a hidden tab changes nothing.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 6_000);
    return () => window.clearInterval(timer);
  });

  const byRecency = (a: JobView, b: JobView) =>
    Date.parse(String(b.updatedAt || b.createdAt || 0)) -
    Date.parse(String(a.updatedAt || a.createdAt || 0));

  /*
   * Filter chips are keyed per DEVICE, never per raw source word. The old row
   * was keyed on `job.source`, so `floating-hud` and `dashboard` each grew a
   * "This Mac" tab and two browser sources each grew a "Browser" tab — the
   * duplicated tabs in the owner's 2026-08-12 screenshot ("delete the entire
   * panel with 6 different tabs below and make sure to keep the ability to
   * filter work or questions by nodes"). `deviceTagsFor` dedupes by device and
   * folds every probe/routine source into one "Agent-initiated" chip.
   */
  const devices = $derived.by(() => {
    const counts = new Map<
      string,
      { key: string; label: string; hint: string; count: number }
    >();
    for (const job of jobs) {
      for (const tag of deviceTagsFor(job)) {
        const entry = counts.get(tag.key) ?? { ...tag, count: 0 };
        entry.count += 1;
        counts.set(tag.key, entry);
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  });

  /*
   * A job that travelled through several nodes matches ANY of its devices'
   * chips ("one task may travel through multiple nodes as well"). Single-select
   * with an All chip — the interaction the row already had.
   */
  const visible = $derived(
    deviceFilter === "all"
      ? jobs
      : jobs.filter((job) =>
          deviceTagsFor(job).some((tag) => tag.key === deviceFilter),
        ),
  );
  /*
   * Sorted by who needs a human, not by recency: a plan the agent parked has
   * stopped, but filing it under "Finished" reads as done when the opposite is
   * true. It gets its own group, first.
   */
  const needsYou = $derived(
    visible.filter((job) => isAwaitingApproval(job.status)).sort(byRecency),
  );
  const running = $derived(
    visible
      .filter(
        (job) => isRunningStatus(job.status) && !isAwaitingApproval(job.status),
      )
      .sort(byRecency),
  );
  const finished = $derived(
    visible
      .filter(
        (job) => !isRunningStatus(job.status) && !isAwaitingApproval(job.status),
      )
      .sort(byRecency),
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
      (selectedRoutine
        ? null
        : (needsYou[0] ?? running[0] ?? finished[0] ?? null)),
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

  /* The row's device tag(s), joined — "the device(s) should be the main tags";
   * a multi-node run names every node it touched. */
  const deviceLabel = (job: JobView) =>
    deviceTagsFor(job)
      .map((tag) => tag.label)
      .join(" · ");

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

<section id="tile-panel-jobs" class="tile-panel jobs-panel" aria-label="Jobs">
  {#if error}
    <p class="history-error">{error}</p>
  {/if}

  <!-- Device chips, not source tabs: one chip per device the work travelled
       through (This Mac, Browser, Pendant, iPhone …) plus one Agent-initiated
       chip. Right-aligned per DESIGN.md: filters live on the right side. -->
  <div class="job-filters" role="group" aria-label="Filter by device">
    <button
      type="button"
      class="job-chip {deviceFilter === 'all' ? 'on' : ''}"
      onclick={() => (deviceFilter = "all")}>All · {jobs.length}</button
    >
    {#each devices as device (device.key)}
      <button
        type="button"
        class="job-chip {deviceFilter === device.key ? 'on' : ''}"
        title={device.hint}
        onclick={() => (deviceFilter = device.key)}
        >{device.label} · {device.count}</button
      >
    {/each}
  </div>

  {#if jobsNote}
    <p class="panel-empty job-note">{jobsNote}</p>
  {/if}

  <div class="jobs-split">
    <div class="jobs-rail">
      {#if needsYou.length}
        <div class="job-group">
          <p class="job-group-head">Needs you <span>{needsYou.length}</span></p>
          {#each needsYou as job}
            <button
              type="button"
              class="history-main {`job:${job.id}` === selectedId ||
              job.id === activeJob?.id
                ? 'selected'
                : ''}"
              onclick={() => (selectedId = `job:${job.id}`)}
              aria-label={`${job.command || "Job"} · ${deviceLabel(job)} · ${statusLabel(job.status)}`}
            >
              <strong>{truncate(job.command || "Job", 46)}</strong>
              <small
                ><i class="run-dot {statusTone(job.status)}" aria-hidden="true"
                ></i>{deviceLabel(job)} · {statusLabel(job.status)} · {formatWhen(
                  job.updatedAt || job.createdAt,
                )}</small
              >
            </button>
          {/each}
        </div>
      {/if}

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
            aria-label={`${job.command || "Job"} · ${deviceLabel(job)} · ${statusLabel(job.status)}`}
          >
            <strong>{truncate(job.command || "Job", 46)}</strong>
            <small
              ><i class="run-dot {statusTone(job.status)}" aria-hidden="true"
              ></i>{deviceLabel(job)} · {statusLabel(job.status)} · {formatWhen(
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
            aria-label={`${routine.name} · scheduled routine`}
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
            aria-label={`${job.command || "Job"} · ${deviceLabel(job)} · ${statusLabel(job.status)}`}
          >
            <strong>{truncate(job.command || "Job", 46)}</strong>
            <small
              ><i class="run-dot {statusTone(job.status)}" aria-hidden="true"
              ></i>{deviceLabel(job)} · {statusLabel(job.status)} · {formatWhen(
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
