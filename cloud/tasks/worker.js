// The owner's task board in the cloud. Every machine's hive-tasks (desktop/app/crates/hive/
// hive-tasks) pushes the messages, tasks, rules, folders and memories that changed (POST /v1/sync)
// and gets back the rules set on the owner's other machines and the folders and memories made
// elsewhere (other machines, the dashboard), so an instruction given once reaches every agent.
// The owner reads all of it on one page (/), signed in by a one-use code from `hive-tasks web`.
// Tables: cloud/knowledge/migrations/0003_task_board.sql to 0011 (the hive-knowledge D1 database).
// The dashboard also sends instructions here for Hive's orchestrator in the cloud (/v1/requests).

const DAY = 86400;
const YEAR = 365 * DAY;
const COOKIE = "hive_board";

// What the browser extension may call, with its own key (see extensionAllowed). It calls from web
// pages too (page-rules.js runs in each page), so these answer cross-origin; the key is a bearer
// token, never a cookie, so "*" lets no page act as the owner.
const EXTENSION_PATHS = new Set(["/v1/requests", "/v1/requests/state", "/v1/requests/steps", "/v1/page-rules", "/v1/page-rules/off"]);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (EXTENSION_PATHS.has(url.pathname)) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const response = await route(request, env, url);
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    }
    return route(request, env, url);
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
      if (url.pathname === "/v1/folders" && request.method === "POST") return await saveFolder(request, env);
      if (url.pathname === "/v1/folders/memory" && request.method === "POST") return await saveMemory(request, env);
      if (url.pathname === "/v1/requests" && request.method === "POST") return await sendRequest(request, env);
      if (url.pathname === "/v1/requests/take" && request.method === "POST") return await takeRequest(request, env);
      if (url.pathname === "/v1/requests/update" && request.method === "POST") return await updateRequest(request, env);
      if (url.pathname === "/v1/requests/state") return await requestState(url, request, env);
      if (url.pathname === "/v1/requests/steps" && request.method === "POST") return await saveSteps(request, env);
      if (url.pathname === "/v1/requests/steps") return await requestSteps(url, request, env);
      if (url.pathname === "/v1/extension-key" && request.method === "POST") return await extensionKey(request, env);
      if (url.pathname === "/v1/page-rules" && request.method === "GET") return await pageRules(url, request, env);
      if (url.pathname === "/v1/page-rules" && request.method === "POST") return await savePageRule(request, env);
      if (url.pathname === "/v1/page-rules/off" && request.method === "POST") return await pageRuleOff(request, env);
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
  "report", "files", "commits",
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
      upsert(env, "board_tasks", TASK_COLUMNS, machine, r.folder === undefined ? { ...r, folder: r.part } : r, at),
    ),
    ...(body.rules || []).map((r) => upsert(env, "board_rules", RULE_COLUMNS, machine, r, at)),
    ...(body.folders || []).map((r) => upsertFolder(env, machine, r, at)),
    ...(body.memories || []).map((r) => upsert(env, "board_memories", MEMORY_COLUMNS, machine, r, at)),
    ...(body.events || []).map((r) => upsert(env, "board_task_events", EVENT_COLUMNS, machine, r, at)),
    ...(body.limits || []).slice(0, 10).map((r) => upsert(env, "board_limits", LIMIT_COLUMNS, machine, limitRow(r), at)),
  ];
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  const since = Number(body.since) || 0;
  const [rules, folders, memories] = await env.DB.batch([
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
  ]);
  return json({ saved: statements.length, now: at, rules: rules.results, folders: folders.results, memories: memories.results });
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

async function anyoneAllowed(request, env) {
  return (await allowed(request, env)) || (await extensionAllowed(request, env));
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
  const { project, folder } = scopeOf(words);
  const at = now();
  const [made] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO board_requests (id, agent, folder, status, created_at, updated_at)
       SELECT COALESCE(MAX(id), 0) + 1, ?1, ?2, 'queued', ?3, ?3 FROM board_requests RETURNING id`,
    ).bind(agent, folder || null, at),
    env.DB.prepare(
      `INSERT INTO board_messages (machine, id, harness, session, project, text, said_at, times, split_at, synced_at)
       VALUES ('cloud', (SELECT MAX(id) FROM board_requests), 'hive', ?4, ?1, ?2, ?3, 1, NULL, ?3)`,
    ).bind(project.toLowerCase(), words, at, from),
  ]);
  const id = made.results[0].id;
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

async function takeRequest(request, env) {
  if (!(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json();
  const by = text(body.by, 80);
  if (!by) return json({ error: "Say who is taking it (by)." }, 400);
  const agent = text(body.agent, 40) || "hive-cloud";
  const at = now();
  const [, taken] = await env.DB.batch([
    // What this orchestrator held when it last stopped won't be finished by it now.
    env.DB.prepare(
      `UPDATE board_requests SET status = 'failed', finished_at = ?2, updated_at = ?2,
         outcome = COALESCE(outcome, 'The orchestrator restarted before it finished this.')
       WHERE taken_by = ?1 AND status IN ('planning', 'working') AND ?3 = 1`,
    ).bind(by, at, body.fresh ? 1 : 0),
    env.DB.prepare(
      `UPDATE board_requests SET status = 'planning', taken_by = ?1, taken_at = ?2, updated_at = ?2
       WHERE id = (SELECT id FROM board_requests WHERE status = 'queued' AND agent = ?3 ORDER BY id LIMIT 1)
       RETURNING id, folder`,
    ).bind(by, at, agent),
  ]);
  const row = taken.results[0];
  if (!row) return json({ request: null });
  const [message, asked] = await Promise.all([
    env.DB.prepare("SELECT project, text, said_at, session FROM board_messages WHERE machine = 'cloud' AND id = ?1").bind(row.id).first(),
    env.DB.prepare("SELECT url, title, outline FROM board_page_asks WHERE request = ?1").bind(row.id).first(),
  ]);
  return json({
    request: {
      id: row.id, folder: row.folder || "", project: message?.project || "", text: message?.text || "",
      said_at: message?.said_at, from: message?.session || "web",
      page: asked ? { url: asked.url, title: asked.title || "", outline: asked.outline || "" } : null,
    },
  });
}

// GET /v1/requests/state?id=7: how one request stands, for whoever sent it.
async function requestState(url, request, env) {
  if (!(await anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) return json({ error: "Say which request (id)." }, 400);
  const row = await env.DB.prepare("SELECT id, status, outcome, updated_at FROM board_requests WHERE id = ?1").bind(id).first();
  return row ? json({ request: row }) : json({ error: "No such request." }, 404);
}

// What the agent is doing, step by step (board_request_steps, migration 0011): the orchestrator sends
// each line its agent prints ("→ click: Open Compose", "💬 …", "✅ Done.") a few at a time while a task
// runs, and the dashboard shows them under the task as they land. A request keeps its first MOST_STEPS.
const MOST_STEPS = 800;

// POST /v1/requests/steps {id, task, steps: [{at, text}]}
async function saveSteps(request, env) {
  if (!(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const body = await request.json();
  const id = Number(body.id);
  const task = Number(body.task);
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(task) || task < 1 || task > 99) {
    return json({ error: "Say which request and task (id, task)." }, 400);
  }
  const steps = (Array.isArray(body.steps) ? body.steps : [])
    .slice(0, 100)
    .map((step) => ({ at: Math.round(Number(step && step.at)) || now(), text: text(step && step.text, 500) }))
    .filter((step) => step.text);
  if (!steps.length) return json({ error: "No steps." }, 400);
  // Each line takes the next number in SQL, so lines sent together keep their order.
  await env.DB.batch(steps.map((step) => env.DB.prepare(
    `INSERT OR IGNORE INTO board_request_steps (request, task, n, at, text)
     SELECT ?1, ?2, COALESCE(MAX(n), 0) + 1, ?3, ?4 FROM board_request_steps WHERE request = ?1
     HAVING COALESCE(MAX(n), 0) < ?5`,
  ).bind(id, task, step.at, step.text, MOST_STEPS)));
  return json({ ok: true });
}

// GET /v1/requests/steps?id=7&after=12: the request's steps after number `after`.
async function requestSteps(url, request, env) {
  if (!(await anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) return json({ error: "Say which request (id)." }, 400);
  const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
  const rows = await env.DB.prepare(
    "SELECT n, task, at, text FROM board_request_steps WHERE request = ?1 AND n > ?2 ORDER BY n LIMIT 500",
  ).bind(id, after).all();
  return json({ steps: rows.results });
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
        upsert(env, "board_tasks", TASK_COLUMNS, "cloud", {
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
  if (!statements.length) return json({ error: "Nothing to change." }, 400);
  await env.DB.batch(statements);
  return json({ ok: true });
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
  const [tasks, unsplit, rules, folders, limits, requests, steps] = await env.DB.batch([
    env.DB.prepare(
      `SELECT t.machine, t.id, t.message, t.quote, t.title, t.status, t.minutes, t.value, t.outcome, t.evidence,
              t.created_at, t.updated_at, t.done_at, t.left_open_at, t.work_seconds, t.tokens_in, t.tokens_out, t.folder, t.report,
              t.files, t.commits, m.harness, m.session, m.project, m.times, m.said_at
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
      `SELECT r.id, r.agent, r.folder, r.status, r.outcome, r.created_at, r.updated_at, r.finished_at, m.text, m.project
       FROM board_requests r LEFT JOIN board_messages m ON m.machine = 'cloud' AND m.id = r.id
       ORDER BY r.id DESC LIMIT 20`,
    ),
    // What the agent is doing on requests still going or just finished: each one's last 200 steps.
    env.DB.prepare(
      `SELECT request, task, n, at, text FROM (
         SELECT s.request, s.task, s.n, s.at, s.text, ROW_NUMBER() OVER (PARTITION BY s.request ORDER BY s.n DESC) AS back
         FROM board_request_steps s JOIN board_requests r ON r.id = s.request
         WHERE r.status IN ('planning', 'working') OR r.updated_at > ?1)
       WHERE back <= 200 ORDER BY request, n`,
    ).bind(now() - 30 * 60),
  ]);
  return json({
    now: now(), tasks: tasks.results, unsplit: unsplit.results, rules: rules.results, folders: folders.results,
    limits: limits.results, requests: requests.results, steps: steps.results,
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
 '<div class="quote">“'+esc(t.quote.length>400?t.quote.slice(0,400)+"…":t.quote)+'”</div>'+
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
  (unsplit.length?'<h2>Not split into tasks yet · '+unsplit.length+'</h2>'+unsplit.map(m=>'<div class="card"><div class="quote">“'+esc(m.text.slice(0,500))+'”</div><div class="meta"><span class="tag">'+esc(m.harness)+' · '+esc(m.machine)+'</span><span>'+esc(short(m.project))+'</span><span>'+ago(m.said_at)+'</span></div></div>').join(""):"")+
  section("Done (last 2 weeks)",[...by("done"),...by("dropped")].sort((a,b)=>b.updated_at-a.updated_at).slice(0,40),"Nothing finished yet.")+
  '<h2>Your rules · '+data.rules.length+'</h2>'+(data.rules.length?data.rules.filter(r=>!project||r.project===project).map(r=>'<div class="card"><div class="title">'+esc(r.text)+'</div><div class="quote">“'+esc(r.quote)+'”</div><div class="meta"><span>'+esc(short(r.project))+'</span><span>'+(JSON.parse(r.paths||"[]").join(", ")||"whole project")+'</span><span>shown '+r.shown+'×</span></div></div>').join(""):'<div class="empty">No standing rules yet.</div>');
}
document.addEventListener("click",e=>{const p=e.target.closest("[data-p]");if(!p)return;project=p.dataset.p;try{localStorage.setItem("project",project)}catch{}render()});
async function load(){try{const r=await fetch("/v1/board",{cache:"no-store"});if(!r.ok)throw new Error(r.status);data=await r.json();render()}catch(e){document.getElementById("sub").textContent="Couldn't load ("+e.message+")."}}
load();setInterval(load,30000);
</script></body></html>`;
