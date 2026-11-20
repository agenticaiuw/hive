import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/http";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/**
 * The iPhone's passcode for unlocking it, kept sealed on the board (cloud/tasks/phone.js):
 * `{passcode, consent: true}` saves it, `{remove: true}` forgets it, `{retry: true, consent: true}`
 * allows another try after one the iPhone didn't confirm. Never answers with the passcode.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await request.json().catch(() => ({}));
  const answer = await askBoard(locals.runtimeEnv, "/v1/phone/agent/unlock", {
    method: "POST",
    body: {
      ...(typeof body.passcode === "string" ? { passcode: body.passcode } : {}),
      ...(body.consent === true ? { consent: true } : {}),
      ...(body.remove === true ? { remove: true } : {}),
      ...(body.retry === true ? { retry: true } : {}),
    },
  });
  if (!answer.ok) return answer.response;
  return json(answer.value, { headers: NO_STORE_HEADERS });
};
