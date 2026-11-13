import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, get, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from './agent.mjs';
import { proxyArgs } from './browser.mjs';
import { PostError, PostStore, postDigest } from './posts.mjs';
import { RECIPES, normalizeText, ownedLink, validatePost } from './sites.mjs';

const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'hive-vm-agent-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const code = expected => error => error instanceof PostError && error.code === expected;

test('a post is sent only once, only while a matching approval is fresh', t => {
  let clock = 1_000;
  const store = new PostStore(join(tempDir(t), 'posts.sqlite'), { now: () => clock });
  const draft = store.draft({ id: 'p1', platform: 'discord', destination: 'd', text: 'hello', attachments: [] });
  assert.equal(draft.status, 'drafted');
  assert.equal(draft.digest, postDigest({ platform: 'discord', destination: 'd', text: 'hello', attachments: [] }));
  assert.deepEqual(store.draft({ id: 'p1', platform: 'discord', destination: 'd', text: 'hello' }), draft, 'same draft is idempotent');
  assert.throws(() => store.draft({ id: 'p1', platform: 'discord', destination: 'd', text: 'different' }), code('conflict'));
  assert.throws(() => store.begin('p1', { approvalTtlMs: 60_000 }), code('not_approved'));
  assert.throws(() => store.approve('p1', 'f'.repeat(64)), code('digest_mismatch'));

  store.approve('p1', draft.digest);
  clock += 61_000;
  assert.throws(() => store.begin('p1', { approvalTtlMs: 60_000 }), code('approval_expired'));
  assert.equal(store.get('p1').status, 'drafted', 'an expired approval must be given again');

  store.approve('p1', draft.digest);
  assert.equal(store.begin('p1', { approvalTtlMs: 60_000 }).status, 'sending');
  assert.throws(() => store.begin('p1', { approvalTtlMs: 60_000 }), code('not_sendable'));
  assert.throws(() => store.cancel('p1'), code('not_cancellable'));
  assert.equal(store.finish('p1', 'sent', { messageId: '1' }).status, 'sent');
  assert.throws(() => store.approve('p1', draft.digest), code('not_approvable'));
  assert.throws(() => store.begin('p1', { approvalTtlMs: 60_000 }), code('not_sendable'));
  store.close();
});

test('a send interrupted by a restart becomes unknown and is never sent again', t => {
  const path = join(tempDir(t), 'posts.sqlite');
  let store = new PostStore(path);
  const draft = store.draft({ id: 'p1', platform: 'x', destination: 'post', text: 'hello' });
  store.approve('p1', draft.digest);
  store.begin('p1', { approvalTtlMs: 60_000 });
  store.close();
  store = new PostStore(path);
  assert.equal(store.get('p1').status, 'unknown');
  assert.equal(store.get('p1').detail.reason, 'interrupted_during_send');
  assert.throws(() => store.begin('p1', { approvalTtlMs: 60_000 }), code('not_sendable'));
  assert.throws(() => store.approve('p1', draft.digest), code('not_approvable'));
  store.close();
});

test('destinations and text are validated before anything is stored', () => {
  const { discord, x } = RECIPES;
  assert.equal(discord.parseDestination('https://discord.com/channels/123456789012345678/234567890123456789/').url, 'https://discord.com/channels/123456789012345678/234567890123456789');
  for (const bad of ['https://discord.com/channels/1/2', 'https://discord.com.evil.example/channels/123456789012345678/234567890123456789', 'http://discord.com/channels/123456789012345678/234567890123456789', 'https://discord.com/channels/123456789012345678/234567890123456789?x=1', 'general']) {
    assert.throws(() => discord.parseDestination(bad), /channel link/);
  }
  assert.equal(x.parseDestination('post').url, 'https://x.com/compose/post');
  assert.throws(() => x.parseDestination('https://x.com/someone/status/1'), /must be "post"/);
  assert.throws(() => validatePost(x, { destination: 'post', text: 'a'.repeat(281) }), /allows 280/);
  assert.throws(() => validatePost(discord, { destination: 'https://discord.com/channels/123456789012345678/234567890123456789', text: '  \n' }), /text is required/);
  assert.equal(normalizeText('a \r\n\r\nb c﻿\n\n'), 'a\n\nb c');
});

// ---- end to end against a real browser and a stand-in site ---------------------------------

const CHROME = [process.env.HIVE_VM_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].filter(Boolean).find(existsSync);
const SECRET = 'fixture-secret';

function fixtureSite() {
  const sent = [];
  const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:14px sans-serif">${body}`;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const signedIn = /(?:^|;\s*)session=ok/.test(req.headers.cookie ?? '');
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const ok = new URLSearchParams(body).get('password') === SECRET;
        res.writeHead(302, ok ? { location: '/channel', 'set-cookie': 'session=ok; Path=/' } : { location: '/login' }); res.end();
      });
      return;
    }
    if (url.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page('Sign in', '<form method="post" action="/login"><input name="password" type="password" autofocus></form>')); }
    if (url.pathname === '/sent' && req.method === 'POST') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => { sent.push(JSON.parse(body)); res.writeHead(204); res.end(); });
      return;
    }
    if (url.pathname === '/channel') {
      if (!signedIn) { res.writeHead(302, { location: '/login' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(page('#general — Fixture', `
        <ol id="messages"><li id="m0">older message</li></ol><ul id="attachments"></ul>
        <input id="file" type="file" multiple><textarea id="composer" rows="6" cols="80">stale draft from last time</textarea>
        <script>
          const silent = new URLSearchParams(location.search).get('mode') === 'silent';
          const box = document.getElementById('composer'), files = document.getElementById('file'), list = document.getElementById('attachments');
          files.addEventListener('change', () => { list.innerHTML = ''; for (const f of files.files) { const li = document.createElement('li'); li.textContent = f.name + ' ' + f.size; list.append(li); } });
          let n = 0;
          box.addEventListener('keydown', async e => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            e.preventDefault();
            const text = box.value, attachments = files.files.length;
            box.value = ''; files.value = ''; list.innerHTML = '';
            await fetch('/sent', { method: 'POST', body: JSON.stringify({ text, attachments, silent }) });
            if (silent) return;
            const li = document.createElement('li'); li.id = 'm' + (++n) + '-' + Date.now(); li.dataset.attachments = attachments; li.innerText = text; document.getElementById('messages').append(li);
          });
        </script>`));
    }
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const recipe = {
      name: 'fixture', maxLength: 2000, maxAttachments: 4, homeUrl: `${base}/channel`, loginUrl: `${base}/login`, allowedHosts: ['127.0.0.1'],
      newline: { key: 'Enter', modifiers: ['shift'] }, submit: { key: 'Enter' }, composer: '#composer', fileInput: '#file',
      parseDestination(destination) { if (![`${base}/channel`, `${base}/channel?mode=silent`].includes(destination)) throw new Error('unknown fixture destination'); return { url: destination }; },
      page: {
        loggedOut: () => location.pathname === '/login',
        ready: () => !!document.querySelector('#composer'),
        label: () => document.title,
        readComposer: () => document.querySelector('#composer')?.value ?? null,
        blocked: () => null,
        attachmentCount: () => document.querySelectorAll('#attachments li').length,
        messageIds: () => [...document.querySelectorAll('#messages li')].map(node => node.id),
        sentProbe: (expected, before, wantAttachments) => {
          for (const node of document.querySelectorAll('#messages li')) {
            if (before.includes(node.id) || node.innerText !== expected) continue;
            if (wantAttachments && node.dataset.attachments === '0') return null;
            return { messageId: node.id, permalink: `${location.origin}/channel#${node.id}`, attachments: Number(node.dataset.attachments) };
          }
          return null;
        },
      },
    };
    resolve({ base, recipe, sent, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) });
  }));
}

const http = (port, method, path, { cookie, body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const outgoing = request({ host: '127.0.0.1', port, method, path, headers: { ...(cookie ? { cookie } : {}), ...headers } }, response => {
    let text = ''; response.on('data', chunk => { text += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
  });
  outgoing.on('error', reject); outgoing.end(body);
});

const firstFrame = (port, cookie) => new Promise((resolve, reject) => {
  const incoming = get({ host: '127.0.0.1', port, path: '/frames', headers: { cookie } }, response => {
    let buffer = '';
    response.on('data', chunk => {
      buffer += chunk;
      const match = /^data: (.+)$/m.exec(buffer);
      if (match && buffer.includes('\n\n', match.index)) { incoming.destroy(); resolve(JSON.parse(match[1])); }
    });
  });
  incoming.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
});

test('a pasted link opens only when it leads to a known site over https', () => {
  assert.equal(ownedLink(' https://click.discord.com/ls/click?upn=abc '), 'https://click.discord.com/ls/click?upn=abc');
  assert.equal(ownedLink('https://discord.com/authorize-ip?token=t'), 'https://discord.com/authorize-ip?token=t');
  assert.equal(ownedLink('https://twitter.com/i/flow/login'), 'https://twitter.com/i/flow/login');
  for (const bad of ['http://discord.com/login', 'https://discord.com.evil.example/', 'https://evildiscord.com/', 'https://user@discord.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'not a link']) {
    assert.throws(() => ownedLink(bad), /link/, bad);
  }
});

test('the browser goes through HIVE_VM_PROXY when it is set, and only a proxy address is accepted', () => {
  assert.deepEqual(proxyArgs(null), []);
  assert.deepEqual(proxyArgs('socks5://127.0.0.1:11080'),
    ['--proxy-server=socks5://127.0.0.1:11080', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']);
  for (const bad of ['127.0.0.1:11080', 'socks5://127.0.0.1:11080 --no-sandbox', 'file:///etc/passwd']) {
    assert.throws(() => proxyArgs(bad), /HIVE_VM_PROXY/, bad);
  }
});

test('sign-in through the viewer, then an approved post with an attachment goes out exactly once', { skip: !CHROME && 'no Chromium available', timeout: 120_000 }, async t => {
  const site = await fixtureSite(); t.after(site.close);
  const logs = [];
  const agent = createAgent({
    stateDir: tempDir(t), executable: CHROME, headless: true, extraRecipes: { fixture: site.recipe }, viewerPort: 0, log: line => logs.push(line),
    timeouts: { arriveMs: 8_000, readbackMs: 3_000, attachMs: 5_000, proofMs: 3_000, proofWithFilesMs: 5_000 },
  });
  t.after(() => agent.close());
  const destination = `${site.base}/channel`;
  const text = 'First line of the post\n\nSecond paragraph — with punctuation: "quotes", it\'s fine.';

  assert.equal((await agent.handle('POST', '/check', { platform: 'fixture' })).state, 'needs_login');
  const unsigned = await agent.handle('POST', '/draft', { id: 'early', platform: 'fixture', destination, text });
  assert.equal(unsigned.loginState, 'needs_login');
  assert.equal(unsigned.label, null);
  await assert.rejects(agent.handle('POST', '/send', { id: 'early' }), code('not_approved'));
  await agent.handle('POST', '/approve', { id: 'early', digest: unsigned.digest });
  const refused = await agent.handle('POST', '/send', { id: 'early' });
  assert.equal(refused.status, 'failed');
  assert.deepEqual([refused.detail.reason, refused.detail.submitted], ['needs_login', false]);
  assert.equal(site.sent.length, 0);

  // The owner signs in by typing into the viewer; the worker only forwards the keystrokes.
  const view = await agent.handle('POST', '/view/open', { site: 'fixture' });
  assert.equal((await http(view.port, 'POST', '/input', { body: '{}', headers: { 'x-hive-viewer': '1' } })).status, 403);
  const auth = await http(view.port, 'GET', `/auth?t=${view.token}`);
  assert.equal(auth.status, 302);
  const cookie = auth.headers['set-cookie'][0].split(';')[0];
  assert.equal((await http(view.port, 'GET', `/auth?t=${view.token}`)).status, 403, 'the sign-in link works once');
  assert.match((await http(view.port, 'GET', '/', { cookie })).text, /Hive VM browser/);
  const frame = await firstFrame(view.port, cookie);
  assert.ok(frame.d.length > 1000 && frame.w > 0 && frame.h > 0, 'viewer shows a live picture');
  const input = event => http(view.port, 'POST', '/input', { cookie, body: JSON.stringify(event), headers: { 'x-hive-viewer': '1', origin: `http://127.0.0.1:${view.port}` } });
  assert.equal((await http(view.port, 'POST', '/input', { cookie, body: '{}', headers: { 'x-hive-viewer': '1', origin: 'https://evil.example' } })).status, 403);
  assert.equal((await http(view.port, 'POST', '/go', { cookie, body: JSON.stringify({ url: 'https://evil.example/' }), headers: { 'x-hive-viewer': '1', origin: `http://127.0.0.1:${view.port}` } })).status, 400, 'the viewer refuses links to other sites');
  for (const char of SECRET) {
    const key = { key: char, code: '', kc: char.toUpperCase().charCodeAt(0) };
    assert.equal((await input({ t: 'k', k: 'keyDown', ...key, text: char })).status, 204);
    await input({ t: 'k', k: 'keyUp', ...key });
  }
  await input({ t: 'k', k: 'keyDown', key: 'Enter', code: 'Enter', kc: 13, text: '\r' });
  await input({ t: 'k', k: 'keyUp', key: 'Enter', code: 'Enter', kc: 13 });
  let login;
  // A check navigates the tab, so give the submitted form time to land first.
  for (let attempt = 0; attempt < 20 && login?.state !== 'signed_in'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 300));
    login = await agent.handle('POST', '/check', { platform: 'fixture' });
  }
  assert.equal(login.state, 'signed_in');
  assert.ok(login.checkedAt > 0, 'login state carries the time it was observed');
  assert.ok(!logs.join('\n').includes(SECRET), 'typed input never reaches the log');
  await agent.handle('POST', '/view/close', {});

  const upload = await agent.saveUpload('shot.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  await assert.rejects(agent.saveUpload('tool.sh', Buffer.from('x')), /unsupported file type/);
  const draft = await agent.handle('POST', '/draft', { id: 'post-1', platform: 'fixture', destination, text, attachments: [upload.uploadId] });
  assert.deepEqual([draft.status, draft.loginState, draft.label], ['drafted', 'signed_in', '#general — Fixture']);
  await assert.rejects(agent.handle('POST', '/draft', { id: 'post-1', platform: 'fixture', destination, text: `${text}!`, attachments: [upload.uploadId] }), code('conflict'));
  await assert.rejects(agent.handle('POST', '/approve', { id: 'post-1', digest: unsigned.digest }), code('digest_mismatch'));
  await agent.handle('POST', '/approve', { id: 'post-1', digest: draft.digest });
  const sent = await agent.handle('POST', '/send', { id: 'post-1' });
  assert.equal(sent.status, 'sent', JSON.stringify(sent.detail));
  assert.equal(sent.detail.attachments, 1);
  assert.ok(existsSync(sent.detail.evidence.before) && existsSync(sent.detail.evidence.after));
  assert.deepEqual(site.sent, [{ text, attachments: 1, silent: false }], 'exact text, once, replacing the stale draft');
  await assert.rejects(agent.handle('POST', '/send', { id: 'post-1' }), code('not_sendable'));
  assert.equal(site.sent.length, 1);

  // Submitted but no proof it appeared: reported as unknown and never retried.
  const quiet = await agent.handle('POST', '/draft', { id: 'post-2', platform: 'fixture', destination: `${destination}?mode=silent`, text: 'second post' });
  await agent.handle('POST', '/approve', { id: 'post-2', digest: quiet.digest });
  const outcome = await agent.handle('POST', '/send', { id: 'post-2' });
  assert.deepEqual([outcome.status, outcome.detail.submitted, outcome.detail.reason], ['unknown', true, 'no_proof_of_delivery']);
  await assert.rejects(agent.handle('POST', '/send', { id: 'post-2' }), code('not_sendable'));
  assert.equal(site.sent.length, 2);

  const status = await agent.handle('GET', '/status');
  assert.equal(status.browser.state, 'running');
  assert.equal(status.viewer.open, false);
});
