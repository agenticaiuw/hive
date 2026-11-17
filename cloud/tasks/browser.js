// The owner's browsers, reached through the cloud (owner, 2026-11-16: "every node should be able to
// reach every other node: through the cloud"). An agent on any node (Hive's agent on the VM, Hive on a
// Mac) sends a command for the owner's browser with the machines' token; the Hive extension in the
// owner's Safari or Chrome asks for its next one with its own key, runs it in that signed-in browser
// (browser/chrome/src/executor.js) and sends back what came of it; the sender waits for that.
//
//   POST /v1/browser/commands {action: {type, params}, browser?, request?, wait?}  machines
//   GET  /v1/browser/commands?id=7&wait=20                                          machines
//   POST /v1/browser/cancel {id}                                                    machines
//   GET  /v1/browser/status                                                         machines
//   GET  /v1/browser/next?browser=safari&wait=20                                    the extension
//   POST /v1/browser/result {id, ok, result | error}                                the extension
//
// "wait" holds the answer open up to that many seconds until there is something to say, so nobody
// polls fast. A command runs once: the extension takes it (running) before it acts, and one it took
// but never answered for is lost, not handed out again. Tables: cloud/knowledge/migrations/0012.

// What the extension runs (bridge-core.js COMMAND_TYPES).
export const COMMAND_TYPES = new Set([
  "navigate", "click", "type", "read_page", "snapshot", "wait_for", "scroll", "select",
  "list_tabs", "capture", "press_key", "activate_tab",
]);
// The extension refuses a command queued longer ago than this (bridge-core.js MAX_COMMAND_AGE_MS), so
// one nobody took by then has expired here too.
export const MAX_AGE_MS = 90_000;
// A command taken this long ago with no answer is lost (Safari stopped the extension mid-command).
export const RUN_MS = 120_000;
// A browser that asked for work this recently is connected; it asks again at least every MOST_WAIT_S.
export const FRESH_MS = 60_000;
const MOST_WAIT_S = 25;
const KEEP_MS = 3_600_000;
// D1 keeps up to 2 MB in one value; a tab capture fits.
const MOST_RESULT = 1_800_000;
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

/**
 * Answers every /v1/browser/ path. `auth` is worker.js's own checks ({machineAllowed,
 * extensionAllowed}), so the keys are checked in one place; `tickMs` is how often a held answer looks
 * again (tests make it short).
 */
export async function browserRoute(request, env, url, auth, { tickMs = 700, clock = Date.now } = {}) {
  const ctx = { env, auth, tickMs, clock };
  const path = url.pathname;
  if (path === "/v1/browser/commands" && request.method === "POST") return sendCommand(request, ctx);
  if (path === "/v1/browser/commands") return commandState(url, request, ctx);
  if (path === "/v1/browser/cancel" && request.method === "POST") return cancelCommand(request, ctx);
  if (path === "/v1/browser/status") return browserStatus(request, ctx);
  if (path === "/v1/browser/next") return nextCommand(url, request, ctx);
  if (path === "/v1/browser/result" && request.method === "POST") return saveResult(request, ctx);
  return json({ error: "No such page." }, 404);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The browser asking: "<extension key name>/<safari|chrome>". The key is already checked, so its
// name is the part after "ext.".
function browserName(request, kind) {
  // Lowercase, as a sender's `browser` is, so a sender can name the browser that ran its last one.
  const name = ((request.headers.get("authorization") || "").slice(7).split(".")[1] || "browser").toLowerCase();
  return `${name}/${kind === "chrome" ? "chrome" : kind === "safari" ? "safari" : "browser"}`;
}

async function connected({ env, clock }) {
  const rows = await env.DB.prepare("SELECT name, seen_at FROM board_browsers WHERE seen_at > ?1 ORDER BY seen_at DESC")
    .bind(clock() - FRESH_MS)
    .all();
  return rows.results.map((r) => r.name);
}

// POST /v1/browser/commands: queue one; with `wait`, also wait for what came of it.
async function sendCommand(request, ctx) {
  const { env, auth, clock } = ctx;
  if (!(await auth.machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json().catch(() => ({}));
  const action = body && typeof body.action === "object" && body.action ? body.action : {};
  const type = text(action.type, 40);
  if (!COMMAND_TYPES.has(type)) {
    return json({ error: `Say what to do (action.type: one of ${[...COMMAND_TYPES].join(", ")}).` }, 400);
  }
  const params = action.params && typeof action.params === "object" && !Array.isArray(action.params) ? action.params : {};
  const encoded = JSON.stringify({ type, params });
  if (encoded.length > 60_000) return json({ error: "That command is too big." }, 413);
  const browser = text(body.browser, 120).toLowerCase();
  const sentFor = Number.isInteger(body.request) && body.request > 0 ? body.request : null;
  const at = clock();
  const [, , made] = await env.DB.batch([
    env.DB.prepare("DELETE FROM board_browser_commands WHERE created_at < ?1").bind(at - KEEP_MS),
    env.DB.prepare("UPDATE board_browser_commands SET status = 'expired', done_at = ?1 WHERE status = 'queued' AND created_at < ?2")
      .bind(at, at - MAX_AGE_MS),
    env.DB.prepare(
      "INSERT INTO board_browser_commands (browser, request, action, status, created_at) VALUES (?1, ?2, ?3, 'queued', ?4) RETURNING id",
    ).bind(browser, sentFor, encoded, at),
  ]);
  const id = made.results[0].id;
  return answer(id, waitOf(body.wait), ctx);
}

// GET /v1/browser/commands?id=7&wait=20: how one command stands.
async function commandState(url, request, ctx) {
  if (!(await ctx.auth.machineAllowed(request, ctx.env))) return json({ error: "Not signed in." }, 401);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) return json({ error: "Say which command (id)." }, 400);
  return answer(id, waitOf(url.searchParams.get("wait")), ctx);
}

async function answer(id, wait, ctx) {
  const { env, clock, tickMs } = ctx;
  const deadline = clock() + wait * 1000;
  for (;;) {
    const row = await env.DB.prepare(
      "SELECT id, status, result, taken_by, created_at, taken_at FROM board_browser_commands WHERE id = ?1",
    ).bind(id).first();
    if (!row) return json({ error: "No such command." }, 404);
    const at = clock();
    let status = row.status;
    if (status === "queued" && at - row.created_at > MAX_AGE_MS) status = "expired";
    if (status === "running" && at - row.taken_at > RUN_MS) status = "lost";
    if (status !== row.status) {
      await env.DB.prepare("UPDATE board_browser_commands SET status = ?2, done_at = ?3 WHERE id = ?1 AND status = ?4")
        .bind(id, status, at, row.status).run();
    }
    if (FINISHED.has(status) || at >= deadline) {
      const result = parse(row.result);
      const command = { id: row.id, status, browser: row.taken_by || "" };
      if (result) Object.assign(command, result.ok ? { result: result.result } : { error: result.error });
      if (status === "expired") command.error = "No browser took it: the Hive extension isn't connected.";
      if (status === "lost") command.error = "The browser took it but never answered (it may have been stopped mid-command).";
      if (status === "cancelled") command.error = "Its sender gave up on it before any browser took it.";
      // Still waiting, or nobody took it: say which browsers are listening.
      return json(status === "queued" || status === "expired" ? { command, browsers: await connected(ctx) } : { command });
    }
    await sleep(tickMs);
  }
}

// POST /v1/browser/cancel {id}: the sender gave up on a command nobody has taken, so no browser runs
// it late. One already taken is left to finish.
async function cancelCommand(request, ctx) {
  const { env, auth, clock } = ctx;
  if (!(await auth.machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return json({ error: "Say which command (id)." }, 400);
  const done = await env.DB.prepare(
    "UPDATE board_browser_commands SET status = 'cancelled', done_at = ?2 WHERE id = ?1 AND status = 'queued'",
  ).bind(id, clock()).run();
  return json({ ok: true, cancelled: done.meta.changes });
}

// GET /v1/browser/status: the browsers that asked for work in the last minute.
async function browserStatus(request, ctx) {
  if (!(await ctx.auth.machineAllowed(request, ctx.env))) return json({ error: "Not signed in." }, 401);
  return json({ browsers: await connected(ctx) });
}

// GET /v1/browser/next?browser=safari&wait=20: the extension takes its next command, if one comes.
async function nextCommand(url, request, ctx) {
  const { env, auth, clock, tickMs } = ctx;
  if (!(await auth.extensionAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const kind = text(url.searchParams.get("browser"), 20).toLowerCase();
  const who = browserName(request, kind);
  const deadline = clock() + waitOf(url.searchParams.get("wait")) * 1000;
  await env.DB.prepare(
    "INSERT INTO board_browsers (name, seen_at) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET seen_at = excluded.seen_at",
  ).bind(who, clock()).run();
  for (;;) {
    const at = clock();
    const row = await env.DB.prepare(
      `UPDATE board_browser_commands SET status = 'running', taken_by = ?1, taken_at = ?2
       WHERE id = (SELECT id FROM board_browser_commands
                   WHERE status = 'queued' AND created_at > ?3 AND browser IN ('', ?4, ?1)
                   ORDER BY id LIMIT 1)
       RETURNING id, action, created_at`,
    ).bind(who, at, at - MAX_AGE_MS, kind).first();
    if (row) {
      return json({
        command: { commandId: String(row.id), createdAt: new Date(row.created_at).toISOString(), action: parse(row.action) },
      });
    }
    if (at >= deadline) return json({ command: null });
    await sleep(tickMs);
  }
}

// POST /v1/browser/result {id, ok, result | error}: what came of a command this browser took.
async function saveResult(request, ctx) {
  const { env, auth, clock } = ctx;
  if (!(await auth.extensionAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return json({ error: "Say which command (id)." }, 400);
  let outcome = body.ok ? { ok: true, result: body.result ?? null } : { ok: false, error: text(body.error, 2000) || "It failed." };
  let encoded = JSON.stringify(outcome);
  if (encoded.length > MOST_RESULT) {
    outcome = { ok: false, error: `What came back was too big to send (${encoded.length} bytes).` };
    encoded = JSON.stringify(outcome);
  }
  const done = await env.DB.prepare(
    "UPDATE board_browser_commands SET status = ?2, result = ?3, done_at = ?4 WHERE id = ?1 AND status = 'running'",
  ).bind(id, outcome.ok ? "done" : "failed", encoded, clock()).run();
  return json({ ok: true, saved: done.meta.changes });
}
