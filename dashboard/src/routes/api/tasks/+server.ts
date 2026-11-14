import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/relay";

export const prerender = false;

/**
 * Every machine's tasks, from the task board Worker (cloud/tasks) through its service binding
 * (`TASKS`, or `TASKS_URL`), signed in as a machine with `TASKS_TOKEN`. Answers what every host
 * answers: `{source: "cloud", board}` (see $lib/tasks).
 */
export const GET: RequestHandler = async ({ locals }) => {
  const env = locals.runtimeEnv;
  const fail = (error: string, status: number) =>
    json({ error }, { status, headers: NO_STORE_HEADERS });
  if (!env.TASKS_TOKEN || (!env.TASKS && !env.TASKS_URL)) {
    return fail("The task board isn't connected (TASKS_TOKEN and the TASKS binding).", 503);
  }
  const init = {
    headers: { authorization: `Bearer ${env.TASKS_TOKEN}`, "user-agent": "hive-dashboard" },
  };
  let response: Response;
  try {
    response = env.TASKS
      ? await env.TASKS.fetch("https://hive-tasks/v1/board", init)
      : await fetch(`${String(env.TASKS_URL).replace(/\/+$/, "")}/v1/board`, init);
  } catch {
    return fail("Couldn't reach the task board.", 502);
  }
  if (!response.ok) return fail(`The task board said ${response.status}.`, 502);
  return json({ source: "cloud", board: await response.json() }, { headers: NO_STORE_HEADERS });
};
