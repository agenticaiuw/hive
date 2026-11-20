import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/http";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/**
 * The owner's iPhone on the board (cloud/tasks/phone.js): `{connected, version, passcode, paused}`,
 * whether Hive Phone is connected, and whether a passcode is saved or unlocking is paused.
 */
export const GET: RequestHandler = async ({ locals }) => {
  const answer = await askBoard(locals.runtimeEnv, "/v1/phone/health");
  if (!answer.ok) return answer.response;
  return json(answer.value, { headers: NO_STORE_HEADERS });
};
