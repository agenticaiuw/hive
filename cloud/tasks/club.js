// The club changes Hive through Hive (the owner, 2026-11-20: "anyone in our club should be able to portal
// into that vm and then start editing the code through an agent, and then we'll have agents collaborating
// with themselves who are started by actual people in our club"; "this collaboration system on the vm is
// hive itself"). The owner lets a member in with a one-use invite link; the member signs in with it on the
// dashboard's club page (dashboard/src/routes/club) and gets their own key. With it they ask Hive to change
// itself, and Hive on the VM runs that the way it runs the owner's changes to Hive (orchestrator.mjs
// changeHive): an agent in its own worktree, on the one Codex login there, tested, landed on main and put
// live everywhere. A member's request is only ever a change to Hive's code: it never reaches the owner's
// Mac, phone, browsers or accounts, and a member sees only the club's requests, never the owner's board.
//
//   GET  /v1/club/members                         owner: the members, and how many changes each has going
//   POST /v1/club/members {name, max_agents?}     owner: lets a member in, or invites them again:
//                                                 {name, invite, expires_in} (the invite works once)
//   POST /v1/club/members/remove {name}           owner: lets a member go; their key stops working
//   POST /v1/club/join {invite}                   with an invite: {name, key}, once
//   GET  /v1/club/me                              member: {name, max_agents, going}
//   POST /v1/club/requests {text, follows?}       member: a change to Hive, if fewer than max_agents of
//                                                 theirs are going: {id, ahead}
//   POST /v1/club/stop {id}                       member: stops one of their own requests
//   GET  /v1/club/board                           member: the club's requests, their tasks and live steps
//   /v1/club/team/...                             member: messages and file leases (team.js), as themselves
//
// How many at once (the knowledge base's "Club collaboration" decision): a member runs at most
// max_agents requests at a time (DEFAULT_AGENTS unless the owner says otherwise); the planner splits each
// into tasks, one agent each; the VM's slots (orchestrator.mjs MOST_REQUESTS, MOST_RUNNING) cap them all.
// Tables: cloud/knowledge/migrations/0025_club.sql.

export const DEFAULT_AGENTS = 3;
export const MOST_AGENTS = 8;
export const INVITE_S = 7 * 86400;
const DAY = 86400;
const SEEN_EVERY_S = 60;
const GOING = "('queued', 'planning', 'working')";

const text = (value, max) => String(value == null ? "" : value).trim().slice(0, max);
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** A member's name: lowercase letters, digits, _ and -, at most 40 (it's part of their key). */
export function memberName(value) {
  const name = text(value, 40).toLowerCase();
  return /^[a-z0-9_-]+$/.test(name) ? name : "";
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const secret = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(value) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

/** The member a request is signed in as ("Bearer club.<name>.<secret>"), or null. */
export async function memberOf(request, env, now) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer club\.([a-z0-9_-]{1,40})\.([0-9a-f]{64})$/.exec(header);
  if (!match) return null;
  const row = await env.DB.prepare("SELECT name, max_agents, key_hash, seen_at FROM club_members WHERE name = ?1").bind(match[1]).first();
  // Only the key's hash is kept, so comparing hashes says nothing about the key.
  if (!row?.key_hash || row.key_hash !== (await sha256(match[2]))) return null;
  if (!(row.seen_at > now - SEEN_EVERY_S)) {
    await env.DB.prepare("UPDATE club_members SET seen_at = ?2 WHERE name = ?1").bind(row.name, now).run();
  }
  return { name: row.name, max_agents: row.max_agents };
}

async function going(env, name) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM board_requests WHERE member = ?1 AND status IN ${GOING}`).bind(name).first();
  return row?.n ?? 0;
}

/**
 * `deps`: allowed(request, env) for the owner; newRequest(env, {words, agent, from, at, member, follows})
 * → id (worker.js); teamRoute (team.js).
 */
export async function clubRoute(request, env, url, { allowed, newRequest, teamRoute }, { clock = () => Date.now() } = {}) {
  const now = Math.floor(clock() / 1000);
  const path = url.pathname;
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

  // ---- the owner ----
  if (path === "/v1/club/members" || path === "/v1/club/members/remove") {
    if (!(await allowed(request, env))) return json({ error: "Not signed in." }, 401);
    if (request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT c.name, c.max_agents, c.key_hash IS NOT NULL AS joined, c.invite_expires_at, c.created_at, c.seen_at,
                (SELECT COUNT(*) FROM board_requests r WHERE r.member = c.name AND r.status IN ${GOING}) AS going
         FROM club_members c ORDER BY c.name`,
      ).all();
      return json({
        members: results.map((m) => ({
          name: m.name, max_agents: m.max_agents, joined: Boolean(m.joined), going: m.going,
          invited: m.invite_expires_at > now, created_at: m.created_at, seen_at: m.seen_at,
        })),
      });
    }
    const name = memberName(body.name);
    if (!name) return json({ error: "Say who (name: lowercase letters, digits, _ or -)." }, 400);
    if (path === "/v1/club/members/remove") {
      const gone = await env.DB.prepare("DELETE FROM club_members WHERE name = ?1").bind(name).run();
      return json({ name, removed: gone.meta.changes });
    }
    const max = Math.min(Math.max(Math.round(Number(body.max_agents)) || DEFAULT_AGENTS, 1), MOST_AGENTS);
    const invite = secret(24);
    await env.DB.prepare(
      `INSERT INTO club_members (name, max_agents, invite_hash, invite_expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (name) DO UPDATE SET max_agents = excluded.max_agents, invite_hash = excluded.invite_hash,
         invite_expires_at = excluded.invite_expires_at`,
    ).bind(name, max, await sha256(invite), now + INVITE_S, now).run();
    return json({ name, max_agents: max, invite, expires_in: INVITE_S });
  }

  // ---- signing in with an invite ----
  if (path === "/v1/club/join" && request.method === "POST") {
    const invite = text(body.invite, 100);
    if (!/^[0-9a-f]{48}$/.test(invite)) return json({ error: "That invite isn't one (invite)." }, 400);
    const key = secret(32);
    const row = await env.DB.prepare(
      `UPDATE club_members SET key_hash = ?3, invite_hash = NULL, invite_expires_at = NULL, seen_at = ?2
       WHERE invite_hash = ?1 AND invite_expires_at > ?2 RETURNING name, max_agents`,
    ).bind(await sha256(invite), now, await sha256(key)).first();
    if (!row) return json({ error: "That invite was used or has expired: ask for a new one." }, 403);
    return json({ name: row.name, max_agents: row.max_agents, key: `club.${row.name}.${key}` });
  }

  // ---- a member ----
  const member = await memberOf(request, env, now);
  if (!member) return json({ error: "Not signed in as a club member." }, 401);

  if (path === "/v1/club/me" && request.method === "GET") {
    return json({ ...member, going: await going(env, member.name) });
  }

  if (path === "/v1/club/requests" && request.method === "POST") {
    const words = text(body.text, 4000);
    if (!words) return json({ error: "Say what to change in Hive (text)." }, 400);
    const busy = await going(env, member.name);
    if (busy >= member.max_agents) {
      return json({ error: `You have ${busy} changes going, the most you can at once: one has to finish first.`, going: busy }, 429);
    }
    // A follow-up continues one of the club's own requests only.
    let follows = null;
    if (body.follows != null) {
      const earlier = await env.DB.prepare("SELECT id FROM board_requests WHERE id = ?1 AND member IS NOT NULL").bind(Number(body.follows)).first();
      if (!earlier) return json({ error: "That isn't one of the club's requests (follows)." }, 400);
      follows = earlier.id;
    }
    const id = await newRequest(env, { words: `For hive: ${words.replace(/^For hive: /i, "")}`, agent: "hive-cloud", from: "club", at: now, member: member.name, follows });
    const ahead = await env.DB.prepare(`SELECT COUNT(*) AS n FROM board_requests WHERE status IN ${GOING} AND id < ?1`).bind(id).first();
    return json({ ok: true, id, ahead: ahead.n });
  }

  if (path === "/v1/club/stop" && request.method === "POST") {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id < 1) return json({ error: "Say which request (id)." }, 400);
    const [asked, ended] = await env.DB.batch([
      env.DB.prepare(`UPDATE board_requests SET stop_at = COALESCE(stop_at, ?2), updated_at = ?2 WHERE id = ?1 AND member = ?3 AND status IN ${GOING}`)
        .bind(id, now, member.name),
      env.DB.prepare(
        `UPDATE board_requests SET status = 'failed', outcome = 'Stopped before it started.', finished_at = ?2, updated_at = ?2
         WHERE id = ?1 AND member = ?3 AND status = 'queued'`,
      ).bind(id, now, member.name),
    ]);
    if (!asked.meta.changes && !ended.meta.changes) return json({ error: "That isn't one of your requests that's going." }, 404);
    return json({ ok: true, stopping: asked.meta.changes, ended: ended.meta.changes });
  }

  if (path === "/v1/club/board" && request.method === "GET") {
    const since = now - 14 * DAY;
    const club = "r.member IS NOT NULL AND r.created_at > ?1";
    const [requests, tasks, runs, steps, members] = await env.DB.batch([
      env.DB.prepare(
        `SELECT r.id, r.member, r.status, r.outcome, r.follows, r.created_at, r.updated_at, r.finished_at, r.stop_at, m.text
         FROM board_requests r LEFT JOIN board_messages m ON m.machine = 'cloud' AND m.id = r.id
         WHERE ${club} ORDER BY r.id DESC LIMIT 60`,
      ).bind(since),
      env.DB.prepare(
        `SELECT t.message AS request, t.id - t.message * 100 AS key, t.title, t.status, t.outcome FROM board_tasks t
         JOIN board_requests r ON r.id = t.message WHERE t.machine = 'cloud' AND ${club} ORDER BY t.id`,
      ).bind(since),
      env.DB.prepare(
        `SELECT u.run, u.request, u.task, u.title, u.status, u.started_at, u.updated_at FROM board_runs u
         JOIN board_requests r ON r.id = u.request WHERE u.machine = 'cloud' AND ${club} ORDER BY u.started_at`,
      ).bind(since),
      env.DB.prepare(
        `SELECT s.run, s.n, s.at, s.kind, s.text FROM board_run_steps s
         JOIN board_runs u ON u.machine = s.machine AND u.run = s.run JOIN board_requests r ON r.id = u.request
         WHERE s.machine = 'cloud' AND ${club} ORDER BY s.at DESC, s.n DESC LIMIT 400`,
      ).bind(since),
      env.DB.prepare(
        `SELECT c.name, c.max_agents, c.seen_at,
                (SELECT COUNT(*) FROM board_requests r WHERE r.member = c.name AND r.status IN ${GOING}) AS going
         FROM club_members c WHERE c.key_hash IS NOT NULL ORDER BY c.name`,
      ),
    ]);
    return json({
      me: member.name, now,
      requests: requests.results.map((r) => ({ ...r, text: String(r.text || "").replace(/^For hive: /, "") })),
      tasks: tasks.results, runs: runs.results, steps: steps.results.reverse(), members: members.results,
    });
  }

  if (path.startsWith("/v1/club/team/")) {
    const teamUrl = new URL(url);
    teamUrl.pathname = path.replace("/v1/club/team/", "/v1/team/");
    return teamRoute(new Request(teamUrl, { method: request.method, headers: request.headers, body: request.method === "POST" ? JSON.stringify(body) : undefined }),
      env, teamUrl, { member: member.name }, { clock });
  }

  return json({ error: "Not found" }, 404);
}
