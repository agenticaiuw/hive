// The owner's iPhone through the board (cloud/tasks/phone.js), through the real worker against every
// migration on node:sqlite, with Hive Phone's WebSocket played by a stand-in WebDriverAgent: only the
// phone's own key connects, the dashboard's pairing carries the board's address and that key, agents'
// calls go down the socket and come back, the passcode is kept sealed and typed once at the real lock
// screen only, and SideStore's source offers the newest Hive Phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../tasks/worker.js';
import { forgetSeen } from '../tasks/nodes.js';
import { PAIRING_PREFIX, PhoneRelay, forgetOrigin, phoneAllowed, phoneKey, unseal } from '../tasks/phone.js';

const MIGRATIONS = new URL('../knowledge/migrations/', import.meta.url);
const TOKEN = 'machine-token';
const PASSCODE = '482915';

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => statement(sql), batch: async (list) => Promise.all(list.map((s) => s.run())), db };
}

function fakeR2() {
  const objects = new Map();
  return {
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

/** WebDriverAgent on a locked iPhone, as much as unlocking and an agent's calls touch. */
function fakeWda() {
  const phone = { locked: true, keypad: false, uuid: 'device-1', typed: [], lockScreenText: 'Enter Passcode', calls: [] };
  phone.answer = ({ method, path, body }) => {
    phone.calls.push(`${method} ${path}`);
    const args = body ? JSON.parse(body) : {};
    if (path === '/status') return { value: { ready: true }, sessionId: 's1' };
    if (path === '/wda/locked') return { value: phone.locked };
    if (path === '/wda/device/info') return { value: { uuid: phone.uuid } };
    if (path === '/wda/activeAppInfo') return { value: { bundleId: 'com.apple.springboard' } };
    if (path === '/session/s1/wda/pressButton') return { value: null };
    if (path === '/session/s1/window/size') return { value: { width: 440, height: 956 } };
    if (path === '/session/s1/actions') { phone.keypad = true; return { value: null }; }
    if (path === '/session/s1/elements' && args.value.includes('StaticText')) return { value: phone.keypad ? [{ ELEMENT: 'p1' }] : [] };
    if (path === '/session/s1/elements' && args.value.includes('SecureTextField')) return { value: [{ ELEMENT: 'field-1' }] };
    if (path === '/session/s1/source') {
      return { value: `<XCUIElementTypeApplication bundleId="com.apple.springboard" visible="true"><XCUIElementTypeStaticText label="${phone.lockScreenText}" visible="true"/><XCUIElementTypeSecureTextField label="Passcode field" visible="true"/></XCUIElementTypeApplication>` };
    }
    if (path === '/session/s1/element/field-1/value') {
      phone.typed.push(args.value.join(''));
      if (args.value.join('') === PASSCODE) phone.locked = false;
      return { value: null };
    }
    if (path === '/screenshot') return { value: 'iVBORw0KGgo=' };
    return { value: { error: 'unknown command', message: `no ${path}` } };
  };
  return phone;
}

function setup() {
  forgetSeen();
  forgetOrigin();
  const env = { DB: fakeD1(), RELEASES: fakeR2(), TASKS_TOKEN: TOKEN };
  const storage = new Map();
  const sockets = [];
  const ctx = {
    storage: {
      get: async (key) => storage.get(key),
      put: async (key, value) => void storage.set(key, value),
      delete: async (keys) => { for (const key of [].concat(keys)) storage.delete(key); },
      setAlarm: async () => {},
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (socket) => sockets.push(socket),
  };
  const relay = new PhoneRelay(ctx, env);
  relay.sleep = async () => {};
  env.PHONE = { idFromName: (name) => name, get: () => ({ fetch: (request) => relay.fetch(request) }) };
  const wda = fakeWda();
  // Hive Phone's end of the socket: each call answered by the stand-in WebDriverAgent.
  const connect = () => {
    const socket = {
      readyState: 1,
      send(text) {
        const call = JSON.parse(text);
        setTimeout(() => relay.webSocketMessage(socket, JSON.stringify({ id: call.id, status: 200, body: JSON.stringify(wda.answer(call)) })), 0);
      },
      close() { this.readyState = 3; },
      deserializeAttachment: () => ({ version: '2026.1118.1530-ab12cd34ef56' }),
    };
    sockets.push(socket);
    return socket;
  };
  const call = async (method, path, { body, auth = `Bearer ${TOKEN}`, host = 'https://board.test', headers = {} } = {}) => {
    const response = await worker.fetch(new Request(`${host}${path}`, {
      method, headers: { authorization: auth, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    }), env, {});
    const text = response.status === 101 ? '' : await response.text();
    let value = null;
    try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, value, response };
  };
  return { env, storage, relay, wda, connect, call };
}

test("only the phone's own key connects as the phone, and only with a WebSocket", async () => {
  const { env, call } = setup();
  const key = await phoneKey(env);
  assert.match(key, /^phone\.iphone\.[0-9a-f]{64}$/);
  assert.equal((await call('GET', '/v1/phone/device', { auth: '' })).status, 401);
  assert.equal((await call('GET', '/v1/phone/device')).status, 401, "the machines' token isn't the phone's key");
  assert.equal((await call('GET', '/v1/phone/device', { auth: `Bearer ${key.slice(0, -1)}0` })).status, 401);
  assert.equal((await call('GET', '/v1/phone/device', { auth: `Bearer ${key}` })).status, 426);
  // The phone's key reaches nothing but its socket.
  assert.equal((await call('GET', '/v1/phone/api/status', { auth: `Bearer ${key}` })).status, 401);
  assert.equal((await call('POST', '/v1/phone/pair', { auth: `Bearer ${key}` })).status, 401);
  assert.equal((await call('POST', '/v1/requests', { auth: `Bearer ${key}`, body: { text: 'x' } })).status, 401);
});

test("the Worker hands the phone's WebSocket back as it is and writes the phone down", async () => {
  const { env, call } = setup();
  const upgraded = { status: 101, headers: new Headers(), webSocket: {} };
  env.PHONE = { idFromName: (n) => n, get: () => ({ fetch: async () => upgraded }) };
  const key = await phoneKey(env);
  const { response } = await call('GET', '/v1/phone/device', {
    auth: `Bearer ${key}`, headers: { upgrade: 'websocket', 'x-hive-node': 'phone:iphone', 'x-hive-version': '2026.1118.1530-ab12cd34ef56', 'x-hive-protocol': '1' },
  });
  assert.equal(response, upgraded);
  const node = env.DB.db.prepare("SELECT version FROM board_nodes WHERE kind = 'phone' AND name = 'iphone'").get();
  assert.equal(node?.version, '2026.1118.1530-ab12cd34ef56');
  assert.equal(env.DB.db.prepare("SELECT value FROM board_settings WHERE key = 'origin'").get(), undefined,
    "the phone's own calls don't teach the board its address");
});

test("the pairing holds the board's address and the phone's key, learned even through the dashboard's binding", async () => {
  const { env, call } = setup();
  // Through the dashboard's service binding the board can't see its address until a node has called.
  const early = await call('POST', '/v1/phone/pair', { host: 'https://hive-tasks' });
  assert.equal(early.status, 503);
  await call('GET', '/v1/board', { headers: { 'x-hive-node': 'vm:hive-vm', 'x-hive-version': 'abc123', 'x-hive-protocol': '1' } });
  const { status, value } = await call('POST', '/v1/phone/pair', { host: 'https://hive-tasks' });
  assert.equal(status, 200);
  assert.ok(value.pairing.startsWith(PAIRING_PREFIX));
  const said = JSON.parse(Buffer.from(value.pairing.slice(PAIRING_PREFIX.length), 'base64url').toString('utf8'));
  assert.deepEqual(said, { url: 'wss://board.test/v1/phone/device', token: await phoneKey(env) });
  assert.ok(await phoneAllowed(new Request('https://board.test/v1/phone/device', { headers: { authorization: `Bearer ${said.token}` } }), env));
  assert.equal(value.source, 'https://board.test/v1/phone/source.json');
  assert.equal(value.sidestore, `sidestore://source?url=${encodeURIComponent(value.source)}`);
  assert.equal((await call('POST', '/v1/phone/pair', { auth: 'Bearer nope' })).status, 401);
});

test("an agent's WebDriverAgent calls go down the socket and come back; nothing else does", async () => {
  const { connect, call, wda } = setup();
  const offline = await call('GET', '/v1/phone/api/status');
  assert.equal(offline.status, 503);
  assert.match(offline.value.error, /offline/);
  connect();
  const status = await call('GET', '/v1/phone/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.value.sessionId, 's1');
  assert.equal((await call('GET', '/v1/phone/api/screenshot')).value.value, 'iVBORw0KGgo=');
  assert.equal((await call('GET', '/v1/phone/api/var/mobile')).status, 400, "only WebDriverAgent's routes");
  assert.equal((await call('GET', '/v1/phone/api/wda/..%2f..')).status, 400);
  assert.equal((await call('PUT', '/v1/phone/api/status')).status, 405);
  assert.equal((await call('GET', '/v1/phone/api/status', { auth: 'Bearer nope' })).status, 401);
  assert.deepEqual(wda.calls, ['GET /status', 'GET /screenshot']);
  const health = await call('GET', '/v1/phone/health');
  assert.deepEqual(health.value, { connected: true, version: '2026.1118.1530-ab12cd34ef56', passcode: false, paused: false });
});

test('the passcode is kept sealed to this iPhone and typed once, at the real lock screen', async () => {
  const { env, storage, connect, call, wda } = setup();
  const notYet = await call('POST', '/v1/phone/agent/unlock', { body: { passcode: PASSCODE, consent: true } });
  assert.equal(notYet.status, 409, "it's tied to the iPhone, so the iPhone must be connected");
  connect();
  assert.equal((await call('POST', '/v1/phone/agent/unlock', { body: { passcode: PASSCODE } })).status, 400, 'consent is asked for');
  assert.equal((await call('POST', '/v1/phone/agent/unlock', { body: { passcode: PASSCODE, consent: true } })).value.saved, true);
  const record = storage.get('passcode');
  assert.ok(!JSON.stringify(record).includes(PASSCODE), 'kept sealed');
  assert.deepEqual(JSON.parse(await unseal(env, record)), { device: 'device-1', passcode: PASSCODE });
  assert.equal((await call('GET', '/v1/phone/health')).value.passcode, true);
  // Only machines unlock: the dashboard's sign-in can save the passcode but not use it.
  assert.equal((await call('POST', '/v1/phone/agent/unlock-now', { auth: 'Bearer nope' })).status, 401);

  const unlocked = await call('POST', '/v1/phone/agent/unlock-now');
  assert.deepEqual(unlocked.value, { unlocked: true, wasLocked: true });
  assert.deepEqual(wda.typed, [PASSCODE]);
  assert.equal(storage.has('unlockAttempt'), false);
  assert.ok(!JSON.stringify(unlocked.value).includes(PASSCODE));
  const again = await call('POST', '/v1/phone/agent/unlock-now');
  assert.deepEqual(again.value, { unlocked: true, wasLocked: false }, 'an unlocked phone is left alone');
  assert.deepEqual(wda.typed, [PASSCODE]);
});

test("a try the iPhone doesn't confirm pauses unlocking until the owner allows another", async () => {
  const { storage, connect, call, wda } = setup();
  connect();
  await call('POST', '/v1/phone/agent/unlock', { body: { passcode: '000000', consent: true } });
  const failed = await call('POST', '/v1/phone/agent/unlock-now');
  assert.equal(failed.status, 409);
  assert.match(failed.value.error, /paused/);
  assert.deepEqual(wda.typed, ['000000']);
  assert.ok(storage.has('unlockAttempt'));
  wda.keypad = false;
  const paused = await call('POST', '/v1/phone/agent/unlock-now');
  assert.equal(paused.status, 409);
  assert.deepEqual(wda.typed, ['000000'], 'never typed twice');
  assert.equal((await call('GET', '/v1/phone/health')).value.paused, true);
  assert.deepEqual((await call('POST', '/v1/phone/agent/unlock', { body: { retry: true, consent: true } })).value, { retry: true });
  assert.equal(storage.has('unlockAttempt'), false);
  assert.deepEqual((await call('POST', '/v1/phone/agent/unlock', { body: { remove: true } })).value, { saved: false });
  assert.equal(storage.has('passcode'), false);
});

test('it never types on a screen that shows a failed try, or into a different install of Hive Phone', async () => {
  const { connect, call, wda } = setup();
  connect();
  await call('POST', '/v1/phone/agent/unlock', { body: { passcode: PASSCODE, consent: true } });
  wda.lockScreenText = 'Enter Passcode. Try again in 1 minute';
  const lockedOut = await call('POST', '/v1/phone/agent/unlock-now');
  assert.equal(lockedOut.status, 409);
  assert.match(lockedOut.value.error, /No passcode was entered/);
  wda.lockScreenText = 'Enter Passcode';
  wda.uuid = 'device-2';
  const reinstalled = await call('POST', '/v1/phone/agent/unlock-now');
  assert.equal(reinstalled.status, 409);
  assert.match(reinstalled.value.error, /installed again/);
  assert.deepEqual(wda.typed, []);
});

test("SideStore's source offers the newest Hive Phone, its IPA and its icon, to anyone", async () => {
  const { call } = setup();
  const none = await call('GET', '/v1/phone/source.json', { auth: '' });
  assert.equal(none.status, 200);
  assert.deepEqual(none.value.apps, []);
  const ipa = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]);
  const sha256 = createHash('sha256').update(ipa).digest('hex');
  const version = '2026.1118.1530-ab12cd34ef56';
  const published = await call('POST', `/v1/releases?kind=phone&version=${version}&protocol=1&sha256=${sha256}&notes=Pairs%20from%20the%20clipboard`, {
    body: ipa, headers: { 'content-type': 'application/octet-stream', 'content-length': String(ipa.length) },
  });
  assert.equal(published.status, 200, JSON.stringify(published.value));
  const { value: source } = await call('GET', '/v1/phone/source.json', { auth: '' });
  assert.equal(source.sourceURL, 'https://board.test/v1/phone/source.json');
  const [app] = source.apps;
  assert.equal(app.bundleIdentifier, 'app.hive.phone.xctrunner');
  assert.equal(app.iconURL, 'https://board.test/v1/phone/icon.png');
  assert.deepEqual(app.versions.map((v) => [v.version, v.buildVersion, v.size, v.minOSVersion, v.localizedDescription]),
    [['2026.1118.1530', '2026.1118.1530', ipa.length, '17.0', 'Pairs from the clipboard']]);
  assert.equal(app.downloadURL, `https://board.test/v1/phone/app.ipa?version=${version}`);
  const download = await call('GET', `/v1/phone/app.ipa?version=${version}`, { auth: '' });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(download.value, 'latin1'), Buffer.from(ipa));
  assert.deepEqual(Buffer.from((await call('GET', '/v1/phone/app.ipa', { auth: '' })).value, 'latin1'), Buffer.from(ipa), 'the newest, unasked');
  assert.equal((await call('GET', '/v1/phone/app.ipa?version=2020.0101.0000-000000000000', { auth: '' })).status, 404);
  const iconResponse = (await call('GET', '/v1/phone/icon.png', { auth: '' })).response;
  assert.equal(iconResponse.headers.get('content-type'), 'image/png');
});
