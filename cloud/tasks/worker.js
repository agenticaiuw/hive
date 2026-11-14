// The owner's task board in the cloud. Every machine's hive-tasks (desktop/app/crates/hive/
// hive-tasks) pushes the messages, tasks, rules, folders and memories that changed (POST /v1/sync)
// and gets back the rules set on the owner's other machines and the folders and memories made
// elsewhere (other machines, the dashboard), so an instruction given once reaches every agent.
// The owner reads all of it on one page (/), signed in by a one-use code from `hive-tasks web`.
// Tables: cloud/knowledge/migrations/0003_task_board.sql, 0004, 0005 (the hive-knowledge D1 database).

const DAY = 86400;
const YEAR = 365 * DAY;
const COOKIE = "hive_board";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/v1/sync" && request.method === "POST") return await sync(request, env);
      if (url.pathname === "/v1/login-code" && request.method === "POST") return await loginCode(request, env);
      if (url.pathname === "/login") return await login(url, env);
      if (url.pathname === "/v1/board") return await board(request, env);
      if (url.pathname === "/v1/folder") return await folder(url, request, env);
      if (url.pathname === "/v1/folders" && request.method === "POST") return await saveFolder(request, env);
      if (url.pathname === "/v1/folders/memory" && request.method === "POST") return await saveMemory(request, env);
      if (url.pathname === "/") return await page(request, env);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return json({ error: String((error && error.message) || error) }, 500);
    }
  },
};

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
  "report",
];
const MEMORY_COLUMNS = ["id", "project", "folder", "kind", "title", "body", "task", "created_at"];
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
  const [tasks, unsplit, rules, folders] = await env.DB.batch([
    env.DB.prepare(
      `SELECT t.machine, t.id, t.message, t.quote, t.title, t.status, t.minutes, t.value, t.outcome, t.evidence,
              t.created_at, t.updated_at, t.done_at, t.left_open_at, t.work_seconds, t.tokens_in, t.tokens_out, t.folder, t.report,
              m.harness, m.session, m.project, m.times, m.said_at
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
  ]);
  return json({ now: now(), tasks: tasks.results, unsplit: unsplit.results, rules: rules.results, folders: folders.results });
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
