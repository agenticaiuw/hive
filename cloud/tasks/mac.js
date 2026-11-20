// The owner's Macs, driven through the cloud by Hive's agent on the VM (owner, 2026-11-18: "The Mac's
// agent still thinks on the Mac... the design goal is a cloud brain driving the Mac"; 2026-11-16:
// "every node should be able to reach every other node: through the cloud"). The agent's `mac` tool
// server (cloud/vm-agent/mac-mcp.mjs) posts a call to one of the Mac's tools; Hive on the Mac
// (hive-app's mac_peer.rs) asks for its next call, runs it with its own Mac tools (hive-mac MacTools,
// with all their rules: the owner taking the mouse and keyboard, one-way steps quoting the owner) and
// posts the result; the sender waits for that. Both sides hold the machines' token.
//
//   POST /v1/mac/hello {mac, tools, about}                           the Mac, when it starts
//   GET  /v1/mac/next?mac=<name>&wait=20                              the Mac
//   POST /v1/mac/result {id, result}                                  the Mac
//   POST /v1/mac/calls {name, arguments, mac?, request?, wait?}       the agent
//   GET  /v1/mac/calls?id=7&wait=20                                   the agent
//   POST /v1/mac/cancel {id}                                          the agent
//   GET  /v1/mac/status?tools=1                                       the agent
//
// A call runs once: the Mac takes it (running) before it acts, and one it took but never answered
// for is lost, not handed out again. The call carries the owner's own words for the request it was
// sent for (their board message), read here, so the Mac checks a one-way step against what the owner
// said and never against the agent's own brief. Tables: cloud/knowledge/migrations/0019.

// No Mac took it by then: Hive isn't running there (it asks at least every MOST_WAIT_S).
export const MAX_AGE_MS = 45_000;
// Taken this long ago with no answer: lost. A step waits up to a minute for the owner's hands to be
// still (hive-mac SHARE_WAIT), and a look or a wait takes a few seconds more.
export const RUN_MS = 5 * 60_000;
// A Mac that asked for work this recently is connected.
export const FRESH_MS = 60_000;
const MOST_WAIT_S = 25;
const KEEP_MS = 3_600_000;
const MOST_RESULT = 1_800_000;
const MOST_TOOLS = 200_000;
const FINISHED = new Set(["done", "failed", "expired", "lost", "cancelled"]);

const text = (value, max) => String(value == null ? "" : value).trim().slice(0, max);
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
const waitOf = (value) => Math.max(0, Math.min(MOST_WAIT_S, Number(value) || 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const macName = (value) => text(value, 80).toLowerCase();

/** Answers every /v1/mac/ path; `auth` is worker.js's {machineAllowed}. */
export async function macRoute(request, env, url, auth, { tickMs = 400, clock = Date.now } = {}) {
  if (!(await auth.machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const ctx = { env, tickMs, clock };
  const path = url.pathname;
  const post = request.method === "POST";
  if (path === "/v1/mac/hello" && post) return hello(request, ctx);
  if (path === "/v1/mac/next") return nextCall(url, ctx);
  if (path === "/v1/mac/result" && post) return saveResult(request, ctx);
  if (path === "/v1/mac/calls" && post) return sendCall(request, ctx);
  if (path === "/v1/mac/calls") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id < 1) return json({ error: "Say which call (id)." }, 400);
    return answer(id, waitOf(url.searchParams.get("wait")), ctx);
  }
  if (path === "/v1/mac/cancel" && post) return cancelCall(request, ctx);
  if (path === "/v1/mac/status") return json({ macs: await connected(ctx, url.searchParams.get("tools") === "1") });
  return json({ error: "No such page." }, 404);
}

async function connected({ env, clock }, withTools = false) {
  const rows = await env.DB.prepare("SELECT name, about, tools, seen_at FROM board_macs WHERE seen_at > ?1 ORDER BY seen_at DESC")
    .bind(clock() - FRESH_MS)
    .all();
  return rows.results.map((r) => ({
    name: r.name, about: r.about, seen_at: r.seen_at, ...(withTools ? { tools: parse(r.tools) ?? [] } : {}),
  }));
}

// POST /v1/mac/hello: the Mac's name, what it is and its tools, for the agent's tool list.
async function hello(request, { env, clock }) {
  const body = await request.json().catch(() => ({}));
  const mac = macName(body.mac);
  if (!mac) return json({ error: "Say which Mac (mac)." }, 400);
  const tools = Array.isArray(body.tools) ? body.tools.filter((t) => t && typeof t.name === "string") : [];
  const encoded = JSON.stringify(tools);
  if (encoded.length > MOST_TOOLS) return json({ error: "That tool list is too big." }, 413);
  await env.DB.prepare(
    `INSERT INTO board_macs (name, tools, about, seen_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (name) DO UPDATE SET tools = excluded.tools, about = excluded.about, seen_at = excluded.seen_at`,
  ).bind(mac, encoded, text(body.about, 500), clock()).run();
  return json({ ok: true, tools: tools.length });
}

// The owner's own words for a request (and the one it follows): what a one-way step must quote.
async function wordsOf(env, id) {
  if (!id) return "";
  const row = await env.DB.prepare(
    `SELECT m.text, r.follows, (SELECT text FROM board_messages WHERE machine = 'cloud' AND id = r.follows) AS earlier
     FROM board_requests r LEFT JOIN board_messages m ON m.machine = 'cloud' AND m.id = r.id WHERE r.id = ?1`,
  ).bind(id).first();
  return [row?.earlier, row?.text].filter(Boolean).join("\n");
}

// GET /v1/mac/next?mac=<name>&wait=20: the Mac takes its next call, if one comes.
async function nextCall(url, ctx) {
  const { env, clock, tickMs } = ctx;
  const mac = macName(url.searchParams.get("mac"));
  if (!mac) return json({ error: "Say which Mac (mac)." }, 400);
  const deadline = clock() + waitOf(url.searchParams.get("wait")) * 1000;
  await env.DB.prepare(
    `INSERT INTO board_macs (name, seen_at) VALUES (?1, ?2)
     ON CONFLICT (name) DO UPDATE SET seen_at = excluded.seen_at`,
  ).bind(mac, clock()).run();
  for (;;) {
    const at = clock();
    const row = await env.DB.prepare(
      `UPDATE board_mac_calls SET status = 'running', taken_by = ?1, taken_at = ?2
       WHERE id = (SELECT id FROM board_mac_calls WHERE status = 'queued' AND created_at > ?3 AND mac IN ('', ?1)
                   ORDER BY id LIMIT 1)
       RETURNING id, name, arguments, request`,
    ).bind(mac, at, at - MAX_AGE_MS).first();
    if (row) {
      return json({
        call: { id: row.id, name: row.name, arguments: parse(row.arguments) ?? {}, request: row.request, words: await wordsOf(env, row.request) },
      });
    }
    if (at >= deadline) return json({ call: null });
    await sleep(tickMs);
  }
}

// POST /v1/mac/result {id, result}: what came of a call this Mac took (the tool's MCP result).
async function saveResult(request, { env, clock }) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return json({ error: "Say which call (id)." }, 400);
  const given = body.result && typeof body.result === "object" && !Array.isArray(body.result) ? body.result : null;
  let outcome = given && Array.isArray(given.content)
    ? { content: given.content, ...(given.isError ? { isError: true } : {}) }
    : { error: text(body.error ?? given?.error, 2000) || "It failed." };
  let encoded = JSON.stringify(outcome);
  if (encoded.length > MOST_RESULT) {
    outcome = { error: `What came back was too big to send (${encoded.length} bytes).` };
    encoded = JSON.stringify(outcome);
  }
  const done = await env.DB.prepare(
    "UPDATE board_mac_calls SET status = ?2, result = ?3, done_at = ?4 WHERE id = ?1 AND status = 'running'",
  ).bind(id, outcome.error ? "failed" : "done", encoded, clock()).run();
  return json({ ok: true, saved: done.meta.changes });
}

// POST /v1/mac/calls: queue one; with `wait`, also wait for what came of it.
async function sendCall(request, ctx) {
  const { env, clock } = ctx;
  const body = await request.json().catch(() => ({}));
  const name = text(body.name, 80);
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return json({ error: "Say which tool (name)." }, 400);
  const args = body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments) ? body.arguments : {};
  const encoded = JSON.stringify(args);
  if (encoded.length > 60_000) return json({ error: "That call is too big." }, 413);
  const sentFor = Number.isInteger(body.request) && body.request > 0 ? body.request : null;
  const at = clock();
  const [, , made] = await env.DB.batch([
    env.DB.prepare("DELETE FROM board_mac_calls WHERE created_at < ?1").bind(at - KEEP_MS),
    env.DB.prepare("UPDATE board_mac_calls SET status = 'expired', done_at = ?1 WHERE status = 'queued' AND created_at < ?2")
      .bind(at, at - MAX_AGE_MS),
    env.DB.prepare(
      "INSERT INTO board_mac_calls (mac, request, name, arguments, status, created_at) VALUES (?1, ?2, ?3, ?4, 'queued', ?5) RETURNING id",
    ).bind(macName(body.mac), sentFor, name, encoded, at),
  ]);
  return answer(made.results[0].id, waitOf(body.wait), ctx);
}

async function answer(id, wait, ctx) {
  const { env, clock, tickMs } = ctx;
  const deadline = clock() + wait * 1000;
  for (;;) {
    const row = await env.DB.prepare(
      "SELECT id, status, result, taken_by, created_at, taken_at FROM board_mac_calls WHERE id = ?1",
    ).bind(id).first();
    if (!row) return json({ error: "No such call." }, 404);
    const at = clock();
    let status = row.status;
    if (status === "queued" && at - row.created_at > MAX_AGE_MS) status = "expired";
    if (status === "running" && at - row.taken_at > RUN_MS) status = "lost";
    if (status !== row.status) {
      await env.DB.prepare("UPDATE board_mac_calls SET status = ?2, done_at = ?3 WHERE id = ?1 AND status = ?4")
        .bind(id, status, at, row.status).run();
    }
    if (FINISHED.has(status) || at >= deadline) {
      const call = { id: row.id, status, mac: row.taken_by || "" };
      const result = parse(row.result);
      if (result?.error) call.error = result.error;
      else if (result) call.result = result;
      if (status === "expired") call.error = "No Mac took it: Hive isn't running on the owner's Mac, or it's offline.";
      if (status === "lost") call.error = "The Mac took it but never answered (Hive may have quit mid-call).";
      if (status === "cancelled") call.error = "Its sender gave up on it before the Mac took it.";
      return json(status === "queued" || status === "expired" ? { call, macs: await connected(ctx) } : { call });
    }
    await sleep(tickMs);
  }
}

// POST /v1/mac/cancel {id}: the sender gave up on a call no Mac has taken, so none runs it late.
async function cancelCall(request, { env, clock }) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return json({ error: "Say which call (id)." }, 400);
  const done = await env.DB.prepare(
    "UPDATE board_mac_calls SET status = 'cancelled', done_at = ?2 WHERE id = ?1 AND status = 'queued'",
  ).bind(id, clock()).run();
  return json({ ok: true, cancelled: done.meta.changes });
}
