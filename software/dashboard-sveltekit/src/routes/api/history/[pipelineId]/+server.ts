import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  relayClient,
  safeIdentifier,
  safeTimestamp,
  sanitizeText,
} from "$lib/server/relay";

export const prerender = false;

export const GET: RequestHandler = async ({ locals, params }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();
  const { relayApiKey, relayFetch } = client;

  const pipelineId = safeIdentifier(params.pipelineId, 160);
  if (!pipelineId) {
    return Response.json(
      { ok: false, error: "pipelineId is required." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const response = await relayFetch(`/v1/ops/history/${pipelineId}`, {
      headers: { Authorization: `Bearer ${relayApiKey}` },
      cache: "no-store",
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(
        {
          ok: false,
          error: payload.error || `Run detail failed (${response.status}).`,
        },
        { status: response.status, headers: NO_STORE_HEADERS },
      );
    }

    const run =
      payload.run && typeof payload.run === "object" ? payload.run : {};
    return Response.json(
      {
        ok: Boolean(payload.ok),
        run: {
          pipelineId: sanitizeText(run.pipelineId, 160),
          command: sanitizeText(run.command, 500),
          reply: sanitizeText(run.reply, 1000),
          status: sanitizeText(run.status, 80),
          origin: sanitizeText(run.origin, 80),
          inputMode: sanitizeText(run.inputMode, 40),
          error: sanitizeText(run.error, 500) || null,
          audio: run.audio ?? null,
          events: Array.isArray(run.events) ? run.events.slice(0, 80) : [],
          actions: Array.isArray(run.actions) ? run.actions.slice(0, 20) : [],
          execution: run.execution ?? null,
          createdAt: safeTimestamp(run.createdAt),
          updatedAt: safeTimestamp(run.updatedAt),
        },
        retention: payload.retention ?? null,
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
            : "Unable to reach run detail.",
      },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
};
