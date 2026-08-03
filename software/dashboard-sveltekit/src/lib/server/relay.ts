/**
 * Server-only relay plumbing and payload sanitizers shared by every
 * `/api/*` endpoint. The React dashboard re-declared these in each route file;
 * the behaviour here is identical, only the duplication is gone.
 *
 * `RELAY_API_KEY` must never cross to the browser: every helper below runs on
 * the server and the browser only ever sees the allowlisted output shapes.
 */
import type { RuntimeEnv } from "./env";

const DEFAULT_RELAY_URL =
  "https://ai-pendant-mission-control.your-subdomain.workers.dev";

export type RelayFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type RelayClient = {
  relayApiKey: string;
  relayFetch: RelayFetch;
};

/** Returned instead of a client when the relay credential is missing. */
export function missingRelayCredential(): Response {
  return Response.json(
    { ok: false, error: "Dashboard relay credential is not configured." },
    { status: 503 },
  );
}

export function relayClient(env: RuntimeEnv): RelayClient | null {
  const relayUrl = String(env.RELAY_URL || DEFAULT_RELAY_URL).replace(/\/$/, "");
  const relayApiKey = String(env.RELAY_API_KEY || "");
  const relayFetch: RelayFetch = (path, init) =>
    env.RELAY
      ? env.RELAY.fetch(new Request(`https://relay.internal${path}`, init))
      : fetch(`${relayUrl}${path}`, init);

  if (!relayApiKey) return null;
  return { relayApiKey, relayFetch };
}

export function sanitizeText(value: unknown, maxLength = 500) {
  return String(value ?? "")
    .replace(
      /(?:\/Users\/[^/\s]+|\/Volumes\/[^/\s]+|\/private\/(?:var|tmp)|\/var\/folders|\/tmp)(?:\/[^\n\r"'`]*)?/gi,
      "[local path]",
    )
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\n\r"'`]*)?/g, "[local path]")
    .slice(0, maxLength);
}

export function safeIdentifier(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(/[^a-zA-Z0-9_.:-]/g, "")
    .slice(0, maxLength);
}

export function safeTimestamp(value: unknown) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function safeStringList(value: unknown) {
  return Array.isArray(value)
    ? value.slice(0, 32).map((item) => sanitizeText(item, 80))
    : [];
}

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
} as const;
