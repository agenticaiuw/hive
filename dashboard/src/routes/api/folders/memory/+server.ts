import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/relay";
import { askBoard } from "$lib/server/tasks";

export const prerender = false;

/** `{project, folder, kind?, title, body}`: a memory every agent in the folder gets from now on. */
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await request.json().catch(() => ({}));
  const answer = await askBoard(locals.runtimeEnv, "/v1/folders/memory", {
    method: "POST",
    body: { project: body?.project, folder: body?.folder, kind: body?.kind, title: body?.title, body: body?.body },
  });
  if (!answer.ok) return answer.response;
  return json(answer.value, { headers: NO_STORE_HEADERS });
};
