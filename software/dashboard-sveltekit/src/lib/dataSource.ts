/* eslint-disable @typescript-eslint/no-explicit-any -- Both backends return schemaless records at this boundary. */

/**
 * The one data layer, two backends.
 *
 * This same build runs in two places:
 *
 *   - served by the Mac agent at `http://127.0.0.1:8000/dashboard`, where it
 *     talks straight to the agent's own routes using the loopback session
 *     cookie the agent sets on `/dashboard`;
 *   - deployed to the Cloudflare Worker, where the browser has no route to the
 *     Mac at all and every call goes through this app's own `/api/*` server
 *     routes, which hold the relay credential.
 *
 * Everything above this file works in one normalised shape, so the views never
 * learn which backend they are on. That is the whole point: the moment a view
 * branches on the backend, the two surfaces start drifting again.
 */
import { base } from "$app/paths";
import {
  jobFromAgent,
  jobFromRelayHistory,
  routineFromAgent,
  withRelayDetail,
  type JobView,
  type RoutineView,
} from "$lib/jobs";
import { mergeMacLocalHistory } from "$lib/hiveFeed.js";

export type Backend = "agent" | "relay";

const CONFIGURED = String(
  import.meta.env.VITE_DASHBOARD_BACKEND || "",
).toLowerCase();

/*
 * The agent build is the only one with a base path, so it doubles as the
 * backend marker and the two can never disagree. The explicit flag stays as an
 * override for `vite dev` against a running agent.
 */
export const backend: Backend =
  CONFIGURED === "agent" || CONFIGURED === "relay"
    ? (CONFIGURED as Backend)
    : base === "/dashboard"
      ? "agent"
      : "relay";

type Fetched<T> = {
  data: T;
  /** Set when the backend answered, but with less than the view asked for. */
  note: string;
};

/*
 * The agent hands the dashboard a loopback-only session cookie when it serves
 * /dashboard, and that cookie is per-process: restart the agent and every
 * already-open tab starts 401ing on every route until someone reloads by hand.
 * The page looks alive but goes blank and stale, which is exactly the failure
 * this dashboard exists to make visible. Re-priming the cookie is a plain GET
 * of the page we are already on, so do it automatically.
 */
let sessionRepair: Promise<boolean> | null = null;

function repairSession() {
  if (!sessionRepair) {
    // `base` already IS the dashboard route the agent sets the cookie on;
    // appending "/dashboard" again asked for /dashboard/dashboard and 404ed,
    // so every stale tab stayed stale.
    sessionRepair = fetch(base || "/", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then((response) => response.ok)
      .catch(() => false);
    // One repair per burst: parallel refresh calls must not fire one each.
    void sessionRepair.finally(() => {
      window.setTimeout(() => {
        sessionRepair = null;
      }, 1000);
    });
  }
  return sessionRepair;
}

/**
 * Exported for `$lib/command`: the command box talks to the same agent with
 * the same loopback session, and must inherit the 401 repair + GET retry
 * behaviour rather than re-implementing a worse copy of it.
 */
export async function agentRequest(
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<any> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    });
  } catch (networkError) {
    /*
     * `/ops/snapshot` is a third of a megabyte and takes over a second to
     * build; two in flight at once, or one crossing an agent restart, comes
     * back as a dropped connection rather than a status. One retry turns that
     * blip back into data instead of an error banner.
     */
    if (retried || String(init.method || "GET").toUpperCase() !== "GET") {
      throw networkError;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return agentRequest(path, init, true);
  }

  if (response.status === 401 && !retried && (await repairSession())) {
    return agentRequest(path, init, true);
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `${path} failed (${response.status})`);
  }
  return payload;
}

async function apiRequest(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `${path} failed (${response.status})`);
  }
  return payload;
}

/**
 * The agent's `/ops/snapshot` and the relay's `/api/snapshot` describe the same
 * machine with different nesting. This is the agent side folded onto the
 * relay's shape, which the page already speaks.
 */
function snapshotFromAgent(snap: any) {
  const agent = snap?.status?.agent ?? {};
  const permissions = agent.permissions ?? {};
  const browser = agent.browserExtension ?? snap?.status?.browser ?? {};
  const relay = snap?.status?.relay ?? {};
  const health = relay.payload ?? {};
  const devices: any[] = Array.isArray(browser.devices) ? browser.devices : [];

  return {
    ok: Boolean(snap?.ok),
    status: {
      agent: {
        ok: Boolean(agent.ok),
        version: agent.version ?? null,
        hostApp: permissions.hostApp ?? null,
        fullControlMode: Boolean(agent.fullControlMode),
        llmPlannerEnabled: Boolean(agent.llmPlannerEnabled),
        permissions: {
          ready: Boolean(permissions.ready),
          accessibility: permissions.accessibility ?? {},
          screenRecording: permissions.screenRecording ?? {},
          automation: permissions.automation ?? {},
          requiredMissing: permissions.requiredMissing ?? [],
        },
        browserExtension: {
          online: Boolean(browser.online),
          pendingCommands: Number(browser.pendingCommands || 0),
          connectedDevices: devices.filter((device) => device.online).length,
          lastSeenAt:
            devices
              .map((device) => String(device.lastSeenAt || ""))
              .filter(Boolean)
              .sort()
              .at(-1) ?? null,
        },
      },
    },
    pipeline: Array.isArray(snap?.pipeline) ? snap.pipeline : [],
    logs: Array.isArray(snap?.logs) ? snap.logs : [],
    product: {
      revision: Number(snap?.status?.counts?.entities || 0),
      sessions: Array.isArray(snap?.sessions) ? snap.sessions : [],
      memory: { entities: snap?.context?.graph?.entities ?? [] },
    },
    cloud: {
      ok: Boolean(relay.reachable && health.ok),
      store: health.store ?? null,
      speechToTextConfigured: Boolean(health.speechToTextConfigured),
      macBridgeOnline: Boolean(health.macBridgeOnline),
      models: health.models ?? {},
    },
  };
}

export async function fetchSnapshot(): Promise<any> {
  if (backend === "agent") return snapshotFromAgent(await agentRequest("/ops/snapshot"));
  return apiRequest("/api/snapshot");
}

export async function fetchRuns(): Promise<any[]> {
  if (backend === "agent") {
    const payload = await agentRequest("/pipeline");
    return Array.isArray(payload?.runs) ? payload.runs : [];
  }
  const payload = await apiRequest("/api/runs");
  return Array.isArray(payload?.runs) ? payload.runs : [];
}

/**
 * A cheap "has anything changed" probe. The agent has no equivalent and needs
 * none — it is on the same machine, so the ordinary refreshes are already
 * cheap and local.
 */
export async function fetchLatestRun(): Promise<any> {
  if (backend === "agent") return null;
  const payload = await apiRequest("/api/runs/latest");
  return payload?.latest ?? null;
}

async function fetchHistoryBase(query: string, cursor: string) {
  if (backend === "agent") {
    const payload = await agentRequest("/pipeline");
    const runs: any[] = Array.isArray(payload?.runs) ? payload.runs : [];
    const needle = query.trim().toLowerCase();
    return {
      entries: runs
        .filter(
          (run) => !needle || String(run.command || "").toLowerCase().includes(needle),
        )
        .map((run) => ({
          pipelineId: run.pipelineId,
          command: run.command,
          status: run.status,
          origin: run.source,
          createdAt: run.createdAt,
          // The agent stores recordings per run, but only exposes them by
          // direction on a separate route, so the row cannot promise one here.
          audio: { available: false, replyAvailable: false },
        })),
      nextCursor: "",
      hasMore: false,
      retention: null,
    };
  }

  const params = new URLSearchParams({ limit: "24" });
  if (query.trim()) params.set("q", query.trim());
  if (cursor) params.set("cursor", cursor);
  return apiRequest(`/api/history?${params}`);
}

/**
 * History, with the owner's Mac-local work folded in.
 *
 * The base feed (relay `/v1/ops/history` off the Worker, the agent's own
 * `/pipeline` on the Mac) is the shared record — but neither ever saw the
 * floating HUD or the on-Mac dashboard composer, whose runs live only in
 * jobTracker (`GET /jobs`). So on the first page we also read `/jobs` and fold
 * the owner's Mac-local rows into one list (`mergeMacLocalHistory`, deduped by
 * id). Older pages skip it: the whole jobTracker window (≤120 rows) already
 * lands on page one, and re-folding it under every cursor would repeat it.
 *
 * Best-effort by design: if `/jobs` is unreachable the shared record still
 * renders exactly as before, rather than an error taking the whole feed down.
 */
export async function fetchHistory(query: string, cursor: string) {
  const base = await fetchHistoryBase(query, cursor);
  if (cursor) return base;
  try {
    const jobs = (await fetchJobs()).data;
    const needle = query.trim().toLowerCase();
    const scoped = needle
      ? jobs.filter((job) =>
          `${job.command} ${job.summary}`.toLowerCase().includes(needle),
        )
      : jobs;
    return { ...base, entries: mergeMacLocalHistory(base.entries, scoped) };
  } catch {
    return base;
  }
}

export async function fetchHistoryDetail(pipelineId: string) {
  if (backend === "agent") {
    const payload = await agentRequest("/pipeline");
    const runs: any[] = Array.isArray(payload?.runs) ? payload.runs : [];
    return runs.find((run) => run.pipelineId === pipelineId) ?? null;
  }
  const payload = await apiRequest(
    `/api/history/${encodeURIComponent(pipelineId)}`,
  );
  return payload?.run ?? null;
}

/** Memory on the agent already rides along in the snapshot. */
export async function fetchMemory() {
  if (backend === "agent") return null;
  return apiRequest("/api/memory");
}

export function audioHref(pipelineId: string, voice: "owner" | "reply") {
  if (backend === "agent") {
    return `/pipeline/${encodeURIComponent(pipelineId)}/audio/${
      voice === "reply" ? "output" : "input"
    }`;
  }
  return `/api/history/${encodeURIComponent(pipelineId)}/audio${
    voice === "reply" ? "?voice=reply" : ""
  }`;
}

export async function fetchJobs(): Promise<Fetched<JobView[]>> {
  if (backend === "agent") {
    const payload = await agentRequest("/jobs");
    return {
      data: (Array.isArray(payload?.jobs) ? payload.jobs : []).map(jobFromAgent),
      note: "",
    };
  }

  const payload = await apiRequest("/api/jobs");
  // The server route says which of its two sources answered; pass it through
  // verbatim rather than guessing at the reason the list looks short.
  return {
    data: (Array.isArray(payload?.jobs) ? payload.jobs : []).map(
      payload?.origin === "relay-history" ? jobFromRelayHistory : jobFromAgent,
    ),
    note: String(payload?.note || ""),
  };
}

export async function fetchRoutines(): Promise<Fetched<RoutineView[]>> {
  if (backend === "agent") {
    const payload = await agentRequest("/routines");
    return {
      data: (Array.isArray(payload?.routines) ? payload.routines : []).map(
        routineFromAgent,
      ),
      note: "",
    };
  }

  const payload = await apiRequest("/api/routines");
  return {
    data: (Array.isArray(payload?.routines) ? payload.routines : []).map(
      routineFromAgent,
    ),
    note: String(payload?.note || ""),
  };
}

/**
 * The agent's list already carries every action and its output. The relay's
 * does not, so the detail is fetched only for the job actually being read.
 */
export async function loadJobDetail(job: JobView): Promise<JobView> {
  if (!job.detailHref) return job;
  const payload = await apiRequest(job.detailHref);
  return withRelayDetail(job, payload?.run);
}

export async function cancelJob(jobId: string) {
  const path = `/jobs/${encodeURIComponent(jobId)}/cancel`;
  if (backend === "agent") return agentRequest(path, { method: "POST" });
  return apiRequest(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
}

export async function undoJob(jobId: string) {
  const path = `/jobs/${encodeURIComponent(jobId)}/undo`;
  if (backend === "agent") return agentRequest(path, { method: "POST" });
  return apiRequest(`/api/jobs/${encodeURIComponent(jobId)}/undo`, {
    method: "POST",
  });
}

/**
 * Approving a parked plan.
 *
 * The agent parks a plan as a `plan_ready` job and executes nothing; the
 * approval IS `POST /execute` carrying the plan's own actions back, which is
 * exactly what the command box already does for a plan it parked itself.
 *
 * The actions are re-fetched from `GET /jobs/:jobId` at approve time rather
 * than taken from the `JobView` on screen: that view has been through
 * `redactParams`, so approving from it would run the plan with `"••••••• hidden"`
 * where a real parameter belongs.
 *
 * Only the agent build can do this. The deployed Worker has no route that
 * approves an already-parked pendant plan — `/api/command` would create a
 * *new* plan, which is not the same thing — so `canApprovePlan` is false there
 * and the UI says where the owner can act instead of showing a dead button.
 */
export const canApprovePlan = backend === "agent";

export async function approvePlan(jobId: string) {
  if (!canApprovePlan) {
    throw new Error(
      "This page has no route to the Mac, so it cannot approve a parked plan.",
    );
  }
  const payload = await agentRequest(`/jobs/${encodeURIComponent(jobId)}`);
  const job = payload?.job ?? payload;
  const actions = Array.isArray(job?.result?.actions) ? job.result.actions : [];
  if (String(job?.status || "") !== "plan_ready") {
    throw new Error(
      `This plan is no longer waiting: the agent now reports "${job?.status || "unknown"}".`,
    );
  }
  if (!actions.length) {
    throw new Error("The agent no longer lists any steps for this plan.");
  }
  return agentRequest("/execute", {
    method: "POST",
    body: JSON.stringify({
      command: String(job.command || ""),
      actions,
      sessionId: job.sessionId || job.thinking?.sessionId || undefined,
      planMeta: { planner: "dashboard-approval", source: "dashboard" },
      source: "dashboard",
    }),
  });
}

/**
 * Saying no to a parked plan.
 *
 * The counterpart to `approvePlan`, and the reason it exists: until now the
 * card could only be approved or left alone, so "no" meant leaving a decision
 * on screen forever. `POST /jobs/:jobId/dismiss` marks the plan declined on
 * the Mac and runs none of it.
 *
 * Every id folded into the card is dismissed, not just the newest: repeat asks
 * each park their own job and the card collapses them, so dismissing one would
 * simply reveal the next. Failures are collected rather than thrown at the
 * first one — a partial dismissal the owner is told about beats a silent one.
 */
export const canDismissPlan = backend === "agent";

export async function dismissPlan(jobIds: string[]) {
  if (!canDismissPlan) {
    throw new Error(
      "This page has no route to the Mac, so it cannot dismiss a parked plan.",
    );
  }
  const ids = jobIds.filter(Boolean);
  if (!ids.length) throw new Error("This card carries no job to dismiss.");

  const failures: string[] = [];
  for (const jobId of ids) {
    try {
      await agentRequest(`/jobs/${encodeURIComponent(jobId)}/dismiss`, {
        method: "POST",
      });
    } catch (failure) {
      failures.push(
        failure instanceof Error ? failure.message : String(failure),
      );
    }
  }
  /* All of them failing is a failure; some of them failing still cleared the
   * card the owner pressed, and the rest are named. */
  if (failures.length === ids.length) throw new Error(failures[0]);
  if (failures.length) {
    return { ok: true, note: `${failures.length} older copy/copies could not be dismissed: ${failures[0]}` };
  }
  return { ok: true };
}

/** Routines live only on the Mac; see `runRoutineSupported`. */
export const runRoutineSupported = backend === "agent";

export async function runRoutine(routineId: string) {
  return agentRequest(`/routines/${encodeURIComponent(routineId)}/run`, {
    method: "POST",
  });
}
