export const dynamic = "force-dynamic";

const DEFAULT_RELAY_URL =
  "https://ai-pendant-mission-control.your-subdomain.workers.dev";

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
    const response = await relayFetch("/v1/ops/voice-runs/latest", {
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
            `Cloud voice-run freshness probe failed (${response.status}).`,
        },
        { status: response.status },
      );
    }

    return Response.json(payload, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to reach the Cloudflare voice-run freshness probe.",
      },
      { status: 502 },
    );
  }
}
