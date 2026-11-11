import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  opsProxy,
  relayClient,
  strictIdentifier,
} from "$lib/server/relay";

export const prerender = false;

/* Both sit under the ops proxy's `/jobs` prefix, so both are reachable. */
const ACTIONS = new Set(["cancel", "undo"]);

export const POST: RequestHandler = async ({ locals, params }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();

  const jobId = strictIdentifier(params.jobId);
  const action = String(params.action || "");
  if (!jobId || !ACTIONS.has(action)) {
    return Response.json(
      { ok: false, error: "Unknown job action." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const proxied = await opsProxy(
    client,
    `/jobs/${encodeURIComponent(jobId)}/${action}`,
    { method: "POST" },
  );
  if (!proxied.ok) {
    return Response.json(
      { ok: false, error: proxied.error },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }

  return Response.json(proxied.payload, { headers: NO_STORE_HEADERS });
};
