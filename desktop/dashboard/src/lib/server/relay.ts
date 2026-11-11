/**
 * Server-only relay plumbing and payload sanitizers shared by every
 * `/api/*` endpoint.
 *
 * `RELAY_API_KEY` must never cross to the browser: every helper below runs on
 * the server and the browser only ever sees the allowlisted output shapes.
 */
import { redactInline } from "$lib/jobs";
import type { RuntimeEnv } from "./env";

const DEFAULT_RELAY_URL =
  "https://ai-pendant-relay.evan20050827.workers.dev";

type RelayFetch = (path: string, init?: RequestInit) => Promise<Response>;

type RelayClient = {
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
function stripAgentControlSentinels(value: unknown) {
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

/* Values that should never be read off a screen, whoever is looking. */
const SENSITIVE_KEY =
  /token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|bearer|private[-_]?key/i;

/**
 * The evidence-grade counterpart to `sanitizeText`.
 *
 * `sanitizeText` rewrites `/Users/...` to `[local path]`, which is right for
 * spoken transcripts but destroys the one thing job evidence exists to show:
 * the actual command that ran. This keeps paths and output intact and hides
 * only credentials. Objects come back as objects so callers can render a
 * parameter table rather than a JSON blob.
 */
export function redactSecrets(value: unknown, maxLength = 500): any {
  if (value == null) return "";
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, item]) => [
          key.slice(0, 80),
          SENSITIVE_KEY.test(key)
            ? "••••••• hidden"
            : redactSecrets(
                item !== null && typeof item === "object"
                  ? JSON.stringify(item)
                  : item,
                maxLength,
              ),
        ]),
    );
  }
  return redactInline(String(value)).slice(0, maxLength);
}

/**
 * Ask the Mac agent a question through the relay's ops proxy.
 *
 * The relay parks the request as a job and waits for the Mac bridge to claim
 * it, so this is a real round trip to the laptop and fails whenever the laptop
 * is asleep. Callers get the failure as a sentence to show the owner, never a
 * thrown error — an offline Mac is a normal state for a remote dashboard, not
 * a fault.
 */
export async function opsProxy(
  client: RelayClient,
  path: string,
  { method = "GET", body = null }: { method?: string; body?: unknown } = {},
): Promise<{ ok: true; payload: any } | { ok: false; error: string }> {
  try {
    const response = await client.relayFetch("/v1/ops/proxy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${client.relayApiKey}`,
      },
      body: JSON.stringify({ method, path, body, deviceId: "ops-dashboard" }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        error:
          sanitizeText(payload.error, 300) ||
          `The Mac agent did not answer (${response.status}).`,
      };
    }
    return { ok: true, payload };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? sanitizeText(error.message, 300)
          : "Could not reach the Mac agent through the relay.",
    };
  }
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
