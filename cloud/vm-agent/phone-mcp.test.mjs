import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HIVE_PHONE_DOWN, Phone, answer, relayConfig, visibleElements, pngSize } from './phone-mcp.mjs';

const XML = `<?xml version="1.0"?><AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Clock" label="Clock" visible="true" x="0" y="0" width="390" height="844">
<XCUIElementTypeButton type="XCUIElementTypeButton" name="Add" label="Add" enabled="true" visible="true" x="340" y="50" width="40" height="40"/>
<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="7:30" name="7:30" label="7:30" enabled="true" visible="true" x="20" y="120" width="100" height="40"/>
<XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" value="••••" name="Password" label="Password" visible="true" x="20" y="200" width="300" height="40"/>
<XCUIElementTypeButton type="XCUIElementTypeButton" name="Hidden" label="Hidden" visible="false" x="0" y="0" width="10" height="10"/>
</XCUIElementTypeApplication></AppiumAUT>`;

test('elements lists visible named things at their centers, in screenshot pixels, never a secure value', () => {
  const lines = visibleElements(XML, 3);
  assert.deepEqual(lines, ['(1080, 210) Button "Add"', '(210, 420) StaticText "7:30"', '(510, 660) SecureTextField "Password"']);
});

test('pngSize reads the header', () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x49484452, 12);
  png.writeUInt32BE(1170, 16);
  png.writeUInt32BE(2532, 20);
  assert.deepEqual(pngSize(png), { width: 1170, height: 2532 });
});

function fakeRelay(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, body: init.body && JSON.parse(init.body), auth: init.headers.authorization });
    const route = routes[`${init.method} ${path}`];
    if (!route) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const [status, value] = typeof route === 'function' ? route() : route;
    return new Response(JSON.stringify(value), { status });
  };
  return { calls, fetcher };
}

test('authenticate asks the relay to unlock and passes on only whether it worked', async () => {
  const { calls, fetcher } = fakeRelay({ 'POST /agent/unlock-now': [200, { unlocked: true, wasLocked: true }] });
  const phone = new Phone({ url: 'https://relay.example', token: 'k' }, fetcher);
  const out = await answer(phone, { id: 1, method: 'tools/call', params: { name: 'authenticate', arguments: {} } });
  assert.equal(out.result.content[0].text, 'Unlocked the iPhone.');
  assert.equal(calls[0].auth, 'Bearer k');
  assert.deepEqual(calls[0].body, {});
});

test('a failed unlock is an error that says not to retry', async () => {
  const { fetcher } = fakeRelay({ 'POST /agent/unlock-now': [409, { unlocked: false, error: 'The iPhone reports an authentication lockout.' }] });
  const phone = new Phone({ url: 'https://relay.example', token: 'k' }, fetcher);
  const out = await answer(phone, { id: 1, method: 'tools/call', params: { name: 'authenticate' } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /lockout.*Don't retry/);
});

test('open_app on a locked phone says to authenticate first and sends nothing to the app', async () => {
  const { calls, fetcher } = fakeRelay({ 'GET /api/wda/locked': [200, { value: true }] });
  const phone = new Phone({ url: 'https://relay.example', token: 'k' }, fetcher);
  const out = await answer(phone, { id: 2, method: 'tools/call', params: { name: 'open_app', arguments: { bundle_id: 'com.apple.mobiletimer' } } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /authenticate first/);
  assert.equal(calls.length, 1);
});

test('a tap in screenshot pixels becomes a touch in screen points', async () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x49484452, 12);
  png.writeUInt32BE(1170, 16);
  png.writeUInt32BE(2532, 20);
  const { calls, fetcher } = fakeRelay({
    'GET /api/status': [200, { sessionId: 'S1' }],
    'GET /api/screenshot': [200, { value: png.toString('base64') }],
    'GET /api/session/S1/window/size': [200, { value: { width: 390, height: 844 } }],
    'POST /api/session/S1/actions': [200, { value: null }],
  });
  const phone = new Phone({ url: 'https://relay.example', token: 'k' }, fetcher);
  const out = await answer(phone, { id: 3, method: 'tools/call', params: { name: 'tap', arguments: { x: 600, y: 300 } } });
  assert.equal(out.result.isError, undefined);
  const move = calls.find(c => c.path.endsWith('/actions')).body.actions[0].actions[0];
  assert.deepEqual([move.x, move.y], [200, 100]);
});

test('tools/list has the phone tools the guides name', async () => {
  const out = await answer(new Phone({ url: 'https://relay.example', token: 'k' }), { id: 4, method: 'tools/list' });
  const names = out.result.tools.map(t => t.name);
  for (const name of ['authenticate', 'open_app', 'screenshot', 'tap', 'elements', 'type_text', 'press_home']) assert.ok(names.includes(name));
});

test("each phone call takes the phone's turn, so two tasks never tap it at once", async () => {
  const used = [];
  const turn = { use: async fn => { used.push('take'); try { return await fn(); } finally { used.push('give'); } } };
  const { fetcher } = fakeRelay({ 'POST /agent/unlock-now': () => { used.push('call'); return [200, { unlocked: true }]; } });
  const phone = new Phone({ url: 'https://relay.example', token: 'k' }, fetcher);
  await answer(phone, { id: 9, method: 'tools/call', params: { name: 'authenticate', arguments: {} } }, turn);
  assert.deepEqual(used.slice(0, 2), ['take', 'call']);
  assert.equal(used.at(-1), 'give');
  const listed = await answer(phone, { id: 10, method: 'tools/list' }, turn);
  assert.ok(listed.result.tools.length);
  assert.equal(used.filter(u => u === 'take').length, 1, 'listing the tools takes no turn');
});

test("the phone is reached through the board, unless this VM has a relay of its own", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-relay-'));
  const board = () => ({ url: 'https://board.example', token: 'machine-token' });
  const viaBoard = relayConfig(join(dir, 'phone-relay.json'), board);
  assert.deepEqual(viaBoard, { url: 'https://board.example/v1/phone', token: 'machine-token', down: HIVE_PHONE_DOWN });
  writeFileSync(join(dir, 'phone-relay.json'), JSON.stringify({ url: 'https://relay.example/', token: 'relay-key' }));
  const own = relayConfig(join(dir, 'phone-relay.json'), board);
  assert.equal(own.url, 'https://relay.example');
  assert.equal(own.token, 'relay-key');
  rmSync(dir, { recursive: true, force: true });

  // Through the board, a phone that isn't connected is Hive Phone not being open, said so.
  const { calls, fetcher } = fakeRelay({ 'GET /v1/phone/api/status': [503, { error: "phone offline: Hive Phone isn't connected" }] });
  const phone = new Phone(viaBoard, fetcher);
  await assert.rejects(phone.wda('/status'), (error) => error.message === HIVE_PHONE_DOWN);
  assert.equal(calls[0].auth, 'Bearer machine-token');
});
