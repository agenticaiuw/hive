import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  relayClient,
  safeTimestamp,
  sanitizeText,
} from "$lib/server/relay";

export const prerender = false;

export const GET: RequestHandler = async ({ locals, url }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();
  const { relayApiKey, relayFetch } = client;

  const query = sanitizeText(url.searchParams.get("q") || "", 120);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("entityLimit", "40");
  params.set("sessionLimit", "12");
  params.set("turnLimit", "8");

  try {
    const response = await relayFetch(`/v1/ops/memory?${params}`, {
      headers: { Authorization: `Bearer ${relayApiKey}` },
      cache: "no-store",
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(
        {
          ok: false,
          error: payload.error || `Memory refresh failed (${response.status}).`,
        },
        { status: response.status, headers: NO_STORE_HEADERS },
      );
    }

    const entities = Array.isArray(payload.memory?.entities)
      ? payload.memory.entities.slice(0, 40).map((entity: any) => ({
          id: sanitizeText(entity.id, 160),
          name: sanitizeText(entity.name, 160),
          type: sanitizeText(entity.type, 80),
          updatedAt: safeTimestamp(entity.updatedAt),
        }))
      : [];

    const sessions = Array.isArray(payload.sessions)
      ? payload.sessions.slice(0, 12).map((session: any) => ({
          sessionId: sanitizeText(session.sessionId, 160),
          title: sanitizeText(session.title, 160),
          turnCount: Number(session.turnCount || 0),
          updatedAt: safeTimestamp(session.updatedAt),
          turns: Array.isArray(session.turns)
            ? session.turns.slice(-8).map((turn: any) => ({
                role: sanitizeText(turn.role, 40),
                content: sanitizeText(turn.content, 400),
                createdAt: safeTimestamp(turn.createdAt),
              }))
            : [],
        }))
      : [];

    return Response.json(
      {
        ok: Boolean(payload.ok),
        counts: payload.counts ?? null,
        memory: { entities },
        sessions,
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
            : "Unable to reach memory.",
      },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
};
