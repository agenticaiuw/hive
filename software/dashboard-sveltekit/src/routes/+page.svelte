<script lang="ts">
  import { onMount } from "svelte";
  import {
    audioHref,
    backend,
    fetchHistory,
    fetchHistoryDetail,
    fetchLatestRun,
    fetchMemory,
    fetchRuns,
    fetchSnapshot,
  } from "$lib/dataSource";
  import ClusterDot from "$lib/components/ClusterDot.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import JobsPanel from "$lib/components/JobsPanel.svelte";
  import Metric from "$lib/components/Metric.svelte";
  import SystemRow from "$lib/components/SystemRow.svelte";
  import Tile from "$lib/components/Tile.svelte";
  import {
    BAD_TRANSCRIPT_DIAGNOSIS,
    bytes,
    clock,
    displayCommand,
    duration,
    hasUsefulTranscript,
    isIdleRun,
    isTranscribing,
    stageState,
    stagesFor,
    type JsonRecord,
  } from "$lib/pipeline";

  let snapshot = $state<JsonRecord | null>(null);
  let liveRuns = $state<JsonRecord[]>([]);
  let selectedId = $state("");
  let error = $state("");
  let refreshing = $state(false);
  let detailsOpen = $state(false);
  let toggledEvents = $state<Set<string>>(new Set());
  // Jobs answers "what is running and what did it just do", which is the
  // question this page exists for, so it is the one panel open on arrival.
  let openTile = $state("jobs");
  let jobsPanel = $state<{ refresh: () => Promise<void> } | null>(null);
  let historyEntries = $state<JsonRecord[]>([]);
  let historyQuery = $state("");
  let historyLoading = $state(false);
  let historyError = $state("");
  let historyRetention = $state<JsonRecord | null>(null);
  let historyNextCursor = $state("");
  let historyHasMore = $state(false);
  let historyDetail = $state<JsonRecord | null>(null);
  let historyDetailLoading = $state(false);
  let historyDetailError = $state("");
  let memoryEntitiesFull = $state<JsonRecord[]>([]);
  let memorySessions = $state<JsonRecord[]>([]);
  let activeSessionId = $state("");
  let playingId = $state("");

  // Re-entrancy guards and the freshness key stay plain bindings on purpose:
  // as reactive state they would retrigger the effects that read them.
  let snapshotRefreshPending = false;
  let runsRefreshPending = false;
  let historyRefreshPending = false;
  let latestRunKey = "";

  async function refresh() {
    if (snapshotRefreshPending) return;
    snapshotRefreshPending = true;
    refreshing = true;
    try {
      const payload = await fetchSnapshot();
      snapshot = payload;
      error = "";
      const nextRuns: JsonRecord[] = Array.isArray(payload.pipeline)
        ? payload.pipeline
        : [];
      selectedId =
        selectedId && nextRuns.some((run) => run.pipelineId === selectedId)
          ? selectedId
          : nextRuns[0]?.pipelineId || "";
    } catch (refreshError) {
      if (
        refreshError instanceof Error &&
        refreshError.message.includes(
          "Superseded by a newer dashboard snapshot request",
        )
      ) {
        return;
      }
      // A failed poll on a page that is already showing data is noise; only
      // say something when there is nothing on screen to trust.
      if (!snapshot) {
        error =
          refreshError instanceof Error
            ? refreshError.message
            : "Dashboard refresh failed.";
      }
    } finally {
      snapshotRefreshPending = false;
      refreshing = false;
    }
  }

  async function refreshRuns() {
    if (runsRefreshPending) return;
    runsRefreshPending = true;
    try {
      const nextRuns: JsonRecord[] = await fetchRuns();
      liveRuns = nextRuns;
      // Note the fallback differs from refresh(): the live feed keeps the
      // current selection rather than clearing it.
      selectedId =
        selectedId && nextRuns.some((run) => run.pipelineId === selectedId)
          ? selectedId
          : nextRuns[0]?.pipelineId || selectedId;
    } catch {
      // The slower full snapshot remains available if the direct feed blips.
    } finally {
      runsRefreshPending = false;
    }
  }

  async function checkLatest() {
    if (document.visibilityState !== "visible") return;
    try {
      const latest = await fetchLatestRun();
      if (!latest) return;
      const key = latest
        ? `${latest.pipelineId}|${latest.status}|${latest.updatedAt}`
        : "";
      if (key !== latestRunKey) {
        latestRunKey = key;
        void refreshRuns();
        void refresh();
        void jobsPanel?.refresh();
        if (openTile === "history") void refreshHistory();
      }
    } catch {
      // Freshness probe is best-effort; the timed refreshes still run.
    }
  }

  async function refreshHistory(
    q = historyQuery,
    cursor = "",
    append = false,
  ) {
    if (historyRefreshPending) return;
    historyRefreshPending = true;
    historyLoading = true;
    try {
      const payload = await fetchHistory(q, cursor);
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      historyEntries = append ? [...historyEntries, ...entries] : entries;
      historyNextCursor = String(payload.nextCursor || "");
      historyHasMore = Boolean(payload.hasMore && historyNextCursor);
      historyRetention =
        payload.retention && typeof payload.retention === "object"
          ? payload.retention
          : null;
      historyError = "";
    } catch (err) {
      historyError =
        err instanceof Error ? err.message : "History could not load.";
    } finally {
      historyRefreshPending = false;
      historyLoading = false;
    }
  }

  async function selectHistoryEntry(pipelineId: string) {
    if (!pipelineId || historyDetailLoading) return;
    historyDetailLoading = true;
    historyDetailError = "";
    try {
      historyDetail = await fetchHistoryDetail(pipelineId);
      if (!historyDetail) throw new Error("Run detail was empty.");
    } catch (detailError) {
      historyDetail = null;
      historyDetailError =
        detailError instanceof Error
          ? detailError.message
          : "Run detail could not load.";
    } finally {
      historyDetailLoading = false;
    }
  }

  async function refreshMemory() {
    try {
      const payload = await fetchMemory();
      if (!payload) return;
      memoryEntitiesFull = Array.isArray(payload.memory?.entities)
        ? payload.memory.entities
        : [];
      memorySessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      if (
        !activeSessionId ||
        !memorySessions.some(
          (session) => session.sessionId === activeSessionId,
        )
      ) {
        activeSessionId = String(memorySessions[0]?.sessionId || "");
      }
    } catch {
      // Data tile still shows snapshot memory if this fails.
    }
  }

  function playRecording(pipelineId: string, voice: "owner" | "reply" = "owner") {
    if (!pipelineId) return;
    const playKey = voice === "reply" ? `${pipelineId}:reply` : pipelineId;
    playingId = playKey;
    const audio = new Audio(audioHref(pipelineId, voice));
    audio.addEventListener("ended", () => {
      if (playingId === playKey) playingId = "";
    });
    audio.addEventListener("error", () => {
      if (playingId === playKey) playingId = "";
      historyError = "Could not play this recording.";
    });
    void audio.play().catch(() => {
      playingId = "";
      historyError = "Browser blocked audio playback.";
    });
  }

  onMount(() => {
    const initialSnapshot = window.setTimeout(refresh, 0);
    const snapshotTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    const initialRuns = window.setTimeout(refreshRuns, 0);
    const probe = window.setInterval(checkLatest, 5_000);
    const runsBackstop = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshRuns();
    }, 15_000);
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void checkLatest();
      void refreshRuns();
      void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(initialSnapshot);
      window.clearInterval(snapshotTimer);
      window.clearTimeout(initialRuns);
      window.clearInterval(probe);
      window.clearInterval(runsBackstop);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  });

  const snapshotRuns = $derived<JsonRecord[]>(
    Array.isArray(snapshot?.pipeline) ? snapshot!.pipeline : [],
  );
  const runs = $derived<JsonRecord[]>(
    liveRuns.length ? liveRuns : snapshotRuns,
  );
  // Prefer an active/recent real run over a stuck empty "transcribing" job.
  const preferredRun = $derived.by(() => {
    const list = runs;
    if (!list.length) return null;
    if (selectedId) {
      const hit = list.find((run) => run.pipelineId === selectedId);
      if (hit && !isIdleRun(hit)) return hit;
    }
    const live = list.find(
      (run) =>
        isTranscribing(run) ||
        (run.status === "processing" && hasUsefulTranscript(run.command)),
    );
    if (live) return live;
    const done = list.find(
      (run) =>
        hasUsefulTranscript(run.command) ||
        run.status === "completed" ||
        run.status === "failed",
    );
    return done ?? null;
  });
  const selected = $derived<any>(preferredRun);
  const cloud = $derived<any>(snapshot?.cloud ?? {});
  const agent = $derived<any>(snapshot?.status?.agent ?? {});
  const telemetry = $derived<any>(
    selected?.events?.find(
      (candidate: JsonRecord) => candidate.stage === "transcription",
    )?.meta?.inputTelemetry ?? null,
  );
  const selectedTranscribing = $derived(isTranscribing(selected));
  const selectedIdle = $derived(!selected || isIdleRun(selected));
  const badTranscript = $derived(
    Boolean(
      selected &&
        !selectedIdle &&
        !selectedTranscribing &&
        !hasUsefulTranscript(selected.command) &&
        selected.status === "failed",
    ),
  );
  const newestRun = $derived<any>(
    runs.find((run) => hasUsefulTranscript(run.command) || isTranscribing(run)) ??
      runs[0] ??
      null,
  );
  const latestBad = $derived(
    Boolean(
      newestRun &&
        !isTranscribing(newestRun) &&
        !hasUsefulTranscript(newestRun.command) &&
        newestRun.status === "failed",
    ),
  );
  const permissions = $derived<any>(agent.permissions ?? {});
  const browserExtension = $derived<any>(agent.browserExtension ?? {});
  const automationEntries = $derived(
    Object.entries(permissions.automation ?? {}) as [string, JsonRecord][],
  );
  const grantedAutomation = $derived(
    automationEntries.filter(([, result]) => result.granted).length,
  );
  const requiredMissing = $derived<string[]>(
    Array.isArray(permissions.requiredMissing) ? permissions.requiredMissing : [],
  );
  const sharedProduct = $derived<any>(snapshot?.product ?? {});
  const sharedSessions = $derived<JsonRecord[]>(
    Array.isArray(sharedProduct.sessions) ? sharedProduct.sessions : [],
  );
  const visibleSessions = $derived<JsonRecord[]>(
    memorySessions.length ? memorySessions : sharedSessions,
  );
  const activeSession = $derived<JsonRecord | null>(
    visibleSessions.find(
      (session) => session.sessionId === activeSessionId,
    ) ??
      visibleSessions[0] ??
      null,
  );
  const memoryEntities = $derived<JsonRecord[]>(
    Array.isArray(sharedProduct.memory?.entities)
      ? sharedProduct.memory.entities
      : [],
  );

  const storeLabel = $derived(cloud.store === "d1" ? "D1" : cloud.store || "—");
  const cloudUp = $derived(Boolean(cloud.ok));
  const bridgeUp = $derived(Boolean(cloud.macBridgeOnline));
  const browserUp = $derived(Boolean(browserExtension.online));
  const systemTone = $derived<"ok" | "warn" | "off">(
    cloudUp && bridgeUp ? "ok" : cloudUp || bridgeUp ? "warn" : "off",
  );
  const heroChip = $derived<{ tone: string; word: string } | null>(
    selectedIdle
      ? { tone: "ok", word: "Idle" }
      : badTranscript
        ? { tone: "warn", word: "No speech" }
        : selectedTranscribing ||
            selected.status === "processing" ||
            selected.status === "active"
          ? { tone: "run", word: "Running" }
          : selected.status === "failed"
            ? { tone: "warn", word: "Failed" }
            : { tone: "ok", word: "Done" },
  );

  const stages = $derived(stagesFor(selected));

  /*
   * Audio sources for the hero card. A run carries audio.captureId for the
   * owner's voice and audio.replyCaptureId for the agent's; either can be
   * absent (a typed command has no recording, and a run whose reply was text
   * only has no reply audio). Both stream through the same server route,
   * which keeps the relay key off the client.
   */
  const heroOwnAudio = $derived(
    selected?.audio?.captureId && selected?.pipelineId
      ? audioHref(String(selected.pipelineId), "owner")
      : "",
  );
  const heroReplyAudio = $derived(
    selected?.audio?.replyCaptureId && selected?.pipelineId
      ? audioHref(String(selected.pipelineId), "reply")
      : "",
  );

  const metaSegments = $derived.by(() => {
    const segments: { title: string; text: string }[] = [];
    if (!selected) return segments;
    const audio = bytes(telemetry?.audioBytes);
    if (audio) segments.push({ title: "Recorded audio", text: audio });
    const length = duration(telemetry?.durationMs);
    if (length) segments.push({ title: "Duration", text: length });
    if (telemetry?.sampleRate) {
      segments.push({
        title: "Sample rate",
        text: `${telemetry.sampleRate.toLocaleString()} Hz`,
      });
    }
    if (selected.updatedAt) {
      segments.push({ title: "Last update", text: clock(selected.updatedAt) });
    }
    return segments;
  });

  // Auto-open the hero details when the selected run failed to transcribe so
  // the evidence is on screen without a click. Closing it stays closed until
  // the selection (or its bad-transcript state) changes.
  $effect(() => {
    void selectedId;
    if (badTranscript) detailsOpen = true;
  });

  function handleCommandQueued() {
    void refreshRuns();
    void refresh();
  }

  function toggleEvent(id: string) {
    const next = new Set(toggledEvents);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    toggledEvents = next;
  }

  function toggleTile(id: string) {
    const next = openTile === id ? "" : id;
    openTile = next;
    if (next === "history") {
      void refreshHistory();
      void refreshMemory();
    }
    if (next === "data") {
      void refreshMemory();
    }
  }
</script>

<main class="dashboard-shell">
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" title="AI Pendant Dashboard">P</span>
      <h1>Dashboard</h1>
    </div>
    <div class="top-actions">
      <div class="dot-cluster" aria-label="System status">
        <ClusterDot
          short="Cloud"
          state={cloudUp ? "ok" : "off"}
          text={`Cloudflare relay: ${cloudUp ? "online" : "offline"}`}
        />
        <ClusterDot
          short="Bridge"
          state={bridgeUp ? "ok" : "off"}
          text={`Mac bridge: ${bridgeUp ? "connected" : "disconnected"}`}
        />
        <ClusterDot
          short="Mic"
          state={latestBad ? "warn" : "ok"}
          text={`Mic input: ${latestBad ? "speech not detected" : "ok"}`}
        />
        <ClusterDot
          short="Browser"
          state={browserUp ? "ok" : "off"}
          text={`Browser extension: ${browserUp ? "online" : "offline"}`}
        />
      </div>
      <button
        class="icon-button {refreshing ? 'spinning' : ''}"
        onclick={refresh}
        disabled={refreshing}
        aria-label="Refresh"
        title="Refresh"
      >
        <svg
          viewBox="0 0 16 16"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9L13.6 5.6" />
          <path d="M13.7 2.2v3.4h-3.4" />
        </svg>
      </button>
      <!-- Nothing to sign out of on the Mac: that build is reachable only from
           loopback and holds no session of its own. -->
      {#if backend === "relay"}
      <form action="/api/auth/logout" method="post">
        <button
          class="icon-button"
          type="submit"
          aria-label="Sign out"
          title="Sign out"
        >
          <svg
            viewBox="0 0 16 16"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M6.5 2H2.5v12h4" />
            <path d="M10.5 5l3 3-3 3" />
            <path d="M13.5 8H6" />
          </svg>
        </button>
      </form>
      {/if}
    </div>
  </header>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  {#if latestBad || requiredMissing.length}
    <div class="alert-strip" aria-label="Attention needed">
      {#if latestBad}
        <span class="alert-chip" title={BAD_TRANSCRIPT_DIAGNOSIS}
          >Mic · no speech</span
        >
      {/if}
      {#if requiredMissing.length}
        <span class="alert-chip" title={requiredMissing.join(", ")}
          >Permissions · {requiredMissing.length} missing</span
        >
      {/if}
    </div>
  {/if}

  <article class="hero {badTranscript ? 'has-alert' : ''}">
    {#if selected && !selectedIdle}
      <div class="hero-top">
        <span class="micro-chip"
          >{selected.pipelineId === newestRun?.pipelineId
            ? "Latest"
            : clock(selected.createdAt)}</span
        >
        {#if heroChip}
          <span
            class="status-chip {heroChip.tone}"
            title={`${selected.status} · ${selected.pipelineId}`}
            ><i aria-hidden="true"></i>{heroChip.word}</span
          >
        {/if}
      </div>
      <h2 class="hero-command">{displayCommand(selected)}</h2>
      {#if badTranscript}
        <span class="alert-chip hero-alert" title={BAD_TRANSCRIPT_DIAGNOSIS}
          >Speech not detected</span
        >
      {/if}

      <div class="stage-rail" aria-label="Pipeline stages">
        {#each stages as stage, index}
          {@const state = stageState(selected, stage.id)}
          {#if index}<i
              class="stage-link {stageState(selected, stages[index - 1].id) ===
              'done'
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

      {#if metaSegments.length}
        <p class="meta-line">{#each metaSegments as segment, index}{#if index}<span class="sep" aria-hidden="true">{" · "}</span>{/if}<span title={segment.title}>{segment.text}</span>{/each}</p>
      {/if}

      <!--
        Both voices, playable in place. The relay's audio route forwards Range
        headers, so a native <audio> element gets a real scrubber and duration
        rather than the fire-and-forget playback the history rows use.
      -->
      {#if heroOwnAudio || heroReplyAudio}
        <div class="hero-audio">
          {#if heroOwnAudio}
            <div class="hero-track">
              <span class="hero-track-label">You</span>
              <audio
                class="hero-player"
                controls
                preload="metadata"
                src={heroOwnAudio}
                aria-label="Your recording"
              ></audio>
            </div>
          {/if}
          {#if heroReplyAudio}
            <div class="hero-track">
              <span class="hero-track-label">Agent</span>
              <audio
                class="hero-player"
                controls
                preload="metadata"
                src={heroReplyAudio}
                aria-label="The agent's spoken reply"
              ></audio>
            </div>
          {/if}
          {#if selected?.audio?.replyTranscript}
            <p class="hero-reply-transcript">
              “{selected.audio.replyTranscript}”
            </p>
          {/if}
        </div>
      {/if}

      <button
        class="details-toggle"
        onclick={() => (detailsOpen = !detailsOpen)}
        aria-expanded={detailsOpen}
        ><span class="chevron {detailsOpen ? 'open' : ''}" aria-hidden="true"
          >▸</span
        >Details</button
      >

      {#if detailsOpen}
        <div class="details-panel">
          <p class="pipeline-id">{selected.pipelineId}</p>
          {#if badTranscript}
            <p class="details-note">{BAD_TRANSCRIPT_DIAGNOSIS}</p>
          {/if}
          <div class="telemetry-grid">
            <Metric label="Payload" value={bytes(telemetry?.audioBytes) || "—"} />
            <Metric
              label="Duration"
              value={duration(telemetry?.durationMs) || "—"}
            />
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
            <Metric label="Transcript" value={selected.command || "empty"} />
          </div>
          <ol class="event-list">
            {#each selected.events ?? [] as event, index}
              {@const eventId = String(
                event.eventId || `${event.stage}-${index}`,
              )}
              <!-- Failed events start expanded; the toggle set records deviations from that default. -->
              {@const open =
                (event.status === "failed") !== toggledEvents.has(eventId)}
              {@const expandable = Boolean(event.detail || event.text)}
              <li>
                <div class="event-index {event.status}">{index + 1}</div>
                <div class="event-copy">
                  <button
                    class="event-row"
                    onclick={() => toggleEvent(eventId)}
                    aria-expanded={open}
                    disabled={!expandable}
                  >
                    <span class="event-stage"
                      >{event.stage?.replaceAll("_", " ")}</span
                    >
                    <span class="event-label">{event.label}</span>
                    <time>{clock(event.at)}</time>
                  </button>
                  {#if open && expandable}
                    {#if event.detail}
                      <p class="event-detail">{event.detail}</p>
                    {/if}
                    {#if event.text}
                      <blockquote>{event.text}</blockquote>
                    {/if}
                  {/if}
                </div>
              </li>
            {/each}
          </ol>
        </div>
      {/if}
    {:else}
      <div class="hero-empty">
        <div class="hero-top">
          <span class="micro-chip">Idle</span>
          {#if heroChip}
            <span class="status-chip {heroChip.tone}"
              ><i aria-hidden="true"></i>{heroChip.word}</span
            >
          {/if}
        </div>
        <h2 class="hero-command">Ready</h2>
        <p class="hero-hint">Press the pendant or type a command</p>
      </div>
    {/if}
    <Composer onQueued={handleCommandQueued} />
  </article>

  <div class="run-strip" aria-label="Recent commands">
    {#each runs as run}
      {@const transcribing = isTranscribing(run)}
      {@const unreadable = !transcribing && !hasUsefulTranscript(run.command)}
      {@const statusText = transcribing
        ? "Transcribing"
        : unreadable
          ? "Speech not detected"
          : run.status}
      {@const dotTone = unreadable
        ? "failed"
        : transcribing
          ? "processing"
          : run.status}
      <button
        class="run-chip {run.pipelineId === selected?.pipelineId
          ? 'selected'
          : ''}"
        onclick={() => (selectedId = run.pipelineId)}
        title={`${displayCommand(run)} · ${statusText} · ${clock(run.createdAt)}`}
        aria-label={`${displayCommand(run)} · ${statusText} · ${clock(run.createdAt)}`}
        ><i class="run-dot {dotTone}" aria-hidden="true"></i><span
          >{displayCommand(run)}</span
        ></button
      >
    {/each}
  </div>

  <div class="tile-strip">
    <Tile
      id="jobs"
      label="Jobs"
      tone="ok"
      dotText="Everything the agent has been asked to do"
      value="What ran"
      open={openTile === "jobs"}
      onToggle={() => toggleTile("jobs")}
    />
    <Tile
      id="system"
      label="System"
      tone={systemTone}
      dotText={`Relay ${cloudUp ? "online" : "offline"} · Bridge ${
        bridgeUp ? "connected" : "disconnected"
      }`}
      value={cloudUp
        ? `${storeLabel} · ${agent.ok ? `v${agent.version}` : "—"}`
        : "Offline"}
      open={openTile === "system"}
      onToggle={() => toggleTile("system")}
    />
    <Tile
      id="mac"
      label="Mac"
      tone={permissions.ready ? "ok" : "warn"}
      dotText={permissions.ready
        ? "Mac permissions ready"
        : "Mac permissions incomplete"}
      value={requiredMissing.length
        ? `${requiredMissing.length} missing`
        : "Ready"}
      open={openTile === "mac"}
      onToggle={() => toggleTile("mac")}
    />
    <Tile
      id="browser"
      label="Browser"
      tone={browserUp ? "ok" : "off"}
      dotText={`Browser extension ${browserUp ? "online" : "offline"}`}
      value={browserUp ? "Connected" : "Offline"}
      open={openTile === "browser"}
      onToggle={() => toggleTile("browser")}
    />
    <Tile
      id="history"
      label="History"
      tone={historyEntries.length || runs.length ? "ok" : "off"}
      dotText="Messages, recordings, spoken replies"
      value={historyEntries.length
        ? `${historyEntries.length} runs`
        : runs.length
          ? `${runs.length} recent`
          : "—"}
      open={openTile === "history"}
      onToggle={() => toggleTile("history")}
    />
    <Tile
      id="data"
      label="Memory"
      tone="ok"
      dotText="What the agent remembers"
      value={`${sharedSessions.length} chats · ${memoryEntities.length} mem`}
      open={openTile === "data"}
      onToggle={() => toggleTile("data")}
    />
  </div>

  {#if openTile === "system"}
    <section id="tile-panel-system" class="tile-panel" aria-label="System detail">
      <dl class="system-list">
        <SystemRow label="Relay" value={cloudUp ? "Online" : "Offline"} />
        <SystemRow label="Queue" value={storeLabel} />
        <SystemRow
          label="STT"
          value={cloud.speechToTextConfigured
            ? cloud.models?.speechToText || "Workers AI ready"
            : "Off"}
        />
        <SystemRow
          label="TTS"
          value={cloud.models?.textToSpeech || "macOS say · 24 kHz"}
        />
        <SystemRow
          label="Bridge"
          value={bridgeUp ? "Connected" : "Disconnected"}
        />
        <SystemRow
          label="Agent"
          value={agent.ok ? `v${agent.version}` : "Offline"}
        />
      </dl>
    </section>
  {/if}

  {#if openTile === "mac"}
    <section
      id="tile-panel-mac"
      class="tile-panel"
      aria-label="Mac permissions detail"
    >
      <dl class="system-list">
        <SystemRow
          label="Accessibility"
          value={permissions.accessibility?.trusted ? "✓" : "—"}
        />
        <SystemRow
          label="Screen"
          value={permissions.screenRecording?.granted ? "✓" : "—"}
        />
        <SystemRow
          label="Automation"
          value={automationEntries.length
            ? `${grantedAutomation}/${automationEntries.length}`
            : "Not checked"}
        />
        <SystemRow label="Host" value={agent.hostApp || "—"} />
      </dl>
      {#if requiredMissing.length}
        <div class="perm-chips">
          {#each requiredMissing as name}
            <span class="perm-chip">{name}</span>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  {#if openTile === "browser"}
    <section
      id="tile-panel-browser"
      class="tile-panel"
      aria-label="Browser bridge detail"
    >
      <dl class="system-list">
        <SystemRow
          label="Devices"
          value={String(browserExtension.connectedDevices ?? 0)}
        />
        <SystemRow
          label="Queued"
          value={String(browserExtension.pendingCommands ?? 0)}
        />
        <SystemRow label="Seen" value={clock(browserExtension.lastSeenAt)} />
      </dl>
    </section>
  {/if}

  {#if openTile === "jobs"}
    <JobsPanel bind:this={jobsPanel} />
  {/if}

  {#if openTile === "history"}
    <section
      id="tile-panel-history"
      class="tile-panel"
      aria-label="Command history and recordings"
    >
      <form
        class="history-search"
        onsubmit={(event) => {
          event.preventDefault();
          historyDetail = null;
          historyDetailError = "";
          void refreshHistory(historyQuery);
        }}
      >
        <input
          type="search"
          placeholder="Search commands and replies"
          bind:value={historyQuery}
          aria-label="Search history"
        />
        <button type="submit" class="icon-button" disabled={historyLoading}
          >{historyLoading ? "…" : "Go"}</button
        >
      </form>
      {#if historyRetention}
        {@const audioPolicy =
          historyRetention.audio && typeof historyRetention.audio === "object"
            ? historyRetention.audio
            : {}}
        <p class="panel-empty history-retention">
          Runs kept ~{Math.round(
            Number(historyRetention.runsTtlMs || 86400000) / 3600000,
          )}h · audio ~{Math.round(
            Number(audioPolicy.maxAgeMs || 2592000000) / 86400000,
          )}d · transcript + recording when available
        </p>
      {/if}
      {#if historyError}
        <p class="panel-empty">{historyError}</p>
      {/if}
      {#if historyEntries.length}
        <ol class="history-list">
          {#each historyEntries as entry}
            <li>
              <div class="history-row">
                <button
                  class="history-main {historyDetail?.pipelineId ===
                  entry.pipelineId
                    ? 'selected'
                    : ''}"
                  onclick={() => {
                    void selectHistoryEntry(String(entry.pipelineId || ""));
                  }}
                  aria-pressed={historyDetail?.pipelineId === entry.pipelineId}
                >
                  <strong>{entry.command || "(no transcript)"}</strong>
                  <small
                    >{entry.status || "—"} · {entry.origin || entry.inputMode || "voice"} · {clock(
                      entry.createdAt,
                    )}</small
                  >
                  {#if entry.reply}
                    <p class="history-reply">{entry.reply}</p>
                  {/if}
                  {#if entry.error}
                    <p class="history-error">{entry.error}</p>
                  {/if}
                </button>
                {#if entry.audio?.available}
                  <button
                    class="history-audio"
                    onclick={() => playRecording(String(entry.pipelineId))}
                    aria-label={playingId === entry.pipelineId
                      ? "Playing your recording"
                      : "Play your recording"}
                    title={entry.audio.audioBytes
                      ? `Your voice · ${bytes(entry.audio.audioBytes)}`
                      : "Play your recording"}
                    >{playingId === entry.pipelineId ? "♪" : "▶"}</button
                  >
                {/if}
                {#if entry.audio?.replyAvailable}
                  <button
                    class="history-audio history-audio-reply"
                    onclick={() =>
                      playRecording(String(entry.pipelineId), "reply")}
                    aria-label={playingId === `${entry.pipelineId}:reply`
                      ? "Playing agent reply"
                      : "Play agent reply"}
                    title="Agent's spoken reply"
                    >{playingId === `${entry.pipelineId}:reply`
                      ? "♪"
                      : "🗣"}</button
                  >
                {/if}
              </div>
            </li>
          {/each}
        </ol>
      {:else if !historyLoading}
        <p class="panel-empty">No history yet — press the pendant or use the mic above.</p>
      {/if}
      {#if historyHasMore}
        <button
          class="history-more"
          type="button"
          disabled={historyLoading}
          onclick={() => {
            void refreshHistory(historyQuery, historyNextCursor, true);
          }}
          >{historyLoading ? "Loading…" : "Load older runs"}</button
        >
      {/if}
      {#if historyDetailLoading}
        <p class="panel-empty history-detail-state">Loading run detail…</p>
      {:else if historyDetailError}
        <p class="history-error history-detail-state">{historyDetailError}</p>
      {:else if historyDetail}
        <article class="history-detail" aria-label="Selected run detail">
          <div class="history-detail-head">
            <div>
              <p class="micro-label">Selected run</p>
              <h3>{historyDetail.command || "(no transcript)"}</h3>
            </div>
            <span>{historyDetail.status || "—"}</span>
          </div>
          {#if historyDetail.reply}
            <blockquote>{historyDetail.reply}</blockquote>
          {/if}
          <p class="history-detail-meta">
            {historyDetail.origin || historyDetail.inputMode || "voice"} ·
            {clock(historyDetail.createdAt)}
            {#if historyDetail.sessionId}
              · chat {historyDetail.sessionId.slice(0, 8)}
            {/if}
          </p>
          {#if historyDetail.events?.length}
            <ol class="history-detail-events">
              {#each historyDetail.events as event}
                <li>
                  <strong>{event.label || event.stage || "Event"}</strong>
                  <small>{event.status || "—"} · {clock(event.at)}</small>
                  {#if event.detail}<p>{event.detail}</p>{/if}
                  {#if event.text}<blockquote>{event.text}</blockquote>{/if}
                </li>
              {/each}
            </ol>
          {/if}
        </article>
      {/if}
    </section>
  {/if}

  {#if openTile === "data"}
    <section
      id="tile-panel-data"
      class="tile-panel"
      aria-label="Shared cloud data detail"
    >
      <span class="rev-badge">rev {sharedProduct.revision ?? 0}</span>
      <div class="data-grid">
        <div>
          <p class="micro-label">Chats</p>
          {#if visibleSessions.length}
            <ol class="data-list">
              {#each visibleSessions.slice(0, 8) as session}
                <li class:active={activeSession?.sessionId === session.sessionId}>
                  <button
                    type="button"
                    class="data-session-button"
                    aria-pressed={activeSession?.sessionId === session.sessionId}
                    onclick={() => (activeSessionId = String(session.sessionId))}
                  >
                    <span class="data-line">
                      <strong>{session.title || "Untitled session"}</strong>
                      <span>{session.sessionId?.slice(0, 8)}</span>
                    </span>
                    <small
                      >{session.turnCount ?? session.turns?.length ?? 0} turns · {clock(
                        session.updatedAt,
                      )}</small
                    >
                  </button>
                </li>
              {/each}
            </ol>
          {:else}
            <p class="panel-empty">None</p>
          {/if}
          {#if activeSession}
            <section class="chat-transcript" aria-label="Selected chat transcript">
              <p class="micro-label">Transcript</p>
              {#if activeSession.turns?.length}
                <ol>
                  {#each activeSession.turns as turn}
                    <li class:assistant={turn.role !== "user"}>
                      <div>
                        <strong>{turn.role === "user" ? "You" : "Pendant"}</strong>
                        <time>{clock(turn.createdAt)}</time>
                      </div>
                      <p>{turn.content}</p>
                    </li>
                  {/each}
                </ol>
              {:else}
                <p class="panel-empty">No messages in this chat.</p>
              {/if}
            </section>
          {/if}
        </div>
        <div>
          <p class="micro-label">Memory</p>
          {#if (memoryEntitiesFull.length ? memoryEntitiesFull : memoryEntities).length}
            <ol class="data-list">
              {#each (memoryEntitiesFull.length ? memoryEntitiesFull : memoryEntities).slice(0, 10) as entity}
                <li>
                  <div class="data-line">
                    <strong>{entity.name || "Untitled memory"}</strong>
                  </div>
                  <small
                    >{entity.type || "Memory"} · {clock(entity.updatedAt)}</small
                  >
                </li>
              {/each}
            </ol>
          {:else}
            <p class="panel-empty">None</p>
          {/if}
        </div>
      </div>
    </section>
  {/if}
</main>
