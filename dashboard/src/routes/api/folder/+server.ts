import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/relay";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/** `?project=hive&key=memory retrieval` → `{folder, memories}`: the folder and all its memories. */
export const GET: RequestHandler = async ({ locals, url }) => {
  const query = new URLSearchParams({
    project: url.searchParams.get("project") ?? "",
    key: url.searchParams.get("key") ?? "",
  });
  const answer = await askBoard(locals.runtimeEnv, `/v1/folder?${query}`);
  if (!answer.ok) return answer.response;
  return json(answer.value, { headers: NO_STORE_HEADERS });
};
