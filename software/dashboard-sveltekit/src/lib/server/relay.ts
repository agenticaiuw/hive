/**
 * Server-only relay plumbing and payload sanitizers shared by every
 * `/api/*` endpoint.
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

const CONTROL_SENTINEL_LINE =
  /^\s*(?:\[DONE\]|<\|(?:eot_id|im_end|end_of_text)\|>|(?:\[|<|__)?agent[_ -]*response[_ -]*complete(?:\]|>|__)?[.!]?)\s*$/i;

/** Remove transport/control markers without deleting ordinary user prose. */
export function stripAgentControlSentinels(value: unknown) {
  return String(value ?? "")
    .split(/\r?\n/)
    .filter((line) => !CONTROL_SENTINEL_LINE.test(line))
    .join("\n")
    .trim();
}

export function sanitizeText(value: unknown, maxLength = 500) {
  return stripAgentControlSentinels(value)
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

/** Reject route/session ids instead of silently rewriting them into another id. */
export function strictIdentifier(value: unknown, maxLength = 160) {
  const identifier = String(value ?? "").trim();
  if (
    !identifier ||
    identifier.length > maxLength ||
    identifier.includes("..") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(identifier)
  ) {
    return "";
  }
  return identifier;
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

export function publicHistoryRetention(value: unknown) {
  const retention =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const audio =
    retention.audio && typeof retention.audio === "object"
      ? (retention.audio as Record<string, unknown>)
      : {};

  return {
    runsTtlMs: Number(retention.runsTtlMs || 0),
    runsOldestVisibleAt: safeTimestamp(retention.runsOldestVisibleAt),
    runsNote: sanitizeText(retention.runsNote, 300) || null,
    audio: {
      maxAgeMs: Number(audio.maxAgeMs || 0),
      maxAgeDays: Number(audio.maxAgeDays || 0),
      defaultMaxAgeMs: Number(audio.defaultMaxAgeMs || 0),
      sweepEnabled: Boolean(audio.sweepEnabled),
      expiresBefore: safeTimestamp(audio.expiresBefore),
    },
  };
}

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
} as const;
