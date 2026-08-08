<script lang="ts">
  /**
   * "Ask the hive" — the universal command box.
   *
   * One component on every surface (deployed site, iOS shell, menu-bar
   * WebView, local dashboard). The transport is decided the way /hive decides
   * LIVE vs SNAPSHOT: served by the Mac agent → same-origin `/plan`/`/execute`
   * with the loopback session (LOCAL); anywhere else → this app's
   * `/api/command` server routes, which hold the relay key (VIA RELAY). The
   * badge says which path ran each command — honest transport, like the hive
   * badges.
   *
   * The status line only ever reports states something actually confirmed:
   * queued (relay accepted), picked up (the Mac claimed it), planning /
   * executing, then done, parked for approval, or failed with the real error.
   * A parked plan is never presented as a failure.
   */
  import { onDestroy, onMount } from "svelte";
  import { base } from "$app/paths";
  import {
    HISTORY_LIMIT,
    MAX_COMMAND_LENGTH,
    commandTransport,
    conversationSessionId,
    dispatchRelayCommand,
    fetchRelayCommandJob,
    isTerminalRelayStatus,
    loadCommandHistory,
    probeLocalAgent,
    runLocalExecute,
    runLocalPlan,
    saveCommandHistory,
    type CommandHistoryEntry,
    type CommandResultView,
    type ParkedInfo,
  } from "$lib/command";

  type Phase =
    | "idle"
    | "sending"
    | "queued"
    | "planning"
    | "executing"
    | "finishing"
    | "done"
    | "parked"
    | "failed"
    | "still-running";

  let {
    variant = "card",
    onQueued = null,
    onOpenJobs = null,
  }: {
    /** "card" = main dashboard block; "bar" = compact /hive top bar row. */
    variant?: "card" | "bar";
    /** Fired once a command is accepted, so pages can refresh their feeds. */
    onQueued?: (() => void) | null;
    /** When provided, "Open Jobs" calls this instead of navigating. */
    onOpenJobs?: (() => void) | null;
  } = $props();

  const POLL_INTERVAL_MS = 1500;
  const POLL_BUDGET_MS = 60_000;

  let text = $state("");
  let phase = $state<Phase>("idle");
  let statusDetail = $state("");
  let errorText = $state("");
  let result = $state<CommandResultView | null>(null);
  let parked = $state<ParkedInfo | null>(null);
  let activeCommand = $state("");
  let activeJobId = $state("");
  let pickedUpMs = $state<number | null>(null);
  let finishedMs = $state<number | null>(null);
  let history = $state<CommandHistoryEntry[]>([]);
  let historyOpen = $state(false);
  let localProbeError = $state("");
  // Local parked plans hold the prepared actions until the owner says go.
  let pendingExecute = $state<{
    command: string;
    actions: unknown[];
    planner: string | null;
    sessionId: string;
  } | null>(null);
  /**
   * Highest stage this command has actually CONFIRMED reaching:
   * 0 none · 1 queued · 2 picked up · 3 planning · 4 executing.
   * The trail renders from this, so a dispatch that failed before the relay
   * accepted it can never paint "queued" as done.
   */
  let progress = $state(0);
  // Monotonic run token: a new submit or unmount abandons older poll loops.
  let runToken = 0;
  let startedAt = 0;
  let historyId = "";

  const busy = $derived(
    phase === "sending" ||
      phase === "queued" ||
      phase === "planning" ||
      phase === "executing" ||
      phase === "finishing",
  );
  const settled = $derived(
    phase === "done" ||
      phase === "parked" ||
      phase === "failed" ||
      phase === "still-running",
  );

  const transportLabel = commandTransport === "local" ? "LOCAL" : "VIA RELAY";
  const transportTitle =
    commandTransport === "local"
      ? "This page is served by the Mac agent itself: commands run same-origin through its /plan and /execute routes with the loopback session. The relay is not involved."
      : "This page has no route to the Mac: commands go to this app's own /api/command server route, which creates the relay plan job with a server-held key and polls the job. The key never reaches this browser.";

  type StageView = { id: string; label: string; state: "done" | "active" | "todo" | "warn" | "skip" };

  /**
   * The queued → picked up → planning → executing trail. Only stages this
   * transport actually has are shown (LOCAL has no queue and no pickup), and
   * a stage reads "done" only when `progress` recorded it really happening.
   */
  const stages = $derived.by<StageView[]>(() => {
    if (phase === "idle") return [];
    const activeOrdinal =
      phase === "sending" || phase === "queued"
        ? 1
        : phase === "planning"
          ? 3
          : phase === "executing"
            ? 4
            : 0; // "finishing" and terminal phases have no active stage
    const defs =
      commandTransport === "relay"
        ? [
            { id: "queued", label: "queued", ordinal: 1 },
            { id: "picked-up", label: "picked up", ordinal: 2 },
            { id: "planning", label: "planning", ordinal: 3 },
            { id: "executing", label: "executing", ordinal: 4 },
          ]
        : [
            { id: "planning", label: "planning", ordinal: 3 },
            { id: "executing", label: "executing", ordinal: 4 },
          ];

    return defs.map(({ id, label, ordinal }): StageView => {
      if (!settled && ordinal === activeOrdinal) return { id, label, state: "active" };
      if (progress >= ordinal) return { id, label, state: "done" };
      if (ordinal === 4 && phase === "parked") return { id, label, state: "warn" };
      if (ordinal === 4 && phase === "done") return { id, label, state: "skip" };
      return { id, label, state: "todo" };
    });
  });

  const terminalChip = $derived.by(() => {
    if (phase === "done") return { cls: "ok", word: "Done" };
    if (phase === "parked") return { cls: "warn", word: "Parked for approval" };
    if (phase === "failed") return { cls: "bad", word: "Failed" };
    if (phase === "still-running") return { cls: "warn", word: "Still running" };
    return null;
  });

  onMount(() => {
    history = loadCommandHistory();
    if (commandTransport === "local") {
      probeLocalAgent().catch((probeError) => {
        localProbeError =
          probeError instanceof Error ? probeError.message : String(probeError);
      });
    }
  });

  onDestroy(() => {
    runToken += 1; // abandon any in-flight poll loop
  });

  function seconds(ms: number) {
    return `${(ms / 1000).toFixed(1)} s`;
  }

  function rememberSent(command: string) {
    historyId = crypto.randomUUID();
    const entry: CommandHistoryEntry = {
      id: historyId,
      text: command,
      transport: commandTransport,
      status: "sent",
      summary: "",
      jobId: null,
      at: Date.now(),
    };
    history = [entry, ...history].slice(0, HISTORY_LIMIT);
    saveCommandHistory(history);
  }

  function rememberOutcome(
    status: CommandHistoryEntry["status"],
    summary: string,
  ) {
    history = history.map((entry) =>
      entry.id === historyId
        ? {
            ...entry,
            status,
            summary: summary.slice(0, 240),
            jobId: activeJobId || null,
          }
        : entry,
    );
    saveCommandHistory(history);
  }

  function resetOutcome() {
    errorText = "";
    result = null;
    parked = null;
    activeJobId = "";
    pickedUpMs = null;
    finishedMs = null;
    statusDetail = "";
    pendingExecute = null;
    progress = 0;
  }

  function settle(
    next: Extract<Phase, "done" | "parked" | "failed" | "still-running">,
    summaryForHistory: string,
  ) {
    phase = next;
    finishedMs = Date.now() - startedAt;
    rememberOutcome(
      next === "done"
        ? "done"
        : next === "parked"
          ? "parked"
          : next === "failed"
            ? "failed"
            : "still-running",
      summaryForHistory,
    );
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const command = text.trim();
    if (!command || busy) return;
    text = "";
    void run(command);
  }

  async function run(command: string) {
    const token = ++runToken;
    resetOutcome();
    activeCommand = command;
    startedAt = Date.now();
    rememberSent(command);
    const sessionId = conversationSessionId();

    if (commandTransport === "local") {
      await runLocal(command, sessionId, token);
    } else {
      await runRelay(command, sessionId, token);
    }
  }

  /* ------------------------------------------------------------- LOCAL */

  async function runLocal(command: string, sessionId: string, token: number) {
    phase = "planning";
    statusDetail = "Planning on the Mac…";
    try {
      const outcome = await runLocalPlan(command, sessionId);
      if (token !== runToken) return;
      progress = 3;
      onQueued?.();

      if (outcome.kind === "done") {
        result = outcome.result;
        settle("done", outcome.result.text);
        statusDetail = `done in ${seconds(finishedMs ?? 0)}`;
        return;
      }

      pendingExecute = {
        command,
        actions: outcome.actions,
        planner: outcome.planner,
        sessionId,
      };
      result = outcome.result;

      if (outcome.parked) {
        parked = outcome.parked;
        settle("parked", outcome.parked.note);
        statusDetail = `plan ready in ${seconds(finishedMs ?? 0)} — waiting for your go-ahead`;
        return;
      }

      await executePending(token);
    } catch (planError) {
      if (token !== runToken) return;
      errorText =
        planError instanceof Error ? planError.message : String(planError);
      settle("failed", errorText);
      statusDetail = `failed after ${seconds(finishedMs ?? 0)}`;
    }
  }

  async function executePending(token: number) {
    const pending = pendingExecute;
    if (!pending) return;
    pendingExecute = null;
    parked = null;
    phase = "executing";
    statusDetail = `Running ${pending.actions.length} action${
      pending.actions.length === 1 ? "" : "s"
    } on the Mac…`;
    try {
      const execution = await runLocalExecute(
        pending.command,
        pending.actions,
        pending.sessionId,
        pending.planner,
      );
      if (token !== runToken) return;
      progress = 4;
      result = execution;
      settle("done", execution.text);
      statusDetail = `done in ${seconds(finishedMs ?? 0)}`;
      onQueued?.();
    } catch (executeError) {
      if (token !== runToken) return;
      progress = 4; // it ran; the error below says how it went
      errorText =
        executeError instanceof Error
          ? executeError.message
          : String(executeError);
      settle("failed", errorText);
      statusDetail = `failed after ${seconds(finishedMs ?? 0)}`;
    }
  }

  function approvePending() {
    // The owner's click IS the approval for a locally parked plan.
    void executePending(runToken);
  }

  /* ------------------------------------------------------------- RELAY */

  async function runRelay(command: string, sessionId: string, token: number) {
    phase = "sending";
    statusDetail = "Sending to the relay…";
    let jobId = "";
    try {
      ({ jobId } = await dispatchRelayCommand(command, sessionId));
    } catch (dispatchError) {
      if (token !== runToken) return;
      errorText =
        dispatchError instanceof Error
          ? dispatchError.message
          : String(dispatchError);
      settle("failed", errorText);
      statusDetail = `failed after ${seconds(Date.now() - startedAt)}`;
      return;
    }
    if (token !== runToken) return;
    activeJobId = jobId;
    progress = 1;
    phase = "queued";
    statusDetail = "Queued — waiting for the Mac to pick it up…";
    onQueued?.();

    const deadline = startedAt + POLL_BUDGET_MS;
    while (token === runToken && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (token !== runToken) return;

      let job;
      try {
        job = await fetchRelayCommandJob(jobId);
      } catch {
        // One blipped poll is not an outcome; the next tick retries.
        continue;
      }
      if (token !== runToken) return;

      if (job.status === "processing") {
        if (pickedUpMs === null) pickedUpMs = Date.now() - startedAt;
        if (job.executedEarly) {
          progress = 4;
          phase = "finishing";
          statusDetail = `picked up in ${seconds(pickedUpMs)} — executed, uploading the result…`;
        } else {
          progress = Math.max(progress, 2);
          phase = "planning";
          statusDetail = `picked up in ${seconds(pickedUpMs)} — planning on the Mac…`;
        }
        continue;
      }

      if (!isTerminalRelayStatus(job.status)) continue;

      result = job.result;
      if (job.parked) {
        progress = Math.max(progress, 3);
        parked = job.parked;
        settle("parked", job.parked.note);
        statusDetail = `parked in ${seconds(finishedMs ?? 0)} — approve it from Jobs`;
      } else if (job.status === "failed" || job.status === "cancelled") {
        // The Mac had it when it failed, so planning demonstrably happened.
        if (pickedUpMs !== null) progress = Math.max(progress, 3);
        errorText =
          job.error ||
          (job.status === "cancelled" ? "The job was cancelled." : "The Mac reported failure.");
        settle("failed", errorText);
        statusDetail = `failed after ${seconds(finishedMs ?? 0)}`;
      } else {
        progress = job.result.ran ? 4 : Math.max(progress, 3);
        settle("done", job.result.text);
        statusDetail = `done in ${seconds(finishedMs ?? 0)}${
          pickedUpMs !== null ? ` (picked up in ${seconds(pickedUpMs)})` : ""
        }`;
      }
      return;
    }

    if (token !== runToken) return;
    // Budget spent. The job keeps running on the Mac without this page —
    // saying "failed" here would be a lie the Jobs view disproves.
    settle("still-running", `job ${jobId} still running`);
    statusDetail =
      "No result after 60 s — the Mac keeps working without this page. Check Jobs for the outcome.";
  }

  function dismiss() {
    runToken += 1;
    phase = "idle";
    resetOutcome();
    activeCommand = "";
  }

  function recall(entry: CommandHistoryEntry) {
    if (busy) return;
    text = entry.text;
  }
</script>

<section
  class="cmd-box {variant === 'bar' ? 'cmd-bar' : 'cmd-card'}"
  aria-label="Ask the hive"
>
  <div class="cmd-head">
    {#if variant === "card"}
      <p class="micro-label">Ask the hive</p>
    {/if}
    <span
      class="hv-badge cmd-transport {commandTransport === 'local'
        ? localProbeError
          ? 'warn'
          : 'ok'
        : ''}"
      title={localProbeError
        ? `${transportTitle}\nAgent probe failed: ${localProbeError}`
        : transportTitle}>{transportLabel}</span
    >
    {#if history.length}
      <button
        type="button"
        class="linkish cmd-history-toggle"
        onclick={() => (historyOpen = !historyOpen)}
        aria-expanded={historyOpen}
        >Recent · {history.length}</button
      >
    {/if}
  </div>

  <form class="composer-field cmd-field" onsubmit={submit}>
    <input
      bind:value={text}
      placeholder="Ask the hive…"
      aria-label="Ask the hive"
      enterkeyhint="send"
      maxlength={MAX_COMMAND_LENGTH}
      disabled={busy}
    />
    <button
      type="submit"
      class="send-button"
      aria-label="Send to the hive"
      title="Send to the hive"
      disabled={busy || !text.trim()}
    >
      <svg
        viewBox="0 0 16 16"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M8 12.5v-9" />
        <path d="M4.2 7.2 8 3.5l3.8 3.7" />
      </svg>
    </button>
  </form>

  {#if phase !== "idle"}
    <div class="cmd-status-block" aria-live="polite">
      <p class="cmd-active-command" title={activeCommand}>
        “{activeCommand}”
      </p>
      <p class="cmd-status-line">
        {#each stages as stage, index (stage.id)}
          {#if index}<span class="cmd-arrow" aria-hidden="true">→</span>{/if}
          <span class="cmd-stage {stage.state}">{stage.label}{stage.state === "skip" ? " (not needed)" : ""}</span>
        {/each}
        {#if terminalChip}
          <span class="cmd-arrow" aria-hidden="true">→</span>
          <span class="cmd-terminal {terminalChip.cls}">{terminalChip.word}</span>
        {/if}
      </p>
      {#if statusDetail}
        <p class="cmd-status-detail">{statusDetail}</p>
      {/if}

      {#if errorText}
        <p class="cmd-error">{errorText}</p>
      {/if}

      {#if parked}
        <div class="cmd-parked">
          <p class="cmd-parked-note">{parked.note}</p>
          {#if parked.blocked.length}
            <ul class="cmd-parked-reasons">
              {#each parked.blocked as blocked, index (index)}
                <li><code>{blocked.type}</code> — {blocked.reason}</li>
              {/each}
            </ul>
          {/if}
          <div class="cmd-parked-tools">
            {#if pendingExecute}
              <button type="button" class="cmd-run-button" onclick={approvePending}
                >Run {pendingExecute.actions.length} action{pendingExecute
                  .actions.length === 1
                  ? ""
                  : "s"}</button
              >
            {/if}
            {#if onOpenJobs}
              <button type="button" class="linkish" onclick={onOpenJobs}
                >Open Jobs & approvals</button
              >
            {:else}
              <a class="linkish" href="{base}/">Open Jobs & approvals</a>
            {/if}
          </div>
        </div>
      {/if}

      {#if phase === "still-running"}
        <div class="cmd-parked-tools">
          {#if onOpenJobs}
            <button type="button" class="linkish" onclick={onOpenJobs}
              >Open Jobs</button
            >
          {:else}
            <a class="linkish" href="{base}/">Open Jobs</a>
          {/if}
        </div>
      {/if}

      {#if result && (result.text || result.actions.length)}
        <div class="cmd-result">
          <!-- A parked plan's reply IS the approval sentence already shown
               in the banner above; repeating it teaches people to skim. -->
          {#if result.text && result.text !== parked?.note}
            <blockquote class="cmd-result-text">{result.text}</blockquote>
          {/if}
          {#if result.actions.length}
            <p class="micro-label">
              {result.ran ? "What ran" : "Planned steps"}
            </p>
            <ul class="cmd-action-list">
              {#each result.actions as action (action.key)}
                <li>
                  <i
                    class="run-dot {action.ok === null
                      ? 'off'
                      : action.ok
                        ? 'ok'
                        : 'warn'}"
                    aria-hidden="true"
                  ></i>
                  <span class="cmd-action-label">{action.label}</span>
                  {#if action.message}
                    <span class="cmd-action-message">{action.message}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      {#if settled}
        <button type="button" class="linkish cmd-dismiss" onclick={dismiss}
          >Dismiss</button
        >
      {/if}
    </div>
  {/if}

  {#if historyOpen && history.length}
    <ol class="cmd-history" aria-label="Recent commands from this browser">
      {#each history as entry (entry.id)}
        <li>
          <button
            type="button"
            class="cmd-history-row"
            onclick={() => recall(entry)}
            title="Click to put this command back in the box"
          >
            <i
              class="run-dot {entry.status === 'done'
                ? 'ok'
                : entry.status === 'failed'
                  ? 'warn'
                  : entry.status === 'parked' || entry.status === 'still-running'
                    ? 'run'
                    : 'off'}"
              aria-hidden="true"
            ></i>
            <span class="cmd-history-text">{entry.text}</span>
            <span class="cmd-history-meta"
              >{entry.transport === "local" ? "LOCAL" : "RELAY"} · {entry.status}</span
            >
          </button>
        </li>
      {/each}
    </ol>
  {/if}
</section>
