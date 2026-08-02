export const dynamic = "force-dynamic";

const DEFAULT_RELAY_URL =
  "https://ai-pendant-mission-control.your-subdomain.workers.dev";

function publicSnapshot(snapshot: Record<string, any>, cloud: Record<string, any>) {
  const pipeline = Array.isArray(snapshot.pipeline)
    ? snapshot.pipeline.slice(0, 12).map((run: Record<string, any>) => ({
        pipelineId: run.pipelineId,
        command: run.command,
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        events: Array.isArray(run.events)
          ? run.events.map((event: Record<string, any>) => ({
              eventId: event.eventId,
              stage: event.stage,
              status: event.status,
              label: event.label,
              detail: event.detail,
              text: event.text,
              at: event.at,
              meta: event.meta?.inputTelemetry
                ? { inputTelemetry: event.meta.inputTelemetry }
                : null,
            }))
          : [],
      }))
    : [];
  const logs = Array.isArray(snapshot.logs)
    ? snapshot.logs.slice(0, 5).map((entry: Record<string, any>) => ({
        id: entry.id,
        command: entry.command,
        status: entry.status,
        createdAt: entry.createdAt,
      }))
    : [];

  return {
    ok: Boolean(snapshot.ok),
    status: {
      agent: {
        ok: Boolean(snapshot.status?.agent?.ok),
        version: snapshot.status?.agent?.version ?? null,
      },
    },
    pipeline,
    logs,
    cloud,
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
    const [healthResponse, snapshotResponse] = await Promise.all([
      relayFetch("/health", { cache: "no-store" }),
      relayFetch("/v1/ops/proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayApiKey}`,
        },
        body: JSON.stringify({
          method: "GET",
          path: "/ops/snapshot",
          body: null,
          deviceId: "deployed-ops-dashboard",
        }),
        cache: "no-store",
      }),
    ]);

    const health = await healthResponse.json().catch(() => ({}));
    const snapshot = await snapshotResponse.json().catch(() => ({}));

    if (!snapshotResponse.ok) {
      return Response.json(
        {
          ok: false,
          error:
            snapshot.error ||
            `Cloud relay snapshot failed (${snapshotResponse.status}).`,
          cloud: health,
        },
        { status: snapshotResponse.status },
      );
    }

    return Response.json(
      publicSnapshot(snapshot, health),
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
            : "Unable to reach the Cloudflare relay.",
      },
      { status: 502 },
    );
  }
}
