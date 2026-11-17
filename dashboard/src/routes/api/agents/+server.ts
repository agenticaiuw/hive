import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/http";
import { NOT_CONNECTED, ORCHESTRATOR, boardConnected } from "$lib/server/agents";

export const prerender = false;

/**
 * The agents this host can hand a task to (the desktop app answers the same route with the ones
 * it can reach). The website hands everything to Hive's orchestrator in the cloud.
 */
export const GET: RequestHandler = ({ locals }) => {
  const available = boardConnected(locals.runtimeEnv);
  return json(
    { agents: [{ ...ORCHESTRATOR, available, ...(available ? {} : { note: NOT_CONNECTED }) }] },
    { headers: NO_STORE_HEADERS },
  );
};
