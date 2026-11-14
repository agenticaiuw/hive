import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/relay";
import { NOT_YET } from "$lib/server/agents";

export const prerender = false;

/**
 * The agents this host can hand a task to (the desktop app answers the same route with the ones
 * it can reach). The website lists Hive, not reachable yet.
 */
export const GET: RequestHandler = () =>
  json(
    { agents: [{ id: "hive-mac", name: "Hive", where: "your Mac", available: false, note: NOT_YET }] },
    { headers: NO_STORE_HEADERS },
  );
