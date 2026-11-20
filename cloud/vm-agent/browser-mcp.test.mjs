// The owner's browser for Hive's agent on the VM (browser-mcp.mjs), against a fake board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, OFFLINE, TOOLS, answer, boardConfig, commandFor, offlineAnswer } from './browser-mcp.mjs';

// A board that answers each call with the next of `answers` ({status, body} or a function of the call)
// and records every call.
function fakeBoard(answers) {
  const calls = [];
  const fetcher = async (url, init) => {
    const call = { path: url.replace('https://board.test', ''), method: init.method, auth: init.headers.authorization,
      body: init.body && JSON.parse(init.body) };
    calls.push(call);
    let reply = answers.shift();
    if (typeof reply === 'function') reply = reply(call);
    if (!reply) throw new Error(`no answer left for ${call.path}`);
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  return { calls, fetcher };
}
const config = { url: 'https://board.test', token: 'machine-token' };
const done = (id, result, browser = 'owner-mac/chrome') => ({ status: 200, body: { command: { id, status: 'done', browser, result } } });
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { step: 'test', ...args } } });

test('every browser tool says its step, and none can type a password or read one', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.inputSchema.required.includes('step'), `${tool.name} requires step`);
    for (const key of Object.keys(tool.inputSchema.properties)) assert.doesNotMatch(key, /sensitive|password/i, `${tool.name}.${key}`);
  }
  assert.deepEqual(commandFor('type', { ref: 'e3', text: 'hi', allowSensitiveInput: true }), { type: 'type', params: { ref: 'e3', text: 'hi' } });
  assert.deepEqual(commandFor('snapshot', { tab_id: 4, includeSensitive: true }), { type: 'snapshot', params: { tabId: 4 } });
});

test("navigate opens its own tab unless it's told which, so it never takes over the owner's page", () => {
  assert.deepEqual(commandFor('navigate', { url: 'https://a.test' }), { type: 'navigate', params: { url: 'https://a.test', newTab: true } });
  assert.deepEqual(commandFor('navigate', { url: 'https://a.test', tab_id: 7 }), { type: 'navigate', params: { url: 'https://a.test', tabId: 7 } });
  assert.deepEqual(commandFor('open', { url_contains: 'canvas', url: 'https://canvas.test' }),
    { type: 'activate_tab', params: { urlContains: 'canvas', url: 'https://canvas.test' } });
  assert.deepEqual(commandFor('wait_for', { text: 'Saved', timeout_ms: 5000 }), { type: 'wait_for', params: { textContains: 'Saved', timeoutMs: 5000 } });
  assert.throws(() => commandFor('eval', {}), /No browser tool/);
});

test('a command goes to the board with the machines\' token, and the browser that ran it runs the rest', async () => {
  const board = fakeBoard([
    done(1, { tabs: [{ tabId: 9, active: true, title: 'Canvas', url: 'https://canvas.test/' }] }),
    done(2, { message: 'Snapshot', title: 'Canvas', url: 'https://canvas.test/', tabId: 9,
      elements: [{ ref: 'e0', role: 'button', name: 'Submit', disabled: true }, { ref: 'e1', role: 'textbox', inputType: 'email', name: 'Email' }] }),
  ]);
  const client = new Browser(config, { fetcher: board.fetcher });
  const tabs = await answer(client, call(1, 'tabs', {}));
  assert.match(tabs.result.content[0].text, /tab 9 \(active\): "Canvas" https:\/\/canvas.test\//);
  assert.deepEqual(board.calls[0], { path: '/v1/browser/commands', method: 'POST', auth: 'Bearer machine-token',
    body: { action: { type: 'list_tabs', params: {} }, browser: '', wait: 25 } });
  const snap = await answer(client, call(2, 'snapshot', { tab_id: 9 }));
  assert.equal(board.calls[1].body.browser, 'owner-mac/chrome', 'sticks to the browser that ran the first one');
  assert.match(snap.result.content[0].text, /e0 button "Submit" \(disabled\)\ne1 textbox\[email\] "Email"/);
});

test('naming the other browser switches to it', async () => {
  const board = fakeBoard([done(1, { message: 'ok' }), done(2, { message: 'ok' }, 'owner-mac/safari'), done(3, { message: 'ok' }, 'owner-mac/safari')]);
  const client = new Browser(config, { fetcher: board.fetcher });
  await client.run({ type: 'list_tabs', params: {} });
  await client.run({ type: 'list_tabs', params: {} }, 'safari');
  await client.run({ type: 'list_tabs', params: {} });
  assert.deepEqual(board.calls.map(c => c.body.browser), ['', 'safari', 'owner-mac/safari']);
});

test('a slow browser is waited for; a failure, a lost command and no browser at all come back in words', async () => {
  const board = fakeBoard([
    { status: 200, body: { command: { id: 5, status: 'running', browser: 'owner-mac/chrome' } } },
    done(5, { message: 'Clicked e2', tabId: 3 }),
    { status: 200, body: { command: { id: 6, status: 'failed', browser: 'owner-mac/chrome', error: 'No element for ref e9' } } },
    { status: 200, body: { command: { id: 7, status: 'lost', error: 'The browser took it but never answered.' } } },
    { status: 200, body: { command: { id: 8, status: 'queued' }, browsers: [] } },
    { status: 200, body: { ok: true, cancelled: 1 } },
    { status: 401, body: { error: 'Not signed in.' } },
  ]);
  const client = new Browser(config, { fetcher: board.fetcher });
  const clicked = await answer(client, call(1, 'click', { ref: 'e2', tab_id: 3 }));
  assert.equal(board.calls[1].path, '/v1/browser/commands?id=5&wait=25');
  assert.match(clicked.result.content[0].text, /^Clicked e2 — tab 3 \(chrome\)$/);
  const failed = await answer(client, call(2, 'click', { ref: 'e9' }));
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.content[0].text, 'No element for ref e9');
  assert.match((await answer(client, call(3, 'click', { ref: 'e1' }))).result.content[0].text, /never answered/);
  assert.match((await answer(client, call(4, 'tabs', {}))).result.content[0].text, /isn't connected .*desktop tools/);
  assert.deepEqual(board.calls.at(-1), { path: '/v1/browser/cancel', method: 'POST', auth: 'Bearer machine-token', body: { id: 8 } },
    'nobody listening: it gives up after one wait and cancels, so nothing runs it late');
  assert.equal((await answer(client, call(5, 'tabs', {}))).result.content[0].text, 'Not signed in.');
});

test('a screenshot comes back as a picture', async () => {
  const board = fakeBoard([done(1, { tabId: 2, title: 'Mail', imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' })]);
  const shot = await answer(new Browser(config, { fetcher: board.fetcher }), call(1, 'screenshot', { tab_id: 2 }));
  assert.deepEqual(shot.result.content[1], { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  assert.deepEqual(board.calls[0].body.action, { type: 'capture', params: { tabId: 2 } });
});

// 2026-11-19: a grades run read a Canvas API answer (CHEM 103 assignment_groups) and it stopped at 50,000 characters
// with no way to get the rest.
test('a long page comes in pieces: the read says how much is left and where the next piece starts', async () => {
  assert.deepEqual(commandFor('read', { step: 's', tab_id: 4, max_chars: 50000, offset: 50000 }),
    { type: 'read_page', params: { tabId: 4, maxChars: 50000, offset: 50000 } });
  const board = fakeBoard([
    done(1, { tabId: 4, title: 'api', content: 'x'.repeat(10), total: 25, offset: 0, next: 10 }),
    done(2, { tabId: 4, title: 'api', content: 'y'.repeat(15), total: 25, offset: 10 }),
    done(3, { tabId: 4, title: 'short', content: 'all of it', total: 9, offset: 0 }),
  ]);
  const browser = new Browser(config, { fetcher: board.fetcher });
  const first = (await answer(browser, call(1, 'read', { tab_id: 4, max_chars: 10 }))).result.content[0].text;
  assert.match(first, /characters 0–10 of 25\n/);
  assert.match(first, /\[15 more characters: read again with offset 10\]$/);
  const last = (await answer(browser, call(2, 'read', { tab_id: 4, offset: 10 }))).result.content[0].text;
  assert.match(last, /characters 10–25 of 25\ny+$/);
  const whole = (await answer(browser, call(3, 'read', { tab_id: 4 }))).result.content[0].text;
  assert.doesNotMatch(whole, /characters|more characters/);
});

test('it reads the board key from the hive-tasks config, and without one still starts with no tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-mcp-'));
  try {
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify({ url: 'https://board.test/', token: 't', machine: 'vm' }));
    assert.deepEqual(boardConfig({ HIVE_TASKS_CONFIG: file }), { url: 'https://board.test', token: 't', machine: 'vm' });
    writeFileSync(file, JSON.stringify({ url: 'https://board.test' }));
    assert.throws(() => boardConfig({ HIVE_TASKS_CONFIG: file }), /no url or token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const init = offlineAnswer({ id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'browser');
  assert.equal(init.result.instructions, OFFLINE);
  assert.deepEqual(offlineAnswer({ id: 2, method: 'tools/list' }).result, { tools: [] });
  assert.equal(offlineAnswer({ id: 3, method: 'tools/call', params: { name: 'tabs' } }).result.isError, true);
  assert.equal(offlineAnswer({ method: 'notifications/initialized' }), null);
});

test('when the browser it was using stops listening, it stops too instead of using another one blind', async () => {
  const board = fakeBoard([
    done(1, { message: 'ok' }),
    { status: 200, body: { command: { id: 2, status: 'queued' }, browsers: ['owner-mac/safari'] } },
    { status: 200, body: { ok: true, cancelled: 1 } },
  ]);
  const client = new Browser(config, { fetcher: board.fetcher });
  await client.run({ type: 'list_tabs', params: {} });
  await assert.rejects(client.run({ type: 'click', params: { ref: 'e1' } }), /chrome stopped listening\. Listening now: owner-mac\/safari/);
  assert.equal(board.calls.at(-1).path, '/v1/browser/cancel');
});
