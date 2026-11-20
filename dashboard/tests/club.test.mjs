import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The club page (src/routes/club) through the real built Worker, as rendered-html.test.mjs does: it opens
// without the owner's sign-in, signs a member in with their invite (their key goes into an HttpOnly cookie,
// never the page), passes only the club's own routes to the board, as the member, and never the machines'
// token for them.
globalThis.caches ??= { default: { async match() {}, async put() {} } };
register("./support/workerd-loader.mjs", import.meta.url);

const KEY = `club.alice.${"ab".repeat(32)}`;
const asked = [];
const env = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  DASHBOARD_ACCESS_KEY: "test-pairing-code",
  DASHBOARD_SESSION_SECRET: "test-session-secret-with-enough-entropy",
  TASKS_TOKEN: "machine-token",
  TASKS: {
    async fetch(url, init) {
      const path = new URL(url).pathname + new URL(url).search;
      asked.push({ path, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
      if (path === "/v1/club/join") {
        return JSON.parse(init.body).invite === "c".repeat(48)
          ? Response.json({ name: "alice", max_agents: 3, key: KEY })
          : Response.json({ error: "That invite was used or has expired: ask for a new one." }, { status: 403 });
      }
      if (path === "/v1/club/requests") return Response.json({ error: "You have 3 changes going, the most you can at once: one has to finish first." }, { status: 429 });
      if (path === "/v1/club/members") return Response.json({ name: "bob", max_agents: 3, invite: "d".repeat(48), expires_in: 604800 });
      return Response.json({ me: "alice", requests: [] });
    },
  },
};
const context = { waitUntil() {}, passThroughOnException() {} };

async function worker() {
  const url = new URL("../.svelte-kit/cloudflare/_worker.js", import.meta.url);
  url.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(url.href)).default;
}

const call = (w, path, { method = "GET", body, cookie } = {}) =>
  w.fetch(new Request(`https://dashboard.example${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, context);

test("a member signs in on the club page with their invite and reaches only the club's routes, as themselves", async () => {
  const w = await worker();
  const page = await call(w, "/club");
  assert.equal(page.status, 200, "no owner sign-in needed");
  assert.match(await page.text(), /Hive club/);

  assert.equal((await call(w, "/club/api/board")).status, 401);
  assert.equal(asked.length, 0, "the board isn't asked for someone not signed in");

  assert.equal((await call(w, "/club/api/join", { method: "POST", body: { invite: "e".repeat(48) } })).status, 403);
  const joined = await call(w, "/club/api/join", { method: "POST", body: { invite: "c".repeat(48) } });
  assert.equal(joined.status, 200);
  assert.deepEqual(await joined.json(), { name: "alice" }, "the key stays out of the page");
  const set = joined.headers.get("set-cookie");
  assert.equal(set, `__Host-hive_club=${KEY}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
  const cookie = set.split(";", 1)[0];

  asked.length = 0;
  assert.equal((await call(w, "/club/api/board", { cookie })).status, 200);
  assert.deepEqual(asked.at(-1), { path: "/v1/club/board", auth: `Bearer ${KEY}`, body: undefined });
  await call(w, "/club/api/team/inbox?agent=alice", { cookie });
  assert.equal(asked.at(-1).path, "/v1/club/team/inbox?agent=alice");
  const busy = await call(w, "/club/api/requests", { method: "POST", body: { text: "a dark theme" }, cookie });
  assert.equal(busy.status, 429, "the board's own answer");
  assert.match((await busy.json()).error, /3 changes going/);
  assert.ok(asked.every((a) => a.auth === `Bearer ${KEY}`), "never the machines' token for a member");

  // Nothing but the club's routes, and the owner's stay behind the owner's sign-in.
  asked.length = 0;
  assert.equal((await call(w, "/club/api/members", { cookie })).status, 404);
  assert.equal((await call(w, "/club/api/../api/tasks", { cookie })).status, 404, "(the URL is /club/api/tasks)");
  assert.equal((await call(w, "/api/tasks", { cookie })).status, 401);
  assert.equal((await call(w, "/api/club/members", { method: "POST", body: { name: "bob" }, cookie })).status, 401);
  assert.equal(asked.length, 0);

  const left = await call(w, "/club/api/leave", { method: "POST", body: {}, cookie });
  assert.match(left.headers.get("set-cookie"), /^__Host-hive_club=; .*Max-Age=0$/);
});
