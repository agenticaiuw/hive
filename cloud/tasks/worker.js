// The owner's task board in the cloud. Every machine's hive-tasks (desktop/app/crates/hive/
// hive-tasks) pushes the messages, tasks, rules, folders and memories that changed (POST /v1/sync)
// and gets back the rules set on the owner's other machines and the folders and memories made
// elsewhere (other machines, the dashboard), so an instruction given once reaches every agent.
// The owner reads all of it on one page (/), signed in by a one-use code from `hive-tasks web`.
// Tables: cloud/knowledge/migrations/0003_task_board.sql onward (the hive-knowledge D1 database).
// The dashboard also sends instructions here for Hive's orchestrator in the cloud (/v1/requests), and
// every node's agent sends what it is doing, step by step, so every dashboard shows it live (/v1/runs).
// Any node reaches the owner's browsers through here too (/v1/browser/, browser.js), and the owner's
// knowledge base (/v1/knowledge/, knowledge.js), and Hive's agent in the cloud drives the owner's Macs
// through here (/v1/mac/, mac.js). Each node says what code it runs on every call, and gets the newest
// release for it to update to (/v1/nodes, /v1/releases, nodes.js). The owner's iPhone is reached here
// too: Hive Phone on it keeps a WebSocket open to the board, and agents' calls go down it (/v1/phone/,
// phone.js). Hive's agents message each other and lease files here (/v1/team/, team.js), and club members
// sign in here to have Hive change itself (/v1/club/, club.js).

import { browserRoute } from "./browser.js";
import { knowledgeRoute } from "./knowledge.js";
import { macRoute } from "./mac.js";
import { memberNode, nodeList, nodeOf, nodesRoute, sawNode, tooOld, versionHeaders } from "./nodes.js";
import { phoneAllowed, phoneRoute, rememberOrigin } from "./phone.js";
import { clubRoute, memberOf } from "./club.js";
import { teamRoute } from "./team.js";

// Hive Phone's relay: one Durable Object per phone (wrangler.jsonc PHONE).
export { PhoneRelay } from "./phone.js";

const DAY = 86400;
const YEAR = 365 * DAY;
const COOKIE = "hive_board";

// What the browser extension may call, with its own key (see extensionAllowed). It calls from web
// pages too (page-rules.js runs in each page), so these answer cross-origin; the key is a bearer
// token, never a cookie, so "*" lets no page act as the owner.
const EXTENSION_PATHS = new Set(["/v1/requests", "/v1/requests/state", "/v1/runs", "/v1/page-rules", "/v1/page-rules/off", "/v1/browser/next", "/v1/browser/result"]);
// The extension talks to the owner's agents and takes the messages for its own agent, with its key.
for (const path of ["/v1/runs/message", "/v1/runs/messages/take", "/v1/runs/messages/update", "/v1/tasks/act", "/v1/rules/off"]) EXTENSION_PATHS.add(path);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-hive-node, x-hive-version, x-hive-protocol",
  "access-control-expose-headers": "x-hive-protocol, x-hive-latest",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const extension = EXTENSION_PATHS.has(url.pathname);
    if (extension && request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // A node that says what it runs (nodes.js): one on routes the board no longer serves is told so
    // at once; every answer carries the board's routes and the newest release for that node.
    const node = nodeOf(request);
    const refused = tooOld(node, url);
    const response = refused ?? (await route(request, env, url));
    // A WebSocket (Hive Phone's, phone.js) goes back as it is: its answer can't be copied.
    if (response.status === 101) {
      if (node) await noteNode(request, env, node);
      return response;
    }
    if (!extension && !node) return response;
    const headers = new Headers(response.headers);
    if (extension) for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    if (node) {
      for (const [k, v] of Object.entries(await versionHeaders(env, node))) headers.set(k, v);
      if (!refused) {
        const noted = noteNode(request, env, node);
        if (ctx?.waitUntil) ctx.waitUntil(noted);
        else await noted;
      }
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  // Every minute (wrangler.jsonc triggers): stuck tasks get going again without the owner.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(continueStuck(env));
  },
};

async function route(request, env, url) {
    try {
      if (url.pathname === "/v1/sync" && request.method === "POST") return await sync(request, env);
      if (url.pathname === "/v1/login-code" && request.method === "POST") return await loginCode(request, env);
      if (url.pathname === "/login") return await login(url, env);
      if (url.pathname === "/v1/board") return await board(request, env);
      if (url.pathname === "/v1/folder") return await folder(url, request, env);
      if (url.pathname === "/v1/rules") return await projectRules(url, request, env);
      if (url.pathname === "/v1/rules/off" && request.method === "POST") return await ruleOff(request, env);
      if (url.pathname === "/v1/folders" && request.method === "POST") return await saveFolder(request, env);
      if (url.pathname === "/v1/folders/memory" && request.method === "POST") return await saveMemory(request, env);
      if (url.pathname === "/v1/requests" && request.method === "POST") return await sendRequest(request, env);
      if (url.pathname === "/v1/requests/take" && request.method === "POST") return await takeRequest(request, env);
      if (url.pathname === "/v1/requests/update" && request.method === "POST") return await updateRequest(request, env);
      if (url.pathname === "/v1/requests/state") return await requestState(url, request, env);
      if (url.pathname === "/v1/requests/context" && request.method === "GET") return await requestContext(url, request, env);
      if (url.pathname === "/v1/requests/stop" && request.method === "POST") return await stopRequest(request, env);
      if (url.pathname === "/v1/runs" && request.method === "POST") return await saveRun(request, env);
      if (url.pathname === "/v1/runs/message" && request.method === "POST") return await messageRun(request, env);
      if (url.pathname === "/v1/tasks/act" && request.method === "POST") return await actOnTask(request, env);
      if (url.pathname === "/v1/runs/messages/take" && request.method === "POST") return await takeRunMessages(request, env);
      if (url.pathname === "/v1/runs/messages/update" && request.method === "POST") return await updateRunMessage(request, env);
      if (url.pathname === "/v1/runs") return await runSteps(url, request, env);
      if (url.pathname === "/v1/extension-key" && request.method === "POST") return await extensionKey(request, env);
      if (url.pathname === "/v1/page-rules" && request.method === "GET") return await pageRules(url, request, env);
      if (url.pathname === "/v1/page-rules" && request.method === "POST") return await savePageRule(request, env);
      if (url.pathname === "/v1/page-rules/off" && request.method === "POST") return await pageRuleOff(request, env);
      if (url.pathname.startsWith("/v1/browser/")) return await browserRoute(request, env, url, { machineAllowed, extensionAllowed });
      if (url.pathname.startsWith("/v1/knowledge/")) return await knowledgeRoute(request, env, url, { machineAllowed });
      if (url.pathname.startsWith("/v1/mac/")) return await macRoute(request, env, url, { machineAllowed });
      if (url.pathname.startsWith("/v1/team/")) return await teamRoute(request, env, url, { machineAllowed });
      if (url.pathname.startsWith("/v1/club/")) return await clubRoute(request, env, url, { allowed, newRequest, teamRoute });
      if (url.pathname.startsWith("/v1/nodes") || url.pathname.startsWith("/v1/releases")) return await nodesRoute(request, env, url, { machineAllowed, anyoneAllowed, memberOf: clubMember });
      if (url.pathname.startsWith("/v1/phone/")) return await phoneRoute(request, env, url, { machineAllowed, allowed });
      if (url.pathname === "/") return await page(request, env);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return json({ error: String((error && error.message) || error) }, 500);
    }
}

const now = () => Math.floor(Date.now() / 1000);
const encode = (text) => new TextEncoder().encode(text);

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Compares through an HMAC so the comparison takes the same time whatever the guess.
async function same(a, b, key) {
  return (await hmac(key, `same:${a}`)) === (await hmac(key, `same:${b}`));
}

async function machineAllowed(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(env.TASKS_TOKEN && token && (await same(token, env.TASKS_TOKEN, env.TASKS_TOKEN)));
}

async function browserAllowed(request, env) {
  const cookies = request.headers.get("cookie") || "";
  const value = cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`));
  if (!value || !env.TASKS_TOKEN) return false;
  const [expires, mac] = value.slice(COOKIE.length + 1).split(".");
  if (!(Number(expires) > now()) || !mac) return false;
  return same(mac, await hmac(env.TASKS_TOKEN, `web:${expires}`), env.TASKS_TOKEN);
}

// ---- machines ------------------------------------------------------------------------------

const MESSAGE_COLUMNS = ["id", "harness", "session", "project", "text", "said_at", "times", "split_at"];
const TASK_COLUMNS = [
  "id", "message", "quote", "title", "status", "minutes", "value", "outcome", "evidence",
  "created_at", "updated_at", "done_at", "left_open_at", "work_seconds", "tokens_in", "tokens_out", "folder",
  "report", "files", "commits", "claimed_harness", "claimed_session",
];
const MEMORY_COLUMNS = ["id", "project", "folder", "kind", "title", "body", "task", "created_at"];
const EVENT_COLUMNS = ["id", "task", "at", "status", "note"];
const KINDS = ["note", "spec", "decision", "report"];
const text = (value, max) => String(value == null ? "" : value).trim().slice(0, max);

// A folder is one row whoever writes it: its name stays as first written, and an empty "about"
// (a folder an agent made by filing a task in it) never wipes one written elsewhere.
function upsertFolder(env, machine, row, at) {
  const updated = Number(row.updated_at) || at;
  return env.DB.prepare(
    `INSERT INTO board_folders (project, key, name, about, machine, created_at, updated_at, synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (project, key) DO UPDATE SET
       about = CASE WHEN excluded.about = '' THEN board_folders.about ELSE excluded.about END,
       machine = excluded.machine, updated_at = excluded.updated_at, synced_at = excluded.synced_at
     WHERE excluded.updated_at >= board_folders.updated_at`,
  ).bind(
    text(row.project, 120).toLowerCase(), text(row.key || row.name, 120).toLowerCase(), text(row.name, 120),
    text(row.about, 2000), machine, Number(row.created_at) || at, updated, at,
  );
}
const RULE_COLUMNS = ["id", "project", "paths", "text", "quote", "created_at", "active", "shown", "last_shown_at"];
const LIMIT_COLUMNS = ["id", "harness", "home", "plan", "windows", "at"];

// A subscription's usage windows as the machine read them (hive-tasks' plan_limits).
function limitRow(row) {
  const harness = text(row.harness, 40);
  const home = text(row.home, 200);
  return {
    id: `${harness}:${home}`, harness, home, plan: text(row.plan, 40),
    windows: JSON.stringify(Array.isArray(row.windows) ? row.windows.slice(0, 6) : []), at: Number(row.at) || null,
  };
}

function upsert(env, table, columns, machine, row, at) {
  const names = ["machine", ...columns, "synced_at"];
  const marks = names.map((_, i) => `?${i + 1}`).join(", ");
  const updates = [...columns.slice(1), "synced_at"].map((c) => `${c} = excluded.${c}`).join(", ");
  const values = [machine, ...columns.map((c) => (row[c] === undefined ? null : row[c])), at];
  return env.DB.prepare(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${marks}) ON CONFLICT (machine, id) DO UPDATE SET ${updates}`,
  ).bind(...values);
}

// A rule as a machine sends it; one the owner turned off from a dashboard stays off whatever the
// machine says, until its ledger hears of it (the sync answer's rules_off).
function upsertRule(env, machine, row, at) {
  const names = ["machine", ...RULE_COLUMNS, "synced_at"];
  const marks = names.map((_, i) => `?${i + 1}`).join(", ");
  const kept = (c) => (c === "active" ? "active = CASE WHEN board_rules.off_at IS NOT NULL THEN 0 ELSE excluded.active END" : `${c} = excluded.${c}`);
  const updates = [...RULE_COLUMNS.slice(1), "synced_at"].map(kept).join(", ");
  const values = [machine, ...RULE_COLUMNS.map((c) => (row[c] === undefined ? null : row[c])), at];
  return env.DB.prepare(
    `INSERT INTO board_rules (${names.join(", ")}) VALUES (${marks}) ON CONFLICT (machine, id) DO UPDATE SET ${updates}`,
  ).bind(...values);
}

// A task as a machine sends it; one the owner cancelled stays dropped whatever an agent says later
// (only done goes through), until the machine's ledger hears of the cancel.
function upsertTask(env, machine, row, at) {
  const names = ["machine", ...TASK_COLUMNS, "synced_at"];
  const marks = names.map((_, i) => `?${i + 1}`).join(", ");
  const kept = (c) =>
    c === "status" ? "status = CASE WHEN board_tasks.cancelled_at IS NOT NULL AND excluded.status != 'done' THEN 'dropped' ELSE excluded.status END"
      : c === "outcome" ? "outcome = CASE WHEN board_tasks.cancelled_at IS NOT NULL AND excluded.status != 'done' THEN board_tasks.outcome ELSE excluded.outcome END"
        : `${c} = excluded.${c}`;
  const updates = [...TASK_COLUMNS.slice(1), "synced_at"].map(kept).join(", ");
  const values = [machine, ...TASK_COLUMNS.map((c) => (row[c] === undefined ? null : row[c])), at];
  return env.DB.prepare(
    `INSERT INTO board_tasks (${names.join(", ")}) VALUES (${marks}) ON CONFLICT (machine, id) DO UPDATE SET ${updates}`,
  ).bind(...values);
}

async function sync(request, env) {
  if (!(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json();
  const machine = String(body.machine || "").trim().slice(0, 80);
  if (!machine) return json({ error: "Say which machine (machine)." }, 400);
  const at = now();
  const statements = [
    ...(body.messages || []).map((r) => upsert(env, "board_messages", MESSAGE_COLUMNS, machine, r, at)),
    // A task's folder was first called its part (older hive-tasks still send that).
    ...(body.tasks || []).map((r) =>
      upsertTask(env, machine, r.folder === undefined ? { ...r, folder: r.part } : r, at),
    ),
    ...(body.rules || []).map((r) => upsertRule(env, machine, r, at)),
    ...(body.folders || []).map((r) => upsertFolder(env, machine, r, at)),
    ...(body.memories || []).map((r) => upsert(env, "board_memories", MEMORY_COLUMNS, machine, r, at)),
    ...(body.events || []).map((r) => upsert(env, "board_task_events", EVENT_COLUMNS, machine, r, at)),
    ...(body.limits || []).slice(0, 10).map((r) => upsert(env, "board_limits", LIMIT_COLUMNS, machine, limitRow(r), at)),
  ];
  // Readings from an account no longer signed in on the machine (signed out, or another plan now)
  // leave the board: hive-tasks names them (limits_gone, "codex:~/.codex"). Only those named go, since
  // a machine's rows have more than one writer (Hive's orchestrator puts its own Codex's on the VM's).
  if (Array.isArray(body.limits_gone) && body.limits_gone.length) {
    const reported = new Set((body.limits || []).map((r) => limitRow(r).id));
    const gone = body.limits_gone.slice(0, 10).map((id) => text(id, 260)).filter((id) => id && !reported.has(id));
    statements.push(
      env.DB.prepare("DELETE FROM board_limits WHERE machine = ?1 AND id IN (SELECT value FROM json_each(?2))")
        .bind(machine, JSON.stringify(gone)),
    );
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  const since = Number(body.since) || 0;
  const [rules, folders, memories, cancelled, rulesOff] = await env.DB.batch([
    env.DB.prepare(
      "SELECT machine, id, project, paths, text, quote, created_at, active FROM board_rules WHERE machine != ?1",
    ).bind(machine),
    // Every folder changed since the machine last asked, its own pushes too (they come back merged).
    env.DB.prepare(
      "SELECT project, key, name, about, created_at, updated_at FROM board_folders WHERE synced_at >= ?1",
    ).bind(since),
    env.DB.prepare(
      `SELECT machine, id, project, folder, kind, title, body, task, created_at FROM board_memories
       WHERE machine != ?1 AND synced_at >= ?2 ORDER BY synced_at LIMIT 2000`,
    ).bind(machine, since),
    // Tasks the owner cancelled from a dashboard since the machine last asked: its ledger drops them.
    env.DB.prepare("SELECT id FROM board_tasks WHERE machine = ?1 AND cancelled_at >= ?2").bind(machine, since),
    // This machine's rules the owner turned off from a dashboard: its ledger turns them off (a rule
    // already off there is left alone, so this is safe to send every time).
    env.DB.prepare("SELECT id FROM board_rules WHERE machine = ?1 AND off_at IS NOT NULL").bind(machine),
  ]);
  return json({
    saved: statements.length, now: at, rules: rules.results, folders: folders.results, memories: memories.results,
    cancelled: cancelled.results.map((r) => r.id), rules_off: rulesOff.results.map((r) => r.id),
  });
}

// POST /v1/rules/off {machine, id}: the owner turning a standing rule off from a dashboard. The same
// rule set on more than one machine (the same words) goes off everywhere; each machine's ledger turns
// its copy off on its next sync, and the cloud agent's briefs (GET /v1/rules) leave it out at once.
async function ruleOff(request, env) {
  if (!(await anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json().catch(() => ({}));
  const machine = text(body.machine, 80);
  const id = Number(String(body.id ?? "").replace(/^R/i, ""));
  if (!machine || !(Number.isInteger(id) && id > 0)) return json({ error: "Say which rule (machine, id)." }, 400);
  const rule = await env.DB.prepare("SELECT text FROM board_rules WHERE machine = ?1 AND id = ?2").bind(machine, id).first();
  if (!rule) return json({ error: "No such rule." }, 404);
  const at = now();
  const off = await env.DB.prepare(
    "UPDATE board_rules SET active = 0, off_at = COALESCE(off_at, ?3) WHERE (machine = ?1 AND id = ?2) OR text = ?4",
  ).bind(machine, id, at, rule.text).run();
  return json({ ok: true, rule: { machine, id, active: false }, turned_off: off.meta?.changes ?? 1 });
}

// ---- folders -------------------------------------------------------------------------------

async function allowed(request, env) {
  return (await browserAllowed(request, env)) || (await machineAllowed(request, env));
}

// The browser extension's key: "ext.<name>.<HMAC of ext:<name> under TASKS_TOKEN>". The owner's own
// machine makes it (hive-tasks extension-key) and hands it to the extension, so the extension never
// holds the machines' token, and the key only reaches EXTENSION_PATHS.
async function extensionAllowed(request, env) {
  const header = request.headers.get("authorization") || "";
  const [kind, name, mac] = (header.startsWith("Bearer ") ? header.slice(7) : "").split(".");
  if (kind !== "ext" || !name || !mac || !env.TASKS_TOKEN) return false;
  return same(mac, await hmac(env.TASKS_TOKEN, `ext:${name}`), env.TASKS_TOKEN);
}

// POST /v1/extension-key {name}: a machine gets the key for the browser extension on it.
async function extensionKey(request, env) {
  if (!(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json().catch(() => ({}));
  const name = text(body.name, 60).replace(/[^a-z0-9-]/gi, "").toLowerCase();
  if (!name) return json({ error: "Say which browser (name)." }, 400);
  return json({ key: `ext.${name}.${await hmac(env.TASKS_TOKEN, `ext:${name}`)}` });
}

// The browser's name in a valid extension key ("ext.chrome.<mac>" → "chrome"), or null.
async function extensionName(request, env) {
  if (!(await extensionAllowed(request, env))) return null;
  return (request.headers.get("authorization") || "").slice(7).split(".")[1];
}

async function anyoneAllowed(request, env) {
  return (await allowed(request, env)) || (await extensionAllowed(request, env));
}

// The club member a call is signed in as (club.js), or null.
function clubMember(request, env) {
  return memberOf(request, env, now());
}

// Writes down what a node runs, for a call that's signed in: a machine as any kind of node, the
// extension's key only as the extension, and a club member's key as one of their own devices (nodes.js
// memberNode), never as the board.
async function noteNode(request, env, node) {
  try {
    const signed = (await machineAllowed(request, env))
      || (node.kind === "extension" && (await extensionAllowed(request, env)))
      || (node.kind === "phone" && (await phoneAllowed(request, env)));
    if (!signed) {
      const member = node.kind !== "board" && (await clubMember(request, env));
      if (member) await sawNode(env, { ...node, name: memberNode(member.name, node.name) });
      return;
    }
    await sawNode(env, node);
    // The address it was reached by goes into the phone's pairing (phone.js).
    if (node.kind !== "phone") await rememberOrigin(env, new URL(request.url).origin);
  } catch {
    // What a node runs is only shown on the dashboard; a failed write never fails the call.
  }
}

// GET /v1/folder?project=hive&key=memory%20retrieval: the folder and every one of its memories.
async function folder(url, request, env) {
  if (!(await allowed(request, env))) return json({ error: "Not signed in." }, 401);
  const project = text(url.searchParams.get("project"), 120).toLowerCase();
  const key = text(url.searchParams.get("key"), 120).toLowerCase();
  if (!project || !key) return json({ error: "Say which folder (project and key)." }, 400);
  const [found, memories] = await env.DB.batch([
    env.DB.prepare("SELECT project, key, name, about, created_at, updated_at FROM board_folders WHERE project = ?1 AND key = ?2").bind(project, key),
    env.DB.prepare(
      `SELECT machine, id, kind, title, body, task, created_at FROM board_memories
       WHERE project = ?1 AND folder = ?2 ORDER BY created_at, machine, id`,
    ).bind(project, key),
  ]);
  return json({ folder: found.results[0] || { project, key, name: key, about: "" }, memories: memories.results });
}

// GET /v1/rules?project=hive: the owner's standing rules for a project, for an agent the cloud starts
// (Hive's orchestrator puts them in every task's brief). "hive" matches the machines' full project
// names ("github.com/agenticaiuw/hive"); a rule synced from more than one machine is listed once.
async function projectRules(url, request, env) {
  if (!(await allowed(request, env))) return json({ error: "Not signed in." }, 401);
  const project = text(url.searchParams.get("project"), 120).toLowerCase();
  if (!project) return json({ error: "Say which project." }, 400);
  const found = await env.DB.prepare(
    `SELECT machine, id, project, paths, text, quote, created_at FROM board_rules
     WHERE active = 1 AND (lower(project) = ?1 OR lower(project) LIKE '%/' || ?1) ORDER BY created_at, machine, id`,
  ).bind(project).all();
  const seen = new Set();
  const rules = found.results.filter((r) => !seen.has(r.text) && seen.add(r.text));
  return json({ rules });
}

// POST /v1/folders {project, name, about?}: makes a folder (or says what one is for) from the web.
async function saveFolder(request, env) {
  if (!(await allowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json();
  const project = text(body.project, 120).toLowerCase();
  const name = text(body.name, 80);
  if (!project || !name) return json({ error: "A folder needs a project and a name." }, 400);
  const at = now();
  await upsertFolder(env, "web", { project, key: name.toLowerCase(), name, about: body.about, created_at: at, updated_at: at }, at).run();
  return json({ ok: true, project, key: name.toLowerCase() });
}

// POST /v1/folders/memory {project, folder, kind?, title, body}: a memory written on the web,
// which every machine takes in on its next sync.
async function saveMemory(request, env) {
  if (!(await allowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json();
  const project = text(body.project, 120).toLowerCase();
  const name = text(body.folder, 80);
  const kind = KINDS.includes(body.kind) ? body.kind : "note";
  const title = text(body.title, 200);
  const content = text(body.body, 60000);
  if (!project || !name || !(title || content)) return json({ error: "A memory needs a project, a folder and some text." }, 400);
  const at = now();
  const key = name.toLowerCase();
  const next = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM board_memories WHERE machine = 'web'").first();
  await env.DB.batch([
    upsertFolder(env, "web", { project, key, name, about: "", created_at: at, updated_at: at }, at),
    env.DB.prepare(
      `INSERT INTO board_memories (machine, id, project, folder, kind, title, body, task, created_at, synced_at)
       VALUES ('web', ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)`,
    ).bind(next.id, project, key, kind, title || content.split("\n")[0].slice(0, 200), content || title, at),
  ]);
  return json({ ok: true, id: next.id });
}

// ---- requests: instructions for Hive's orchestrator in the cloud ---------------------------
//
// The dashboard sends an instruction here (POST /v1/requests); it becomes a board message on machine
// "cloud" (harness "hive", session "web") and a queued request with the same id. The orchestrator on
// the VM (cloud/vm-agent/orchestrator.mjs) takes the oldest (POST /v1/requests/take), plans it into
// tasks and reports each one as it goes (POST /v1/requests/update). A request's task n has the id
// request * 100 + n, so its tasks sort with it and never meet another machine's ids.

const REQUEST_STATUSES = ["queued", "planning", "working", "done", "failed"];
const TASK_STATUSES = ["open", "active", "waiting", "blocked", "done", "dropped"];

/** "For hive › Voice: do x" → {project: "hive", folder: "Voice"}; "For hive: x" → {project: "hive"}. */
export function scopeOf(words) {
  const match = /^For ([^›:\n]{1,120}?)(?: › ([^:\n]{1,120}?))?: /.exec(words);
  return match ? { project: match[1].trim(), folder: (match[2] || "").trim() } : { project: "", folder: "" };
}

async function sendRequest(request, env) {
  if (!(await anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json();
  const words = text(body.text, 4000);
  if (!words) return json({ error: "Say what to do (text)." }, 400);
  const agent = text(body.agent, 40) || "hive-cloud";
  // The device it was sent from (mac, phone, extension, web, siri) is the message's session.
  const from = text(body.from, 40) || "web";
  const id = await newRequest(env, { words, agent, from, at: now() });
  // Asked on a web page (the browser extension): the page goes along for the agent to read.
  const page = body.page && typeof body.page === "object" ? body.page : null;
  const pageUrl = page ? text(page.url, 2000) : "";
  if (pageUrl) {
    await env.DB.prepare("INSERT OR REPLACE INTO board_page_asks (request, url, title, outline) VALUES (?1, ?2, ?3, ?4)")
      .bind(id, pageUrl, text(page.title, 300), text(page.outline, 60000)).run();
  }
  const ahead = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM board_requests WHERE status IN ('queued', 'planning', 'working') AND id < ?1",
  ).bind(id).first();
  return json({ ok: true, id, ahead: ahead.n });
}

// A new request to Hive's agent on the VM, with its words as a board message: its id. `member`: the club
// member who asked (club.js), whose request Hive runs only as a change to its own code.
async function newRequest(env, { words, agent, from, at, member = null, follows = null }) {
  const { project, folder } = scopeOf(words);
  const [made] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO board_requests (id, agent, folder, status, created_at, updated_at, member, follows)
       SELECT COALESCE(MAX(id), 0) + 1, ?1, ?2, 'queued', ?3, ?3, ?4, ?5 FROM board_requests RETURNING id`,
    ).bind(agent, folder || null, at, member, follows),
    env.DB.prepare(
      `INSERT INTO board_messages (machine, id, harness, session, project, text, said_at, times, split_at, synced_at)
       VALUES ('cloud', (SELECT MAX(id) FROM board_requests), 'hive', ?4, ?1, ?2, ?3, 1, NULL, ?3)`,
    ).bind(project.toLowerCase(), words, at, from),
  ]);
  return made.results[0].id;
}

// A request Hive on the VM was on when it restarted runs again, at most this many times, with this note.
const MOST_RESTARTS = 2;
const RESTARTED = "Hive on the VM restarted while it was working on this request, so it runs again. What it did "
  + "before is on the board (the request's steps, which knowledge get_request reads): check what's already done there first.";

async function takeRequest(request, env) {
  if (!(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json();
  const by = text(body.by, 80);
  if (!by) return json({ error: "Say who is taking it (by)." }, 400);
  const agent = text(body.agent, 40) || "hive-cloud";
  const at = now();
  // The owner's requests go before the club's (club.js), oldest first in each.
  const [, , taken] = await env.DB.batch([
    // What this orchestrator held when it last stopped goes on: back in the queue, first in line, with a
    // note of what happened, MOST_RESTARTS times at most a request; after that it ends there.
    env.DB.prepare(
      `UPDATE board_requests SET status = 'failed', finished_at = ?2, updated_at = ?2,
         outcome = COALESCE(outcome, 'Hive on the VM restarted while it worked on this, ' || restarts || ' times; it stopped here.')
       WHERE taken_by = ?1 AND status IN ('planning', 'working') AND ?3 = 1 AND restarts >= ?4`,
    ).bind(by, at, body.fresh ? 1 : 0, MOST_RESTARTS),
    env.DB.prepare(
      `UPDATE board_requests SET status = 'queued', taken_by = NULL, restarts = restarts + 1, updated_at = ?2, retry_note = ?4
       WHERE taken_by = ?1 AND status IN ('planning', 'working') AND ?3 = 1`,
    ).bind(by, at, body.fresh ? 1 : 0, RESTARTED),
    env.DB.prepare(
      `UPDATE board_requests SET status = 'planning', taken_by = ?1, taken_at = ?2, updated_at = ?2
       WHERE id = (SELECT id FROM board_requests WHERE status = 'queued' AND agent = ?3 ORDER BY member IS NOT NULL, id LIMIT 1)
       RETURNING id, folder, follows, retry_note, member`,
    ).bind(by, at, agent),
  ]);
  const row = taken.results[0];
  if (!row) return json({ request: null });
  const [message, asked, chain] = await Promise.all([
    env.DB.prepare("SELECT project, text, said_at, session FROM board_messages WHERE machine = 'cloud' AND id = ?1").bind(row.id).first(),
    env.DB.prepare("SELECT url, title, outline FROM board_page_asks WHERE request = ?1").bind(row.id).first(),
    row.follows ? conversationBefore(env, row.follows) : [],
  ]);
  // The owner replied in an earlier request's conversation: the agent hears what that one was, and what
  // came before it in the same conversation ("nah, verbatim actually but fix the caps" means nothing
  // without the bio it's about, two requests back).
  // Run again by Hive because its tasks got stuck (continueStuck): its note comes first.
  const retry = row.retry_note ? `${row.retry_note}\nDon't redo what's already done. The request, as it was:\n` : "";
  // Hive on the Mac handing over more of the same work (vm-post.mjs task --follows) says so in its
  // words ("[Hive on the Mac, not the owner]"): they aren't introduced as the owner's.
  const handed = /^(?:For [^\n:]{1,250}: )?\[Hive on the Mac\b/.test(message?.text || "");
  const earlier = chain.at(-1);
  const older = chain.slice(0, -1);
  const before = retry + (older.length
    ? `Earlier in this conversation, oldest first:\n${older.map((r) => `- R${r.id} ("${clip(r.text || "", WORDS_BEFORE)}"), which ended: ${r.outcome || "no outcome recorded"}`).join("\n")}\n`
    : "") + (earlier
    ? `This follows the ${row.member ? "club's" : "owner's"} earlier request R${row.follows} ("${earlier.text || ""}"), which ended: ${earlier.outcome || "no outcome recorded"}.\n${handed ? "Now" : row.member ? `Club member ${row.member} now says` : "The owner now says"}: `
    : "");
  return json({
    request: {
      id: row.id, folder: row.folder || "", project: message?.project || "", text: before + (message?.text || ""),
      follows: row.follows || null, retry: Boolean(row.retry_note), member: row.member || null,
      said_at: message?.said_at, from: message?.session || "web",
      page: asked ? { url: asked.url, title: asked.title || "", outline: asked.outline || "" } : null,
    },
  });
}

// How far back a follow-up hears its conversation, and how much of each earlier request's words.
const MOST_BEFORE = 6;
const WORDS_BEFORE = 600;
const clip = (text, most) => (text.length > most ? `${text.slice(0, most)}…` : text);

/** The requests a follow-up continues, oldest first and the one it follows last: each one's words and how it
 *  ended, along `follows`, MOST_BEFORE at most. */
async function conversationBefore(env, id) {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE chain (id, follows, depth) AS (
       SELECT id, follows, 1 FROM board_requests WHERE id = ?1
       UNION ALL
       SELECT r.id, r.follows, chain.depth + 1 FROM board_requests r JOIN chain ON r.id = chain.follows WHERE chain.depth < ?2
     )
     SELECT chain.id, chain.depth, m.text, r.outcome FROM chain
       JOIN board_requests r ON r.id = chain.id
       LEFT JOIN board_messages m ON m.machine = 'cloud' AND m.id = chain.id
     ORDER BY chain.depth DESC`,
  ).bind(id, MOST_BEFORE).all();
  return results ?? [];
}

// Earlier requests are source material for later work. Read the saved words and page, not the
// dashboard's summary. Runs include every node; their steps and messages have pages so old material
// is reachable even in a long conversation. follows points to the request before this one.
async function requestContext(url, request, env) {
  if (!(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const raw = url.searchParams.get("id") || "";
  const id = Number(raw.replace(/^R/i, ""));
  const offset = Number(url.searchParams.get("offset") || "0");
  if (!/^[Rr]?[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) return json({ error: "Say which request (id, such as R7)." }, 400);
  if (!Number.isSafeInteger(offset) || offset < 0) return json({ error: "offset must be a nonnegative whole number." }, 400);
  const row = await env.DB.prepare(
    `SELECT r.id, r.agent, r.folder, r.status, r.outcome, r.follows, r.retry_note,
       r.created_at, r.updated_at, r.finished_at, r.stop_at, m.text, m.project, m.session AS "from", m.said_at
     FROM board_requests r LEFT JOIN board_messages m ON m.machine = 'cloud' AND m.id = r.id WHERE r.id = ?1`,
  ).bind(id).first();
  if (!row) return json({ error: "No such request." }, 404);
  const size = 50;
  const [page, tasks, runs, steps, messages] = await env.DB.batch([
    env.DB.prepare("SELECT url, title, outline FROM board_page_asks WHERE request = ?1").bind(id),
    env.DB.prepare(
      `SELECT id - ?1 * 100 AS key, quote, title, status, outcome, evidence FROM board_tasks
       WHERE machine = 'cloud' AND message = ?1 ORDER BY id`,
    ).bind(id),
    env.DB.prepare("SELECT machine, run, agent, title, status, task, project, started_at, updated_at FROM board_runs WHERE request = ?1 ORDER BY machine, run").bind(id),
    env.DB.prepare(
      `SELECT s.machine, s.run, s.n, s.at, s.kind, s.text FROM board_run_steps s
       JOIN board_runs r ON r.machine = s.machine AND r.run = s.run
       WHERE r.request = ?1 ORDER BY s.machine, s.run, s.n LIMIT ?2 OFFSET ?3`,
    ).bind(id, size + 1, offset),
    env.DB.prepare(
      `SELECT m.id, m.machine, m.run, m.text, m.sender, m.status, m.detail, m.request, m.task, m.created_at, m.updated_at
       FROM board_run_messages m JOIN board_runs r ON r.machine = m.machine AND r.run = m.run
       WHERE r.request = ?1 ORDER BY m.id LIMIT ?2 OFFSET ?3`,
    ).bind(id, size + 1, offset),
  ]);
  return json({
    request: row, page: page.results[0] ?? null, tasks: tasks.results, runs: runs.results,
    steps: steps.results.slice(0, size), messages: messages.results.slice(0, size),
    next_offset: steps.results.length > size || messages.results.length > size ? offset + size : null,
  });
}

// GET /v1/requests/state?id=7: how one request stands, for whoever sent it.
async function requestState(url, request, env) {
  if (!(await anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) return json({ error: "Say which request (id)." }, 400);
  const row = await env.DB.prepare("SELECT id, status, outcome, updated_at, stop_at FROM board_requests WHERE id = ?1").bind(id).first();
  if (!row) return json({ error: "No such request." }, 404);
  if (url.searchParams.get("steps") !== "1") return json({ request: row });
  // With its tasks and their runs' latest steps, for a node that shows the request as it goes (Hive
  // on the Mac, which sent the owner's words here): each step once, by its run and number.
  const [tasks, steps] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id - ?1 * 100 AS key, title, status, outcome FROM board_tasks
       WHERE machine = 'cloud' AND id > ?1 * 100 AND id < ?1 * 100 + 100 ORDER BY id`,
    ).bind(id),
    env.DB.prepare(
      `SELECT s.run, s.n, s.at, s.kind, s.text FROM board_run_steps s
       JOIN board_runs r ON r.machine = s.machine AND r.run = s.run
       WHERE r.machine = 'cloud' AND r.request = ?1 ORDER BY s.at DESC, s.n DESC LIMIT 60`,
    ).bind(id),
  ]);
  return json({ request: row, tasks: tasks.results, steps: steps.results.reverse() });
}

// POST /v1/requests/stop {id}: the owner stops a request to Hive's cloud agent (the x on Hive's window on
// the Mac, whose agent thinks in the cloud). One no agent has taken yet ends here; the orchestrator
// stops the agents of one it's working on when it next looks (requestState's stop_at) and ends it.
async function stopRequest(request, env) {
  if (!(await anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return json({ error: "Say which request (id)." }, 400);
  const at = now();
  const [asked, ended] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE board_requests SET stop_at = COALESCE(stop_at, ?2), updated_at = ?2 WHERE id = ?1 AND status IN ('queued', 'planning', 'working')",
    ).bind(id, at),
    env.DB.prepare(
      `UPDATE board_requests SET status = 'failed', outcome = 'Stopped by the owner before it started.', finished_at = ?2, updated_at = ?2
       WHERE id = ?1 AND status = 'queued'`,
    ).bind(id, at),
  ]);
  return json({ ok: true, stopping: asked.meta.changes, ended: ended.meta.changes });
}

// Every node's agent, live (board_runs and board_run_steps, migration 0013). Each node sends what its
// agent is doing a few steps at a time while it works: Hive on each Mac (hive-tasks/src/runs.rs, from its
// session journal), Hive's cloud agent on the VM (cloud/vm-agent/orchestrator.mjs, which also drives the
// phone), the browser extension's own agent (browser/chrome/src/board-runs.js), and each Claude Code and
// Codex session on the owner's Macs (hive-tasks/src/live.rs, from its hooks). The board hands the
// recent ones to every dashboard. Steps are numbered by the node, so a post sent twice lands once.
const RUN_STATUSES = new Set(["working", "done", "failed", "stopped"]);
// A Claude Code or Codex session is one run however long it goes on (hive-tasks live.rs).
const MOST_RUN_STEPS = 10_000_000;
// The runs every dashboard lists (?1: two days ago, ?2: six hours ago).
const LISTED_RUNS = "(r.updated_at > ?1 OR (r.status = 'working' AND r.updated_at > ?2))";

// POST /v1/runs {machine, run, agent, title?, project?, status?, request?, task?, steps: [{n, at, kind?, text}]}.
// A machine names itself; the browser extension's key is always "ext:<its name>".
async function saveRun(request, env) {
  const extension = await extensionName(request, env);
  if (!extension && !(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json();
  const machine = extension ? `ext:${extension}` : text(body.machine, 60);
  const run = text(body.run, 80);
  const agent = text(body.agent, 30).toLowerCase();
  if (!machine || !run || !agent) return json({ error: "Say which machine, run and agent." }, 400);
  const status = RUN_STATUSES.has(body.status) ? body.status : null;
  const whole = (value, low, high) => (Number.isInteger(Number(value)) && Number(value) >= low && Number(value) <= high ? Number(value) : null);
  const request_ = whole(body.request, 1, Number.MAX_SAFE_INTEGER);
  const task = request_ ? whole(body.task, 1, 99) : null;
  const steps = (Array.isArray(body.steps) ? body.steps : [])
    .slice(0, 100)
    .map((step) => ({
      n: whole(step && step.n, 1, MOST_RUN_STEPS),
      at: Math.round(Number(step && step.at)) || now(),
      kind: text(step && step.kind, 20).toLowerCase(),
      text: text(step && step.text, 4000), // an agent's whole report, not its first lines
    }))
    .filter((step) => step.n && step.text);
  const at = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO board_runs (machine, run, agent, title, status, request, task, started_at, updated_at, project)
       VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 'working'), ?6, ?7, ?8, ?8, ?9)
       ON CONFLICT (machine, run) DO UPDATE SET
         agent = excluded.agent,
         title = CASE WHEN excluded.title != '' THEN excluded.title ELSE board_runs.title END,
         project = CASE WHEN excluded.project != '' THEN excluded.project ELSE board_runs.project END,
         status = COALESCE(?5, board_runs.status),
         request = COALESCE(excluded.request, board_runs.request),
         task = COALESCE(excluded.task, board_runs.task),
         updated_at = excluded.updated_at`,
    ).bind(machine, run, agent, text(body.title, 300), status, request_, task, at, text(body.project, 200)),
    ...steps.map((step) => env.DB.prepare(
      "INSERT OR IGNORE INTO board_run_steps (machine, run, n, at, kind, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(machine, run, step.n, step.at, step.kind, step.text)),
  ]);
  return json({ ok: true, machine });
}

// GET /v1/runs?machine=cloud&run=1101&after=12: the run, its steps after number `after` (500 at most),
// and what the owner said to it (board_run_messages). `before=900` instead: the 300 steps before that
// number; `tail=300`: its last 300 steps (an agent's conversation opening on its newest part).
async function runSteps(url, request, env) {
  if (!(await anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const machine = text(url.searchParams.get("machine"), 60);
  const run = text(url.searchParams.get("run"), 80);
  if (!machine || !run) return json({ error: "Say which run (machine, run)." }, 400);
  const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
  const before = Math.max(0, Number(url.searchParams.get("before")) || 0);
  const tail = Math.min(500, Math.max(0, Number(url.searchParams.get("tail")) || 0));
  const window_ = before || tail
    ? env.DB.prepare(
      `SELECT n, at, kind, text FROM (SELECT n, at, kind, text FROM board_run_steps
         WHERE machine = ?1 AND run = ?2 AND n < ?3 ORDER BY n DESC LIMIT ?4) ORDER BY n`,
    ).bind(machine, run, before || MOST_RUN_STEPS + 1, before ? 300 : tail)
    : env.DB.prepare(
      "SELECT n, at, kind, text FROM board_run_steps WHERE machine = ?1 AND run = ?2 AND n > ?3 ORDER BY n LIMIT 500",
    ).bind(machine, run, after);
  const [found, steps, said] = await env.DB.batch([
    env.DB.prepare(
      "SELECT machine, run, agent, title, status, request, task, started_at, updated_at, project FROM board_runs WHERE machine = ?1 AND run = ?2",
    ).bind(machine, run),
    window_,
    env.DB.prepare(
      `SELECT id, text, sender, status, detail, task, created_at, updated_at FROM board_run_messages
       WHERE machine = ?1 AND run = ?2 ORDER BY id DESC LIMIT 100`,
    ).bind(machine, run),
  ]);
  // A session known only from what the owner said in it has no steps yet, but can be talked to.
  const known = found.results.length ? null : await knownSession(env, machine, run);
  if (!found.results.length && !known) return json({ error: "No such run." }, 404);
  return json({
    run: found.results[0] ?? { machine, run, agent: known.agent, title: "", status: "", request: null, task: null },
    steps: steps.results,
    messages: said.results.reverse(),
  });
}

// ---- talking to an agent (board_run_messages, migration 0015) --------------------------------------

const MESSAGE_STATUSES = new Set(["delivered", "failed", "queued"]);

// POST /v1/runs/message {machine, run, text, from?}: the owner says something to one of their agents.
// It waits here until the node that agent is on takes it (/v1/runs/messages/take). {request, text}
// instead: a reply to Hive's cloud agent about that request, which becomes a follow-up request.
async function messageRun(request, env) {
  if (!(await anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json().catch(() => ({}));
  const words = text(body.text, 8000);
  if (!words) return json({ error: "Say what to tell the agent (text)." }, 400);
  const from = text(body.from, 40) || "web";
  const at = now();
  const follows = Number(body.request);
  if (Number.isInteger(follows) && follows > 0) return await followUp(env, follows, words, from);
  const machine = text(body.machine, 60);
  const run = text(body.run, 80);
  if (!machine || !run) return json({ error: "Say which agent (machine and run, or request)." }, 400);
  const found = (await env.DB.prepare("SELECT agent, title FROM board_runs WHERE machine = ?1 AND run = ?2").bind(machine, run).first())
    ?? (await knownSession(env, machine, run));
  if (!found) return json({ error: "No such agent." }, 404);
  const message = await queueMessage(env, { machine, run, agent: found.agent, words, from, at });
  // A job Hive's agent on the VM ran by itself (hive-task.mjs, run "vm-<id>") takes no messages: what
  // the owner says to it goes to Hive on the VM as a new request, which says which job it's about.
  if (machine === "cloud" && run.startsWith("vm-")) {
    const id = await newRequest(env, {
      words: `${words}\n\n(Said about the VM job “${found.title || run}”.)`, agent: "hive-cloud", from, at,
    });
    const detail = `Hive on the VM took it as a new request (${id})`;
    await env.DB.prepare("UPDATE board_run_messages SET status = 'delivered', detail = ?2, updated_at = ?3 WHERE id = ?1")
      .bind(message.id, detail, at).run();
    return json({ ok: true, request: id, message: { ...message, status: "delivered", detail } });
  }
  return json({ ok: true, message });
}

// A Claude Code or Codex session the board knows from what the owner said in it or a task it took,
// though it never reported a run: it can still be talked to ("claude:<session>").
async function knownSession(env, machine, run) {
  const [harness, session] = run.split(":");
  if (!["claude", "codex"].includes(harness) || !session) return null;
  const seen = await env.DB.prepare(
    `SELECT 1 FROM board_messages WHERE machine = ?1 AND harness = ?2 AND session = ?3
     UNION ALL SELECT 1 FROM board_tasks WHERE machine = ?1 AND claimed_harness = ?2 AND claimed_session = ?3
     LIMIT 1`,
  ).bind(machine, harness, session).first();
  return seen ? { agent: harness } : null;
}

function queueMessage(env, { machine, run, agent, words, from, at, task = null, wake = 1 }) {
  return env.DB.prepare(
    `INSERT INTO board_run_messages (machine, run, agent, text, sender, status, task, wake, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8, ?8)
     RETURNING id, machine, run, text, sender, status, detail, task, created_at, updated_at`,
  ).bind(machine, run, agent, words, from, task, wake, at).first();
}

// A message to Hive's cloud agent about an earlier request: a new request that knows what it follows.
async function followUp(env, follows, words, from) {
  const at = now();
  const earlier = await env.DB.prepare(
    `SELECT r.agent, r.folder, m.project FROM board_requests r
     LEFT JOIN board_messages m ON m.machine = 'cloud' AND m.id = r.id WHERE r.id = ?1`,
  ).bind(follows).first();
  if (!earlier) return json({ error: "No such request." }, 404);
  const [made] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO board_requests (id, agent, folder, status, created_at, updated_at, follows)
       SELECT COALESCE(MAX(id), 0) + 1, ?1, ?2, 'queued', ?3, ?3, ?4 FROM board_requests RETURNING id`,
    ).bind(earlier.agent, earlier.folder, at, follows),
    env.DB.prepare(
      `INSERT INTO board_messages (machine, id, harness, session, project, text, said_at, times, split_at, synced_at)
       VALUES ('cloud', (SELECT MAX(id) FROM board_requests), 'hive', ?4, ?1, ?2, ?3, 1, NULL, ?3)`,
    ).bind(earlier.project || "", words, at, from),
  ]);
  const id = made.results[0].id;
  const ahead = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM board_requests WHERE status IN ('queued', 'planning', 'working') AND id < ?1",
  ).bind(id).first();
  return json({ ok: true, request: id, ahead: ahead.n });
}

// POST /v1/tasks/act {machine, id, action: cancel|continue|answer, text?, from}: the owner acting on a
// task from a dashboard. The words go to the agent the task belongs to, through the cloud: a session
// on a Mac gets them at its next step (or is continued with them), Hive's cloud agent gets a follow-up
// request. A cancel drops the task here at once and stays (upsertTask); it reaches only a session that
// is running, so it never starts one just to say stop.
const TASK_ACTIONS = new Set(["cancel", "continue", "answer"]);
async function actOnTask(request, env) {
  if (!(await anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json().catch(() => ({}));
  const machine = text(body.machine, 80);
  const id = Number(body.id);
  const action = TASK_ACTIONS.has(body.action) ? body.action : "";
  const words = text(body.text, 8000);
  const from = text(body.from, 40) || "web";
  if (!machine || !(Number.isInteger(id) && id > 0) || !action) {
    return json({ error: "Say which task (machine, id) and what to do (cancel, continue or answer)." }, 400);
  }
  if (action === "answer" && !words) return json({ error: "Say your answer (text)." }, 400);
  const task = await env.DB.prepare(
    `SELECT t.id, t.title, t.status, t.outcome, COALESCE(t.claimed_harness, m.harness) AS harness,
            COALESCE(t.claimed_session, m.session) AS session
     FROM board_tasks t LEFT JOIN board_messages m ON m.machine = t.machine AND m.id = t.message
     WHERE t.machine = ?1 AND t.id = ?2`,
  ).bind(machine, id).first();
  if (!task) return json({ error: "No such task." }, 404);
  const at = now();
  const name = `T${id} ("${task.title}")`;
  if (action === "cancel") {
    await env.DB.prepare(
      `UPDATE board_tasks SET status = 'dropped', outcome = 'Cancelled by the owner from the dashboard.',
         cancelled_at = ?3, updated_at = ?3 WHERE machine = ?1 AND id = ?2`,
    ).bind(machine, id, at).run();
  } else {
    // The owner just asked it themselves: Hive's own continue (continueStuck) waits on this one.
    await env.DB.prepare("UPDATE board_tasks SET auto_continued_at = ?3 WHERE machine = ?1 AND id = ?2").bind(machine, id, at).run();
  }
  const said = {
    cancel: `The owner cancelled ${name} from the Hive dashboard. Stop any work on it; it is already marked dropped, so don't report it.`,
    continue: `The owner asks you to continue ${name}${words ? `: ${words}` : "."}`,
    answer: `The owner answered you on ${name}, which was waiting on them${task.outcome ? ` for: ${task.outcome}` : ""}. Their answer, in their own words: ${words}`,
  }[action];
  // Hive's cloud agent: task n of request R is R*100+n.
  if (machine === "cloud") {
    if (action === "cancel") return json({ ok: true, task: { machine, id, status: "dropped" } });
    return await followUp(env, Math.floor(id / 100), said, from);
  }
  if (!task.session || !task.harness) {
    if (action === "cancel") return json({ ok: true, task: { machine, id, status: "dropped" } });
    return json({ error: "Hive doesn't know which agent has that task." }, 409);
  }
  const run = `${task.harness}:${task.session}`;
  const message = await queueMessage(env, {
    machine, run, agent: task.harness, words: said, from, at, task: id, wake: action === "cancel" ? 0 : 1,
  });
  return json({ ok: true, message, task: action === "cancel" ? { machine, id, status: "dropped" } : undefined });
}

// ---- stuck tasks get going again by themselves -------------------------------------------------

// The owner: "why tf would it get stuck just for me to click continue? what's the point?" and then
// "if they must stop they must provide an exact reason of why they stopped and what exactly do they
// need me for or else they'd just keep going" (2026-11-17). So a stuck (blocked) task is never the
// owner's: Hive keeps sending its agent a continue, the way the dashboard used to, waiting a little
// longer each time (AUTO_STEP, doubled per try up to AUTO_LONGEST) so an agent that's stuck for good
// isn't asked every minute. Only a task reported waiting, with why it stopped and exactly what the
// owner must do (hive-tasks report checks both), is the owner's. The words start with FROM_HIVE, so
// the agent's board (hive-tasks: from_the_owner) never takes them for the owner's own, and a task
// that came from such words is never continued (2026-11-17: continues that became new tasks, which got
// stuck and were continued in turn, put 400+ tasks on Needs you). One agent per project at a time, so
// sessions continued together don't trample each other's files.
const AUTO_STEP = 10 * 60;
const AUTO_LONGEST = 6; // the wait stops doubling at AUTO_STEP << 6 (about 10.7 hours)
const FROM_HIVE = "[Hive, not the owner]";
// How long after its last try a task gets the next one (SQL, for a row `t`).
const NEXT_TRY = `t.auto_continued_at + (${AUTO_STEP} << MIN(t.auto_continues, ${AUTO_LONGEST}))`;

const autoWords = (tasks, n) => {
  const one = tasks.length === 1;
  const list = tasks.map((t) => `T${t.id} ("${t.title}")${t.outcome ? `, stuck on: ${t.outcome}` : ""}`).join("\n- ");
  return `${FROM_HIVE} ${one ? "This task is" : "These tasks are"} stuck, and Hive continues ${one ? "it" : "them"} so the owner doesn't have to (try ${n}):\n- ${list}\n` +
    "Get past what's in the way yourself and finish. Do nothing the owner hasn't asked for: no publishing, sending, deleting or spending to get around it. " +
    "This is Hive's note, not a new request: register no tasks for it. " +
    "Report each when it ends: done; dropped if it can't or shouldn't be done, saying why; waiting only if the owner must do something themselves, " +
    'with "why" (exactly why it stopped) and "need" (exactly what the owner must do). Anything else, keep going.';
};

async function continueStuck(env, at = now()) {
  const stuck = await env.DB.prepare(
    `SELECT t.machine, t.id, t.title, t.outcome, t.message, t.auto_continues, COALESCE(m.project, '') AS project,
            COALESCE(t.claimed_harness, m.harness) AS harness, COALESCE(t.claimed_session, m.session) AS session
     FROM board_tasks t LEFT JOIN board_messages m ON m.machine = t.machine AND m.id = t.message
     WHERE t.status = 'blocked' AND t.cancelled_at IS NULL
       AND (t.auto_continued_at IS NULL OR ${NEXT_TRY} <= ?1)
       AND COALESCE(m.text, '') NOT LIKE '${FROM_HIVE}%'
       AND NOT (t.machine = 'cloud' AND EXISTS (SELECT 1 FROM board_requests r WHERE r.id = t.message AND r.stop_at IS NOT NULL))
     ORDER BY t.updated_at LIMIT 200`,
  ).bind(at).all();
  if (!stuck.results.length) return { continued: 0 };
  // Projects where an agent Hive continued is still at it: the next one there waits its turn.
  const busy = await env.DB.prepare(
    `SELECT DISTINCT t.machine, COALESCE(m.project, '') AS project,
            COALESCE(t.claimed_harness, m.harness) || ':' || COALESCE(t.claimed_session, m.session) AS run
     FROM board_tasks t LEFT JOIN board_messages m ON m.machine = t.machine AND m.id = t.message
     WHERE t.auto_continued_at >= ?1 AND t.auto_continues > 0 AND t.status IN ('blocked', 'active')`,
  ).bind(at - AUTO_STEP * 3).all();
  const runs = new Map();
  for (const t of stuck.results) {
    if (t.machine === "cloud") {
      const key = `cloud:R${Math.floor(t.id / 100)}`;
      if (!runs.has(key)) runs.set(key, { machine: "cloud", request: Math.floor(t.id / 100), tasks: [] });
      runs.get(key).tasks.push(t);
      continue;
    }
    if (!t.session || !t.harness) continue; // no agent to ask: it stays the owner's
    const run = `${t.harness}:${t.session}`;
    const key = `${t.machine}:${run}`;
    if (!runs.has(key)) runs.set(key, { machine: t.machine, run, agent: t.harness, project: t.project, tasks: [] });
    runs.get(key).tasks.push(t);
  }
  const taken = new Set();
  const statements = [];
  let continued = 0;
  for (const r of runs.values()) {
    const n = Math.max(...r.tasks.map((t) => t.auto_continues)) + 1;
    const words = autoWords(r.tasks, n);
    if (r.machine === "cloud") {
      // Hive in the cloud: the same request runs again, with Hive's note before the owner's words.
      const again = await env.DB.prepare(
        `UPDATE board_requests SET status = 'queued', retry_note = ?2, taken_by = NULL, finished_at = NULL, updated_at = ?3
         WHERE id = ?1 AND status IN ('done', 'failed') RETURNING id`,
      ).bind(r.request, words, at).first();
      if (!again) continue; // still going: it may yet move them
    } else {
      const place = `${r.machine}:${r.project}`;
      const others = busy.results.some((b) => b.machine === r.machine && b.project === r.project && b.run !== r.run);
      if (r.project && (others || taken.has(place))) continue;
      taken.add(place);
      await queueMessage(env, { machine: r.machine, run: r.run, agent: r.agent, words, from: "hive", at, task: r.tasks[0].id });
    }
    for (const t of r.tasks) {
      statements.push(
        env.DB.prepare(
          "UPDATE board_tasks SET auto_continues = auto_continues + 1, auto_continued_at = ?3 WHERE machine = ?1 AND id = ?2",
        ).bind(t.machine, t.id, at),
      );
    }
    continued += r.tasks.length;
  }
  if (statements.length) await env.DB.batch(statements);
  return { continued };
}

// POST /v1/runs/messages/take {machine}: the node takes what's waiting for its agents, each message once.
// One nobody took in a day has failed. The extension's key takes its own browser's messages.
async function takeRunMessages(request, env) {
  const extension = await extensionName(request, env);
  if (!extension && !(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json().catch(() => ({}));
  const machine = extension ? `ext:${extension}` : text(body.machine, 60);
  if (!machine) return json({ error: "Say which machine." }, 400);
  const at = now();
  const [, taken] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE board_run_messages SET status = 'failed', detail = 'Nothing on that machine picked it up within a day.',
         updated_at = ?2 WHERE machine = ?1 AND status = 'queued' AND created_at < ?3`,
    ).bind(machine, at, at - DAY),
    env.DB.prepare(
      `UPDATE board_run_messages SET status = 'taken', updated_at = ?2 WHERE machine = ?1 AND status = 'queued'
       RETURNING id, run, agent, text, sender, wake, created_at`,
    ).bind(machine, at),
  ]);
  return json({ messages: taken.results.sort((a, b) => a.id - b.id) });
}

// POST /v1/runs/messages/update {id, status: delivered|failed|queued, detail?}: how handing it over went
// (queued puts it back for the next take).
async function updateRunMessage(request, env) {
  const extension = await extensionName(request, env);
  if (!extension && !(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  const status = MESSAGE_STATUSES.has(body.status) ? body.status : "";
  if (!(Number.isInteger(id) && id > 0) || !status) return json({ error: "Say which message (id) and how it went (status)." }, 400);
  const row = await env.DB.prepare(
    `UPDATE board_run_messages SET status = ?2, detail = ?3, updated_at = ?4
     WHERE id = ?1 AND (?5 = '' OR machine = ?5) RETURNING id`,
  ).bind(id, status, text(body.detail, 300), now(), extension ? `ext:${extension}` : "").first();
  return row ? json({ ok: true }) : json({ error: "No such message." }, 404);
}

// ---- page rules (the browser extension) -----------------------------------------------------------

const host = (value) => text(value, 200).toLowerCase().replace(/^www\./, "");

// GET /v1/page-rules?host=canvas.wisc.edu: the rules that are on for a site (every site without host).
async function pageRules(url, request, env) {
  if (!(await anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const site = host(url.searchParams.get("host"));
  const rows = await env.DB.prepare(
    `SELECT id, host, path, title, rule, request, on_at FROM board_page_rules
     WHERE off_at IS NULL AND (?1 = '' OR host = ?1) ORDER BY id`,
  ).bind(site).all();
  const rules = rows.results.map((r) => ({ ...r, rule: safeJson(r.rule) }));
  return json({ rules });
}

const safeJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

// POST /v1/page-rules {host, path, title, rule, request}: Hive's orchestrator saves the rule it wrote.
// A new rule for the same page replaces the one before it.
async function savePageRule(request, env) {
  if (!(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json();
  const site = host(body.host);
  const title = text(body.title, 200);
  const rule = body.rule && typeof body.rule === "object" ? JSON.stringify(body.rule).slice(0, 60000) : "";
  if (!site || !title || !rule) return json({ error: "Say which site (host), what it does (title) and the rule." }, 400);
  const path = text(body.path, 500);
  const at = now();
  const [, made] = await env.DB.batch([
    env.DB.prepare("UPDATE board_page_rules SET off_at = ?3 WHERE host = ?1 AND path = ?2 AND off_at IS NULL").bind(site, path, at),
    env.DB.prepare(
      `INSERT INTO board_page_rules (id, host, path, title, rule, request, on_at)
       SELECT COALESCE(MAX(id), 0) + 1, ?1, ?2, ?3, ?4, ?5, ?6 FROM board_page_rules RETURNING id`,
    ).bind(site, path, title, rule, Number.isInteger(body.request) ? body.request : null, at),
  ]);
  return json({ ok: true, id: made.results[0].id });
}

// POST /v1/page-rules/off {id} or {host}: puts a page (or a whole site) back the way it was.
async function pageRuleOff(request, env) {
  if (!(await anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json();
  const id = Number(body.id);
  const site = host(body.host);
  if (!(Number.isInteger(id) && id > 0) && !site) return json({ error: "Say which rule (id) or site (host)." }, 400);
  const done = await env.DB.prepare(
    "UPDATE board_page_rules SET off_at = ?3 WHERE off_at IS NULL AND (id = ?1 OR (?1 = 0 AND host = ?2))",
  ).bind(Number.isInteger(id) ? id : 0, site, now()).run();
  return json({ ok: true, off: done.meta.changes });
}

async function updateRequest(request, env) {
  if (!(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json();
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return json({ error: "Say which request (id)." }, 400);
  const at = now();
  const statements = [];
  if (body.status !== undefined || body.outcome !== undefined) {
    const status = REQUEST_STATUSES.includes(body.status) ? body.status : null;
    statements.push(
      env.DB.prepare(
        `UPDATE board_requests SET status = COALESCE(?2, status), outcome = COALESCE(?3, outcome), updated_at = ?4,
           finished_at = CASE WHEN ?2 IN ('done', 'failed') THEN ?4 ELSE finished_at END
         WHERE id = ?1`,
      ).bind(id, status, body.outcome === undefined ? null : text(body.outcome, 4000), at),
    );
  }
  const project = text(body.project, 120).toLowerCase();
  if (project) {
    statements.push(
      env.DB.prepare("UPDATE board_messages SET project = ?2, synced_at = ?3 WHERE machine = 'cloud' AND id = ?1 AND project = ''")
        .bind(id, project, at),
    );
  }
  const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 40) : [];
  if (tasks.length) {
    statements.push(
      env.DB.prepare("UPDATE board_messages SET split_at = COALESCE(split_at, ?2), synced_at = ?2 WHERE machine = 'cloud' AND id = ?1")
        .bind(id, at),
    );
    const message = await env.DB.prepare("SELECT project FROM board_messages WHERE machine = 'cloud' AND id = ?1").bind(id).first();
    const home = project || message?.project || "";
    for (const t of tasks) {
      const n = Number(t.key);
      if (!Number.isInteger(n) || n < 1 || n > 99) continue;
      const status = TASK_STATUSES.includes(t.status) ? t.status : "open";
      const folder = text(t.folder, 120);
      const number = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
      statements.push(
        upsertTask(env, "cloud", {
          id: id * 100 + n, message: id, quote: text(t.quote, 2000), title: text(t.title, 300), status,
          minutes: number(t.minutes), value: ["low", "medium", "high"].includes(t.value) ? t.value : null,
          outcome: text(t.outcome, 4000) || null, evidence: text(t.evidence, 4000) || null,
          created_at: number(t.created_at) || at, updated_at: at,
          done_at: ["done", "dropped"].includes(status) ? number(t.done_at) || at : null, left_open_at: null,
          work_seconds: number(t.work_seconds), tokens_in: number(t.tokens_in), tokens_out: number(t.tokens_out),
          folder: folder || null, report: text(t.report, 20000) || null, files: null, commits: null,
        }, at),
      );
      if (folder && home && !folder.includes("›")) {
        statements.push(upsertFolder(env, "cloud", { project: home, key: folder, name: folder, about: "", created_at: at, updated_at: at }, at));
      }
    }
  }
  // A request that ends without tasks (a page change from the browser extension, a plan that
  // failed) is still something the owner asked for: it becomes one task in their words with how it
  // ended, so no message waits on the board as never split (2026-11-17).
  const ended = body.status === "done" || body.status === "failed";
  if (ended && !tasks.length) {
    const message = await env.DB.prepare(
      "SELECT text, said_at FROM board_messages WHERE machine = 'cloud' AND id = ?1 AND split_at IS NULL",
    ).bind(id).first();
    // Stopped by the owner (stop_at): dropped, not stuck. As "blocked" it went to continueStuck, which
    // started the very request the owner had just stopped again (2026-11-20, requests 76 and 77).
    const stopped = await env.DB.prepare("SELECT stop_at FROM board_requests WHERE id = ?1").bind(id).first();
    if (message) statements.push(...endedAlone(env, id, message, body.status, text(body.outcome, 4000), at, Boolean(stopped?.stop_at)));
  }
  if (!statements.length) return json({ error: "Nothing to change." }, 400);
  await env.DB.batch(statements);
  return json({ ok: true });
}

/** The one task of a cloud request that ended without tasks (updateRequest), and its message split. */
function endedAlone(env, id, message, status, outcome, at, stopped = false) {
  const state = status === "done" ? "done" : stopped ? "dropped" : "blocked";
  const words = String(message.text || "").trim();
  const title = words.split("\n").map((l) => l.trim()).find(Boolean) || `Request R${id}`;
  return [
    env.DB.prepare("UPDATE board_messages SET split_at = COALESCE(split_at, ?2), synced_at = ?2 WHERE machine = 'cloud' AND id = ?1")
      .bind(id, at),
    upsertTask(env, "cloud", {
      id: id * 100 + 1, message: id, quote: words.slice(0, 2000), title: title.slice(0, 300),
      status: state, minutes: null, value: null,
      outcome: outcome || (state === "done" ? "Done." : state === "dropped" ? "Stopped by the owner." : "It didn't finish."), evidence: null,
      created_at: Number(message.said_at) || at, updated_at: at, done_at: state === "blocked" ? null : at, left_open_at: null,
      work_seconds: null, tokens_in: null, tokens_out: null, folder: null, report: null, files: null, commits: null,
    }, at),
  ];
}

// ---- the owner's browser -------------------------------------------------------------------

async function loginCode(request, env) {
  if (!(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const code = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM board_login_codes WHERE expires_at < ?1").bind(now()),
    env.DB.prepare("INSERT INTO board_login_codes (code, expires_at) VALUES (?1, ?2)").bind(code, now() + 600),
  ]);
  return json({ code, expires_in: 600 });
}

async function login(url, env) {
  const code = url.searchParams.get("code") || "";
  const used = code
    ? await env.DB.prepare("DELETE FROM board_login_codes WHERE code = ?1 AND expires_at > ?2 RETURNING code")
        .bind(code, now())
        .first()
    : null;
  if (!used) return new Response("That sign-in link was used or expired. Run hive-tasks web again.", { status: 403 });
  const expires = now() + YEAR;
  const mac = await hmac(env.TASKS_TOKEN, `web:${expires}`);
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": `${COOKIE}=${expires}.${mac}; Max-Age=${YEAR}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function board(request, env) {
  if (!(await browserAllowed(request, env)) && !(await machineAllowed(request, env))) {
    return json({ error: "Not signed in." }, 401);
  }
  const since = now() - 14 * DAY;
  const [tasks, unsplit, rules, folders, limits, requests, runs, steps, said] = await env.DB.batch([
    env.DB.prepare(
      `SELECT t.machine, t.id, t.message, t.quote, t.title, t.status, t.minutes, t.value, t.outcome, t.evidence,
              t.created_at, t.updated_at, t.done_at, t.left_open_at, t.work_seconds, t.tokens_in, t.tokens_out, t.folder, t.report,
              t.files, t.commits, COALESCE(t.claimed_harness, m.harness) AS harness,
              COALESCE(t.claimed_session, m.session) AS session, m.project, m.times, m.said_at, t.cancelled_at,
              -- Stuck, and Hive keeps continuing it on its own (continueStuck): never the owner's.
              CASE WHEN t.status = 'blocked' AND t.cancelled_at IS NULL
                     AND (t.machine = 'cloud' OR COALESCE(NULLIF(t.claimed_session, ''), NULLIF(m.session, '')) IS NOT NULL)
                     THEN 1 ELSE 0 END AS retrying
       FROM board_tasks t LEFT JOIN board_messages m ON m.machine = t.machine AND m.id = t.message
       WHERE t.status NOT IN ('done', 'dropped') OR t.updated_at > ?1
       ORDER BY t.updated_at DESC LIMIT 600`,
    ).bind(since),
    env.DB.prepare(
      `SELECT machine, id, harness, session, project, text, said_at, times FROM board_messages
       WHERE split_at IS NULL AND said_at > ?1 ORDER BY said_at DESC LIMIT 60`,
    ).bind(since),
    env.DB.prepare(
      "SELECT machine, id, project, paths, text, quote, active, shown FROM board_rules WHERE active = 1 ORDER BY created_at DESC",
    ),
    env.DB.prepare(
      `SELECT f.project, f.key, f.name, f.about, f.updated_at,
              (SELECT COUNT(*) FROM board_memories m WHERE m.project = f.project AND m.folder = f.key) AS memories
       FROM board_folders f ORDER BY f.project, f.key`,
    ),
    env.DB.prepare("SELECT machine, harness, home, plan, windows, at, synced_at FROM board_limits ORDER BY machine, harness, home"),
    env.DB.prepare(
      `SELECT r.id, r.agent, r.folder, r.status, r.outcome, r.created_at, r.updated_at, r.finished_at, r.follows, r.member, m.text, m.project
       FROM board_requests r LEFT JOIN board_messages m ON m.machine = 'cloud' AND m.id = r.id
       ORDER BY r.id DESC LIMIT 30`,
    ),
    // Every node's agent: its conversations of the last two days (one still working shows until it has
    // been quiet 6 hours), how many steps each has, its newest 40 (the rest open with GET /v1/runs) and
    // what the owner said to it.
    env.DB.prepare(
      `SELECT machine, run, agent, title, status, request, task, started_at, updated_at, project,
              (SELECT MAX(n) FROM board_run_steps s WHERE s.machine = r.machine AND s.run = r.run) AS step_count
       FROM board_runs r WHERE ${LISTED_RUNS} ORDER BY updated_at DESC LIMIT 60`,
    ).bind(now() - 2 * DAY, now() - 6 * 3600),
    env.DB.prepare(
      `WITH listed AS (
         SELECT machine, run, (SELECT MAX(n) FROM board_run_steps s WHERE s.machine = r.machine AND s.run = r.run) AS top
         FROM board_runs r WHERE ${LISTED_RUNS} ORDER BY updated_at DESC LIMIT 60)
       SELECT s.machine, s.run, s.n, s.at, s.kind, s.text FROM listed l
       JOIN board_run_steps s ON s.machine = l.machine AND s.run = l.run AND s.n > l.top - 40
       ORDER BY s.machine, s.run, s.n`,
    ).bind(now() - 2 * DAY, now() - 6 * 3600),
    env.DB.prepare(
      `SELECT id, machine, run, text, sender, status, detail, task, created_at, updated_at FROM board_run_messages
       WHERE created_at > ?1 ORDER BY id`,
    ).bind(now() - 2 * DAY),
  ]);
  return json({
    now: now(), tasks: tasks.results, unsplit: unsplit.results, rules: rules.results, folders: folders.results,
    limits: limits.results, requests: requests.results, runs: runs.results, run_steps: steps.results,
    run_messages: said.results,
    // What each node runs (nodes.js); the board answers without it if that read fails.
    nodes: await nodeList(env).catch(() => null),
  });
}

async function page(request, env) {
  if (!(await browserAllowed(request, env))) {
    return new Response(
      "<!doctype html><meta name=viewport content='width=device-width'><title>Hive tasks</title>" +
        "<p style='font:16px system-ui;margin:2rem'>Not signed in. On your Mac, run <code>hive-tasks web</code>.</p>",
      { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  return new Response(PAGE, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hive tasks</title>
<style>
:root{--bg:#f6f6f3;--card:#fff;--ink:#1c1c1a;--soft:#6b6b66;--line:#e3e3dd;--accent:#b4570f;--ok:#2f7a3b;--warn:#a33a2c;--chip:#efeee8}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1d1d1b;--ink:#ecebe6;--soft:#9d9c95;--line:#2e2e2b;--accent:#e08a44;--ok:#6cbf78;--warn:#ef7d6d;--chip:#262624}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0 2px}.sub{color:var(--soft);font-size:13px;margin-bottom:12px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 14px}.chip{border:1px solid var(--line);background:var(--chip);color:var(--ink);border-radius:99px;padding:4px 10px;font-size:13px;cursor:pointer}
.chip.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--soft);margin:20px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:6px 0}
.title{font-weight:600}.quote{color:var(--soft);font-size:13px;margin-top:3px;white-space:pre-wrap;overflow-wrap:anywhere}
.meta{color:var(--soft);font-size:12px;margin-top:6px;display:flex;gap:10px;flex-wrap:wrap}
.outcome{margin-top:6px;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.tag{font-size:11px;border-radius:4px;padding:1px 6px;background:var(--chip)}.warn{color:var(--warn)}.ok{color:var(--ok)}.acc{color:var(--accent)}
.empty{color:var(--soft);font-size:13px;padding:4px 0}
</style></head><body><main>
<h1>Hive tasks</h1><div class="sub" id="sub">Loading…</div>
<div class="chips" id="projects"></div>
<div id="board"></div>
</main><script>
let data=null,project=localStorage.getItem("project")||"";
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ago=t=>{if(!t)return"";const s=data.now-t;return s<90?"just now":s<5400?Math.round(s/60)+" min ago":s<129600?Math.round(s/3600)+" h ago":Math.round(s/86400)+" d ago"};
const short=p=>String(p||"").replace(/^github\\.com\\//,"").replace(/^\\/Users\\/[^/]+\\//,"~/");
function card(t){const worth=t.value==="low"&&(t.minutes||0)>=30;return '<div class="card"><div class="title">'+esc(t.title)+'</div>'+
 '<div class="quote">“'+esc(t.quote)+'”</div>'+
 (t.outcome?'<div class="outcome">'+esc(t.outcome)+'</div>':"")+
 '<div class="meta"><span class="tag">'+esc(t.harness||"")+' · '+esc(t.machine)+'</span><span>'+esc(short(t.project))+'</span>'+
 (t.minutes!=null?'<span>~'+t.minutes+' min</span>':"")+(t.value?'<span>'+esc(t.value)+' value</span>':"")+
 ((t.times||1)>1?'<span class="warn">said '+t.times+'×</span>':"")+(worth?'<span class="acc">worth asking first</span>':"")+
 '<span>'+ago(t.updated_at)+'</span></div></div>'}
function section(name,list,empty){return '<h2>'+name+' · '+list.length+'</h2>'+(list.length?list.map(card).join(""):'<div class="empty">'+empty+'</div>')}
function render(){const all=data.tasks.filter(t=>!project||t.project===project);const by=s=>all.filter(t=>t.status===s);
 const unsplit=data.unsplit.filter(m=>!project||m.project===project);
 const open=all.filter(t=>t.status==="open"),left=open.filter(t=>t.left_open_at),notStarted=open.filter(t=>!t.left_open_at);
 document.getElementById("sub").textContent=data.tasks.filter(t=>t.status==="active").length+" in progress · "+data.tasks.filter(t=>["waiting","blocked"].includes(t.status)).length+" need you · updated "+new Date().toLocaleTimeString();
 const projects=[...new Set(data.tasks.map(t=>t.project).filter(Boolean))].sort();
 document.getElementById("projects").innerHTML=['<button class="chip'+(project?"":" on")+'" data-p="">All</button>',...projects.map(p=>'<button class="chip'+(p===project?" on":"")+'" data-p="'+esc(p)+'">'+esc(short(p))+'</button>')].join("");
 document.getElementById("board").innerHTML=
  section("Needs you",[...by("waiting"),...by("blocked")],"Nothing is waiting on you.")+
  section("In progress",by("active"),"No agent is working on anything.")+
  section("Not started",notStarted,"Nothing queued.")+
  section("Left open by an agent",left,"No agent stopped with work unfinished.")+
  (unsplit.length?'<h2>Not split into tasks yet · '+unsplit.length+'</h2>'+unsplit.map(m=>'<div class="card"><div class="quote">“'+esc(m.text)+'”</div><div class="meta"><span class="tag">'+esc(m.harness)+' · '+esc(m.machine)+'</span><span>'+esc(short(m.project))+'</span><span>'+ago(m.said_at)+'</span></div></div>').join(""):"")+
  section("Done (last 2 weeks)",[...by("done"),...by("dropped")].sort((a,b)=>b.updated_at-a.updated_at).slice(0,40),"Nothing finished yet.")+
  '<h2>Your rules · '+data.rules.length+'</h2>'+(data.rules.length?data.rules.filter(r=>!project||r.project===project).map(r=>'<div class="card"><div class="title">'+esc(r.text)+'</div><div class="quote">“'+esc(r.quote)+'”</div><div class="meta"><span>'+esc(short(r.project))+'</span><span>'+(JSON.parse(r.paths||"[]").join(", ")||"whole project")+'</span><span>shown '+r.shown+'×</span></div></div>').join(""):'<div class="empty">No standing rules yet.</div>');
}
document.addEventListener("click",e=>{const p=e.target.closest("[data-p]");if(!p)return;project=p.dataset.p;try{localStorage.setItem("project",project)}catch{}render()});
async function load(){try{const r=await fetch("/v1/board",{cache:"no-store"});if(!r.ok)throw new Error(r.status);data=await r.json();render()}catch(e){document.getElementById("sub").textContent="Couldn't load ("+e.message+")."}}
load();setInterval(load,30000);
</script></body></html>`;
