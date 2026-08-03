import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  relayClient,
  safeTimestamp,
  sanitizeText,
} from "$lib/server/relay";

export const prerender = false;

function publicHistoryEntry(value: unknown) {
  const entry =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const audio =
    entry.audio && typeof entry.audio === "object"
      ? (entry.audio as Record<string, unknown>)
      : {};

  return {
    pipelineId: sanitizeText(entry.pipelineId, 160),
    kind: sanitizeText(entry.kind, 80),
    command: sanitizeText(entry.command, 300),
    origin: sanitizeText(entry.origin, 80),
    inputMode: sanitizeText(entry.inputMode, 40),
    source: sanitizeText(entry.source, 80),
    status: sanitizeText(entry.status, 80),
    jobStatus: sanitizeText(entry.jobStatus, 80),
    reply: sanitizeText(entry.reply, 500),
    actionCount: Number(entry.actionCount || 0),
    eventCount: Number(entry.eventCount || 0),
    error: sanitizeText(entry.error, 300) || null,
    durationMs: entry.durationMs == null ? null : Number(entry.durationMs),
    audio: {
      available: Boolean(audio.available),
      captureId: sanitizeText(audio.captureId, 160) || null,
      link: sanitizeText(audio.link, 40) || null,
      storage: sanitizeText(audio.storage, 40) || null,
      format: sanitizeText(audio.format, 40) || null,
      audioBytes: audio.audioBytes == null ? null : Number(audio.audioBytes),
      createdAt: safeTimestamp(audio.createdAt),
      deletedAt: safeTimestamp(audio.deletedAt),
    },
    createdAt: safeTimestamp(entry.createdAt),
    updatedAt: safeTimestamp(entry.updatedAt),
  };
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();
  const { relayApiKey, relayFetch } = client;

  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") || 20) || 20, 1),
    50,
  );
  const query = sanitizeText(url.searchParams.get("q") || "", 120);
  const cursor = sanitizeText(url.searchParams.get("cursor") || "", 200);
  const origin = sanitizeText(url.searchParams.get("origin") || "", 40);

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (query) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  if (origin) params.set("origin", origin);

  try {
    const response = await relayFetch(`/v1/ops/history?${params}`, {
      headers: { Authorization: `Bearer ${relayApiKey}` },
      cache: "no-store",
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(
        {
          ok: false,
          error:
            payload.error ||
            `History refresh failed (${response.status}).`,
        },
        { status: response.status, headers: NO_STORE_HEADERS },
      );
    }

    return Response.json(
      {
        ok: Boolean(payload.ok),
        entries: Array.isArray(payload.entries)
          ? payload.entries.slice(0, 50).map(publicHistoryEntry)
          : [],
        nextCursor: sanitizeText(payload.nextCursor, 200) || null,
        hasMore: Boolean(payload.hasMore),
        limit: Number(payload.limit || limit),
        query: sanitizeText(payload.query, 120),
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
            : "Unable to reach the history feed.",
      },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
};
