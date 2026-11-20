import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/http";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/** The club's members (cloud/tasks/club.js): `{members: [{name, max_agents, joined, going, invited, seen_at}]}`. */
export const GET: RequestHandler = async ({ locals }) => {
  const answer = await askBoard(locals.runtimeEnv, "/v1/club/members");
  if (!answer.ok) return answer.response;
  return json(answer.value, { headers: NO_STORE_HEADERS });
};

/**
 * `{name, max_agents?}` → `{name, max_agents, link, expires_in}`: lets a member in (or invites them again).
 * The link is theirs to open once, on the club page here; the owner hands it to them.
 */
export const POST: RequestHandler = async ({ locals, request, url }) => {
  const body = await request.json().catch(() => ({}));
  const answer = await askBoard(locals.runtimeEnv, "/v1/club/members", {
    method: "POST",
    body: { name: String(body?.name ?? ""), max_agents: body?.max_agents },
  });
  if (!answer.ok) return answer.response;
  const { name, max_agents, invite, expires_in } = answer.value;
  return json({ name, max_agents, expires_in, link: `${url.origin}/club?invite=${invite}` }, { headers: NO_STORE_HEADERS });
};
