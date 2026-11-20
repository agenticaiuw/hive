// Versions and updates between Hive's nodes (owner, 2026-11-18: "No version check or automatic updates
// between nodes. A node on old code finds out only when a route answers differently.").
//
// Every node says who it is and what code it runs on each call: x-hive-node ("vm:badger-vm",
// "mac:owner-mbp", "extension:chrome"), x-hive-version (its release, or "dev" for a build made by
// hand) and x-hive-protocol (the board routes it was written against). The board keeps the latest of
// each (board_nodes), answers every call with its own protocol and the newest release published for
// that kind of node (x-hive-protocol, x-hive-latest), and refuses a node whose protocol is older than
// it serves with 426 and what to do, so old code finds out on its first call.
//
// A release is one kind of node's code, published here (POST /v1/releases, kept in R2) by
// cloud/release.mjs; each node fetches the newest for its kind and puts it in when it's idle (the VM:
// cloud/vm-agent/updater.mjs). Tables: cloud/knowledge/migrations/0021_nodes.sql.
//
// One version for all of Hive (owner, 2026-11-20: "how would we have a consistent versionning and push
// these updates to all of our personal devices"): each release says the commit on main it was built from
// (0026_release_commits.sql), so every node of every kind reads as a commit of the same history. A club
// member's devices (club.js) take the same releases with the member's own key, and say what they run
// here under the member's name ("alice@macbook"), so the club sees whose device is behind.

// The board's routes as the nodes see them. A change a node on the old routes would get wrong raises
// PROTOCOL, and MIN_PROTOCOL once the board stops serving the old ones. Every node carries its own
// copy; cloud/tests/nodes.test.mjs checks they all agree with cloud/shared/protocol.json.
export const PROTOCOL = 1;
export const MIN_PROTOCOL = 1;

export const KINDS = new Set(["board", "vm", "mac", "cli", "extension", "phone"]);
// A workers.dev upload is capped at 100 MB; the Mac app zipped is well under.
const MOST_BYTES = 95 * 1024 * 1024;
// A node is written down at most once a minute unless what it runs changed.
const SEEN_EVERY_MS = 60_000;
const LATEST_FOR_MS = 30_000;

const nowMs = () => Date.now();
const clean = (value, most) => String(value ?? "").replace(/[^\w.:@+-]/g, "").slice(0, most);

/** A club member's device as the board names it: theirs, whatever the device calls itself. */
export function memberNode(member, name) {
  return `${member}@${clean(name, 60).toLowerCase().replace(/@/g, "-")}`.slice(0, 60);
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Who sent a call and what it runs, from its headers; null when it didn't say. */
export function nodeOf(request) {
  const said = request.headers.get("x-hive-node");
  if (!said) return null;
  const at = said.indexOf(":");
  const kind = clean(at < 0 ? said : said.slice(0, at), 20).toLowerCase();
  const name = clean(at < 0 ? "" : said.slice(at + 1), 60).toLowerCase();
  if (!KINDS.has(kind) || !name) return null;
  const protocol = Number(request.headers.get("x-hive-protocol"));
  return {
    kind,
    name,
    version: clean(request.headers.get("x-hive-version"), 40) || "unknown",
    protocol: Number.isInteger(protocol) && protocol > 0 ? protocol : null,
  };
}

/** A node on routes the board no longer serves: what it gets instead of an answer. */
export function tooOld(node, url) {
  if (!node?.protocol || node.protocol >= MIN_PROTOCOL) return null;
  if (url.pathname.startsWith("/v1/releases") || url.pathname.startsWith("/v1/nodes")) return null;
  return json({
    error: `This ${node.kind === "vm" ? "VM" : node.kind === "mac" ? "Mac" : node.kind}'s Hive is older than the board `
      + `(routes ${node.protocol}; the board serves ${MIN_PROTOCOL} to ${PROTOCOL}). It updates itself when it's idle.`,
    protocol: PROTOCOL,
    min_protocol: MIN_PROTOCOL,
  }, 426, { "x-hive-protocol": String(PROTOCOL) });
}

// The newest release of each kind, for every answer's x-hive-latest without a query each call.
let latestCache = { at: 0, byKind: new Map() };

export async function latestReleases(env, { fresh = false } = {}) {
  if (!fresh && nowMs() - latestCache.at < LATEST_FOR_MS) return latestCache.byKind;
  const { results } = await env.DB.prepare(
    `SELECT kind, version, protocol, sha256, size, notes, published_at, git_commit AS "commit" FROM board_releases r
     WHERE published_at = (SELECT MAX(published_at) FROM board_releases WHERE kind = r.kind)`,
  ).all();
  latestCache = { at: nowMs(), byKind: new Map(results.map((r) => [r.kind, r])) };
  return latestCache.byKind;
}

/** The board's headers on an answer to a node: its routes and the newest release for that node. */
export async function versionHeaders(env, node) {
  const headers = { "x-hive-protocol": String(PROTOCOL) };
  if (!node) return headers;
  const latest = (await latestReleases(env).catch(() => new Map())).get(node.kind);
  if (latest) headers["x-hive-latest"] = latest.version;
  return headers;
}

const lastSeen = new Map();

/** Writes down what a node runs, at most once a minute unless that changed. */
export async function sawNode(env, node, at = nowMs()) {
  const key = `${node.kind}:${node.name}`;
  const before = lastSeen.get(key);
  if (before && before.version === node.version && before.protocol === node.protocol && at - before.at < SEEN_EVERY_MS) return false;
  lastSeen.set(key, { version: node.version, protocol: node.protocol, at });
  await env.DB.prepare(
    `INSERT INTO board_nodes (kind, name, version, protocol, seen_at, changed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT (kind, name) DO UPDATE SET
       changed_at = CASE WHEN board_nodes.version = excluded.version THEN board_nodes.changed_at ELSE excluded.seen_at END,
       version = excluded.version, protocol = excluded.protocol, seen_at = excluded.seen_at`,
  ).bind(node.kind, node.name, node.version, node.protocol, at).run();
  return true;
}

/** Forgets what was written down (tests: each starts from an empty board). */
export function forgetSeen() {
  lastSeen.clear();
  latestCache = { at: 0, byKind: new Map() };
}

/** /v1/nodes and /v1/releases. `auth` is the worker's machineAllowed and anyoneAllowed, and memberOf
 *  (the club member a call is signed in as, or null). */
export async function nodesRoute(request, env, url, auth) {
  const path = url.pathname;
  if (path === "/v1/nodes" && request.method === "GET") return listNodes(request, env, auth);
  if (path === "/v1/nodes/report" && request.method === "POST") return reportNode(request, env, auth);
  if (path === "/v1/releases" && request.method === "POST") return publish(request, env, url, auth);
  if (path === "/v1/releases/latest" && request.method === "GET") return latest(request, env, url, auth);
  if (path === "/v1/releases/get" && request.method === "GET") return fetchRelease(request, env, url, auth);
  return new Response("Not found", { status: 404 });
}

// GET /v1/nodes: every node, what it runs and whether that's the newest release for its kind.
async function listNodes(request, env, auth) {
  if (!(await auth.anyoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  return json(await nodeList(env));
}

/** Every node and what it runs, against the newest release of its kind (also in /v1/board). `member`
 *  keeps only that club member's devices. Each node's `commit` is the commit on main its release was
 *  built from (null for a build made by hand), `latest_commit` the newest release's. */
export async function nodeList(env, { member = null } = {}) {
  const releases = await latestReleases(env, { fresh: true });
  const { results } = await env.DB.prepare(
    `SELECT n.kind, n.name, n.version, n.protocol, n.seen_at, n.changed_at, n.note, n.note_at, r.git_commit AS "commit"
     FROM board_nodes n LEFT JOIN board_releases r ON r.kind = n.kind AND r.version = n.version
     WHERE ?1 = '' OR substr(n.name, 1, length(?1) + 1) = ?1 || '@' ORDER BY n.kind, n.name`,
  ).bind(member ?? "").all();
  const nodes = results.map((n) => {
    const newest = releases.get(n.kind);
    return {
      ...n,
      commit: n.commit ?? null,
      latest: newest?.version ?? null,
      latest_commit: newest?.commit ?? null,
      current: newest ? n.version === newest.version : null,
      old_protocol: n.protocol != null && n.protocol < MIN_PROTOCOL,
    };
  });
  // The board is a node too: its version is set when it's deployed (cloud/release.mjs board).
  return {
    protocol: PROTOCOL,
    min_protocol: MIN_PROTOCOL,
    board: { version: env.HIVE_VERSION || "dev", commit: env.HIVE_COMMIT || null },
    nodes,
    releases: [...releases.values()],
  };
}

// POST /v1/nodes/report {kind, name, version?, note}: a node's updater says what happened, e.g.
// "Updated from 3f2a… to 9c1b…" or "Didn't update to 9c1b…: a test failed (…)".
// A club member's device reports under their name (memberNode), and never as the board.
async function reportNode(request, env, auth) {
  const machine = await auth.machineAllowed(request, env);
  const member = machine ? null : await auth.memberOf?.(request, env);
  if (!machine && !member) return json({ error: "Not signed in." }, 401);
  const body = await request.json().catch(() => ({}));
  const kind = clean(body.kind, 20).toLowerCase();
  const said = clean(body.name, 60).toLowerCase();
  const name = member && said ? memberNode(member.name, said) : said;
  if (!KINDS.has(kind) || !name || (member && kind === "board")) return json({ error: "Say which node (kind and name)." }, 400);
  const note = String(body.note ?? "").slice(0, 500);
  const at = nowMs();
  const version = clean(body.version, 40) || "unknown";
  await env.DB.prepare(
    `INSERT INTO board_nodes (kind, name, version, protocol, seen_at, changed_at, note, note_at) VALUES (?1, ?2, ?3, NULL, ?4, ?4, ?5, ?4)
     ON CONFLICT (kind, name) DO UPDATE SET note = excluded.note, note_at = excluded.note_at, seen_at = excluded.seen_at,
       changed_at = CASE WHEN ?6 = 0 OR board_nodes.version = excluded.version THEN board_nodes.changed_at ELSE excluded.seen_at END,
       version = CASE WHEN ?6 = 0 THEN board_nodes.version ELSE excluded.version END`,
  ).bind(kind, name, version, at, note, body.version ? 1 : 0).run();
  lastSeen.delete(`${kind}:${name}`);
  return json({ ok: true });
}

// POST /v1/releases?kind=vm&version=9c1b…&protocol=1&sha256=<hex>[&commit=<40 hex>][&notes=…], the release as the body.
async function publish(request, env, url, auth) {
  if (!(await auth.machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
  if (!env.RELEASES) return json({ error: "This board has no release storage (the RELEASES bucket)." }, 500);
  const kind = clean(url.searchParams.get("kind"), 20).toLowerCase();
  const version = clean(url.searchParams.get("version"), 40);
  const sha256 = String(url.searchParams.get("sha256") ?? "").toLowerCase();
  const protocol = Number(url.searchParams.get("protocol"));
  const commit = String(url.searchParams.get("commit") ?? "").toLowerCase();
  const size = Number(request.headers.get("content-length"));
  if (!KINDS.has(kind) || kind === "board") return json({ error: "Say which kind of node (vm, mac, cli, extension, phone)." }, 400);
  if (!/^[a-z0-9][a-z0-9.-]{3,39}$/.test(version) || version.startsWith("dev")) return json({ error: "A release needs a version (4 to 40 of a-z, 0-9, '.', '-'), not dev." }, 400);
  if (!/^[0-9a-f]{64}$/.test(sha256)) return json({ error: "Give the release's sha256 (64 hex)." }, 400);
  if (!Number.isInteger(protocol) || protocol < 1) return json({ error: "Say which board routes it was written for (protocol)." }, 400);
  if (!(size > 0) || size > MOST_BYTES) return json({ error: `A release is 1 byte to ${MOST_BYTES / 1024 / 1024} MB, with its length.` }, 400);
  if (commit && !/^[0-9a-f]{40}$/.test(commit)) return json({ error: "A release's commit is the full id of the commit on main it was built from." }, 400);
  // R2 checks the bytes against the sha256 and keeps nothing if they differ.
  await env.RELEASES.put(`${kind}/${version}`, request.body, { sha256, httpMetadata: { contentType: "application/octet-stream" } });
  const at = nowMs();
  await env.DB.prepare(
    `INSERT INTO board_releases (kind, version, protocol, sha256, size, notes, published_at, git_commit) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (kind, version) DO UPDATE SET protocol = excluded.protocol, sha256 = excluded.sha256, size = excluded.size,
       notes = excluded.notes, published_at = excluded.published_at, git_commit = excluded.git_commit`,
  ).bind(kind, version, protocol, sha256, size, String(url.searchParams.get("notes") ?? "").slice(0, 500), at, commit || null).run();
  latestCache.at = 0;
  return json({ ok: true, release: { kind, version, protocol, sha256, size, published_at: at, commit: commit || null } });
}

// A machine of the owner's reads any release; a club member's device every kind but the board's, which
// only the owner deploys.
async function mayRead(request, env, auth, kind) {
  return (await auth.machineAllowed(request, env)) || (kind !== "board" && Boolean(await auth.memberOf?.(request, env)));
}

// GET /v1/releases/latest?kind=vm: the newest release for that kind, or null.
async function latest(request, env, url, auth) {
  const kind = clean(url.searchParams.get("kind"), 20).toLowerCase();
  if (!(await mayRead(request, env, auth, kind))) return json({ error: "Not signed in." }, 401);
  const release = (await latestReleases(env, { fresh: true })).get(kind) ?? null;
  return json({ protocol: PROTOCOL, min_protocol: MIN_PROTOCOL, release });
}

// GET /v1/releases/get?kind=vm&version=…: the release's bytes, with their sha256.
async function fetchRelease(request, env, url, auth) {
  const kind = clean(url.searchParams.get("kind"), 20).toLowerCase();
  if (!(await mayRead(request, env, auth, kind))) return json({ error: "Not signed in." }, 401);
  const version = clean(url.searchParams.get("version"), 40);
  const row = await env.DB.prepare("SELECT sha256, size FROM board_releases WHERE kind = ?1 AND version = ?2").bind(kind, version).first();
  const object = row && env.RELEASES ? await env.RELEASES.get(`${kind}/${version}`) : null;
  if (!object) return json({ error: `There's no ${kind} release ${version}.` }, 404);
  return new Response(object.body, {
    headers: { "content-type": "application/octet-stream", "content-length": String(row.size), "x-hive-sha256": row.sha256, "cache-control": "no-store" },
  });
}
