import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/relay";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/**
 * Every machine's tasks and the folders they're in, from the task board Worker (cloud/tasks).
 * Answers what every host answers: `{source: "cloud", board}` (see $lib/tasks).
 */
export const GET: RequestHandler = async ({ locals }) => {
  const answer = await askBoard(locals.runtimeEnv, "/v1/board");
  if (!answer.ok) return answer.response;
  return json({ source: "cloud", board: answer.value }, { headers: NO_STORE_HEADERS });
};
