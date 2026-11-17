import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/relay";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/**
 * Talking to one agent: `{machine, run, text, from}` for an agent on a node (a Claude Code or Codex
 * session, Hive on a Mac, a browser's agent), `{request, text, from}` for Hive's cloud agent (a
 * follow-up to that request). The words wait in the cloud for the agent's node to take them.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await request.json().catch(() => ({}));
  const answer = await askBoard(locals.runtimeEnv, "/v1/runs/message", {
    method: "POST",
    body: {
      machine: body?.machine,
      run: body?.run,
      request: body?.request,
      text: String(body?.text ?? ""),
      from: String(body?.from ?? "web").slice(0, 40),
    },
  });
  if (!answer.ok) return answer.response;
  return json(answer.value, { headers: NO_STORE_HEADERS });
};
