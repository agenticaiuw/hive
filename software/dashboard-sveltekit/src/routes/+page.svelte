<script lang="ts">
  /*
   * ===========================================================================
   * THE DASHBOARD — design rationale
   * ===========================================================================
   *
   * This page used to open with the owner's own question set in the largest
   * type on screen, a six-dot `STT · AGENT · TTS · RELAY · NRF · PLAY` strip,
   * `786.3 KiB · 16,000 Hz`, a Details block repeating the question a third
   * time — and a pill reading "Running" while the plan had actually PARKED and
   * was waiting for the owner. The question appeared three times; the answer
   * appeared zero times. Debug telemetry I needed while fixing the audio
   * pipeline had been promoted to the product.
   *
   * Eight principles, and what each one changes here:
   *
   * 1. ANSWER FIRST (inverted pyramid, NN/g). "The most important information
   *    ... is presented first" — the conclusion before the reasoning.
   *    → The answer is the display-size element. The question is one small
   *      secondary line above it, and appears exactly once on the page.
   *      nngroup.com/articles/inverted-pyramid/
   *
   * 2. STATUS THAT IS TRUE, IN THE USER'S WORDS (heuristics 1 + 2). #1 asks for
   *    feedback that builds "trust through open and continuous communication";
   *    #2 asks for "words, phrases, and concepts familiar to the user, rather
   *    than internal jargon".
   *    → `$lib/runState` derives the phase from the run's own events instead of
   *      echoing `run.status`, which lies. "Needs your approval", "Listening",
   *      "Thinking", "Answered", "Couldn't do it" — never "processing",
   *      "plan_ready", or a stage code.
   *      nngroup.com/articles/ten-usability-heuristics/
   *
   * 3. BLOCKED ON A HUMAN OUTRANKS EVERYTHING. Heuristic 9: name the problem in
   *    plain language and offer the way out.
   *    → A parked plan gets its own card above the answer, carrying the agent's
   *      verbatim reason, the steps it prepared, and the Approve button itself.
   *
   * 4. PROGRESSIVE DISCLOSURE, TWO LEVELS. "Show users only a few of the most
   *    important options"; going past two levels loses people; the control must
   *    be labelled to set expectations.
   *    → All telemetry — payload, sample rate, format, storage, gain, the stage
   *      strip, the event log — moves behind one <details> labelled "Technical
   *      details", with a noun-phrase hint. Kept, not deleted: it is how this
   *      hardware gets debugged. Nothing inside it opens a third level.
   *      nngroup.com/articles/progressive-disclosure/
   *
   * 5. EMPHASIZE BY DE-EMPHASIZING (Refactoring UI). Three text colours, two
   *    weights, and "resist immediately reaching for a border" — separate with
   *    space, not boxes.
   *    → One type scale (--fs-*), three ink tiers, weights 450/650. The nested
   *      bordered panels are gone; grouping is spacing.
   *      medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886
   *
   * 6. SPEND THE TOP OF THE PAGE ON DECISIONS. NN/g eyetracking: content just
   *    above the fold is viewed ~102% more than just below it.
   *    → Order is: what needs you → what it said → ask it something → what it
   *      did → system panels. Diagnostics never occupy that space again.
   *      nngroup.com/articles/page-fold-manifesto/
   *
   * 7. STATUS IS NEVER COLOUR ALONE (WCAG 1.4.1), AND MUST BE READABLE
   *    (1.4.3 / 1.4.11). Every state pill is icon + word + colour; body text
   *    clears 4.5:1 and every state dot and control edge clears 3:1 on this
   *    dark surface. Text is #f7f8fa, not #fff — pure white on near-black
   *    bleeds (Material dark-theme guidance).
   *    w3.org/WAI/WCAG22/Understanding/use-of-color.html
   *
   * 8. NOTHING FABRICATES. A run with no answer looks like a run with no
   *    answer: the status word takes the display slot and no placeholder stands
   *    in for a result. Errors are the agent's verbatim text. The spoken-reply
   *    line reports `delivery.label` as written ("Waiting at the relay") and
   *    never claims the pendant played anything, because nothing observed that.
   *
   * KNOWN DATA GAP: a parked run's events never record that the owner later
   * approved it — approval starts a separate job — so "Needs your approval"
   * means "this plan is parked", not "nobody has acted on it". See
   * `$lib/runState` for how duplicates are collapsed rather than guessed at.
   */
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import {
    approvePlan,
    audioHref,
    backend,
    canApprovePlan,
    dismissPlan,
    fetchHistory,
    fetchHistoryDetail,
    fetchJobs,
    fetchLatestRun,
    fetchMemory,
    fetchRuns,
    fetchSnapshot,
  } from "$lib/dataSource";
  import AnswerCard from "$lib/components/AnswerCard.svelte";
  import ApprovalCard from "$lib/components/ApprovalCard.svelte";
  import ClusterDot from "$lib/components/ClusterDot.svelte";
  import CommandBox from "$lib/components/CommandBox.svelte";
  import JobsPanel from "$lib/components/JobsPanel.svelte";
  import TechnicalDetails from "$lib/components/TechnicalDetails.svelte";
  import Tile from "$lib/components/Tile.svelte";
  import {
    BAD_TRANSCRIPT_DIAGNOSIS,
    bytes,
    clock,
    hasUsefulTranscript,
    isIdleRun,
    isTranscribing,
    type JsonRecord,
  } from "$lib/pipeline";
  import { formatWhen, nodeMeta, statusLabel, type JobView } from "$lib/jobs";
  import { mergeMacLocalHistory, pickHero } from "$lib/hiveFeed.js";
  import {
    pendingApprovals,
    runState,
    withBlockedReasons,
  } from "$lib/runState";

  let snapshot = $state<JsonRecord | null>(null);
  let liveRuns = $state<JsonRecord[]>([]);
  let jobs = $state<JobView[]>([]);
  /*
   * The owner's explicit pick from Recent, and ONLY that. It used to double as
   * the auto-default (set to runs[0] on every poll), which meant the hero was
   * pinned to the newest run before the "is this worth showing" rules ever ran
   * — so a parked run was rendered twice, once in its approval card and again
   * as the headline. The default now lives in `heroRun`.
   */
  let selectedId = $state("");
  let error = $state("");
  let refreshing = $state(false);
  let approvingId = $state("");
  let denyingId = $state("");
  let approvalError = $state("");
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
  let jobsRefreshPending = false;
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
      // Drop a pick that has aged out of BOTH feeds (pipeline runs and the
      // Mac-local jobs merged into Recent); never invent one.
      if (
        selectedId &&
        !nextRuns.some((run) => run.pipelineId === selectedId) &&
        !jobs.some((job) => job.id === selectedId)
      ) {
        selectedId = "";
      }
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
      if (
        selectedId &&
        nextRuns.length &&
        !nextRuns.some((run) => run.pipelineId === selectedId) &&
        !jobs.some((job) => job.id === selectedId)
      ) {
        selectedId = "";
      }
    } catch {
      // The slower full snapshot remains available if the direct feed blips.
    } finally {
      runsRefreshPending = false;
    }
  }

  /*
   * The job list is what knows a plan is still parked: a pipeline run records
   * that it asked for approval and never records the answer. Polled at page
   * level, not inside the Jobs panel, because "something needs you" has to be
   * on screen whether or not that panel is open.
   */
  async function refreshJobs() {
    if (jobsRefreshPending) return;
    jobsRefreshPending = true;
    try {
      jobs = (await fetchJobs()).data;
    } catch {
      // The approval card simply does not appear; nothing is invented.
    } finally {
      jobsRefreshPending = false;
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
        void refreshJobs();
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
    const initialJobs = window.setTimeout(refreshJobs, 0);
    const probe = window.setInterval(checkLatest, 5_000);
    const runsBackstop = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshRuns();
      void refreshJobs();
    }, 15_000);
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void checkLatest();
      void refreshRuns();
      void refreshJobs();
      void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(initialSnapshot);
      window.clearInterval(snapshotTimer);
      window.clearTimeout(initialRuns);
      window.clearTimeout(initialJobs);
      window.clearInterval(probe);
      window.clearInterval(runsBackstop);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  });

  const snapshotRuns = $derived<JsonRecord[]>(
    Array.isArray(snapshot?.pipeline) ? snapshot!.pipeline : [],
  );
  /* Pipeline runs ONLY. Kept separate from `feed` on purpose: the mic
   * diagnosis (`newestRun`/`latestBad`) reads voice runs, and a newer typed
   * HUD job must not mask a bad transcript. */
  const runs = $derived<JsonRecord[]>(
    liveRuns.length ? liveRuns : snapshotRuns,
  );

  /*
   * The hero/Recent candidate set: every hive node's work in one list.
   * Pipeline runs plus the owner's Mac-local jobs (the floating HUD and the
   * on-Mac composer), which run through the agent's own /plan+/execute and
   * never enter the pipeline — so the hero used to sit on a stale pendant run
   * while newer Mac answers piled up unseen. Same fold History uses
   * (mergeMacLocalHistory: owner sources only, deduped by id, newest first),
   * fed from the `jobs` poll this page already runs for the approval cards —
   * no second fetch. Bridge-executed relay work is stamped 'pendant' and is
   * excluded by the fold, so a relay run can never appear twice.
   */
  const feed = $derived<JsonRecord[]>(mergeMacLocalHistory(runs, jobs));

  /* Plans the agent prepared and will not run until the owner says so. */
  const approvals = $derived(withBlockedReasons(pendingApprovals(jobs), runs));
  /*
   * Urgency is a function of age, not just of state. A plan parked moments ago
   * is the page's one legitimate interruption; a plan the owner slept on (the
   * split lives in pendingApprovals — see STALE_APPROVAL_AFTER_MS) is an open
   * decision, and rendering it in the amber interruption suit forever is how
   * the owner learns to stop believing the amber. Fresh cards keep the shout;
   * stale ones drop to a quiet, dismiss-first row below them.
   */
  const freshApprovals = $derived(approvals.filter((entry) => !entry.stale));
  const staleApprovals = $derived(approvals.filter((entry) => entry.stale));
  const approvedCommands = $derived(
    new Set(approvals.map((entry) => entry.command.trim().toLowerCase())),
  );

  /*
   * The hero shows the newest entry — from ANY node — that has something to
   * say. A run that is parked AND already has its own approval card on screen
   * is skipped, so the owner's question is never printed twice on one page.
   * The skip rules live in `pickHero` (hiveFeed.js) so the node test suite
   * drives the exact code that decides; there is deliberately no fallback to
   * "show something anyway" — if every entry is empty or already accounted
   * for, the honest hero is the empty state.
   */
  const heroRun = $derived.by<JsonRecord | null>(() => {
    if (!feed.length) return null;
    if (selectedId) {
      const picked = feed.find((run) => run.pipelineId === selectedId);
      if (picked && !isIdleRun(picked)) return picked;
    }
    return pickHero(feed, runState, { approvedCommands });
  });

  const selected = $derived<any>(heroRun);
  const hero = $derived(runState(selected));
  const cloud = $derived<any>(snapshot?.cloud ?? {});
  const agent = $derived<any>(snapshot?.status?.agent ?? {});
  const telemetry = $derived<any>(
    selected?.events?.find(
      (candidate: JsonRecord) => candidate.stage === "transcription",
    )?.meta?.inputTelemetry ??
      selected?.events?.find(
        (candidate: JsonRecord) => candidate.meta?.inputTelemetry,
      )?.meta?.inputTelemetry ??
      null,
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

  /*
   * Audio for the hero. `audio.captureId` is the owner's voice and
   * `audio.replyCaptureId` the agent's; either can be absent (a typed command
   * has no recording, a text-only reply has no speech). Both stream through the
   * same server route, which keeps the relay key off the client.
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

  async function handleApprove(jobId: string) {
    approvingId = jobId;
    approvalError = "";
    try {
      await approvePlan(jobId);
    } catch (failure) {
      // The agent's own words, never a friendlier invention.
      approvalError =
        failure instanceof Error ? failure.message : String(failure);
    } finally {
      approvingId = "";
      await Promise.all([refreshJobs(), refreshRuns(), refresh()]);
      void jobsPanel?.refresh();
    }
  }

  /**
   * "No." Every job the card folded in is dismissed, so the decision the owner
   * just made does not come straight back wearing the next duplicate.
   */
  async function handleDeny(jobIds: string[]) {
    denyingId = jobIds[0] ?? "";
    approvalError = "";
    try {
      const outcome = await dismissPlan(jobIds);
      // A partial dismissal is said out loud rather than looking clean.
      if (outcome?.note) approvalError = outcome.note;
    } catch (failure) {
      approvalError =
        failure instanceof Error ? failure.message : String(failure);
    } finally {
      denyingId = "";
      await Promise.all([refreshJobs(), refreshRuns(), refresh()]);
      void jobsPanel?.refresh();
    }
  }

  function handleCommandQueued() {
    void refreshRuns();
    void refresh();
    void refreshJobs();
    void jobsPanel?.refresh();
  }

  /** Parked plans point here: open the Jobs panel and bring it on screen. */
  function showJobsPanel() {
    openTile = "jobs";
    window.setTimeout(() => {
      document
        .getElementById("tile-panel-jobs")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  function scrollToApproval() {
    document
      .getElementById("needs-you")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      <!-- The product icon, from assets/icon via scripts/sync-icons.mjs — this used to be a green letter "P" that matched nothing else the product wears. -->
      <img class="brand-mark" src="{base}/pendant-logo.png" alt="AI Pendant" title="AI Pendant Dashboard" />
      <h1>Dashboard</h1>
    </div>
    <div class="top-actions">
      <a
        class="hive-link"
        href="{base}/hive"
        title="Hive — fleet observability: runtime ring, design committee, event ticker"
        >⬡ Hive</a
      >
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

  <!-- 1 · WHAT NEEDS YOU. Above the answer, because it is the only thing on
       this page that cannot proceed without the owner. -->
  {#if approvals.length}
    <div id="needs-you" class="needs-you">
      {#if freshApprovals.length}
        <!-- A live region so "needs your approval" is announced when it appears,
             without stealing focus from whatever the owner is doing (WCAG 4.1.3).
             Only FRESH plans are announced: a stale park re-announced on every
             visit is an alarm that has learned to cry wolf. -->
        <div
          class="needs-you-fresh"
          role="status"
          aria-live="polite"
          aria-label={`${freshApprovals.length} ${freshApprovals.length === 1 ? "plan needs" : "plans need"} your approval`}
        >
          <!-- One banner, one decision: the newest in full, the rest as compact
               rows that still carry their own Approve button. -->
          {#each freshApprovals as approval, index (approval.jobId)}
            <ApprovalCard
              {approval}
              canApprove={canApprovePlan}
              compact={index > 0}
              busy={approvingId === approval.jobId}
              denying={denyingId === approval.jobId}
              error={approvingId === approval.jobId ? "" : approvalError}
              onApprove={handleApprove}
              onDeny={handleDeny}
              onSeePlan={showJobsPanel}
            />
          {/each}
        </div>
      {/if}
      {#if staleApprovals.length}
        <!-- Parked long enough that the moment has passed. Every one renders
             compact and quiet — never the full amber banner — with Dismiss in
             the lead slot. No live region: old news is not an announcement. -->
        <section
          class="needs-you-stale"
          aria-label={`${staleApprovals.length} older ${staleApprovals.length === 1 ? "plan is" : "plans are"} still parked`}
        >
          {#each staleApprovals as approval (approval.jobId)}
            <ApprovalCard
              {approval}
              canApprove={canApprovePlan}
              compact
              stale
              busy={approvingId === approval.jobId}
              denying={denyingId === approval.jobId}
              error={approvingId === approval.jobId ? "" : approvalError}
              onApprove={handleApprove}
              onDeny={handleDeny}
              onSeePlan={showJobsPanel}
            />
          {/each}
        </section>
      {/if}
    </div>
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

  <!-- 2 · WHAT IT SAID. -->
  <AnswerCard
    state={hero}
    source={String(selected?.source || "")}
    origin={String(selected?.origin || "")}
    ownAudio={heroOwnAudio}
    replyAudio={heroReplyAudio}
    onNeedsYou={approvals.length ? scrollToApproval : null}
  >
    {#snippet details()}
      <!-- A Mac-local job never had a voice pipeline; rendering the six-stage
           STT rail as permanent "waiting" would be fabricated telemetry, so
           the developer layer stays off for those. Their evidence (actions,
           outputs) already lives in the Jobs panel. -->
      {#if selected && selected.kind !== "mac_local"}
        <TechnicalDetails
          run={selected}
          {telemetry}
          open={hero.phase === "failed"}
        />
      {/if}
    {/snippet}
  </AnswerCard>

  <!-- 3 · ASK IT SOMETHING. One box for voice and text — the transport is
       chosen per submission and each submission's card says which path
       carried it (via this Mac / via relay). -->
  <section class="ask" aria-label="Ask the hive">
    <CommandBox onQueued={handleCommandQueued} onOpenJobs={showJobsPanel} />
  </section>

  <!-- 4 · WHAT IT DID — the merged hive feed, not pipeline runs alone, so a
       HUD or on-Mac composer task is as visible here as a pendant run. -->
  {#if feed.length}
    <section class="recent" aria-label="Recent commands">
      <p class="section-label">Recent</p>
      <ul class="recent-list">
        {#each feed.slice(0, 8) as run (run.pipelineId)}
          {@const state = runState(run)}
          <li>
            <button
              class="recent-row {run.pipelineId === selected?.pipelineId
                ? 'selected'
                : ''}"
              onclick={() => (selectedId = run.pipelineId)}
              aria-current={run.pipelineId === selected?.pipelineId
                ? "true"
                : undefined}
              aria-label={`${state.question || "Untitled run"} · ${state.label} · ${clock(run.createdAt)}`}
            >
              <span class="recent-text">
                {state.answer || state.question || "Untitled run"}
              </span>
              <span class="recent-meta">
                <i class="state-dot {state.tone}" aria-hidden="true"></i>
                {nodeMeta({ origin: run.origin, source: run.source }).label} · {state.label}
                · {formatWhen(run.createdAt)}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <!-- 5 · THE MACHINE. Everything below here is diagnostics by design. -->
  <p class="section-label section-label-standalone">System</p>
  <div class="tile-strip">
    <!-- Amber only for FRESH parks: the count still names every open decision,
         but a plan the owner slept on no longer keeps the tile in alarm. -->
    <Tile
      id="jobs"
      label="Jobs"
      tone={freshApprovals.length ? "warn" : "ok"}
      dotText="Everything the agent has been asked to do"
      value={approvals.length ? `${approvals.length} need you` : "What ran"}
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
      tone={historyEntries.length || feed.length ? "ok" : "off"}
      dotText="Messages, recordings, spoken replies"
      value={historyEntries.length
        ? `${historyEntries.length} runs`
        : feed.length
          ? `${feed.length} recent`
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
        <div><dt>Relay</dt><dd>{cloudUp ? "Online" : "Offline"}</dd></div>
        <div><dt>Queue</dt><dd>{storeLabel}</dd></div>
        <div>
          <dt>STT</dt><dd>{cloud.speechToTextConfigured
              ? cloud.models?.speechToText || "Workers AI ready"
              : "Off"}</dd>
        </div>
        <div>
          <dt>TTS</dt><dd>{cloud.models?.textToSpeech || "macOS say · 24 kHz"}</dd>
        </div>
        <div><dt>Bridge</dt><dd>{bridgeUp ? "Connected" : "Disconnected"}</dd></div>
        <div><dt>Agent</dt><dd>{agent.ok ? `v${agent.version}` : "Offline"}</dd></div>
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
        <div>
          <dt>Accessibility</dt><dd>{permissions.accessibility?.trusted ? "✓" : "—"}</dd>
        </div>
        <div>
          <dt>Screen</dt><dd>{permissions.screenRecording?.granted ? "✓" : "—"}</dd>
        </div>
        <div>
          <dt>Automation</dt><dd>{automationEntries.length
              ? `${grantedAutomation}/${automationEntries.length}`
              : "Not checked"}</dd>
        </div>
        <div><dt>Host</dt><dd>{agent.hostApp || "—"}</dd></div>
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
        <div>
          <dt>Devices</dt><dd>{String(browserExtension.connectedDevices ?? 0)}</dd>
        </div>
        <div>
          <dt>Queued</dt><dd>{String(browserExtension.pendingCommands ?? 0)}</dd>
        </div>
        <div><dt>Seen</dt><dd>{clock(browserExtension.lastSeenAt)}</dd></div>
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
                    >{nodeMeta({
                      origin: entry.origin,
                      source: entry.source,
                      kind: entry.kind,
                    }).label} · {statusLabel(entry.status)} · {clock(
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
            <span>{statusLabel(historyDetail.status)}</span>
          </div>
          {#if historyDetail.reply}
            <blockquote>{historyDetail.reply}</blockquote>
          {/if}
          <p class="history-detail-meta">
            {nodeMeta({
              origin: historyDetail.origin,
              source: historyDetail.source,
              kind: historyDetail.kind,
            }).label} ·
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
