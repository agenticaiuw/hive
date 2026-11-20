import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/http";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/**
 * `{pairing, source, sidestore}`: what the owner copies on the iPhone before opening Hive Phone, and
 * the SideStore source Hive Phone installs from (cloud/tasks/phone.js).
 */
export const POST: RequestHandler = async ({ locals }) => {
  const answer = await askBoard(locals.runtimeEnv, "/v1/phone/pair", { method: "POST", body: {} });
  if (!answer.ok) return answer.response;
  return json(answer.value, { headers: NO_STORE_HEADERS });
};
