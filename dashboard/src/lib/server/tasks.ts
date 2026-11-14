import { json } from "@sveltejs/kit";
import type { RuntimeEnv } from "./env";
import { NO_STORE_HEADERS } from "./relay";

/**
 * Asks the task board Worker (cloud/tasks), through its service binding (`TASKS`, or `TASKS_URL`),
 * signed in as a machine with `TASKS_TOKEN`. Answers the board's JSON, or a JSON error response
 * to hand straight back to the page.
 */
export async function askBoard(
  env: RuntimeEnv,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: true; value: any } | { ok: false; response: Response }> {
  const fail = (error: string, status: number) => ({
    ok: false as const,
    response: json({ error }, { status, headers: NO_STORE_HEADERS }),
  });
  if (!env.TASKS_TOKEN || (!env.TASKS && !env.TASKS_URL)) {
    return fail("The task board isn't connected (TASKS_TOKEN and the TASKS binding).", 503);
  }
  const request: RequestInit = {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${env.TASKS_TOKEN}`,
      "user-agent": "hive-dashboard",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  };
  let response: Response;
  try {
    response = env.TASKS
      ? await env.TASKS.fetch(`https://hive-tasks${path}`, request)
      : await fetch(`${String(env.TASKS_URL).replace(/\/+$/, "")}${path}`, request);
  } catch {
    return fail("Couldn't reach the task board.", 502);
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) return fail(value?.error || `The task board said ${response.status}.`, response.status === 400 ? 400 : 502);
  return { ok: true, value };
}
