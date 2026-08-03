import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  relayClient,
  safeIdentifier,
} from "$lib/server/relay";

export const prerender = false;

/** Stream the stored recording for one run. Auth stays server-side. */
export const GET: RequestHandler = async ({ locals, params, request }) => {
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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${relayApiKey}`,
    };
    const range = request.headers.get("range");
    if (range) headers.Range = range;

    const response = await relayFetch(
      `/v1/ops/history/${pipelineId}/audio`,
      { headers, cache: "no-store" },
    );

    if (!response.ok) {
      const payload: any = await response.json().catch(() => ({}));
      return Response.json(
        {
          ok: false,
          error:
            payload.error ||
            `Recording fetch failed (${response.status}).`,
        },
        { status: response.status, headers: NO_STORE_HEADERS },
      );
    }

    const passthrough = new Headers();
    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
    ]) {
      const value = response.headers.get(name);
      if (value) passthrough.set(name, value);
    }
    passthrough.set("Cache-Control", "private, no-store");

    return new Response(response.body, {
      status: response.status,
      headers: passthrough,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to stream the recording.",
      },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
};
