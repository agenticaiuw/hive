/* eslint-disable @typescript-eslint/no-explicit-any -- Plan/execute/job payloads are schemaless at this boundary; the views below bound them. */

/**
 * "Ask the hive" — one command box, two transports.
 *
 * LOCAL: on the agent build the page's own origin IS the Mac agent
 * (http://127.0.0.1:8000/dashboard), so a command goes straight to the agent's
 * `POST /plan` / `POST /execute` with the loopback session cookie — the same
 * decision the /hive page makes when it finds the local aggregator answering.
 *
 * VIA RELAY: everywhere else (the deployed Worker, the iOS shell, the menu-bar
 * WebView loading the deployed site) the browser has no route to the Mac at
 * all, so the command goes through this app's own `/api/command` server routes,
 * which create a `/v1/mac/plan` job with the server-held relay key and poll
 * `/v1/mac/jobs/:jobId` for it. The relay key never reaches the browser.
 *
 * The two transports converge on one normalized shape (`CommandResultView`),
 * so the box renders both identically — only the badge says which path ran it.
 */
import { agentRequest, backend } from "$lib/dataSource";

export type CommandTransport = "local" | "relay";

/** Decided by which host serves the page, exactly like `$lib/dataSource`. */
export const commandTransport: CommandTransport =
  backend === "agent" ? "local" : "relay";

/** Matches the relay route's cap; enforced client-side for an instant hint. */
export const MAX_COMMAND_LENGTH = 2000;

/** Same conversation id the voice/text composer uses, so one browser is one
 * conversation no matter which box the owner typed into. */
export const SESSION_STORAGE_KEY = "ai-pendant-dashboard-conversation-id";
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;

export function conversationSessionId(): string {
  let stored = "";
  try {
    stored = localStorage.getItem(SESSION_STORAGE_KEY) || "";
  } catch {
    // Private browsing; fall through to a fresh in-memory id.
  }
  const sessionId = SESSION_ID_PATTERN.test(stored)
    ? stored
    : crypto.randomUUID();
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch {
    // See above.
  }
  return sessionId;
}

/* ------------------------------------------------------------------ views */

export type CommandActionRow = {
  key: string;
  type: string;
  label: string;
  /** null = planned but not run; true/false = ran and succeeded/failed. */
  ok: boolean | null;
  message: string;
};

export type ParkedInfo = {
  /** The agent's own sentence for why this is waiting, verbatim. */
  note: string;
  /** Blocked/confirm-first actions with the agent's reasons, verbatim. */
  blocked: { type: string; reason: string }[];
};

export type CommandResultView = {
  /** The reply the agent would speak, verbatim. */
  text: string;
  /** Compact evidence list: ran actions when there are receipts, else the plan. */
  actions: CommandActionRow[];
  /** True when the listed actions actually ran (receipts), false when planned. */
  ran: boolean;
};

function actionRow(entry: any, index: number): CommandActionRow {
  const action =
    entry && typeof entry === "object" && entry.action ? entry.action : entry;
  return {
    key: `${action?.type || "action"}-${index}`,
    type: String(action?.type || "action"),
    label: String(
      action?.label || action?.description || action?.type || "Action",
    ),
    ok: entry?.ok === undefined || entry?.ok === null ? null : Boolean(entry.ok),
    message: String(entry?.message || entry?.error || ""),
  };
}

function resultView(payload: any): CommandResultView {
  const ranEntries = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.sideResults)
      ? payload.sideResults
      : [];
  const plannedEntries = Array.isArray(payload?.actions) ? payload.actions : [];
  const entries = ranEntries.length ? ranEntries : plannedEntries;
  return {
    text: String(payload?.response || payload?.summary || ""),
    actions: entries.slice(0, 40).map(actionRow),
    ran: ranEntries.length > 0,
  };
}

/* ------------------------------------------------------------- local path */

export type LocalPlanOutcome =
  | { kind: "done"; result: CommandResultView }
  | {
      kind: "needs-execute";
      /** Raw actions to hand back to `/execute` untouched. */
      actions: any[];
      planner: string | null;
      /** Present when the agent wants the owner to look before it runs. */
      parked: ParkedInfo | null;
      result: CommandResultView;
    };

/** Cheap reachability probe for the badge; `/health` is the agent's public
 * liveness route. Rejection means the serving agent process died under us. */
export async function probeLocalAgent(timeoutMs = 1500): Promise<void> {
  const response = await fetch("/health", {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Mac agent answered HTTP ${response.status}`);
  }
}

/**
 * Plan on the Mac. The agent's `/plan` is synchronous — planning happens
 * during the request — and its `status` field says what came back:
 * `instant` (already answered, nothing left to run), `ready` (actions
 * prepared, nothing executed yet), or a 4xx/5xx with the real error.
 *
 * A `ready` plan with `requiresConfirmation === false` is the agent's own
 * "safe to run hands-free" signal (the same one the pendant bridge acts on);
 * anything else is parked until the owner says go.
 */
export async function runLocalPlan(
  command: string,
  sessionId: string,
): Promise<LocalPlanOutcome> {
  const plan = await agentRequest("/plan", {
    method: "POST",
    body: JSON.stringify({ command, sessionId, source: "dashboard" }),
  });

  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  if (plan?.status === "instant" || !actions.length) {
    return { kind: "done", result: resultView(plan) };
  }

  const requiresConfirmation = plan?.requiresConfirmation !== false;
  return {
    kind: "needs-execute",
    actions,
    planner: plan?.planner ? String(plan.planner) : null,
    parked: requiresConfirmation
      ? {
          note: String(
            plan?.safety ||
              "Actions are prepared first. Nothing runs until you confirm.",
          ),
          blocked: [],
        }
      : null,
    result: resultView(plan),
  };
}

export async function runLocalExecute(
  command: string,
  actions: any[],
  sessionId: string,
  planner: string | null,
): Promise<CommandResultView> {
  const payload = await agentRequest("/execute", {
    method: "POST",
    body: JSON.stringify({
      command,
      actions,
      sessionId,
      planMeta: { planner, source: "dashboard" },
      source: "dashboard",
    }),
  });
  return resultView(payload);
}

/* ------------------------------------------------------------- relay path */

export type RelayJobView = {
  jobId: string;
  status: string;
  error: string;
  /** Partial-progress marker: the Mac already ran it, upload still pending. */
  executedEarly: boolean;
  parked: ParkedInfo | null;
  result: CommandResultView;
};

export async function dispatchRelayCommand(
  text: string,
  sessionId: string,
): Promise<{ jobId: string }> {
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, sessionId }),
    cache: "no-store",
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Command dispatch failed (${response.status})`);
  }
  if (!payload.jobId) {
    throw new Error("The relay accepted the command but returned no job id.");
  }
  return { jobId: String(payload.jobId) };
}

export async function fetchRelayCommandJob(jobId: string): Promise<RelayJobView> {
  const response = await fetch(
    `/api/command/status/${encodeURIComponent(jobId)}`,
    { cache: "no-store" },
  );
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Job status failed (${response.status})`);
  }
  const job = payload.job && typeof payload.job === "object" ? payload.job : {};
  const result = job.result && typeof job.result === "object" ? job.result : {};
  const blocked = Array.isArray(result.awaitingApproval)
    ? result.awaitingApproval.map((entry: any) => ({
        type: String(entry?.type || "action"),
        reason: String(entry?.reason || ""),
      }))
    : [];
  /*
   * Parked is its own outcome. Current bridge/relay: an ordinary plan_ready
   * job carrying result.parked / phase 'parked_for_approval' (and the
   * awaitingApproval reasons). Pre-fix relay: the same plan came back
   * status 'failed' with the approval sentence in job.error. Honour both, so
   * a parked plan is never presented as a failure whichever side deployed
   * first.
   */
  const isParked =
    result.parked === true ||
    result.phase === "parked_for_approval" ||
    blocked.length > 0;

  return {
    jobId: String(job.jobId || jobId),
    status: String(job.status || ""),
    error: String(job.error || ""),
    executedEarly: result.phase === "executed" && job.status === "processing",
    parked: isParked
      ? {
          // The bridge's own approval sentence, wherever this deploy put it.
          note: String(
            result.response ||
              job.error ||
              "Waiting for your approval on the dashboard.",
          ),
          blocked,
        }
      : null,
    result: resultView(result),
  };
}

/** True when this relay job status means nothing more will change. */
export function isTerminalRelayStatus(status: string): boolean {
  return ["plan_ready", "completed", "failed", "cancelled", "unsupported"].includes(
    status,
  );
}

/* ---------------------------------------------------------------- history */

export type CommandHistoryEntry = {
  id: string;
  text: string;
  transport: CommandTransport;
  /** "sent" until a terminal state overwrites it — never fabricated. */
  status: "sent" | "done" | "parked" | "failed" | "still-running";
  summary: string;
  jobId: string | null;
  at: number;
};

const HISTORY_KEY = "ai-pendant-dashboard-command-history-v1";
export const HISTORY_LIMIT = 10;

export function loadCommandHistory(): CommandHistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry) => entry && typeof entry === "object" && entry.text)
      .slice(0, HISTORY_LIMIT)
      .map((entry: any) => ({
        id: String(entry.id || crypto.randomUUID()),
        text: String(entry.text).slice(0, MAX_COMMAND_LENGTH),
        transport: entry.transport === "local" ? "local" : "relay",
        status: ["sent", "done", "parked", "failed", "still-running"].includes(
          entry.status,
        )
          ? entry.status
          : "sent",
        summary: String(entry.summary || "").slice(0, 240),
        jobId: entry.jobId ? String(entry.jobId) : null,
        at: Number(entry.at) || 0,
      }));
  } catch {
    return [];
  }
}

export function saveCommandHistory(entries: CommandHistoryEntry[]): void {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(entries.slice(0, HISTORY_LIMIT)),
    );
  } catch {
    // Private browsing: history is a convenience, not a record.
  }
}
