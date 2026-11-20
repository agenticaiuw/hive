// The club changing Hive through Hive (cloud/tasks/club.js) through the board's own fetch, against every
// migration on node:sqlite standing in for D1: the owner lets a member in by invite, the member asks Hive
// to change itself within their limit, sees only the club's requests, and talks and leases files only as
// themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../tasks/worker.js';
import { memberName, MAC_DOWNLOAD, MAC_DOWNLOAD_ABOUT } from '../tasks/club.js';
import * as release from '../release.mjs';

const dir = new URL('../knowledge/migrations/', import.meta.url);
const migrations = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, dir), 'utf8'));

// D1 binds ?1, ?2 by number (one can appear twice); node:sqlite binds those only by name.
const numbered = (sql, args) => (/\?\d/.test(sql)
  ? [sql.replace(/\?(\d+)/g, '$$p$1'), [Object.fromEntries(args.map((v, i) => [`p${i + 1}`, v]))]]
  : [sql, args]);

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const sql of migrations) db.exec(sql);
  const statement = (given, values = []) => {
    const [sql, args] = numbered(given, values);
    return {
      bind: (...more) => statement(given, more),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      batchOne: () => (/\bRETURNING\b|^\s*(SELECT|WITH)/i.test(sql)
        ? { results: db.prepare(sql).all(...args) }
        : { results: [], meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    };
  };
  return { prepare: (sql) => statement(sql), batch: async (list) => list.map((s) => s.batchOne()), db };
}

function setup() {
  const env = { DB: fakeD1(), TASKS_TOKEN: 'machine-token' };
  const call = async (method, path, body, token = 'machine-token') => {
    const response = await worker.fetch(new Request(`https://board.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const join = async (name, more = {}) => {
    const { invite } = (await call('POST', '/v1/club/members', { name, ...more })).body;
    return (await call('POST', '/v1/club/join', { invite })).body.key;
  };
  return { env, call, join };
}

test("the owner lets a member in by an invite that works once; the member's key is theirs until they're let go", async () => {
  const { call } = setup();
  assert.equal(memberName('Alice'), 'alice');
  assert.equal(memberName('a b'), '');
  assert.equal((await call('POST', '/v1/club/members', { name: 'alice' }, 'nobody')).status, 401);
  assert.equal((await call('POST', '/v1/club/members', { name: 'not ok' })).status, 400);

  const invited = (await call('POST', '/v1/club/members', { name: 'Alice' })).body;
  assert.equal(invited.name, 'alice');
  assert.equal(invited.max_agents, 3);
  assert.match(invited.invite, /^[0-9a-f]{48}$/);
  assert.deepEqual((await call('GET', '/v1/club/members')).body.members.map((m) => [m.name, m.joined, m.invited]), [['alice', false, true]]);

  const joined = await call('POST', '/v1/club/join', { invite: invited.invite });
  assert.equal(joined.body.name, 'alice');
  assert.match(joined.body.key, /^club\.alice\.[0-9a-f]{64}$/);
  assert.equal((await call('POST', '/v1/club/join', { invite: invited.invite })).status, 403, 'once');
  const key = joined.body.key;
  assert.deepEqual((await call('GET', '/v1/club/me', undefined, key)).body, { name: 'alice', max_agents: 3, going: 0 });
  assert.equal((await call('GET', '/v1/club/me', undefined, key.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).status, 401);
  // A member's key opens the club's routes only: never the owner's board or the owner's club routes.
  assert.equal((await call('GET', '/v1/board', undefined, key)).status, 401);
  assert.equal((await call('GET', '/v1/club/members', undefined, key)).status, 401);
  assert.equal((await call('POST', '/v1/requests', { text: 'open my email' }, key)).status, 401);
  assert.deepEqual((await call('GET', '/v1/club/members')).body.members.map((m) => [m.name, m.joined, m.invited]), [['alice', true, false]]);

  assert.equal((await call('POST', '/v1/club/members/remove', { name: 'alice' })).body.removed, 1);
  assert.equal((await call('GET', '/v1/club/me', undefined, key)).status, 401, 'let go');
});

test("a member asks Hive to change itself, within their limit; the owner's requests go first; they see only the club's", async () => {
  const { call, join } = setup();
  const key = await join('alice', { max_agents: 2 });
  const bob = await join('bob');

  const first = await call('POST', '/v1/club/requests', { text: 'add a dark theme to the club page' }, key);
  assert.equal(first.status, 200);
  const owners = (await call('POST', '/v1/requests', { text: 'reply to my landlord' })).body.id;
  await call('POST', '/v1/club/requests', { text: 'make agents say which files they hold' }, key);
  const third = await call('POST', '/v1/club/requests', { text: 'one more' }, key);
  assert.equal(third.status, 429);
  assert.match(third.body.error, /2 changes going/);
  assert.equal((await call('GET', '/v1/club/me', undefined, key)).body.going, 2);

  // The owner's request is taken first, though a member's came before it.
  const taken = (await call('POST', '/v1/requests/take', { by: 'vm', agent: 'hive-cloud' })).body.request;
  assert.equal(taken.id, owners);
  assert.equal(taken.member, null);
  const club = (await call('POST', '/v1/requests/take', { by: 'vm', agent: 'hive-cloud' })).body.request;
  assert.equal(club.id, first.body.id);
  assert.equal(club.member, 'alice');
  assert.equal(club.project, 'hive');
  assert.equal(club.text, 'For hive: add a dark theme to the club page');

  // Steps of the club's runs show to members; the owner's never do.
  await call('POST', '/v1/runs', { machine: 'cloud', run: String(club.id * 100 + 1), agent: 'code', title: 'Add a dark theme', request: club.id, task: 1,
    status: 'working', steps: [{ n: 1, at: 100, kind: 'action', text: '$ npm test' }] });
  await call('POST', '/v1/runs', { machine: 'cloud', run: String(owners * 100 + 1), agent: 'cloud', title: 'Reply to the landlord', request: owners, task: 1,
    status: 'working', steps: [{ n: 1, at: 100, text: 'the owner’s email' }] });
  const seen = (await call('GET', '/v1/club/board', undefined, bob)).body;
  assert.equal(seen.me, 'bob');
  assert.deepEqual(seen.requests.map((r) => [r.member, r.text]), [['alice', 'make agents say which files they hold'], ['alice', 'add a dark theme to the club page']]);
  assert.deepEqual(seen.steps.map((s) => s.text), ['$ npm test']);
  assert.deepEqual(seen.runs.map((r) => r.title), ['Add a dark theme']);
  assert.deepEqual(seen.members.map((m) => [m.name, m.going]), [['alice', 2], ['bob', 0]]);
  assert.ok(!JSON.stringify(seen).includes('landlord'), "nothing of the owner's");

  // A member stops only their own; follows only the club's.
  const second = seen.requests[0].id;
  assert.equal((await call('POST', '/v1/club/stop', { id: second }, bob)).status, 404);
  assert.equal((await call('POST', '/v1/club/stop', { id: owners }, key)).status, 404);
  assert.deepEqual((await call('POST', '/v1/club/stop', { id: second }, key)).body, { ok: true, stopping: 1, ended: 1 });
  assert.equal((await call('POST', '/v1/club/requests', { text: 'and this', follows: owners }, key)).status, 400);
  const more = await call('POST', '/v1/club/requests', { text: 'darker, please', follows: club.id }, key);
  assert.equal(more.status, 200);
  const followed = (await call('POST', '/v1/requests/take', { by: 'vm', agent: 'hive-cloud' })).body.request;
  assert.equal(followed.id, more.body.id);
  assert.match(followed.text, /club's earlier request .*\nClub member alice now says: For hive: darker, please$/s);
});

test('a member messages and leases files only as themselves, and sees no notes of the owner’s agents', async () => {
  const { call, join } = setup();
  const key = await join('alice');
  // One of the owner's tasks, working and holding a file.
  await call('POST', '/v1/runs', { machine: 'cloud', run: '501', agent: 'cloud', title: 'Pay the rent', request: 5, task: 1, status: 'working',
    steps: [{ n: 1, at: Math.floor(Date.now() / 1000), text: 'x' }] });
  await call('POST', '/v1/team/claim', { agent: 'R5-1', paths: ['cloud/tasks/worker.js'], note: 'the rent' });

  assert.equal((await call('POST', '/v1/club/team/send', { from: 'R5-1', to: 'all', text: 'pretending' }, key)).status, 403);
  assert.equal((await call('POST', '/v1/club/team/send', { from: 'alice', to: 'all', text: 'I am on the club page' }, key)).status, 200);
  assert.equal((await call('GET', '/v1/club/team/inbox?agent=R5-1', undefined, key)).status, 403);
  assert.deepEqual((await call('GET', '/v1/team/inbox?agent=R5-1')).body.messages.map((m) => [m.from, m.text]), [['alice', 'I am on the club page']]);
  await call('POST', '/v1/team/send', { from: 'R5-1', to: 'alice', text: 'worker.js is mine for now' });
  assert.deepEqual((await call('GET', '/v1/club/team/inbox?agent=alice', undefined, key)).body.messages.map((m) => m.text), ['worker.js is mine for now']);

  const claimed = (await call('POST', '/v1/club/team/claim', { agent: 'alice:codex', paths: ['dashboard/src/routes/club/', 'cloud/tasks/worker.js'], note: 'club page' }, key)).body;
  assert.deepEqual(claimed.claimed, ['dashboard/src/routes/club/']);
  assert.deepEqual(claimed.conflicts.map((c) => [c.holder, c.note]), [['R5-1', '']], "the owner's note stays the owner's");
  assert.equal((await call('POST', '/v1/club/team/claim', { agent: 'R5-1', paths: ['README.md'] }, key)).status, 403);
  assert.equal((await call('POST', '/v1/club/team/release', { agent: 'R5-1' }, key)).status, 403);

  const { agents } = (await call('GET', '/v1/club/team/agents', undefined, key)).body;
  assert.deepEqual(agents.map((a) => [a.name, a.title, a.files.map((f) => [f.path, f.note])]), [
    ['R5-1', '', [['cloud/tasks/worker.js', '']]], ['alice:codex', '', [['dashboard/src/routes/club/', 'club page']]]]);
  const owner = (await call('GET', '/v1/team/agents')).body.agents;
  assert.deepEqual(owner.map((a) => [a.name, a.title]), [['R5-1', 'Pay the rent'], ['alice:codex', '']], 'the owner sees it all');
});

test("a member connects their Mac with a one-use code from the club page; the Mac's key works as theirs until they're let go", async () => {
  const { env, call, join } = setup();
  const key = await join('alice');
  assert.equal((await call('POST', '/v1/club/devices/code', {}, 'nobody')).status, 401);
  const made = (await call('POST', '/v1/club/devices/code', {}, key)).body;
  assert.match(made.code, /^[0-9a-f]{32}$/);
  assert.equal(made.link, `hive://club/connect?board=${encodeURIComponent('https://board.test')}&code=${made.code}`);
  assert.equal(made.expires_in, 600);

  assert.equal((await call('POST', '/v1/club/devices/connect', { code: 'nope' }, 'nobody')).status, 400);
  const mac = await call('POST', '/v1/club/devices/connect', { code: made.code, device: 'alices-macbook' }, 'nobody');
  assert.equal(mac.status, 200);
  assert.equal(mac.body.name, 'alice');
  assert.equal(mac.body.board, 'https://board.test');
  assert.match(mac.body.key, /^club\.alice\.[0-9a-f]{64}$/);
  assert.notEqual(mac.body.key, key);
  assert.equal((await call('POST', '/v1/club/devices/connect', { code: made.code }, 'nobody')).status, 403, 'once');

  // The Mac's key is the member's: it sees their devices and takes the club's releases, nothing of the owner's.
  assert.equal((await call('GET', '/v1/club/me', undefined, mac.body.key)).body.name, 'alice');
  assert.equal((await call('GET', '/v1/club/devices', undefined, mac.body.key)).body.me, 'alice');
  assert.equal((await call('GET', '/v1/board', undefined, mac.body.key)).status, 401);
  assert.equal((await call('GET', '/v1/club/me', undefined, key)).body.name, 'alice', "the browser's key still works too");

  // A code that waited too long doesn't connect anything.
  const late = (await call('POST', '/v1/club/devices/code', {}, key)).body.code;
  env.DB.db.prepare('UPDATE club_device_codes SET expires_at = 1').run();
  assert.equal((await call('POST', '/v1/club/devices/connect', { code: late }, 'nobody')).status, 403);

  // Letting the member go stops their Macs too.
  await call('POST', '/v1/club/members/remove', { name: 'alice' });
  assert.equal((await call('GET', '/v1/club/me', undefined, mac.body.key)).status, 401);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM club_device_keys').get().n, 0);
});

test("over the dashboard's service binding, the club's links carry the board's public address", async () => {
  const { env, join } = setup();
  const key = await join('bob');
  const viaBinding = async (path) => {
    const response = await worker.fetch(new Request(`https://hive-tasks${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}',
    }), env);
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await viaBinding('/v1/club/devices/code')).status, 503, "it doesn't know its address yet");
  env.DB.db.prepare("INSERT INTO board_settings (key, value, updated_at) VALUES ('origin', 'https://board.example.com', 1)").run();
  const made = await viaBinding('/v1/club/devices/code');
  assert.equal(made.status, 200);
  assert.ok(made.body.link.startsWith(`hive://club/connect?board=${encodeURIComponent('https://board.example.com')}&code=`));
});

test("a member downloads Hive for Mac from the club page once there's one, and nobody else can", async () => {
  const { env, call, join } = setup();
  const objects = new Map();
  env.RELEASES = {
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { body: new Blob([bytes]).stream(), size: bytes.length } : null;
    },
  };
  // `node cloud/release.mjs download` puts them where the board looks.
  assert.deepEqual([release.MAC_DOWNLOAD, release.MAC_DOWNLOAD_ABOUT], [MAC_DOWNLOAD, MAC_DOWNLOAD_ABOUT]);
  const key = await join('alice');
  const download = (token) => worker.fetch(new Request('https://board.test/v1/club/download/mac', { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal((await call('GET', '/v1/club/devices', undefined, key)).body.mac_download, null);
  assert.equal((await download(key)).status, 404);
  // A member's Hive.app asks what the newest download is (hive-tasks app_update.rs).
  assert.deepEqual((await call('GET', '/v1/club/download/mac/about', undefined, key)).body, { download: null });
  // release.mjs download puts the disk image and what it is there.
  const dmg = Buffer.from('a notarized disk image');
  objects.set('download/mac/Hive.dmg', dmg);
  objects.set('download/mac/Hive.json', Buffer.from(JSON.stringify({ version: 'b40fdeb43958', size: dmg.length, published_at: 1 })));
  assert.deepEqual((await call('GET', '/v1/club/devices', undefined, key)).body.mac_download, { version: 'b40fdeb43958', size: dmg.length, published_at: 1 });
  assert.deepEqual((await call('GET', '/v1/club/download/mac/about', undefined, key)).body, { download: { version: 'b40fdeb43958', size: dmg.length, published_at: 1 } });
  assert.equal((await call('GET', '/v1/club/download/mac/about', undefined, 'club.mallory.' + 'a'.repeat(64))).status, 401);
  const got = await download(key);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/x-apple-diskimage');
  assert.equal(got.headers.get('content-disposition'), 'attachment; filename="Hive.dmg"');
  assert.equal(got.headers.get('content-length'), String(dmg.length));
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), dmg);
  assert.equal((await download('club.mallory.' + 'a'.repeat(64))).status, 401);
  assert.equal((await download('nobody')).status, 401);
});
