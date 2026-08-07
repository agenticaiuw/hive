/* eslint-disable @typescript-eslint/no-explicit-any -- The agent payload is untrusted and allowlisted into a public shape below. */
import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  opsProxy,
  relayClient,
  redactSecrets,
  sanitizeText,
  safeTimestamp,
} from "$lib/server/relay";

export const prerender = false;

const MAX_JOBS = 200;
const MAX_ACTIONS = 40;
/* Long enough for a real command transcript; short enough not to ship a log. */
const MAX_OUTPUT = 4000;

/**
 * Job evidence is passed through nearly whole, unlike the pipeline text
 * elsewhere in this app.
 *
 * `sanitizeText` scrubs local filesystem paths because run transcripts are
 * spoken content that can be replayed. A job's evidence is the opposite: the
 * shell command and its stdout ARE the answer to "what did my agent just do to
 * my machine", and a redacted `[local path]` makes the view useless. This
 * surface is single-owner and sits behind the dashboard login, so the trade is
 * to show the command and keep only credentials hidden.
 */
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
    status: sanitizeText(entry.status, 80) || null,
    message: redactSecrets(entry.message || entry.error, 1000),
    stdout: redactSecrets(entry.stdout, MAX_OUTPUT),
    stderr: redactSecrets(entry.stderr, MAX_OUTPUT),
  };
}

function publicJob(value: unknown) {
  const job =
    value && typeof value === "object" ? (value as Record<string, any>) : {};
  const result =
    job.result && typeof job.result === "object" ? job.result : null;

  return {
    jobId: sanitizeText(job.jobId || job.id, 160),
    type: sanitizeText(job.type, 40),
    command: redactSecrets(job.command, 300),
    source: sanitizeText(job.source, 80) || "unknown",
    status: sanitizeText(job.status, 80),
    createdAt: safeTimestamp(job.createdAt),
    updatedAt: safeTimestamp(job.updatedAt),
    error: redactSecrets(job.error, 500),
    cancellable: Boolean(job.cancellable),
    undo: { canUndo: Boolean(job.undo?.canUndo) },
    result: result
      ? {
          response: redactSecrets(result.response, 2000),
          summary: redactSecrets(result.summary, 1000),
          results: Array.isArray(result.results)
            ? result.results.slice(0, MAX_ACTIONS).map(publicAction)
            : [],
          actions: Array.isArray(result.actions)
            ? result.actions.slice(0, MAX_ACTIONS).map(publicAction)
            : [],
        }
      : null,
  };
}

function publicHistoryJob(value: unknown) {
  const entry =
    value && typeof value === "object" ? (value as Record<string, any>) : {};
  return {
    pipelineId: sanitizeText(entry.pipelineId, 160),
    command: sanitizeText(entry.command, 300),
    origin: sanitizeText(entry.origin, 80),
    source: sanitizeText(entry.source, 80),
    status: sanitizeText(entry.status, 80),
    jobStatus: sanitizeText(entry.jobStatus, 80),
    reply: sanitizeText(entry.reply, 500),
    error: sanitizeText(entry.error, 300),
    createdAt: safeTimestamp(entry.createdAt),
    updatedAt: safeTimestamp(entry.updatedAt),
  };
}

/**
 * Two sources, deliberately ordered.
 *
 * The Mac agent is the only place the *complete* job list exists — work the
 * agent started on its own (recon, probes, harness runs) never touches the
 * relay. So ask the Mac first, through the relay's ops proxy. When the Mac is
 * asleep the relay's own durable history still answers, but it only ever saw
 * the runs that were routed through it; `note` says so rather than letting a
 * short list read as a quiet Mac.
 */
export const GET: RequestHandler = async ({ locals }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();

  const proxied = await opsProxy(client, "/jobs");
  if (proxied.ok) {
    const jobs = Array.isArray(proxied.payload?.jobs)
      ? proxied.payload.jobs
      : [];
    return Response.json(
      {
        ok: true,
        origin: "mac-agent",
        jobs: jobs.slice(0, MAX_JOBS).map(publicJob),
        note: "",
      },
      { headers: NO_STORE_HEADERS },
    );
  }

  const { relayApiKey, relayFetch } = client;
  try {
    const response = await relayFetch("/v1/ops/history?limit=50", {
      headers: { Authorization: `Bearer ${relayApiKey}` },
      cache: "no-store",
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(
        {
          ok: false,
          error:
            sanitizeText(payload.error, 300) ||
            `Job history failed (${response.status}).`,
        },
        { status: response.status, headers: NO_STORE_HEADERS },
      );
    }

    return Response.json(
      {
        ok: true,
        origin: "relay-history",
        jobs: Array.isArray(payload.entries)
          ? payload.entries.slice(0, MAX_JOBS).map(publicHistoryJob)
          : [],
        note: `${proxied.error} Showing the relay's own record instead, which holds only the runs that went through the cloud — work the Mac started on its own is not in this list.`,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? sanitizeText(error.message, 300)
            : "Unable to reach the job feed.",
      },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
};
