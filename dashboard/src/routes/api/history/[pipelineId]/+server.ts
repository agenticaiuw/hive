import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  publicHistoryRetention,
  relayClient,
  safeTimestamp,
  sanitizeText,
  strictIdentifier,
} from "$lib/server/relay";

export const prerender = false;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function nullableNumber(value: unknown) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicAudio(value: unknown) {
  const audio = record(value);
  return {
    available: Boolean(audio.available),
    captureId: strictIdentifier(audio.captureId) || null,
    link: sanitizeText(audio.link, 40) || null,
    storage: sanitizeText(audio.storage, 40) || null,
    format: sanitizeText(audio.format, 40) || null,
    audioBytes: nullableNumber(audio.audioBytes),
    createdAt: safeTimestamp(audio.createdAt),
    deletedAt: safeTimestamp(audio.deletedAt),
  };
}

function publicInputTelemetry(value: unknown) {
  const input = record(value);
  if (!Object.keys(input).length) return null;
  return {
    audioBytes: nullableNumber(input.audioBytes),
    durationMs: nullableNumber(input.durationMs),
    sampleRate: nullableNumber(input.sampleRate),
    format: sanitizeText(input.format, 40) || null,
    storage: sanitizeText(input.storage, 80) || null,
    inputGainDb: nullableNumber(input.inputGainDb),
  };
}

function publicEvent(value: unknown) {
  const event = record(value);
  const meta = record(event.meta);
  return {
    eventId: strictIdentifier(event.eventId) || null,
    stage: sanitizeText(event.stage, 80),
    status: sanitizeText(event.status, 80),
    label: sanitizeText(event.label, 160),
    detail: sanitizeText(event.detail, 500),
    text: sanitizeText(event.text, 500),
    source: sanitizeText(event.source, 80),
    at: safeTimestamp(event.at),
    meta: meta.inputTelemetry
      ? { inputTelemetry: publicInputTelemetry(meta.inputTelemetry) }
      : null,
  };
}

function publicAction(value: unknown) {
  const action = record(value);
  // Parameters can contain shell commands, paths, message bodies, or tokens.
  // The history UI needs the chosen action, not those arbitrary internals.
  return {
    type: sanitizeText(action.type, 80),
    label: sanitizeText(action.label || action.description, 240),
  };
}

function publicExecution(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const execution = record(value);
  return {
    ok: execution.ok == null ? null : Boolean(execution.ok),
    status: sanitizeText(execution.status, 80) || null,
    summary: sanitizeText(execution.summary, 500) || null,
    response: sanitizeText(execution.response, 1000) || null,
    planner: sanitizeText(execution.planner, 80) || null,
    results: Array.isArray(execution.results)
      ? execution.results.slice(0, 20).map((value) => {
          const result = record(value);
          return {
            ok: result.ok == null ? null : Boolean(result.ok),
            status: sanitizeText(result.status, 80) || null,
            message: sanitizeText(result.message, 500) || null,
            error: sanitizeText(result.error, 500) || null,
          };
        })
      : [],
    actions: Array.isArray(execution.actions)
      ? execution.actions.slice(0, 20).map(publicAction)
      : [],
  };
}

export const GET: RequestHandler = async ({ locals, params }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();
  const { relayApiKey, relayFetch } = client;

  const pipelineId = strictIdentifier(params.pipelineId);
  if (!pipelineId) {
    return Response.json(
      { ok: false, error: "pipelineId is required." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const response = await relayFetch(
      `/v1/ops/history/${encodeURIComponent(pipelineId)}`,
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
            `Run detail failed (${response.status}).`,
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
          sessionId: strictIdentifier(run.sessionId) || null,
          command: sanitizeText(run.command, 500),
          reply: sanitizeText(run.reply, 1000),
          status: sanitizeText(run.status, 80),
          origin: sanitizeText(run.origin, 80),
          inputMode: sanitizeText(run.inputMode, 40),
          error: sanitizeText(run.error, 500) || null,
          audio: publicAudio(run.audio),
          events: Array.isArray(run.events)
            ? run.events.slice(0, 80).map(publicEvent)
            : [],
          actions: Array.isArray(run.actions)
            ? run.actions.slice(0, 20).map(publicAction)
            : [],
          execution: publicExecution(run.execution),
          createdAt: safeTimestamp(run.createdAt),
          updatedAt: safeTimestamp(run.updatedAt),
        },
        retention: payload.retention
          ? publicHistoryRetention(payload.retention)
          : null,
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
            ? sanitizeText(error.message, 300)
            : "Unable to reach run detail.",
      },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
};
