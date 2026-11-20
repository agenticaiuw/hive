// How Hive's agents work together (the owner, 2026-11-20: "agents collaborating with themselves who are
// started by actual people in our club", "interagent communciations, etc. built into hive", "maybe some
// agents need to lockup some files to prevent other agents from editing"). Every agent has a name here:
// a task Hive runs is its run's label (R12-1, request 12's first task); any other agent (a member's
// Codex or Claude Code, an agent on someone's Mac) names itself. Like Devhub's inbox and claims and MCP
// Agent Mail's file reservations (the knowledge base's "Club collaboration" decision):
//
//   POST /v1/team/send {from, to, text, request?}         a message to one agent (its name), to "all"
//                                                          agents, or to a person ("owner" or a member)
//   GET  /v1/team/inbox?agent=R12-1[&peek=1]               its unread messages, then marked read (peek: not)
//   GET  /v1/team/agents                                   who's working now, with the files each holds
//   POST /v1/team/claim {agent, paths, exclusive?, minutes?, note?, repo?}
//                                                          leases on files or globs: {claimed, conflicts}
//   POST /v1/team/release {agent, paths?, repo?}           its leases (all of them without paths)
//   GET  /v1/team/claims[?paths=a,b][&repo=hive]           the live leases, or those over these paths
//
// A lease is advisory and lapses (an agent that died lets go by itself); an agent claims again to keep
// it. Hive's own landing honors them (orchestrator.mjs improveOnVm): a change waits while another live
// agent holds one of its files exclusively. Tables: cloud/knowledge/migrations/0024_team.sql.

export const DEFAULT_MINUTES = 60;
export const MOST_MINUTES = 24 * 60;
// A running task that wrote a step this recently is working now.
export const ACTIVE_S = 15 * 60;
const MOST_TEXT = 8000;
const MOST_PATHS = 100;
const MOST_INBOX = 50;

const text = (value, max) => String(value == null ? "" : value).trim().slice(0, max);
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** An agent's or person's name: letters, digits and . _ @ : - only, at most 80. */
export function nameOf(value) {
  const name = text(value, 80);
  return /^[\w.@:-]+$/.test(name) ? name : "";
}

/** A path or glob relative to the repository: no leading slash, no "..", at most 300. */
export function pathOf(value) {
  const path = text(value, 300).replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return "";
  return path;
}

const GLOB = /[*?[]/;

/** A glob as a regular expression: ** any folders, * and ? within one name; "dir/" everything under it. */
export function globRegex(glob) {
  const pattern = glob.endsWith("/") ? `${glob}**` : glob;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i++;
      if (pattern[i + 1] === "/") i++;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether two leased paths can touch the same file. A file against a glob: the glob matches it. Two
 * globs: one's fixed start is the start of the other's (so "cloud/**" and "cloud/tasks/*.js" overlap,
 * "cloud/**" and "dashboard/**" don't); it can say yes for two that never meet, never no for two that do.
 */
export function overlaps(a, b) {
  const globA = GLOB.test(a) || a.endsWith("/");
  const globB = GLOB.test(b) || b.endsWith("/");
  if (!globA && !globB) return a === b;
  if (!globA) return globRegex(b).test(a);
  if (!globB) return globRegex(a).test(b);
  const fixed = (g) => g.split(/[*?[]/)[0];
  const [fa, fb] = [fixed(a), fixed(b)];
  return fa.startsWith(fb) || fb.startsWith(fa);
}

export async function teamRoute(request, env, url, { machineAllowed }, { clock = () => Date.now() } = {}) {
  if (!(await machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  const now = Math.floor(clock() / 1000);
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const repo = nameOf(body.repo ?? url.searchParams.get("repo")) || "hive";

  if (url.pathname === "/v1/team/send" && request.method === "POST") {
    const from = nameOf(body.from);
    const to = nameOf(body.to);
    const words = text(body.text, MOST_TEXT);
    if (!from || !to || !words) return json({ error: "Say who it's from, who it's to and what it says (from, to, text)." }, 400);
    const req = Number.isSafeInteger(body.request) && body.request > 0 ? body.request : null;
    const row = await env.DB.prepare(
      "INSERT INTO team_messages (sender, recipient, text, request, at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
    ).bind(from, to, words, req, now).first();
    return json({ id: row.id, to });
  }

  if (url.pathname === "/v1/team/inbox" && request.method === "GET") {
    const agent = nameOf(url.searchParams.get("agent"));
    if (!agent) return json({ error: "Say whose inbox (agent)." }, 400);
    const { results } = await env.DB.prepare(
      `SELECT id, sender AS "from", recipient AS "to", text, request, at FROM team_messages m
       WHERE (recipient = ?1 OR recipient = 'all') AND sender <> ?1
         AND NOT EXISTS (SELECT 1 FROM team_reads r WHERE r.agent = ?1 AND r.message = m.id)
       ORDER BY id LIMIT ${MOST_INBOX}`,
    ).bind(agent).all();
    if (results.length && url.searchParams.get("peek") !== "1") {
      await env.DB.batch(results.map((m) => env.DB.prepare("INSERT OR IGNORE INTO team_reads (agent, message, at) VALUES (?1, ?2, ?3)").bind(agent, m.id, now)));
    }
    return json({ agent, messages: results });
  }

  if (url.pathname === "/v1/team/agents" && request.method === "GET") {
    const { results: runs } = await env.DB.prepare(
      `SELECT machine, run, agent, title, request, task, updated_at FROM board_runs
       WHERE status = 'working' AND updated_at > ?1 ORDER BY started_at`,
    ).bind(now - ACTIVE_S).all();
    const { results: leases } = await env.DB.prepare(
      "SELECT agent, path, exclusive, note, expires_at FROM team_leases WHERE repo = ?1 AND expires_at > ?2 ORDER BY at",
    ).bind(repo, now).all();
    const agents = new Map();
    for (const r of runs) {
      const name = r.request && r.task ? `R${r.request}-${r.task}` : `${r.machine}:${r.run}`;
      agents.set(name, { name, kind: r.agent, title: r.title, request: r.request, files: [], seen: r.updated_at });
    }
    for (const l of leases) {
      if (!agents.has(l.agent)) agents.set(l.agent, { name: l.agent, kind: "", title: "", request: null, files: [], seen: null });
      agents.get(l.agent).files.push({ path: l.path, exclusive: Boolean(l.exclusive), note: l.note, expires_in: l.expires_at - now });
    }
    return json({ agents: [...agents.values()] });
  }

  if (url.pathname === "/v1/team/claim" && request.method === "POST") {
    const agent = nameOf(body.agent);
    const paths = [...new Set((Array.isArray(body.paths) ? body.paths : []).map(pathOf).filter(Boolean))].slice(0, MOST_PATHS);
    if (!agent || !paths.length) return json({ error: "Say who claims and which files (agent, paths)." }, 400);
    const exclusive = body.exclusive === false ? 0 : 1;
    const minutes = Math.min(Math.max(Number(body.minutes) || DEFAULT_MINUTES, 1), MOST_MINUTES);
    const note = text(body.note, 300);
    const { results: held } = await env.DB.prepare(
      "SELECT agent, path, exclusive, note, expires_at FROM team_leases WHERE repo = ?1 AND agent <> ?2 AND expires_at > ?3",
    ).bind(repo, agent, now).all();
    const claimed = [];
    const conflicts = [];
    for (const path of paths) {
      const against = held.filter((h) => (exclusive || h.exclusive) && overlaps(path, h.path));
      if (against.length) {
        for (const h of against) conflicts.push({ path, holder: h.agent, held: h.path, note: h.note, expires_in: h.expires_at - now });
      } else claimed.push(path);
    }
    if (claimed.length) {
      await env.DB.batch(claimed.map((path) => env.DB.prepare(
        `INSERT INTO team_leases (repo, path, agent, exclusive, note, at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (repo, path, agent) DO UPDATE SET exclusive = excluded.exclusive, note = excluded.note, expires_at = excluded.expires_at`,
      ).bind(repo, path, agent, exclusive, note, now, now + minutes * 60)));
    }
    return json({ agent, claimed, conflicts, minutes });
  }

  if (url.pathname === "/v1/team/release" && request.method === "POST") {
    const agent = nameOf(body.agent);
    if (!agent) return json({ error: "Say whose leases (agent)." }, 400);
    const paths = (Array.isArray(body.paths) ? body.paths : []).map(pathOf).filter(Boolean);
    const result = paths.length
      ? await env.DB.batch(paths.map((path) => env.DB.prepare("DELETE FROM team_leases WHERE repo = ?1 AND agent = ?2 AND path = ?3").bind(repo, agent, path)))
      : [await env.DB.prepare("DELETE FROM team_leases WHERE repo = ?1 AND agent = ?2").bind(repo, agent).run()];
    return json({ agent, released: result.reduce((n, r) => n + (r?.meta?.changes ?? 0), 0) });
  }

  if (url.pathname === "/v1/team/claims" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT agent, path, exclusive, note, at, expires_at FROM team_leases WHERE repo = ?1 AND expires_at > ?2 ORDER BY at",
    ).bind(repo, now).all();
    const over = (url.searchParams.get("paths") || "").split(",").map(pathOf).filter(Boolean);
    const leases = results
      .filter((l) => !over.length || over.some((p) => overlaps(p, l.path)))
      .map((l) => ({ agent: l.agent, path: l.path, exclusive: Boolean(l.exclusive), note: l.note, held_for: now - l.at, expires_in: l.expires_at - now }));
    return json({ leases });
  }

  return json({ error: "Not found" }, 404);
}
