import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/http";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/** `{name}`: lets a club member go; their key stops working at once (cloud/tasks/club.js). */
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await request.json().catch(() => ({}));
  const answer = await askBoard(locals.runtimeEnv, "/v1/club/members/remove", { method: "POST", body: { name: String(body?.name ?? "") } });
  if (!answer.ok) return answer.response;
  return json(answer.value, { headers: NO_STORE_HEADERS });
};
