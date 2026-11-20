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
//   GET  /v1/club/devices                         member: their own devices on Hive's releases (nodes.js),
//                                                 each against the newest release of its kind, and where
//                                                 Hive Phone's updates come from (SideStore)
//   POST /v1/club/devices/code                    member: a one-use code, for 10 minutes, that connects one
//                                                 of their Macs: {code, link, expires_in}; the link
//                                                 (hive://club/connect?board=…&code=…) opens Hive there
//   POST /v1/club/devices/connect {code, device}  with that code: {name, key, board}, once: the Mac's own
//                                                 key, which works as the member's until they're let go;
//                                                 Hive keeps it as where its releases come from
//                                                 (hive-tasks club.rs, tasks.json's `releases`)
//   GET  /v1/club/download/mac                    member: Hive for Mac (Hive.dmg), notarized: open it and it
//                                                 sets itself up (tools/release.sh builds it, `node
//                                                 cloud/release.mjs download` puts it in RELEASES); the
//                                                 devices answer says which (mac_download)
//   GET  /v1/club/download/mac/about              member: {download: {version, size, published_at} | null},
//                                                 which a member's Hive.app updates itself to (hive-tasks
//                                                 app_update.rs)
//   GET  /v1/club/download/windows                member: Hive for Windows (Hive.exe), the newest windows
//                                                 release (nodes.js; built on GitHub's Windows machines by
//                                                 .github/workflows/windows.yml, published by `node
//                                                 cloud/release.mjs windows`): open it and it sets itself
//                                                 up, connects with Connect this PC and updates itself
//                                                 (desktop/app/crates/hive/hive-windows)
//   /v1/club/team/...                             member: messages and file leases (team.js), as themselves
//
// How many at once (the knowledge base's "Club collaboration" decision): a member runs at most
// max_agents requests at a time (DEFAULT_AGENTS unless the owner says otherwise); the planner splits each
// into tasks, one agent each; the VM's slots (orchestrator.mjs MOST_REQUESTS, MOST_RUNNING) cap them all.
// Tables: cloud/knowledge/migrations/0025_club.sql, 0027_club_devices.sql.

import { latestReleases, nodeList } from "./nodes.js";
import { boardOrigin } from "./phone.js";

export const DEFAULT_AGENTS = 3;
export const MOST_AGENTS = 8;
export const INVITE_S = 7 * 86400;
export const DEVICE_CODE_S = 600;
// Hive for Mac as members download it, and what it is ({version, size, published_at}), in RELEASES.
export const MAC_DOWNLOAD = "download/mac/Hive.dmg";
export const MAC_DOWNLOAD_ABOUT = "download/mac/Hive.json";
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
  // Only keys' hashes are kept, so comparing hashes says nothing about the key. A member's key is the one
  // their invite gave them, or one of their Macs' (/v1/club/devices/connect).
  const row = await env.DB.prepare(
    `SELECT c.name, c.max_agents, c.seen_at FROM club_members c
     WHERE c.name = ?1 AND (c.key_hash = ?2 OR EXISTS (SELECT 1 FROM club_device_keys d WHERE d.member = c.name AND d.key_hash = ?2))`,
  ).bind(match[1], await sha256(match[2])).first();
  if (!row) return null;
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
/** What Hive for Mac members download is ({version, size, published_at}), or null before there's one. */
async function macDownload(env) {
  const object = env.RELEASES ? await env.RELEASES.get(MAC_DOWNLOAD_ABOUT) : null;
  const about = object ? await new Response(object.body).json().catch(() => null) : null;
  if (!about || typeof about.version !== "string") return null;
  return { version: about.version, size: Number(about.size) || null, published_at: about.published_at ?? null };
}

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
      await env.DB.batch([
        env.DB.prepare("DELETE FROM club_device_keys WHERE member = ?1").bind(name),
        env.DB.prepare("DELETE FROM club_device_codes WHERE member = ?1").bind(name),
        // Their devices leave the board's list of nodes (nodes.js memberNode names them "<member>@…").
        env.DB.prepare("DELETE FROM board_nodes WHERE kind != 'board' AND substr(name, 1, length(?1) + 1) = ?1 || '@'").bind(name),
      ]);
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

  // ---- a member's Mac, with the code the club page gave them ----
  if (path === "/v1/club/devices/connect" && request.method === "POST") {
    const code = text(body.code, 100);
    if (!/^[0-9a-f]{32}$/.test(code)) return json({ error: "That code isn't one (code)." }, 400);
    const row = await env.DB.prepare("DELETE FROM club_device_codes WHERE code_hash = ?1 AND expires_at > ?2 RETURNING member")
      .bind(await sha256(code), now).first();
    if (!row) return json({ error: "That link was used or has expired: open Connect this Mac on the club page again." }, 403);
    const key = secret(32);
    await env.DB.prepare("INSERT INTO club_device_keys (member, key_hash, device, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(row.member, await sha256(key), text(body.device, 60) || null, now).run();
    return json({ name: row.member, key: `club.${row.member}.${key}`, board: await boardOrigin(env, url) });
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

  if (path === "/v1/club/devices" && request.method === "GET") {
    // A member's Mac and VM take the club's releases with their key (hive-tasks update.rs, vm-agent
    // updater.mjs: tasks.json's `releases`), and say here what they run, under the member's name.
    const list = await nodeList(env, { member: member.name });
    const phone = list.releases.some((r) => r.kind === "phone");
    // Over the dashboard's service binding the board's own address is https://hive-tasks, which nobody
    // else can open; boardOrigin knows its public one.
    const origin = await boardOrigin(env, url);
    return json({
      me: member.name,
      nodes: list.nodes.map((n) => ({ ...n, name: n.name.slice(member.name.length + 1) })),
      releases: list.releases.filter((r) => r.kind !== "board").map(({ kind, version, commit, published_at }) => ({ kind, version, commit, published_at })),
      board: list.board,
      phone_source: phone && origin ? `${origin}/v1/phone/source.json` : null,
      mac_download: await macDownload(env),
    });
  }

  if (path === "/v1/club/download/mac/about" && request.method === "GET") {
    return json({ download: await macDownload(env) });
  }

  if (path === "/v1/club/download/mac" && request.method === "GET") {
    const object = env.RELEASES ? await env.RELEASES.get(MAC_DOWNLOAD) : null;
    if (!object) return json({ error: "There's no Hive for Mac to download yet." }, 404);
    return new Response(object.body, {
      headers: {
        "content-type": "application/x-apple-diskimage",
        ...(object.size ? { "content-length": String(object.size) } : {}),
        "content-disposition": 'attachment; filename="Hive.dmg"',
        "cache-control": "no-store",
      },
    });
  }

  if (path === "/v1/club/download/windows" && request.method === "GET") {
    const newest = (await latestReleases(env, { fresh: true })).get("windows");
    const object = newest && env.RELEASES ? await env.RELEASES.get(`windows/${newest.version}`) : null;
    if (!object) return json({ error: "There's no Hive for Windows to download yet." }, 404);
    return new Response(object.body, {
      headers: {
        "content-type": "application/vnd.microsoft.portable-executable",
        "content-length": String(newest.size),
        "content-disposition": 'attachment; filename="Hive.exe"',
        "x-hive-sha256": newest.sha256,
        "cache-control": "no-store",
      },
    });
  }

  if (path === "/v1/club/devices/code" && request.method === "POST") {
    const origin = await boardOrigin(env, url);
    if (!origin) return json({ error: "The board doesn't know its own address yet; it learns it from the next call a Mac or the VM makes to it." }, 503);
    const code = secret(16);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM club_device_codes WHERE expires_at <= ?1").bind(now),
      env.DB.prepare("INSERT INTO club_device_codes (code_hash, member, expires_at) VALUES (?1, ?2, ?3)")
        .bind(await sha256(code), member.name, now + DEVICE_CODE_S),
    ]);
    const link = `hive://club/connect?board=${encodeURIComponent(origin)}&code=${code}`;
    return json({ code, link, expires_in: DEVICE_CODE_S });
  }

  if (path.startsWith("/v1/club/team/")) {
    const teamUrl = new URL(url);
    teamUrl.pathname = path.replace("/v1/club/team/", "/v1/team/");
    return teamRoute(new Request(teamUrl, { method: request.method, headers: request.headers, body: request.method === "POST" ? JSON.stringify(body) : undefined }),
      env, teamUrl, { member: member.name }, { clock });
  }

  return json({ error: "Not found" }, 404);
}
