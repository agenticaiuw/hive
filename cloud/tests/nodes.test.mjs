// Versions between Hive's nodes (cloud/tasks/nodes.js), through the real worker against every
// migration on node:sqlite: each node says what it runs, the board answers with its routes and the
// newest release, a node on routes the board no longer serves is told so on its first call, and a
// release published once reaches every node of its kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../tasks/worker.js';
import { MIN_PROTOCOL, PROTOCOL, forgetSeen, tooOld } from '../tasks/nodes.js';

const MIGRATIONS = new URL('../knowledge/migrations/', import.meta.url);
const ROOT = new URL('../../', import.meta.url);

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    batchOne: () => (/\bRETURNING\b|^\s*(SELECT|WITH)/i.test(sql)
      ? { results: db.prepare(sql).all(...args) }
      : { results: [], meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => statement(sql), batch: async (list) => list.map((s) => s.batchOne()), db };
}

/** R2 as the board uses it: put checks the bytes against the sha256 it's given. */
function fakeR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, { sha256 } = {}) {
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      if (sha256 && createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('sha256 mismatch');
      objects.set(key, bytes);
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { body: new Blob([bytes]).stream() } : null;
    },
  };
}

const TOKEN = 'machine-token';
const extKey = (name) => `ext.${name}.${createHmac('sha256', TOKEN).update(`ext:${name}`).digest('hex')}`;

function setup() {
  forgetSeen();
  const env = { DB: fakeD1(), RELEASES: fakeR2(), TASKS_TOKEN: TOKEN, HIVE_VERSION: 'b0a4d1c2e3f4' };
  const call = async (method, path, { body, node, version, protocol, auth = `Bearer ${TOKEN}`, raw } = {}) => {
    const headers = { authorization: auth, 'content-type': raw ? 'application/octet-stream' : 'application/json' };
    if (node) headers['x-hive-node'] = node;
    if (version) headers['x-hive-version'] = version;
    if (protocol) headers['x-hive-protocol'] = String(protocol);
    if (raw) headers['content-length'] = String(raw.length);
    const response = await worker.fetch(new Request(`https://board.test${path}`, {
      method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    }), env);
    const text = await response.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return { env, call };
}

const nodes = (env) => env.DB.db.prepare('SELECT kind, name, version, protocol FROM board_nodes ORDER BY kind, name').all()
  .map((n) => `${n.kind}:${n.name} ${n.version} p${n.protocol}`);

test('a node that says what it runs is written down once a minute, and every answer carries the routes and the newest release', async () => {
  const { env, call } = setup();
  const first = await call('GET', '/v1/requests/state?id=1', { node: 'vm:Badger-VM', version: '3f2a9b8c7d6e', protocol: PROTOCOL });
  assert.equal(first.headers.get('x-hive-protocol'), String(PROTOCOL));
  assert.equal(first.headers.get('x-hive-latest'), null, 'nothing published yet');
  assert.deepEqual(nodes(env), [`vm:badger-vm 3f2a9b8c7d6e p${PROTOCOL}`]);

  // The same again within the minute writes nothing; new code is written down at once.
  env.DB.db.exec("UPDATE board_nodes SET seen_at = 5");
  await call('GET', '/v1/requests/state?id=1', { node: 'vm:badger-vm', version: '3f2a9b8c7d6e', protocol: PROTOCOL });
  assert.equal(env.DB.db.prepare('SELECT seen_at FROM board_nodes').get().seen_at, 5);
  await call('GET', '/v1/requests/state?id=1', { node: 'vm:badger-vm', version: '9c1b2a3d4e5f', protocol: PROTOCOL });
  assert.deepEqual(nodes(env), [`vm:badger-vm 9c1b2a3d4e5f p${PROTOCOL}`]);

  // A call that isn't signed in is never written down, and the extension's key is only ever the extension.
  await call('GET', '/v1/requests/state?id=1', { node: 'mac:stranger', version: 'x', protocol: PROTOCOL, auth: 'Bearer wrong' });
  await call('GET', '/v1/requests/state?id=1', { node: 'vm:pretend', version: 'x', protocol: PROTOCOL, auth: `Bearer ${extKey('chrome')}` });
  await call('GET', '/v1/requests/state?id=1', { node: 'extension:chrome', version: '1.4.0', protocol: PROTOCOL, auth: `Bearer ${extKey('chrome')}` });
  assert.deepEqual(nodes(env), [`extension:chrome 1.4.0 p${PROTOCOL}`, `vm:badger-vm 9c1b2a3d4e5f p${PROTOCOL}`]);

  // Old nodes that say nothing get the same answers as before.
  const plain = await call('GET', '/v1/requests/state?id=1');
  assert.equal(plain.headers.get('x-hive-protocol'), null);
});

test('a node on routes the board no longer serves is told what to do, and the update routes stay open', async () => {
  // A node below MIN_PROTOCOL (none is yet: both are 1), as a board that has moved on would see it.
  const refusal = tooOld({ kind: 'vm', name: 'badger-vm', version: 'a', protocol: 0.5 }, new URL('https://board.test/v1/requests/take'));
  assert.equal(refusal.status, 426);
  const said = await refusal.json();
  assert.match(said.error, /This VM's Hive is older than the board .*It updates itself when it's idle\./);
  for (const path of ['/v1/releases/latest?kind=vm', '/v1/releases/get?kind=vm&version=a', '/v1/nodes/report']) {
    assert.equal(tooOld({ kind: 'vm', name: 'b', version: 'a', protocol: 0.5 }, new URL(`https://board.test${path}`)), null, path);
  }
});

test('a release published once is the newest for its kind; nodes on it are current, others are told where to go', async () => {
  const { env, call } = setup();
  const bytes = Buffer.from('the VM code, gzipped');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const bad = await call('POST', `/v1/releases?kind=vm&version=9c1b2a3d4e5f&protocol=1&sha256=${'0'.repeat(64)}`, { raw: bytes });
  assert.equal(bad.status, 500, 'R2 keeps nothing whose bytes differ from the sha256');
  assert.equal((await call('POST', `/v1/releases?kind=vm&version=dev-1&protocol=1&sha256=${sha}`, { raw: bytes })).status, 400);
  assert.equal((await call('POST', `/v1/releases?kind=vm&version=9c1b2a3d4e5f&protocol=1&sha256=${sha}`, { raw: bytes, auth: `Bearer ${extKey('chrome')}` })).status, 401);
  const sent = await call('POST', `/v1/releases?kind=vm&version=9c1b2a3d4e5f&protocol=1&sha256=${sha}&notes=Knowledge%20route`, { raw: bytes });
  assert.equal(sent.status, 200);
  assert.deepEqual([...env.RELEASES.objects.keys()], ['vm/9c1b2a3d4e5f']);

  const newest = await call('GET', '/v1/releases/latest?kind=vm', { node: 'vm:badger-vm', version: '3f2a9b8c7d6e', protocol: 1 });
  assert.equal(newest.body.release.version, '9c1b2a3d4e5f');
  assert.equal(newest.body.release.notes, 'Knowledge route');
  assert.equal(newest.headers.get('x-hive-latest'), '9c1b2a3d4e5f');
  assert.equal((await call('GET', '/v1/releases/latest?kind=mac')).body.release, null);

  const got = await call('GET', '/v1/releases/get?kind=vm&version=9c1b2a3d4e5f');
  assert.equal(got.headers.get('x-hive-sha256'), sha);
  assert.equal(got.body, 'the VM code, gzipped');
  assert.equal((await call('GET', '/v1/releases/get?kind=vm&version=000000000000')).status, 404);

  await call('POST', '/v1/nodes/report', { body: { kind: 'vm', name: 'badger-vm', note: "Didn't update to 9c1b2a3d4e5f: a test failed." } });
  await call('GET', '/v1/requests/state?id=1', { node: 'mac:owner-mbp', version: 'dev', protocol: 1 });
  const listed = await call('GET', '/v1/nodes');
  assert.equal(listed.body.board.version, 'b0a4d1c2e3f4');
  assert.deepEqual(listed.body.nodes.map((n) => [n.kind, n.name, n.version, n.latest, n.current, n.note]), [
    ['mac', 'owner-mbp', 'dev', null, null, ''],
    ['vm', 'badger-vm', '3f2a9b8c7d6e', '9c1b2a3d4e5f', false, "Didn't update to 9c1b2a3d4e5f: a test failed."],
  ]);
  await call('POST', '/v1/nodes/report', { body: { kind: 'vm', name: 'badger-vm', version: '9c1b2a3d4e5f', note: 'Updated from 3f2a9b8c7d6e to 9c1b2a3d4e5f.' } });
  const after = (await call('GET', '/v1/nodes')).body.nodes.find((n) => n.kind === 'vm');
  assert.equal(after.current, true);
  assert.equal((await call('GET', '/v1/nodes', { auth: 'Bearer wrong' })).status, 401);
});

test("every node's copy of the routes number matches cloud/shared/protocol.json", () => {
  const { protocol } = JSON.parse(readFileSync(new URL('cloud/shared/protocol.json', ROOT), 'utf8'));
  assert.equal(PROTOCOL, protocol, 'the board');
  const copies = [
    ['cloud/vm-agent/version.mjs', /export const PROTOCOL = (\d+);/],
    ['desktop/app/crates/hive/hive-tasks/src/node.rs', /pub const PROTOCOL: u32 = (\d+);/],
    ['browser/chrome/src/version.js', /export const PROTOCOL = (\d+)\b/],
    ['mobile/relay/WebDriverAgent/WebDriverAgentRunner/PhoneRelay.h', /HivePhoneProtocol = (\d+);/],
  ];
  for (const [file, pattern] of copies) {
    const at = new URL(file, ROOT);
    assert.ok(existsSync(at), `${file} carries the routes number`);
    assert.equal(Number(pattern.exec(readFileSync(at, 'utf8'))?.[1]), protocol, file);
  }
});

test("one version: releases say their commit, and a club member's devices take the same releases with the member's key", async () => {
  const { env, call } = setup();
  env.HIVE_COMMIT = 'b'.repeat(40);
  const commit = 'a'.repeat(40);
  const bytes = Buffer.from('the Mac build');
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal((await call('POST', `/v1/releases?kind=mac&version=9c1b2a3d4e5f&protocol=1&sha256=${sha}&commit=abc`, { raw: bytes })).status, 400,
    "a commit is the full id of one");
  const sent = await call('POST', `/v1/releases?kind=mac&version=9c1b2a3d4e5f&protocol=1&sha256=${sha}&commit=${commit}`, { raw: bytes });
  assert.equal(sent.body.release.commit, commit);

  const { invite } = (await call('POST', '/v1/club/members', { body: { name: 'alice' } })).body;
  const key = (await call('POST', '/v1/club/join', { body: { invite }, auth: '' })).body.key;
  const alice = `Bearer ${key}`;
  // Alice's Mac reads the club's releases with her key, but never publishes one or reads the board's.
  const newest = await call('GET', '/v1/releases/latest?kind=mac', { auth: alice, node: 'mac:macbook', version: '3f2a9b8c7d6e', protocol: 1 });
  assert.equal(newest.status, 200);
  assert.equal(newest.body.release.commit, commit);
  assert.equal((await call('GET', '/v1/releases/get?kind=mac&version=9c1b2a3d4e5f', { auth: alice })).body, 'the Mac build');
  assert.equal((await call('GET', '/v1/releases/latest?kind=board', { auth: alice })).status, 401);
  assert.equal((await call('POST', `/v1/releases?kind=mac&version=9c1b2a3d4e5f&protocol=1&sha256=${sha}`, { raw: bytes, auth: alice })).status, 401);
  assert.equal((await call('GET', '/v1/releases/latest?kind=mac', { auth: `Bearer club.alice.${'0'.repeat(64)}` })).status, 401);
  // What her devices run is written down under her name, whatever they call themselves.
  await call('POST', '/v1/nodes/report', { auth: alice, body: { kind: 'mac', name: 'macbook', version: '9c1b2a3d4e5f', note: 'Updated from 3f2a9b8c7d6e to 9c1b2a3d4e5f.' } });
  await call('POST', '/v1/nodes/report', { auth: alice, body: { kind: 'vm', name: 'bob@vm', note: 'Up to date.' } });
  assert.equal((await call('POST', '/v1/nodes/report', { auth: alice, body: { kind: 'board', name: 'x' } })).status, 400);
  await call('GET', '/v1/club/me', { auth: alice, node: 'vm:own-vm', version: 'dev', protocol: 1 });
  await call('GET', '/v1/requests/state?id=1', { node: 'mac:owner-mbp', version: '9c1b2a3d4e5f', protocol: 1 });
  assert.deepEqual(nodes(env), ['mac:alice@macbook 9c1b2a3d4e5f p1', 'mac:owner-mbp 9c1b2a3d4e5f p1', 'vm:alice@bob-vm unknown pnull', 'vm:alice@own-vm dev p1']);

  // The owner sees every device as the commit it runs; Alice sees only hers, by the names they gave.
  const all = (await call('GET', '/v1/nodes')).body;
  assert.equal(all.board.commit, 'b'.repeat(40));
  assert.deepEqual(all.nodes.filter((n) => n.kind === 'mac').map((n) => [n.name, n.commit, n.latest_commit, n.current]),
    [['alice@macbook', commit, commit, true], ['owner-mbp', commit, commit, true]]);
  const mine = (await call('GET', '/v1/club/devices', { auth: alice })).body;
  assert.deepEqual(mine.nodes.map((n) => `${n.kind}:${n.name}`), ['mac:macbook', 'vm:bob-vm', 'vm:own-vm']);
  assert.deepEqual(mine.releases.map((r) => [r.kind, r.commit]), [['mac', commit]]);
  assert.equal(mine.phone_source, null, 'no Hive Phone release yet');
  assert.equal((await call('GET', '/v1/club/devices')).status, 401, "the owner's machines aren't a member");
});
