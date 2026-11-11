/* eslint-disable @typescript-eslint/no-explicit-any -- The relay payload is schemaless; shape checks below bound it. */
import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  relayClient,
  safeTimestamp,
  sanitizeText,
} from "$lib/server/relay";

export const prerender = false;

/**
 * The hive observability snapshot, read back from the relay's generic state
 * store. The document under `/v1/state/hive` is written every ~8 s by
 * `ai-pendant-simulator/hive-dashboard/server.mjs`, which already truncates
 * every string, masks secret-looking values, and scrubs `.env` values before
 * anything leaves that process — so this route passes the object through
 * intact. Unlike the spoken-transcript routes it deliberately keeps local
 * paths: this page is the owner's evidence console, and rewriting
 * `/Users/...` would destroy exactly what it exists to show. Rendering is
 * safe because the Svelte views interpolate (never `{@html}`) these strings.
 */
export const GET: RequestHandler = async ({ locals }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();
  const { relayApiKey, relayFetch } = client;

  try {
    const response = await relayFetch("/v1/state/hive", {
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
            `Hive snapshot fetch failed (${response.status}).`,
        },
        { status: response.status, headers: NO_STORE_HEADERS },
      );
    }

    const data = payload.state?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return Response.json(
        {
          ok: false,
          error: "Relay returned a hive state record without a data object.",
        },
        { status: 502, headers: NO_STORE_HEADERS },
      );
    }

    return Response.json(
      {
        ok: true,
        state: {
          revision: Number(payload.state?.revision || 0),
          updatedAt: safeTimestamp(payload.state?.updatedAt),
          updatedBy: sanitizeText(payload.state?.updatedBy, 120) || null,
        },
        data,
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
            : "Unable to reach the Cloudflare relay.",
      },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
};
