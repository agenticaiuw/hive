/* eslint-disable @typescript-eslint/no-explicit-any -- Job records cross two backends and are schemaless at this display boundary. */

import { hiveNodeFor, humanizeKey, terminalPhaseFor } from "$lib/hiveFeed.js";

/* One definition, in the dependency-free module the node tests import. */
export { humanizeKey };

/**
 * One job shape for both backends.
 *
 * The Mac agent (`GET /jobs`) and the relay (`GET /v1/ops/history`) describe
 * the same work with different field names and different amounts of detail.
 * Normalising here is what lets a single set of components render either one —
 * the alternative, a branch per backend inside the view, is how the React and
 * SvelteKit dashboards drifted apart in the first place.
 */

export type JobActionView = {
  key: string;
  type: string;
  label: string;
  params: [string, string][];
  /** null means "planned but not run yet" — distinct from "ran and failed". */
  ok: boolean | null;
  failed: boolean;
  message: string;
  output: [string, string][];
};

export type JobView = {
  id: string;
  type: string;
  command: string;
  source: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  summary: string;
  error: string;
  ran: JobActionView[];
  planned: JobActionView[];
  cancellable: boolean;
  canUndo: boolean;
  /** Set only by the relay adapter: detail lives behind a second request. */
  detailHref: string | null;
};

export type RoutineView = {
  id: string;
  name: string;
  command: string;
  schedule: any;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: string | null;
  lastStatus: string;
  lastError: string;
  runCount: number;
};

const RUNNING_STATUSES = [
  "processing",
  "queued",
  "active",
  "thinking",
  "running",
  "transcribing",
];

/* Values that should never be read off a shared screen. */
const SENSITIVE_KEY =
  /token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|bearer|private[-_]?key/i;

export function isRunningStatus(status: unknown) {
  return RUNNING_STATUSES.includes(String(status));
}

/**
 * The node that answered a job, in plain words, from its `source` alone.
 *
 * Every per-node label on the page comes from one classifier (`hiveNodeFor`)
 * so the Jobs panel, the answer card, and the history feed can never disagree
 * about what "This Mac" or "Pendant" means. `nodeMeta` is the same classifier
 * when more than the source is known (a history entry's `origin` is the
 * stronger signal — the relay stamps every run it saw with `source:
 * "cloudflare"`, so source alone would call a pendant run "Cloud").
 */
export function sourceMeta(source: unknown) {
  const { label, hint } = hiveNodeFor({ source });
  return { label, hint };
}

export function nodeMeta(record: {
  origin?: unknown;
  source?: unknown;
  kind?: unknown;
  executor?: unknown;
}) {
  const { label, hint } = hiveNodeFor(record);
  return { label, hint };
}

/**
 * Statuses that mean "this has stopped and is waiting on the owner".
 *
 * `plan_ready` is the agent's word for a job it prepared and did not run;
 * `needs_approval` is the pipeline run's equivalent. Neither is a word anyone
 * says out loud, and neither may reach the screen (heuristic 2).
 */
const AWAITING_STATUSES = ["plan_ready", "needs_approval", "awaiting_approval"];

export function isAwaitingApproval(status: unknown) {
  return AWAITING_STATUSES.includes(String(status));
}

export function statusLabel(status: unknown) {
  const value = String(status || "");
  if (!value) return "Unknown";
  if (isAwaitingApproval(value)) return "Needs your approval";
  if (value === "processing") return "Running";
  if (value === "queued") return "Queued";
  if (value === "completed") return "Done";
  if (value === "failed") return "Failed";
  if (value === "transcribing") return "Transcribing";
  /*
   * The goal-grounded terminal words — jobTracker's 'incomplete'/'cancelled'
   * and browserTaskHistory's read_only/handed_off/finished/recorded — come
   * from the one table the hero also renders (`terminalPhaseFor`), so a run
   * the feed calls "Incomplete" can never headline as anything else, and a
   * run that finished without doing the thing is never worded "Done".
   */
  const terminal = terminalPhaseFor(value);
  if (terminal) return terminal.label;
  return humanizeKey(value);
}

/** Collapses every status onto the four tones the stylesheet knows. */
export function statusTone(status: unknown): "ok" | "run" | "warn" | "off" {
  const value = String(status || "");
  if (isAwaitingApproval(value)) return "warn";
  if (isRunningStatus(value)) return "run";
  if (value === "failed") return "warn";
  // 'incomplete'/'cancelled' ended without meeting their goal — attention,
  // never the "ok" of Done; read_only / handed_off / finished / recorded are
  // terminal-but-not-Done and stay neutral. Same table the hero renders.
  const terminal = terminalPhaseFor(value);
  if (terminal) return terminal.tone === "attention" ? "warn" : "off";
  // Only a genuine success is "ok".
  if (value === "completed") return "ok";
  return "off";
}

export function truncate(text: unknown, max: number) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function redactInline(text: unknown) {
  return String(text).replace(
    /\b(bearer|token|secret|password|api[-_]?key)([=:"'\s]+)(\S{6,})/gi,
    (_match, label, separator) => `${label}${separator}•••••••`,
  );
}

/** Params stay visible; only the values that are credentials get hidden. */
export function redactParams(params: unknown): [string, string][] {
  if (!params || typeof params !== "object") return [];
  return Object.entries(params as Record<string, unknown>).map(
    ([key, value]) => {
      if (SENSITIVE_KEY.test(key)) return [key, "••••••• hidden"];
      if (value == null) return [key, "—"];
      if (typeof value === "object") {
        return [key, redactInline(JSON.stringify(value))];
      }
      return [key, redactInline(value)];
    },
  );
}

export function formatWhen(value: unknown) {
  if (!value) return "";
  const timestamp =
    typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return "";
  const deltaMs = Date.now() - timestamp;
  if (deltaMs >= 0 && deltaMs < 60_000) return "just now";
  if (deltaMs >= 0 && deltaMs < 3_600_000) {
    return `${Math.floor(deltaMs / 60_000)}m ago`;
  }
  const date = new Date(timestamp);
  const sameDay = new Date().toDateString() === date.toDateString();
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
  }).format(date);
}

export function formatDuration(value: unknown) {
  const ms = Number(value || 0);
  if (!ms || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function elapsedBetween(start: unknown, end: unknown) {
  const from = Date.parse(String(start || ""));
  const to = Date.parse(String(end || ""));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, to - from);
}

export function describeSchedule(schedule: any) {
  if (schedule?.kind === "daily") {
    return `Every day at ${schedule.at || "08:00"}`;
  }
  if (schedule?.kind === "interval") {
    return `Every ${formatDuration(Number(schedule.everyMs) || 0)}`;
  }
  return "No schedule";
}

/* What the run actually reached for, read back off the recorded actions. */
export function summarizeTouches(entries: JobActionView[]) {
  const apps = new Set<string>();
  const urls = new Set<string>();
  let shell = 0;
  let browser = 0;

  for (const entry of entries) {
    for (const [key, value] of entry.params) {
      if (key === "appName") apps.add(value);
      if (key === "url") urls.add(value);
    }
    if (entry.type === "run_shell" || entry.type === "run_applescript") {
      shell += 1;
    }
    if (entry.type.startsWith("browser_")) browser += 1;
  }

  return [
    apps.size ? `Apps · ${[...apps].join(", ")}` : null,
    urls.size ? `Web · ${[...urls].slice(0, 3).join(", ")}` : null,
    shell ? `Shell/AppleScript · ${shell}` : null,
    browser ? `Browser control · ${browser}` : null,
  ].filter(Boolean) as string[];
}

function actionView(entry: any, index: number): JobActionView {
  const action = entry?.action || entry || {};
  const failed = entry?.ok === false || entry?.status === "failed";
  const output: [string, string][] = [];
  if (entry?.stdout) output.push(["stdout", String(entry.stdout)]);
  if (entry?.stderr) output.push(["stderr", String(entry.stderr)]);

  return {
    key: `${action.type || "action"}-${index}`,
    type: String(action.type || "action"),
    label: String(action.label || action.description || action.type || "Action"),
    params: redactParams(action.params),
    ok: entry?.ok === undefined ? null : Boolean(entry.ok),
    failed,
    message: String(entry?.message || entry?.error || ""),
    output,
  };
}

/** The Mac agent's `GET /jobs` rows — the richest source, with real evidence. */
export function jobFromAgent(raw: any): JobView {
  const result = raw?.result && typeof raw.result === "object" ? raw.result : null;
  const ran = Array.isArray(result?.results) ? result.results : [];
  const planned = Array.isArray(result?.actions)
    ? result.actions
    : Array.isArray(raw?.actions)
      ? raw.actions
      : [];

  return {
    id: String(raw?.jobId || raw?.id || ""),
    type: String(raw?.type || "execute"),
    command: String(raw?.command || ""),
    source: String(raw?.source || "unknown"),
    status: String(raw?.status || ""),
    createdAt: raw?.createdAt ?? null,
    updatedAt: raw?.updatedAt ?? null,
    summary: String(result?.response || result?.summary || ""),
    error: String(raw?.error || ""),
    ran: ran.map(actionView),
    planned: planned.map(actionView),
    cancellable: Boolean(raw?.cancellable),
    canUndo: Boolean(raw?.undo?.canUndo),
    detailHref: null,
  };
}

/**
 * A relay history entry. Deliberately thinner than the agent shape: the relay
 * only ever saw the work that was routed *through* it, and its list endpoint
 * carries counts rather than the actions themselves. `detailHref` is where the
 * rest lives.
 */
export function jobFromRelayHistory(entry: any): JobView {
  const status = String(entry?.jobStatus || entry?.status || "");
  return {
    id: String(entry?.pipelineId || ""),
    type: "execute",
    command: String(entry?.command || ""),
    source: String(entry?.origin || entry?.source || "cloudflare"),
    status,
    createdAt: entry?.createdAt ?? null,
    updatedAt: entry?.updatedAt ?? null,
    summary: String(entry?.reply || ""),
    error: String(entry?.error || ""),
    ran: [],
    planned: [],
    cancellable: false,
    canUndo: false,
    detailHref: entry?.pipelineId
      ? `/api/history/${encodeURIComponent(String(entry.pipelineId))}`
      : null,
  };
}

/** Merge a lazily fetched relay run detail into the list-shaped job. */
export function withRelayDetail(job: JobView, run: any): JobView {
  const execution =
    run?.execution && typeof run.execution === "object" ? run.execution : null;
  const results = Array.isArray(execution?.results) ? execution.results : [];
  const actions = Array.isArray(run?.actions) ? run.actions : [];

  return {
    ...job,
    summary: String(execution?.response || execution?.summary || job.summary),
    error: String(run?.error || job.error),
    ran: results.map(actionView),
    planned: actions.map(actionView),
  };
}

export function routineFromAgent(raw: any): RoutineView {
  return {
    id: String(raw?.id || ""),
    name: String(raw?.name || raw?.command || "Routine"),
    command: String(raw?.command || ""),
    schedule: raw?.schedule ?? null,
    enabled: Boolean(raw?.enabled),
    nextRunAt: Number(raw?.nextRunAt) || null,
    lastRunAt: raw?.lastRunAt ?? null,
    lastStatus: String(raw?.lastStatus || ""),
    lastError: String(raw?.lastError || ""),
    runCount: Number(raw?.runCount || 0),
  };
}
