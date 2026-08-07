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

export type Fetched<T> = {
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
    sessionRepair = fetch(`${base}/dashboard`, {
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

async function agentRequest(
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<any> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });

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

/** Routines live only on the Mac; see `runRoutineSupported`. */
export const runRoutineSupported = backend === "agent";

export async function runRoutine(routineId: string) {
  return agentRequest(`/routines/${encodeURIComponent(routineId)}/run`, {
    method: "POST",
  });
}
