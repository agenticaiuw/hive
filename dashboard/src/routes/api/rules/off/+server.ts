import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/http";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/**
 * The owner turning a standing rule off: `{machine, id}`. The board turns it (and the same words set
 * on another machine) off at once; each machine's ledger turns its copy off on its next sync.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await request.json().catch(() => ({}));
  const answer = await askBoard(locals.runtimeEnv, "/v1/rules/off", {
    method: "POST",
    body: { machine: body?.machine, id: Number(String(body?.id ?? "").replace(/^R/i, "")) },
  });
  if (!answer.ok) return answer.response;
  return json(answer.value, { headers: NO_STORE_HEADERS });
};
