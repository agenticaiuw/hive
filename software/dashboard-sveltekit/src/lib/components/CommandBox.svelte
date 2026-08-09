<script lang="ts">
  /**
   * "Ask the hive" — THE command box. One per page, voice and text.
   *
   * There used to be two places to talk to the agent: this box (typed, with
   * the status trail) and a second "speak from this browser" composer that
   * fire-and-forgot into the pendant pipeline. Same agent, two boxes. They are
   * now one component on every surface (deployed site, iOS shell, menu-bar
   * WebView, local dashboard): a mic, a field, a send button.
   *
   * Transport is chosen per submission by the rule in `$lib/transportRule`:
   * typed commands run LOCAL when the Mac agent itself serves the page
   * (same-origin `/plan`/`/execute` with the loopback session) and VIA RELAY
   * everywhere else (this app's `/api/command` server routes hold the key).
   * Voice keeps the existing browser-speech pipeline exactly — MediaRecorder
   * → `/api/command/audio` (Workers AI transcription → the same relay plan
   * job) — which exists only on the Worker build, so the mic is disabled with
   * the reason on the agent build instead of recording audio with nowhere to
   * go.
   *
   * Honest transport, per submission: every submission's card carries a badge
   * recorded at dispatch time — "via this Mac" or "via relay" — for the path
   * that actually carried it, never a page-level constant. The header badge
   * still names where the NEXT command will go, kept honest by the mount-time
   * `/health` probe on the agent build.
   *
   * The status line only ever reports states something actually confirmed:
   * transcribed (the transcript came back), queued (relay accepted), picked
   * up (the Mac claimed it), planning / executing, then done, parked for
   * approval, or failed with the real error. A parked plan is never presented
   * as a failure.
   */
  import { onDestroy, onMount } from "svelte";
  import { base } from "$app/paths";
  import {
    HISTORY_LIMIT,
    MAX_COMMAND_LENGTH,
    commandTransport,
    conversationSessionId,
    dispatchRelayCommand,
    dispatchVoiceCommand,
    fetchRelayCommandJob,
    isTerminalRelayStatus,
    loadCommandHistory,
    probeLocalAgent,
    runLocalExecute,
    runLocalPlan,
    saveCommandHistory,
    voiceSupported,
    type CommandHistoryEntry,
    type CommandResultView,
    type CommandTransport,
    type ParkedInfo,
  } from "$lib/command";
  import { submissionBadge } from "$lib/transportRule.js";
  import {
    blobToBase64,
    mimeToFormat,
    pickRecorderMimeType,
    recordClock,
  } from "$lib/pipeline";

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

  type CommandKind = "typed" | "voice";

  type ActiveRecording = {
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    mimeType: string;
    startedAt: number;
  };

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
  /** How the ACTIVE submission travelled; null when nothing is on the card. */
  let activeTransport = $state<CommandTransport | null>(null);
  let activeKind = $state<CommandKind>("typed");
  /** Confirmed by the transcript itself coming back, never inferred. */
  let voiceTranscribed = $state(false);
  let pickedUpMs = $state<number | null>(null);
  let finishedMs = $state<number | null>(null);
  let history = $state<CommandHistoryEntry[]>([]);
  let historyOpen = $state(false);
  let localProbeError = $state("");
  /** Mic/permission problems live under the field, not on a submission card. */
  let hint = $state("");
  let recording = $state(false);
  let recordSeconds = $state(0);
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
  // Deliberately a plain binding, not `$state`: the recorder handle is
  // machinery, and mutating it must never schedule a re-render or re-run the
  // timer effect below.
  let activeRecording: ActiveRecording | null = null;

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

  /** Where the NEXT command goes; each submission's card records its own. */
  const transportLabel = commandTransport === "local" ? "LOCAL" : "VIA RELAY";
  const transportTitle =
    commandTransport === "local"
      ? "This page is served by the Mac agent itself: typed commands run same-origin through its /plan and /execute routes with the loopback session. The relay is not involved."
      : "This page has no route to the Mac: commands go to this app's own /api/command server routes, which create the relay plan job with a server-held key and poll the job. The key never reaches this browser.";

  const micTitle = $derived(
    recording
      ? "Stop recording and send"
      : voiceSupported
        ? "Record a voice command"
        : "Voice uses the deployed dashboard's speech pipeline; this Mac-served page has no transcription route — type instead.",
  );

  /** The per-submission honest-transport badge, from what actually carried it. */
  const subBadge = $derived(
    activeTransport ? submissionBadge(activeTransport, activeKind) : null,
  );

  type StageView = { id: string; label: string; state: "done" | "active" | "todo" | "warn" | "skip" };

  /**
   * The transcribed → queued → picked up → planning → executing trail. Only
   * stages this submission's transport actually has are shown (LOCAL has no
   * queue and no pickup; only voice has a transcription hop), and a stage
   * reads "done" only when something recorded it really happening.
   */
  const stages = $derived.by<StageView[]>(() => {
    if (phase === "idle") return [];
    const transport = activeTransport ?? commandTransport;
    const activeOrdinal =
      phase === "sending" || phase === "queued"
        ? activeKind === "voice" && phase === "sending"
          ? 0 // the transcribed stage below carries "active" while sending
          : 1
        : phase === "planning"
          ? 3
          : phase === "executing"
            ? 4
            : 0; // "finishing" and terminal phases have no active stage
    const defs =
      transport === "relay"
        ? [
            ...(activeKind === "voice"
              ? [{ id: "transcribed", label: "transcribed", ordinal: 0 }]
              : []),
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
      if (id === "transcribed") {
        // Confirmed by the transcript coming back, not by `progress`.
        if (voiceTranscribed) return { id, label, state: "done" };
        if (phase === "sending") return { id, label, state: "active" };
        // A settled voice run with no transcript died right here.
        if (phase === "failed") return { id, label, state: "warn" };
        return { id, label, state: "todo" };
      }
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

  $effect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const recordStartedAt = activeRecording?.startedAt;
      if (recordStartedAt) {
        recordSeconds = Math.floor((Date.now() - recordStartedAt) / 1000);
      }
    }, 250);
    return () => window.clearInterval(timer);
  });

  onDestroy(() => {
    runToken += 1; // abandon any in-flight poll loop
    // Release the microphone if the page unmounts mid-recording.
    const pending = activeRecording;
    activeRecording = null;
    if (!pending) return;
    try {
      if (pending.recorder.state !== "inactive") pending.recorder.stop();
    } catch {
      // already stopped
    }
    pending.stream.getTracks().forEach((track) => track.stop());
  });

  function seconds(ms: number) {
    return `${(ms / 1000).toFixed(1)} s`;
  }

  function rememberSent(command: string, transport: CommandTransport) {
    historyId = crypto.randomUUID();
    const entry: CommandHistoryEntry = {
      id: historyId,
      text: command,
      transport,
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
    // A voice run that died before its transcript never entered history, and
    // must not overwrite the previous submission's entry.
    if (!historyId) return;
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
    voiceTranscribed = false;
    historyId = "";
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
    if (!command || busy || recording) return;
    text = "";
    void run(command);
  }

  async function run(command: string) {
    const token = ++runToken;
    resetOutcome();
    hint = "";
    activeCommand = command;
    activeKind = "typed";
    activeTransport = commandTransport;
    startedAt = Date.now();
    rememberSent(command, commandTransport);
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
    await pollRelayJob(jobId, token);
  }

  /** Shared by typed relay commands and voice: one poll loop, one truth. */
  async function pollRelayJob(jobId: string, token: number) {
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

  /* ------------------------------------------------------------- VOICE */

  async function startRecording() {
    hint = "";
    if (busy || !voiceSupported) return;
    if (
      typeof MediaRecorder === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      hint = "This browser cannot record audio — type a command instead.";
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.start(250);
      activeRecording = {
        recorder,
        stream,
        chunks,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        startedAt: Date.now(),
      };
      recordSeconds = 0;
      recording = true;
    } catch {
      // The mic stays live if MediaRecorder failed after getUserMedia resolved.
      stream?.getTracks().forEach((track) => track.stop());
      hint = "Microphone blocked — allow mic access or type instead.";
    }
  }

  /**
   * Stop the recording and send it down the browser-speech pipeline —
   * `/api/command/audio` transcribes it server-side and creates the same
   * relay plan job a typed command creates — then follow that job on the
   * same status trail.
   */
  async function stopAndSend() {
    const pending = activeRecording;
    if (!pending) return;
    activeRecording = null;
    recording = false;
    const token = ++runToken;
    resetOutcome();
    hint = "";
    activeCommand = ""; // unknown until the transcript comes back
    activeKind = "voice";
    activeTransport = "relay";
    startedAt = Date.now();
    phase = "sending";
    statusDetail = "Transcribing your recording in the cloud…";
    try {
      // A recorder that already stopped itself will never fire onstop again,
      // and a wedged one must not strand the box in "sending".
      if (pending.recorder.state !== "inactive") {
        const stopped = new Promise<void>((resolve) => {
          pending.recorder.onstop = () => resolve();
        });
        pending.recorder.stop();
        await Promise.race([
          stopped,
          new Promise<void>((resolve) => window.setTimeout(resolve, 2000)),
        ]);
      }

      const blob = new Blob(pending.chunks, { type: pending.mimeType });
      if (!blob.size) {
        throw new Error("No audio captured — try again.");
      }
      const audioBase64 = await blobToBase64(blob);
      const outcome = await dispatchVoiceCommand({
        audioBase64,
        format: mimeToFormat(blob.type || pending.mimeType),
        durationMs: Date.now() - pending.startedAt,
        sessionId: conversationSessionId(),
        language: navigator.language?.toLowerCase().startsWith("ko")
          ? "ko"
          : "en",
      });
      if (token !== runToken) return;

      if (outcome.noSpeech) {
        // Nothing was sent anywhere; not a run, so no card and no history.
        resetOutcome();
        phase = "idle";
        activeTransport = null;
        hint = "No speech detected — try again.";
        return;
      }

      voiceTranscribed = true;
      activeCommand = outcome.text || "(voice command)";
      rememberSent(activeCommand, "relay");

      if (!outcome.queued || !outcome.jobId) {
        // Transcribed fine, but the relay refused the dispatch (its own
        // sentence, e.g. "Mac bridge is offline…").
        errorText =
          outcome.queueError ||
          "The transcript could not be queued for the Mac.";
        settle("failed", errorText);
        statusDetail = `failed after ${seconds(finishedMs ?? 0)}`;
        return;
      }

      activeJobId = outcome.jobId;
      progress = 1;
      phase = "queued";
      statusDetail = "Transcribed and queued — waiting for the Mac to pick it up…";
      onQueued?.();
      await pollRelayJob(outcome.jobId, token);
    } catch (sendError) {
      if (token !== runToken) return;
      errorText =
        sendError instanceof Error ? sendError.message : "Voice send failed.";
      settle("failed", errorText);
      statusDetail = `failed after ${seconds(finishedMs ?? 0)}`;
    } finally {
      // Always hand the microphone back, however the send ended.
      pending.stream.getTracks().forEach((track) => track.stop());
    }
  }

  function dismiss() {
    runToken += 1;
    phase = "idle";
    resetOutcome();
    activeCommand = "";
    activeTransport = null;
    activeKind = "typed";
  }

  function recall(entry: CommandHistoryEntry) {
    if (busy || recording) return;
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

  <div class="cmd-composer">
    <button
      type="button"
      class="mic-button {recording ? 'recording' : ''}"
      onclick={recording ? stopAndSend : startRecording}
      disabled={busy || !voiceSupported}
      aria-label={recording ? "Stop recording and send" : "Record a voice command"}
      title={micTitle}
    >
      {#if recording}
        <svg
          viewBox="0 0 16 16"
          width="15"
          height="15"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect x="4" y="4" width="8" height="8" rx="1.5" />
        </svg>
      {:else}
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
          <path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0" />
          <path d="M8 11.8v2.4" />
        </svg>
      {/if}
    </button>
    {#if recording}
      <span class="record-timer">{recordClock(recordSeconds)}</span>
    {/if}
    <form class="composer-field cmd-field" onsubmit={submit}>
      <input
        bind:value={text}
        placeholder="Ask the hive…"
        aria-label="Ask the hive"
        enterkeyhint="send"
        maxlength={MAX_COMMAND_LENGTH}
        disabled={busy || recording}
      />
      <button
        type="submit"
        class="send-button"
        aria-label="Send to the hive"
        title="Send to the hive"
        disabled={busy || recording || !text.trim()}
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
  </div>
  {#if hint}
    <p class="composer-hint">{hint}</p>
  {/if}

  {#if phase !== "idle"}
    <div class="cmd-status-block" aria-live="polite">
      <div class="cmd-status-head">
        {#if subBadge}
          <span class="hv-badge cmd-sub-badge" title={subBadge.title}
            >{subBadge.label}</span
          >
        {/if}
        <p class="cmd-active-command" title={activeCommand || "Voice command"}>
          {#if activeCommand}“{activeCommand}”{:else}Voice command{/if}
        </p>
      </div>
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
              >{entry.transport === "local" ? "via this Mac" : "via relay"} · {entry.status}</span
            >
          </button>
        </li>
      {/each}
    </ol>
  {/if}
</section>
