import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  relayClient,
  safeTimestamp,
  sanitizeText,
} from "$lib/server/relay";

export const prerender = false;

function publicRun(value: unknown) {
  const run =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const events = Array.isArray(run.events) ? run.events : [];

  return {
    pipelineId: sanitizeText(run.pipelineId, 160),
    kind: sanitizeText(run.kind, 80),
    command: sanitizeText(run.command, 300),
    source: sanitizeText(run.source, 80),
    status: sanitizeText(run.status, 80),
    /*
     * Browser-executed runs joined /v1/ops/voice-runs on 2026-08-12 (the owner:
     * "why didn't my question in the browser extension carried to the
     * dashboard?"). Their honest verdict lives in `jobStatus` (read_only /
     * incomplete / needs_approval — runState reads it before `status`) and
     * their answer line in `reply` (the extension's ledger-derived headline,
     * which replyText prefers). Dropping these two fields here is what would
     * make an achieved browser run render as "No answer recorded".
     */
    jobStatus: sanitizeText(run.jobStatus, 80),
    reply: sanitizeText(run.reply, 500),
    events: events.slice(0, 80).map((value) => {
      const event =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const meta =
        event.meta && typeof event.meta === "object"
          ? (event.meta as Record<string, unknown>)
          : {};
      const input =
        meta.inputTelemetry && typeof meta.inputTelemetry === "object"
          ? (meta.inputTelemetry as Record<string, unknown>)
          : null;
      return {
        eventId: sanitizeText(event.eventId, 160),
        stage: sanitizeText(event.stage, 80),
        status: sanitizeText(event.status, 80),
        label: sanitizeText(event.label, 160),
        detail: sanitizeText(event.detail, 500),
        text: sanitizeText(event.text, 500),
        source: sanitizeText(event.source, 80),
        at: safeTimestamp(event.at),
        meta: input
          ? {
              inputTelemetry: {
                audioBytes: Number(input.audioBytes || 0),
                durationMs: Number(input.durationMs || 0),
                sampleRate: Number(input.sampleRate || 0),
                format: sanitizeText(input.format, 40) || null,
                storage: sanitizeText(input.storage, 80) || null,
                inputGainDb:
                  input.inputGainDb == null ? null : Number(input.inputGainDb),
              },
            }
          : null,
      };
    }),
    createdAt: safeTimestamp(run.createdAt),
    updatedAt: safeTimestamp(run.updatedAt),
  };
}

export const GET: RequestHandler = async ({ locals }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();
  const { relayApiKey, relayFetch } = client;

  try {
    const response = await relayFetch("/v1/ops/voice-runs?limit=12", {
      headers: {
        Authorization: `Bearer ${relayApiKey}`,
      },
      cache: "no-store",
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(
        {
          ok: false,
          error:
            payload.error ||
            `Cloud voice-run refresh failed (${response.status}).`,
        },
        { status: response.status },
      );
    }

    return Response.json(
      {
        ok: Boolean(payload.ok),
        runs: Array.isArray(payload.runs)
          ? payload.runs.slice(0, 40).map(publicRun)
          : [],
        observedAt: safeTimestamp(payload.observedAt),
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to reach the Cloudflare voice-run feed.",
      },
      { status: 502 },
    );
  }
};
