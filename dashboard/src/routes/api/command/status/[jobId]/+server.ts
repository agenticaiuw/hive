/* eslint-disable @typescript-eslint/no-explicit-any -- The relay job record is schemaless; the allowlist below bounds it. */
import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  redactSecrets,
  relayClient,
  safeTimestamp,
  sanitizeText,
  strictIdentifier,
} from "$lib/server/relay";

export const prerender = false;

/**
 * Status of a command dispatched through `/api/command`, read back from the
 * relay's `GET /v1/mac/jobs/:jobId` with the server-held key — the companion
 * poll to the dispatch route, same credential pattern as `/api/hive`.
 *
 * The payload is allowlisted the way `/api/jobs` allowlists its evidence:
 * command text, replies, action labels/params and errors are the owner's own
 * material and pass through with only credentials hidden (`redactSecrets`) —
 * a parked plan's reason or a failed shell step is useless censored. What
 * never passes: `pendantSpeech` (megabytes of PCM the browser has no use
 * for), `contextHandle`-adjacent fields, and anything not named below.
 */
const MAX_ACTIONS = 40;

function publicAction(value: unknown) {
  const entry =
    value && typeof value === "object" ? (value as Record<string, any>) : {};
  const action =
    entry.action && typeof entry.action === "object" ? entry.action : entry;
  const params =
    action.params && typeof action.params === "object" ? action.params : null;

  return {
    action: {
      type: sanitizeText(action.type, 80),
      label: redactSecrets(action.label || action.description, 240),
      params: params ? redactSecrets(params, 2000) : null,
    },
    ok: entry.ok == null ? null : Boolean(entry.ok),
    message: redactSecrets(entry.message || entry.error, 1000),
  };
}

function publicCommandJob(value: unknown) {
  const job =
    value && typeof value === "object" ? (value as Record<string, any>) : {};
  const result =
    job.result && typeof job.result === "object" ? job.result : null;
  const execution =
    result?.execution && typeof result.execution === "object"
      ? result.execution
      : null;
  const ranEntries = Array.isArray(execution?.results)
    ? execution.results
    : Array.isArray(result?.sideResults)
      ? result.sideResults
      : [];

  return {
    jobId: sanitizeText(job.jobId, 160),
    type: sanitizeText(job.type, 40),
    status: sanitizeText(job.status, 80),
    command: redactSecrets(job.command, 300),
    createdAt: safeTimestamp(job.createdAt),
    updatedAt: safeTimestamp(job.updatedAt),
    error: redactSecrets(job.error, 500),
    result: result
      ? {
          response: redactSecrets(result.response, 2000),
          summary: redactSecrets(result.summary, 1000),
          executed: result.executed == null ? null : Boolean(result.executed),
          phase: sanitizeText(result.phase, 40) || null,
          /*
           * Parked is its own outcome, not a failure (commit "Routines are
           * standing approval"): the bridge marks it `parked` / `phase:
           * 'parked_for_approval'` on an ordinary plan_ready job. Both
           * markers are honoured here, and `awaitingApproval` still rides
           * along for the reasons list.
           */
          parked:
            result.parked === true ||
            result.phase === "parked_for_approval",
          awaitingApproval: Array.isArray(result.awaitingApproval)
            ? result.awaitingApproval.slice(0, 12).map((entry: any) => ({
                type: sanitizeText(entry?.type, 80) || "action",
                reason: redactSecrets(entry?.reason, 240),
              }))
            : [],
          actions: Array.isArray(result.actions)
            ? result.actions.slice(0, MAX_ACTIONS).map(publicAction)
            : [],
          results: ranEntries.slice(0, MAX_ACTIONS).map(publicAction),
        }
      : null,
  };
}

export const GET: RequestHandler = async ({ locals, params }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();
  const { relayApiKey, relayFetch } = client;

  const jobId = strictIdentifier(params.jobId);
  if (!jobId) {
    return Response.json(
      { ok: false, error: "A valid jobId is required." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const response = await relayFetch(
      `/v1/mac/jobs/${encodeURIComponent(jobId)}`,
      {
        headers: { Authorization: `Bearer ${relayApiKey}` },
        cache: "no-store",
      },
    );
    const payload: any = await response.json().catch(() => ({}));

    if (!response.ok) {
      return Response.json(
        {
          ok: false,
          error:
            sanitizeText(payload.error, 300) ||
            `Job status failed (${response.status}).`,
        },
        { status: response.status, headers: NO_STORE_HEADERS },
      );
    }

    return Response.json(
      { ok: true, job: publicCommandJob(payload.job) },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? sanitizeText(error.message, 300)
            : "Unable to reach the Cloudflare relay.",
      },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
};
