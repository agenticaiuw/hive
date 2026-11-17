import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/relay";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/**
 * One agent's conversation: `?machine&run&tail=300` (its newest steps), `&after=<n>` (what it did
 * since), `&before=<n>` (older) → `{run, steps, messages}`, `messages` being what the owner said to it
 * and how each delivery went. The same route every host answers.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  const query = new URLSearchParams();
  for (const key of ["machine", "run", "tail", "after", "before"]) {
    const value = url.searchParams.get(key);
    if (value) query.set(key, value);
  }
  if (!query.get("machine") || !query.get("run")) {
    return json({ error: "Say which agent (machine and run)." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const answer = await askBoard(locals.runtimeEnv, `/v1/runs?${query}`);
  if (!answer.ok) return answer.response;
  return json(answer.value, { headers: NO_STORE_HEADERS });
};
