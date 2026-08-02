export const dynamic = "force-dynamic";

const DEFAULT_RELAY_URL =
  "https://ai-pendant-mission-control.your-subdomain.workers.dev";

function sanitizeText(value: unknown, maxLength = 500) {
  return String(value ?? "")
    .replace(
      /(?:\/Users\/[^/\s]+|\/Volumes\/[^/\s]+|\/private\/(?:var|tmp)|\/var\/folders|\/tmp)(?:\/[^\n\r"'`]*)?/gi,
      "[local path]",
    )
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\n\r"'`]*)?/g, "[local path]")
    .slice(0, maxLength);
}

function safeTimestamp(value: unknown) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function publicRun(value: unknown) {
  const run =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const events = Array.isArray(run.events) ? run.events : [];

  return {
    pipelineId: sanitizeText(run.pipelineId, 160),
    kind: sanitizeText(run.kind, 80),
    command: sanitizeText(run.command, 300),
    source: sanitizeText(run.source, 80),
    status: sanitizeText(run.status, 80),
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

export async function GET() {
  type RelayBinding = {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  type RuntimeEnv = {
    RELAY_URL?: string;
    RELAY_API_KEY?: string;
    RELAY?: RelayBinding;
  };
  const runtimeEnv =
    (
      globalThis as typeof globalThis & {
        __PENDANT_RUNTIME_ENV__?: RuntimeEnv;
      }
    ).__PENDANT_RUNTIME_ENV__ ?? (process.env as unknown as RuntimeEnv);
  const relayUrl = String(runtimeEnv.RELAY_URL || DEFAULT_RELAY_URL).replace(
    /\/$/,
    "",
  );
  const relayApiKey = String(runtimeEnv.RELAY_API_KEY || "");
  const relayFetch = (path: string, init?: RequestInit) =>
    runtimeEnv.RELAY
      ? runtimeEnv.RELAY.fetch(new Request(`https://relay.internal${path}`, init))
      : fetch(`${relayUrl}${path}`, init);

  if (!relayApiKey) {
    return Response.json(
      { ok: false, error: "Dashboard relay credential is not configured." },
      { status: 503 },
    );
  }

  try {
    const response = await relayFetch("/v1/ops/voice-runs?limit=12", {
      headers: {
        Authorization: `Bearer ${relayApiKey}`,
      },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
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
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
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
}
