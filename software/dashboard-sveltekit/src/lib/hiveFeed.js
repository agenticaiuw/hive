/**
 * The hive feed: one list, every node named in plain words.
 *
 * "The tasks answered by any agent living in any node should be recorded to the
 * dashboard or else it shouldn't be called the hive." Two things stood between
 * that and the screen:
 *
 *  1. The feed never named the node. A pendant run and a dashboard-relay run
 *     both carry `source: "cloudflare"` (the relay is the body that witnessed
 *     them), so the old badge said "Cloud" for everything the relay saw and
 *     "Dashboard" for everything typed — the physical node that answered was
 *     invisible. `hiveNodeFor` reads the strongest signal a record carries
 *     (origin first, source second, plus the browser/executor markers) and
 *     returns the node the owner would name.
 *
 *  2. Mac-LOCAL answered tasks never reached the feed at all. The floating HUD
 *     (`source: "floating-hud"`) and the on-Mac dashboard composer
 *     (`source: "dashboard"`) run straight through the agent's own
 *     `/plan`+`/execute`, which record them in jobTracker (`GET /jobs`) but
 *     never touch the relay — so `/v1/ops/history` (the shared record the
 *     dashboard reads) never saw them, exactly like browser tasks before #47.
 *     `macLocalHistoryEntries` folds that jobTracker view into the same history
 *     shape so the two lists become one, without a second store: the data is
 *     already in jobTracker, this only surfaces it.
 *
 * DEDUPE IS STRUCTURAL, NOT HEURISTIC. Work the Mac ran on behalf of the relay
 * (pendant, iPhone, relay-typed dashboard) is executed by the bridge, which
 * stamps `source: "pendant"` on those local /plan+/execute calls — never
 * "floating-hud" or "dashboard". So the Mac-local sources this module folds in
 * are disjoint by construction from everything already in relay history; there
 * is no same-run double count to guess about. jobTracker ids (`local_…`) also
 * never collide with relay pipeline ids (`job_…`, `btask_…`).
 *
 * SCOPE-OUT. Development/orchestration work the agent starts for itself (recon,
 * harness, probes, measurement, tests, routines) is not a hive node answering
 * an owner task, so it is not folded into the owner feed — but it keeps an
 * honest label wherever it already shows (the Jobs panel), never a node word.
 *
 * Dependency-free on purpose (no $app, no fetch), so the node test suite can
 * import the exact code the components run — the same rule as transportRule.js.
 */

/** @typedef {{ key: string, label: string, hint: string }} HiveNode */

/** @param {unknown} value */
const norm = (value) => String(value ?? "").trim().toLowerCase();

/* Pendant transports. `inputTelemetry.storage` is one of the first three;
 * `microSD` normalises to `microsd`. `pendant`/`nrf9160` are the source names
 * the bridge and mesh use for the same device. */
const PENDANT = new Set([
  "live_lte",
  "microsd",
  "pendant_upload",
  "pendant",
  "nrf9160",
]);

/* The iPhone app. Today its typed commands ride the shared dashboard relay
 * path and arrive as origin `dashboard`, so they read as "Dashboard" rather
 * than "iPhone" until the iOS shell stamps one of these — see the module's
 * companion follow-up. Mapped now so the label is ready the moment it does. */
const IPHONE = new Set(["mobile", "ios", "iphone"]);

/* Work that physically happened on this Mac and never left it: the floating
 * HUD, a direct local API caller, and the mac-bridge's own label. `dashboard`
 * and `local` are handled separately below because they are only "This Mac"
 * when they arrive with no relay origin (i.e. as a jobTracker job). */
const MAC_LOCAL = new Set(["floating-hud", "mac-local", "mac-bridge"]);

const CLOUD = new Set(["cloudflare", "cloud", "cloud-relay"]);

/* Not hive nodes: work the system runs on itself. Kept honest, never a node
 * word, and excluded from the owner feed fold. */
/** @type {Record<string, HiveNode>} */
const DEV = {
  routine: { key: "routine", label: "Routine", hint: "Fired on a schedule, not by you" },
  recon: { key: "recon", label: "Recon", hint: "The agent started this on its own" },
  "harness-task": { key: "harness-task", label: "Harness", hint: "Automated harness run" },
  "mac-planner": { key: "mac-planner", label: "Planner", hint: "Planned on this Mac" },
  measure: { key: "measure", label: "Measure", hint: "Benchmark / measurement run" },
  probe: { key: "probe", label: "Probe", hint: "Health probe" },
  "user-test": { key: "user-test", label: "Manual", hint: "Hand-run test from the owner" },
  test: { key: "test", label: "Test", hint: "Automated test run" },
};

const NODE = {
  pendant: { key: "pendant", label: "Pendant", hint: "Asked from the pendant" },
  iphone: { key: "iphone", label: "iPhone", hint: "Sent from the iPhone app" },
  browser: {
    key: "browser",
    label: "Browser",
    hint: "Run by the browser extension in the page it was on",
  },
  mac: {
    key: "mac",
    label: "This Mac",
    hint: "Answered on this Mac — the floating HUD or the dashboard composer",
  },
  dashboard: {
    key: "dashboard",
    label: "Dashboard",
    hint: "Typed into a dashboard and routed to the Mac through the relay",
  },
  cloud: {
    key: "cloud",
    label: "Cloud",
    hint: "Answered by the cloud relay (no Mac action)",
  },
};

/**
 * Title-case an unrecognised key so it is at least readable, never a lie.
 * @param {unknown} key
 */
export function humanizeKey(key) {
  return String(key ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

/**
 * The node that answered one record, in plain words.
 *
 * `origin` wins over `source` because `source` is the witnessing body (the
 * relay stamps "cloudflare" on everything it saw) while `origin` /
 * `inputTelemetry.storage` is where the owner actually issued it. Browser and
 * dev markers are checked first because they are unambiguous.
 *
 * @param {{ origin?: unknown, source?: unknown, kind?: unknown,
 *   executor?: unknown, executedBy?: unknown, inputMode?: unknown }} record
 * @returns {HiveNode}
 */
export function hiveNodeFor(record = {}) {
  const origin = norm(record.origin);
  const source = norm(record.source);
  const kind = norm(record.kind);
  const executor = norm(record.executor);

  if (
    kind === "browser_task" ||
    executor === "browser" ||
    origin === "browser-extension" ||
    origin.includes("browser") ||
    source.includes("browser")
  ) {
    return NODE.browser;
  }
  if (PENDANT.has(origin) || PENDANT.has(source)) return NODE.pendant;
  if (IPHONE.has(origin) || IPHONE.has(source)) return NODE.iphone;
  if (MAC_LOCAL.has(origin) || MAC_LOCAL.has(source)) return NODE.mac;

  /*
   * `dashboard`/`local` mean "This Mac" only as a jobTracker source (no relay
   * origin): the on-Mac composer and direct local callers. The same word as a
   * relay history ORIGIN is a dashboard on some other device, routed through
   * the relay — a different node, named honestly rather than claimed as local.
   */
  if (!origin && (source === "dashboard" || source === "local")) return NODE.mac;
  if (origin === "dashboard" || origin === "local") return NODE.dashboard;

  if (CLOUD.has(origin) || CLOUD.has(source)) return NODE.cloud;

  const devKey = DEV[source] ? source : DEV[origin] ? origin : "";
  if (devKey) return DEV[devKey];

  const key = source || origin || "unknown";
  return {
    key,
    label: key === "unknown" ? "Unknown" : humanizeKey(key),
    hint: "Origin not recorded",
  };
}

/* -------------------------------------------------------- Mac-local fold-in */

/*
 * jobTracker sources the owner's own on-Mac work carries. These are exactly the
 * sources the relay never sees (the bridge stamps relay work "pendant"), so
 * folding them into relay history adds the missing rows and duplicates nothing.
 */
const MAC_LOCAL_OWNER_SOURCES = new Set([
  "floating-hud",
  "dashboard",
  "mac-local",
  "local",
]);

/**
 * True for a jobTracker job that is the owner's own answered on-Mac task.
 *
 * `detailHref` must be absent: it is set only by `jobFromRelayHistory` (the
 * `/api/jobs` fallback the Worker serves when the Mac is asleep), whose rows
 * are relay history — and a relay-typed dashboard command arrives there with
 * `source: "dashboard"`, the very word on-Mac composer work also carries. The
 * guard keeps the fold to rows that genuinely came from the Mac agent
 * (`jobFromAgent`, which never sets `detailHref`), so relay history is never
 * relabelled "This Mac".
 *
 * @param {any} job
 */
export function isMacLocalOwnerJob(job) {
  if (job?.detailHref) return false;
  return MAC_LOCAL_OWNER_SOURCES.has(norm(job?.source));
}

/**
 * One jobTracker job as a history entry, in the exact shape the history feed
 * already renders. Status is passed through untouched — jobTracker already
 * keeps the goal-grounded verdict ('incomplete' stays 'incomplete', a parked
 * plan stays 'plan_ready'), and the feed's own statusLabel is what turns those
 * into honest words. Nothing here can promote a partial run to "Done".
 *
 * @param {any} [job]
 */
export function jobToHistoryEntry(job = {}) {
  const id = String(job.id || job.jobId || "");
  return {
    pipelineId: id,
    kind: "mac_local",
    command: String(job.command || ""),
    /* Left empty so hiveNodeFor reads the jobTracker `source` and returns
     * "This Mac"; a non-empty origin would be read as a relay origin. */
    origin: "",
    source: String(job.source || "local"),
    inputMode: "typed",
    status: String(job.status || ""),
    jobStatus: String(job.status || ""),
    reply: String(job.summary || ""),
    error: String(job.error || ""),
    durationMs: null,
    audio: { available: false, replyAvailable: false },
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
    detailHref: null,
  };
}

/** @param {any} entry */
const timeOf = (entry) =>
  Date.parse(String(entry?.createdAt || entry?.updatedAt || 0)) || 0;

/* --------------------------------------------- honest terminal verdicts */

/**
 * @typedef {{ phase: "incomplete" | "no-result",
 *   label: string, tone: "attention" | "idle" }} TerminalPhase
 */

/*
 * Job-vocabulary terminal statuses that must never present as "Answered".
 *
 * jobTracker's goal-grounded verdict ('incomplete': every planned step ran and
 * the goal still was not met) and browserTaskHistory's terminal-but-not-Done
 * words all arrive with an honest summary attached — and a summary is exactly
 * what the hero's answered branch keys on, so without this table a goal-not-met
 * run whose summary reads "Moved 3 files; 2 could not be sorted." would
 * headline as Answered. One table, consumed by BOTH renderers: the hero's
 * `runState` and the feed's `statusLabel`/`statusTone` (jobs.ts) read it, so
 * the two surfaces cannot drift about what 'incomplete' means.
 *
 * 'completed' is deliberately absent (a genuine success IS the answered path),
 * and so are 'failed' and the running/parked words — each has an honest branch
 * of its own already.
 */
/** @type {Record<string, TerminalPhase>} */
const TERMINAL_PHASES = {
  /* Ended without the goal being met, or stopped short — the owner should
   * look, so these carry the attention tone and never the "ok" of Done. */
  incomplete: { phase: "incomplete", label: "Incomplete", tone: "attention" },
  cancelled: { phase: "incomplete", label: "Cancelled", tone: "attention" },
  /* Terminal-but-not-Done: ended honestly with nothing to celebrate or fix,
   * so they stay neutral. Same grouping as browserTaskHistory's mapping. */
  read_only: { phase: "no-result", label: "Read only", tone: "idle" },
  handed_off: { phase: "no-result", label: "Handed off", tone: "idle" },
  finished: { phase: "no-result", label: "Finished", tone: "idle" },
  recorded: { phase: "no-result", label: "Recorded", tone: "idle" },
};

/**
 * The honest presentation for a goal-grounded terminal status, or null when
 * the status is not one (completed / failed / running / parked all keep their
 * own branches in `runState`).
 * @param {unknown} status
 * @returns {TerminalPhase | null}
 */
export function terminalPhaseFor(status) {
  return TERMINAL_PHASES[norm(status)] ?? null;
}

/**
 * Fold the owner's Mac-local jobs into a page of relay history: one list,
 * deduped by id, newest first. `base` (the relay/agent history) is trusted as
 * the record of record; a Mac-local job whose id already appears is dropped
 * rather than shown twice.
 *
 * @param {any[]} base history entries already fetched
 * @param {any[]} jobs jobTracker jobs (JobView shape: id, source, …)
 * @returns {any[]}
 */
export function mergeMacLocalHistory(base = [], jobs = []) {
  const seen = new Set(
    (Array.isArray(base) ? base : [])
      .map((entry) => String(entry?.pipelineId || ""))
      .filter(Boolean),
  );
  const folded = (Array.isArray(jobs) ? jobs : [])
    .filter(isMacLocalOwnerJob)
    .map(jobToHistoryEntry)
    .filter((entry) => entry.pipelineId && !seen.has(entry.pipelineId));

  return [...(Array.isArray(base) ? base : []), ...folded].sort(
    (left, right) => timeOf(right) - timeOf(left),
  );
}

/* ---------------------------------------------------------------- the hero */

/**
 * The newest entry worth headlining, from an already-merged newest-first feed
 * (`mergeMacLocalHistory` output: pipeline runs plus the owner's Mac-local
 * jobs). This is what makes the newest answered task from ANY node eligible to
 * be the hero — before it, the hero read pipeline runs only, so a stale
 * pendant answer outlived a screenful of newer HUD work.
 *
 * The two skip rules are the page's own, moved here so the node test suite
 * drives the exact code the hero runs:
 *  - "nothing-yet" has nothing to say;
 *  - a parked run whose command already has its approval card on screen would
 *    print the owner's question twice.
 * No fallback to "show something anyway": if every entry is empty or already
 * accounted for, the honest hero is the empty state, so this returns null.
 *
 * `stateFor` is the page's `runState`, passed in so this module stays
 * dependency-free; the tests hand it the same `terminalPhaseFor`-first
 * precedence that `runState` applies.
 *
 * @param {any[]} entries newest-first merged feed
 * @param {(entry: any) => { phase: string, question?: string }} stateFor
 * @param {{ approvedCommands?: Set<string> }} [options]
 * @returns {any | null}
 */
export function pickHero(entries, stateFor, { approvedCommands } = {}) {
  const carded = approvedCommands ?? new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const state = stateFor(entry) ?? { phase: "" };
    if (state.phase === "nothing-yet") continue;
    if (
      state.phase === "needs-approval" &&
      carded.has(String(state.question || "").trim().toLowerCase())
    ) {
      continue;
    }
    return entry;
  }
  return null;
}
