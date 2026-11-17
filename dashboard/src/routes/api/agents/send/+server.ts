import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/http";
import { ORCHESTRATOR } from "$lib/server/agents";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/**
 * `{agent, text}` → `{accepted, receiptId, ahead}`: queues the instruction for Hive's orchestrator in
 * the cloud, which takes it within seconds (or `ahead` requests later). It shows on the board at once.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await request.json().catch(() => ({}));
  const text = String(body?.text ?? "").trim();
  if (!text) return json({ accepted: false, error: "Say what to do." }, { status: 400, headers: NO_STORE_HEADERS });
  if (body?.agent && body.agent !== ORCHESTRATOR.id) {
    return json({ accepted: false, error: "From the website, instructions go to Hive in the cloud." }, {
      status: 400,
      headers: NO_STORE_HEADERS,
    });
  }
  const answer = await askBoard(locals.runtimeEnv, "/v1/requests", {
    method: "POST",
    // Which device it came from ("web", "phone", "extension"), so the agent knows where you are.
    body: { text, agent: ORCHESTRATOR.id, from: String(body?.from ?? "web").slice(0, 40) },
  });
  if (!answer.ok) return answer.response;
  return json(
    { accepted: true, receiptId: `R${answer.value.id}`, ahead: Number(answer.value.ahead) || 0 },
    { headers: NO_STORE_HEADERS },
  );
};
