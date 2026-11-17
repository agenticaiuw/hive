import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/relay";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/**
 * The owner acting on a task: `{machine, id, action: "cancel" | "continue" | "answer", text?, from}`.
 * A cancel drops it at once; continue and answer go to the agent that has the task.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await request.json().catch(() => ({}));
  const answer = await askBoard(locals.runtimeEnv, "/v1/tasks/act", {
    method: "POST",
    body: {
      machine: body?.machine,
      id: Number(String(body?.id ?? "").replace(/^T/i, "")),
      action: body?.action,
      text: String(body?.text ?? ""),
      from: String(body?.from ?? "web").slice(0, 40),
    },
  });
  if (!answer.ok) return answer.response;
  return json(answer.value, { headers: NO_STORE_HEADERS });
};
