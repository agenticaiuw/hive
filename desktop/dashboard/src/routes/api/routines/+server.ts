/* eslint-disable @typescript-eslint/no-explicit-any -- The agent payload is untrusted and allowlisted into a public shape below. */
import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  opsProxy,
  relayClient,
  redactSecrets,
  safeTimestamp,
  sanitizeText,
} from "$lib/server/relay";

export const prerender = false;

function publicRoutine(value: unknown) {
  const routine =
    value && typeof value === "object" ? (value as Record<string, any>) : {};
  const schedule =
    routine.schedule && typeof routine.schedule === "object"
      ? routine.schedule
      : {};

  return {
    id: sanitizeText(routine.id, 160),
    name: sanitizeText(routine.name, 240),
    command: redactSecrets(routine.command, 300),
    schedule: {
      kind: sanitizeText(schedule.kind, 40),
      at: sanitizeText(schedule.at, 20),
      everyMs: Number(schedule.everyMs || 0) || null,
    },
    enabled: Boolean(routine.enabled),
    nextRunAt: Number(routine.nextRunAt) || null,
    lastRunAt: safeTimestamp(routine.lastRunAt),
    lastStatus: sanitizeText(routine.lastStatus, 80),
    lastError: redactSecrets(routine.lastError, 300),
    runCount: Number(routine.runCount || 0),
  };
}

/**
 * Scheduled routines are a Mac-agent feature — the relay has no routine store
 * of its own, and `/routines` is not on the ops proxy's allowlist, so this call
 * is expected to come back refused rather than empty. Report that plainly:
 * "no routines" and "cannot see routines from here" are very different facts
 * and the schedule section must not show the first when it means the second.
 */
export const GET: RequestHandler = async ({ locals }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();

  const proxied = await opsProxy(client, "/routines");
  if (proxied.ok) {
    const routines = Array.isArray(proxied.payload?.routines)
      ? proxied.payload.routines
      : [];
    return Response.json(
      { ok: true, routines: routines.slice(0, 60).map(publicRoutine), note: "" },
      { headers: NO_STORE_HEADERS },
    );
  }

  return Response.json(
    {
      ok: true,
      routines: [],
      note: `Scheduled routines are not readable from the cloud dashboard. ${proxied.error} They run on the Mac whether or not anything is watching; each run still lands in the job list above.`,
    },
    { headers: NO_STORE_HEADERS },
  );
};
