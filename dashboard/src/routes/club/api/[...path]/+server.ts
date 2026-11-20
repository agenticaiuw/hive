import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/http";
import { askBoard, boardFile } from "$lib/server/tasks";

export const prerender = false;

/*
 * The club page's way to the board (cloud/tasks/club.js), as the member signed in here. Their invite
 * (POST join {invite}) becomes their own key, kept in an HttpOnly cookie and sent to the board on each
 * call, so the page never holds it and the machines' token never leaves this server for a member.
 * Only the club's own routes go through; everything else of the owner's stays behind the owner's sign-in.
 * GET download/mac is Hive for Mac itself (Hive.dmg), passed through as the board sends it.
 */
const COOKIE = "__Host-hive_club";
const YEAR = 365 * 86400;
const GETS = new Set(["me", "board", "devices", "team/inbox", "team/agents", "team/claims"]);
const POSTS = new Set(["requests", "stop", "devices/code", "team/send", "team/claim", "team/release"]);

const answer = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  json(value, { status, headers: { ...NO_STORE_HEADERS, ...headers } });
const cookie = (value: string, age: number) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;

function keyOf(request: Request): string {
  const value = (request.headers.get("cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1) ?? "";
  return /^club\.[a-z0-9_-]{1,40}\.[0-9a-f]{64}$/.test(value) ? value : "";
}

export const GET: RequestHandler = async ({ locals, params, request, url }) => {
  if (!GETS.has(params.path) && params.path !== "download/mac") return answer({ error: "Not found" }, 404);
  const key = keyOf(request);
  if (!key) return answer({ error: "Sign in with the invite link the club's owner sent you." }, 401);
  if (params.path === "download/mac") {
    const file = await boardFile(locals.runtimeEnv, "/v1/club/download/mac", key);
    if (!file.ok) return file;
    const headers: Record<string, string> = { ...NO_STORE_HEADERS, "content-type": "application/x-apple-diskimage", "content-disposition": 'attachment; filename="Hive.dmg"' };
    const length = file.headers.get("content-length");
    if (length) headers["content-length"] = length;
    return new Response(file.body, { headers });
  }
  const asked = await askBoard(locals.runtimeEnv, `/v1/club/${params.path}${url.search}`, { token: key, statuses: true });
  return asked.ok ? answer(asked.value) : asked.response;
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const body = await request.json().catch(() => ({}));
  if (params.path === "join") {
    const joined = await askBoard(locals.runtimeEnv, "/v1/club/join", {
      method: "POST",
      body: { invite: String(body?.invite ?? "").trim() },
      statuses: true,
    });
    if (!joined.ok) return joined.response;
    return answer({ name: joined.value.name }, 200, { "set-cookie": cookie(joined.value.key, YEAR) });
  }
  if (params.path === "leave") return answer({ ok: true }, 200, { "set-cookie": cookie("", 0) });
  if (!POSTS.has(params.path)) return answer({ error: "Not found" }, 404);
  const key = keyOf(request);
  if (!key) return answer({ error: "Sign in with the invite link the club's owner sent you." }, 401);
  const asked = await askBoard(locals.runtimeEnv, `/v1/club/${params.path}`, { method: "POST", body, token: key, statuses: true });
  return asked.ok ? answer(asked.value) : asked.response;
};
