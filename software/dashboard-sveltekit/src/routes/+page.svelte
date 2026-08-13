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
   *      did → the Work feed. Diagnostics never occupy that space again — and
   *      the System tile row that once closed the page is deleted outright
   *      (owner, 2026-08-12: "i told you to delete these 4 tabs in the
   *      system do that please").
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
    fetchJobs,
    fetchLatestRun,
    fetchRuns,
    fetchSnapshot,
  } from "$lib/dataSource";
  import AnswerCard from "$lib/components/AnswerCard.svelte";
  import ApprovalCard from "$lib/components/ApprovalCard.svelte";
  import ClusterDot from "$lib/components/ClusterDot.svelte";
  import CommandBox from "$lib/components/CommandBox.svelte";
  import JobsPanel from "$lib/components/JobsPanel.svelte";
  import TechnicalDetails from "$lib/components/TechnicalDetails.svelte";
  import {
    BAD_TRANSCRIPT_DIAGNOSIS,
    clock,
    hasUsefulTranscript,
    isIdleRun,
    isTranscribing,
    type JsonRecord,
  } from "$lib/pipeline";
  import { formatWhen, type JobView } from "$lib/jobs";
  import {
    deviceTagsFor,
    isAgentInitiated,
    mergeHiveFeed,
    pickHero,
    repeatSummary,
} from "$lib/hiveFeed.js";
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
  /*
   * The Work panel answers "what is running and what did it just do", which is
   * the question this page exists for, so it is ALWAYS on screen — there is no
   * tile to toggle it. The whole System tile row (Work/System/Mac/Browser) is
   * deleted, not hidden: the owner, 2026-08-12 — "i told you to delete these
   * 4 tabs in the system do that please" — after the earlier consolidation
   * ("jobs, memory, and history are literally the same thing … repeated 4
   * times") had already cut six tiles to four. Everything load-bearing the
   * tiles carried already lives elsewhere: relay/bridge/mic/browser health in
   * the topbar dot cluster, missing Mac permissions in the alert strip, the
   * needs-you count in the approval banner and the feed's "Needs you" group,
   * per-node health on the Hive ring page.
   */
  let jobsPanel = $state<{ refresh: () => Promise<void> } | null>(null);

  // Re-entrancy guards and the freshness key stay plain bindings on purpose:
  // as reactive state they would retrigger the effects that read them.
  let snapshotRefreshPending = false;
  let runsRefreshPending = false;
  let jobsRefreshPending = false;
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
      }
    } catch {
      // Freshness probe is best-effort; the timed refreshes still run.
    }
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
   * THE feed: every hive node's work in one device-tagged list. Pipeline runs
   * plus the whole job feed (HUD, on-Mac composer, browser runs, probes,
   * routines), deduped by id — the owner's 2026-08-12 ruling: "'recent' shows
   * cloud work only, which should be changed … the device(s) should be the
   * main tags." Fed from the `jobs` poll this page already runs for the
   * approval cards — no second fetch. Bridge-executed relay work is stamped
   * 'pendant' and is excluded by the fold, so a relay run can never appear
   * twice under two ids.
   */
  const feed = $derived<JsonRecord[]>(mergeHiveFeed(runs, jobs));

  /*
   * Hero candidates only: agent-initiated rows (probes, routines) stay out of
   * the headline slot. They belong in the feed — the owner can see and filter
   * them — but a probe's log must never occupy the answer card, which DESIGN.md
   * reserves for the page's main feature: the owner's own latest answer.
   */
  const ownerFeed = $derived<JsonRecord[]>(
    feed.filter((entry) => !isAgentInitiated(entry)),
  );

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
      // An explicit Recent pick may be ANY row, agent-initiated included.
      const picked = feed.find((run) => run.pipelineId === selectedId);
      if (picked && !isIdleRun(picked)) return picked;
    }
    return pickHero(ownerFeed, runState, { approvedCommands });
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
  const requiredMissing = $derived<string[]>(
    Array.isArray(permissions.requiredMissing) ? permissions.requiredMissing : [],
  );
  const cloudUp = $derived(Boolean(cloud.ok));
  const bridgeUp = $derived(Boolean(cloud.macBridgeOnline));
  const browserUp = $derived(Boolean(browserExtension.online));

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

  /** Parked plans point here: bring the always-on Work feed on screen. */
  function showJobsPanel() {
    document
      .getElementById("tile-panel-jobs")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function scrollToApproval() {
    document
      .getElementById("needs-you")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
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

  <!-- 1 · ASK IT SOMETHING. One box for voice and text — the transport is
       chosen per submission and each submission's card says which path carried
       it (via this Mac / via relay).

       It used to sit BELOW the answer card, which is where DESIGN.md says it
       must not be: "the main feature of any page should always occupy the most
       visual field", and "are the most common user actions accessible on the
       first level". Asking is the action the owner takes most; the answer card
       above it is a variable-height block that, on a long answer at 375px,
       pushed the composer off the screen entirely — so the one control the page
       exists for could only be found by scrolling past the last reply. One row
       at the top costs the answer card almost nothing and costs the ask
       nothing. -->
  <section class="ask" aria-label="Ask the hive">
    <CommandBox onQueued={handleCommandQueued} onOpenJobs={showJobsPanel} />
  </section>

  <!-- 2 · WHAT NEEDS YOU. Still above the answer, because it is the only thing
       on this page that cannot proceed without the owner — and still within a
       screen of the top, since the composer above it is a single row. -->
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

  <!-- 3 · WHAT IT SAID. -->
  <AnswerCard
    state={hero}
    run={selected}
    ownAudio={heroOwnAudio}
    replyAudio={heroReplyAudio}
    onNeedsYou={approvals.length ? scrollToApproval : null}
  >
    {#snippet details()}
      <!-- A job-feed row (kind "job") never had a voice pipeline; rendering
           the six-stage STT rail as permanent "waiting" would be fabricated
           telemetry, so the developer layer stays off for those. Their
           evidence (actions, outputs) already lives in the Work panel. -->
      {#if selected && selected.kind !== "job"}
        <TechnicalDetails
          run={selected}
          {telemetry}
          open={hero.phase === "failed"}
        />
      {/if}
    {/snippet}
  </AnswerCard>

  <!-- 4 · WHAT IT DID — the one hive feed across EVERY node, each row wearing
       its device tag(s). It used to render relay-witnessed runs plus Mac-local
       folds only, with the issuing device dropped by the /api/runs sanitizer —
       the owner: "'recent' shows cloud work only, which should be changed." -->
  {#if feed.length}
    <section class="recent" aria-label="Recent commands">
      <p class="section-label">Recent</p>
      <ul class="recent-list">
        {#each feed.slice(0, 8) as run (run.pipelineId)}
          {@const state = runState(run)}
          {@const tags = deviceTagsFor(run)
            .map((tag) => tag.label)
            .join(" · ")}
          <!-- Empty for every row the relay did not fold, so a row with
               nothing to repeat gains no text. -->
          {@const repeats = repeatSummary(run)}
          <li>
            <button
              class="recent-row {run.pipelineId === selected?.pipelineId
                ? 'selected'
                : ''}"
              onclick={() => (selectedId = run.pipelineId)}
              aria-current={run.pipelineId === selected?.pipelineId
                ? "true"
                : undefined}
              aria-label={`${state.question || "Untitled run"} · ${tags} · ${state.label}${repeats ? ` ${repeats}` : ""} · ${clock(run.createdAt)}`}
            >
              <span class="recent-text">
                {state.answer || state.question || "Untitled run"}
              </span>
              <span class="recent-meta">
                <i class="state-dot {state.tone}" aria-hidden="true"></i>
                {tags} · {state.label}{repeats ? ` ${repeats}` : ""}
                · {formatWhen(run.createdAt)}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <!-- 5 · THE WORK FEED, always on. The System tile row that used to sit here
       (Work/System/Mac/Browser and their detail panels) is deleted, not
       hidden — the owner, 2026-08-12: "i told you to delete these 4 tabs in
       the system do that please." Nothing load-bearing left with it: the
       topbar dot cluster carries relay/bridge/mic/browser health, the alert
       strip names missing Mac permissions, the needs-you count lives in the
       approval banner and this feed's "Needs you" group, and per-node health
       is the Hive ring page. -->
  <JobsPanel bind:this={jobsPanel} />

</main>
