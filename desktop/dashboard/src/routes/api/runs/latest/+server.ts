import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  relayClient,
  safeIdentifier,
  safeTimestamp,
} from "$lib/server/relay";

export const prerender = false;

export const GET: RequestHandler = async ({ locals }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();
  const { relayApiKey, relayFetch } = client;

  try {
    const response = await relayFetch("/v1/ops/voice-runs/latest", {
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
            `Cloud voice-run freshness probe failed (${response.status}).`,
        },
        { status: response.status },
      );
    }

    // Only these three fields are echoed; anything else the relay attaches
    // (local paths, for instance) is dropped.
    const latest =
      payload.latest && typeof payload.latest === "object"
        ? payload.latest
        : null;
    return Response.json(
      {
        ok: Boolean(payload.ok),
        latest: latest
          ? {
              pipelineId: safeIdentifier(latest.pipelineId, 160),
              status: safeIdentifier(latest.status, 80),
              updatedAt: safeTimestamp(latest.updatedAt),
            }
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
            ? error.message
            : "Unable to reach the Cloudflare voice-run freshness probe.",
      },
      { status: 502 },
    );
  }
};
