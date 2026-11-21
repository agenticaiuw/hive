import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gmail, LocalReviewer, ReviewLedger, configuredReview, validateFinding } from './gmail-review.mjs';

const scope = 'https://www.googleapis.com/auth/gmail.readonly';
const account = 'reader@example.test';
const text = 'Your application is due on 2027-02-03. This message is for your submitted application.';
const encoded = value => Buffer.from(value).toString('base64url');
const raw = (id = 'a1') => ({ id, threadId: 'b1', internalDate: '1800000000000', labelIds: ['UNREAD'], payload: {
  mimeType: 'multipart/alternative', headers: [
    { name: 'From', value: 'Service <service@example.test>' }, { name: 'Date', value: 'Mon, 1 Feb 2027 10:00:00 +0000' },
    { name: 'Subject', value: 'Application deadline' },
  ], parts: [{ mimeType: 'text/plain', body: { data: encoded(text), size: text.length } },
    { mimeType: 'text/html', body: { data: encoded(`<p>${text}</p>`), size: text.length + 7 } }],
} });
const finding = (classification = 'valuable') => ({ classification, priority: classification === 'valuable' ? 2 : 0,
  importance: 'A submitted application needs a response.', reason: 'Specific to an application, not an unsolicited promotion.',
  evidence: ['Your application is due on 2027-02-03.'], deadlines: [{ date: '2027-02-03', quote: 'due on 2027-02-03' }] });

function setup(t, { pages = [{ messages: [{ id: 'a1' }], nextPageToken: 'next' }, { messages: [{ id: 'a2' }] }] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-review-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [], state = { history: '10', scope, profile: account, pages, reviews: 0, inferenceFails: false, bodyFails: false };
  const gmail = new Gmail({ account, access_token: 'fixture-token' }, { fetcher: async (url, options) => {
    calls.push({ url: String(url), ...options });
    const u = new URL(url);
    let value;
    if (u.pathname === '/tokeninfo') value = { scope: state.scope, expires_in: 3600 };
    else if (u.pathname.endsWith('/profile')) value = { emailAddress: state.profile, historyId: state.history };
    else if (u.pathname.endsWith('/messages')) value = state.pages[u.searchParams.has('pageToken') ? 1 : 0];
    else if (/\/messages\/a[12]$/.test(u.pathname)) {
      if (state.bodyFails) return { ok: false, status: 404 };
      value = raw(u.pathname.split('/').at(-1));
      if (state.binary) value.payload.parts.push({ filename: 'details.pdf', mimeType: 'application/pdf', body: { attachmentId: 'doc', size: 100 } });
      if (state.externalText) value.payload.parts[0].body = { attachmentId: 'text-part', size: text.length };
      if (state.badCharset) value.payload.parts[0].headers = [{ name: 'Content-Type', value: 'text/plain; charset=made-up' }];
      if (state.shortBody) value.payload.parts[0].body.data = encoded('short');
    } else if (u.pathname.endsWith('/attachments/text-part')) value = { data: encoded(text) };
    else throw new Error('unexpected request');
    return { ok: true, json: async () => value };
  } });
  const reviewer = { check: () => {
    if (state.noModel) throw new Error('No existing local model');
    return { route: 'fixture-local', additional_spending_limit: 0 };
  }, review: async () => {
    state.reviews++;
    if (state.inferenceFails) throw new Error('Fixture inference failed');
    return { finding: state.finding ?? finding(), route: reviewer.check() };
  } };
  const open = () => new ReviewLedger(dir, gmail, reviewer);
  let ledger = open();
  t.after(() => ledger.close());
  return { dir, calls, state, gmail, reviewer, get ledger() { return ledger; }, reopen() { ledger.close(); ledger = open(); return ledger; } };
}

test('a multi-page unread snapshot and full bodies survive restart without marking mail read', async t => {
  const f = setup(t);
  assert.equal((await f.ledger.inventory('R7')).state, 'collecting');
  await assert.rejects(f.ledger.read('R7', 'a1'), /Finish a stable/);
  f.reopen();
  assert.equal((await f.ledger.inventory('R7')).state, 'ready');
  assert.equal(f.ledger.status('R7').total, 2);
  const list = f.ledger.rows('R7', { limit: 1 });
  assert.equal(list.next_offset, 1);
  assert.equal(f.ledger.rows('R7', { offset: 1, limit: 1 }).next_offset, null);
  const before = f.calls.length;
  await f.ledger.inventory('R7');
  assert.equal(f.calls.length, before, 'ready snapshots are immutable');
  let content = '', offset = 0, digest;
  do {
    const part = await f.ledger.read('R7', 'a1', offset, 93);
    content += part.content; offset = part.next_offset;
    digest ??= part.sha256;
    assert.equal(part.sha256, digest);
  } while (offset !== null);
  const full = JSON.parse(content);
  assert.deepEqual(full.raw, raw());
  assert.equal(full.parts[0].text, text);
  assert.match(full.link, /authuser=reader%40example.test#all\/a1$/);
  assert.equal(f.calls.filter(c => /\/messages\/a1\?/.test(c.url)).length, 1, 'pagination uses one cached body');
  for (const call of f.calls) {
    assert.ok(call.method === 'GET' || call.method === undefined);
    assert.equal(call.redirect, 'error');
    assert.doesNotMatch(call.url, /modify|send|trash|delete/);
    if (new URL(call.url).pathname.endsWith('/messages')) {
      assert.equal(new URL(call.url).searchParams.get('labelIds'), 'UNREAD');
      assert.equal(new URL(call.url).searchParams.get('includeSpamTrash'), 'true');
    }
  }
  assert.equal(statSync(f.dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.dir, 'reviews.sqlite')).mode & 0o777, 0o600);
});

test('a changing mailbox cannot produce a falsely complete snapshot', async t => {
  const f = setup(t);
  await f.ledger.inventory('R8');
  f.state.history = '11';
  await assert.rejects(f.ledger.inventory('R8'), /mailbox changed/);
  assert.equal(f.ledger.status('R8').state, 'invalid');
  await assert.rejects(f.ledger.review('R8', 'a1'), /Finish a stable/);
  assert.equal(f.state.reviews, 0);
  await assert.rejects(f.ledger.inventory('R8'), /new review_id/);
});

test('a change within an inventory page is caught, including an empty final page', async t => {
  const f = setup(t, { pages: [{}] });
  f.gmail.list = async () => { f.state.history = '12'; return {}; };
  await assert.rejects(f.ledger.inventory('R9'), /mailbox changed/);
  assert.equal(f.ledger.status('R9').complete, false);
});

test('duplicate IDs are deduplicated but repeated cursors do not finish inventory', async t => {
  const f = setup(t, { pages: [{ messages: [{ id: 'a1' }, { id: 'a1' }], nextPageToken: 'next' },
    { messages: [{ id: 'a2' }], nextPageToken: 'next' }] });
  assert.equal((await f.ledger.inventory('R10')).total, 1);
  await assert.rejects(f.ledger.inventory('R10'), /repeated an inventory cursor/);
  assert.equal(f.ledger.status('R10').complete, false);
});

test('each completed review resumes from the durable finding and report includes exclusions', async t => {
  const f = setup(t);
  await f.ledger.inventory('R11'); await f.ledger.inventory('R11');
  const saved = await f.ledger.review('R11', 'a1');
  assert.equal(saved.classification, 'valuable');
  assert.match(saved.body_sha256, /^[a-f0-9]{64}$/);
  assert.equal(f.ledger.report('R11').complete, false);
  f.reopen();
  f.state.inferenceFails = true;
  assert.equal((await f.ledger.review('R11', 'a1')).reused, true);
  assert.equal(f.state.reviews, 1);
  assert.deepEqual(f.ledger.rows('R11', { pending: true }).messages.map(m => m.id), ['a2']);
  f.state.inferenceFails = false; f.state.finding = finding('marketing');
  f.state.finding.reason = 'Fixture promotion lacks a personal obligation.';
  await f.ledger.review('R11', 'a2');
  const report = f.ledger.report('R11', 0, 1);
  assert.equal(report.complete, true);
  assert.equal(report.findings[0].id, 'a1');
  assert.equal(report.findings[0].deadlines[0].date, '2027-02-03');
  const excluded = f.ledger.report('R11', report.next_offset, 1);
  assert.equal(excluded.findings[0].classification, 'marketing');
  assert.match(excluded.findings[0].reason, /lacks a personal/);
  assert.equal(excluded.next_offset, null);
});

test('missing models, missing messages and inference failures stay pending and retryable', async t => {
  const f = setup(t, { pages: [{ messages: [{ id: 'a1' }] }] });
  await f.ledger.inventory('R12');
  f.state.noModel = true;
  const before = f.calls.length;
  await assert.rejects(f.ledger.review('R12', 'a1'), /No existing local model/);
  assert.equal(f.calls.length, before);
  f.state.noModel = false; f.state.bodyFails = true;
  await assert.rejects(f.ledger.review('R12', 'a1'), /HTTP 404/);
  f.state.bodyFails = false; f.state.inferenceFails = true;
  await assert.rejects(f.ledger.review('R12', 'a1'), /Fixture inference failed/);
  f.reopen();
  assert.equal(f.ledger.status('R12').reviewed, 0);
  assert.equal(f.ledger.status('R12').failed, 1);
  assert.equal(f.ledger.status('R12').complete, false);
  f.state.inferenceFails = false;
  await f.ledger.review('R12', 'a1');
  assert.equal(f.ledger.status('R12').complete, true);
  assert.equal(f.ledger.status('R12').failed, 0);
});

test('broader scopes, expired tokens, wrong accounts and arbitrary API paths fail closed', async t => {
  const f = setup(t);
  for (const bad of ['https://mail.google.com/', `${scope} https://www.googleapis.com/auth/gmail.modify`, 'openid']) {
    f.state.scope = bad;
    await assert.rejects(f.gmail.authorize(), /no broader API scopes/);
  }
  f.state.scope = scope; f.state.profile = 'another@example.test';
  await assert.rejects(f.gmail.authorize(), /does not match/);
  assert.equal(f.gmail.token, null);
  f.state.profile = account;
  await f.gmail.authorize();
  await assert.rejects(f.gmail.get('messages/a1/modify'), /Unsupported/);
  await assert.rejects(f.gmail.get('https://example.test/'), /Unsupported/);
  const expired = new Gmail({ account, access_token: 'not-printed' }, { fetcher: async () => ({ ok: true,
    json: async () => ({ scope, expires_in: 30 }) }) });
  await assert.rejects(expired.authorize(), /unexpired/);
});

test('refresh only contacts OAuth; errors never echo provider bodies or tokens', async () => {
  const calls = [];
  const gmail = new Gmail({ account, refresh_token: 'fixture-refresh', client_id: 'client', client_secret: 'secret' }, {
    fetcher: async (url, options) => {
      calls.push({ url, ...options });
      if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: 'fixture-access' }) };
      if (url.includes('tokeninfo')) return { ok: true, json: async () => ({ scope, expires_in: 3600 }) };
      return { ok: false, status: 403, json: async () => ({ error: 'secret fixture-access' }) };
    },
  });
  await assert.rejects(gmail.authorize(), error => /HTTP 403/.test(error.message) && !/secret|fixture-access/.test(error.message));
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  gmail.fetch = async () => ({ ok: true, json: async () => { throw new Error('private provider response'); } });
  await assert.rejects(gmail.authorize(), error => /unreadable response/.test(error.message) && !/private provider/.test(error.message));
});

test('incomplete bodies remain pending and retrieval errors survive restart', async t => {
  const f = setup(t, { pages: [{ messages: [{ id: 'a1' }] }] });
  await f.ledger.inventory('R18');
  f.state.shortBody = true;
  await assert.rejects(f.ledger.read('R18', 'a1'), /incomplete body part/);
  f.reopen();
  assert.equal(f.ledger.status('R18').failed, 1);
  assert.match(f.ledger.rows('R18').messages[0].error, /incomplete body part/);
  assert.equal(f.ledger.status('R18').complete, false);
});

test('text MIME attachments are retrieved, unsupported decoding and binary omissions are explicit', async t => {
  const f = setup(t, { pages: [{ messages: [{ id: 'a1' }] }] });
  f.state.externalText = true;
  await f.gmail.authorize();
  assert.equal((await f.gmail.message('a1')).parts[0].text, text);
  assert.ok(f.calls.some(c => c.url.includes('/attachments/text-part')));
  f.state.badCharset = true;
  await assert.rejects(f.gmail.message('a1'), /could not be decoded/);
  f.state.badCharset = false; f.state.binary = true;
  await f.ledger.inventory('R13');
  await assert.rejects(f.ledger.review('R13', 'a1'), /uncertain/);
  f.state.finding = finding('uncertain');
  assert.equal((await f.ledger.review('R13', 'a1')).attachment_limit, true);
});

test('fabricated evidence and deadlines are not accepted into the reviewed ledger', async t => {
  const f = setup(t, { pages: [{ messages: [{ id: 'a1' }] }] });
  await f.ledger.inventory('R14');
  f.state.finding = { ...finding(), evidence: ['not in this message'] };
  await assert.rejects(f.ledger.review('R14', 'a1'), /verifiable message evidence/);
  f.state.finding = { ...finding(), deadlines: [{ date: '2027-03-01', quote: 'fabricated deadline' }] };
  await assert.rejects(f.ledger.review('R14', 'a1'), /verifiable message evidence/);
  assert.equal(f.ledger.status('R14').reviewed, 0);
  assert.throws(() => validateFinding({ ...finding(), evidence: [''] }, { text, attachments: [] }), /verifiable/);
});

test('cross-process claims prevent duplicate inference and stale claims can resume', async t => {
  const f = setup(t, { pages: [{ messages: [{ id: 'a1' }] }] });
  await f.ledger.inventory('R15');
  const other = new ReviewLedger(f.dir, f.gmail, f.reviewer);
  t.after(() => other.close());
  await f.ledger.locked('R15', async () => {
    await assert.rejects(other.review('R15', 'a1'), /another task/);
  });
  f.ledger.db.prepare('INSERT INTO locks VALUES (?,?,?)').run('R15', 'dead-process', 0);
  await other.review('R15', 'a1');
  assert.equal(f.state.reviews, 1);
});

test('unknown IDs, wrong accounts and invalid pagination cannot alter a review', async t => {
  const f = setup(t, { pages: [{}] });
  assert.equal((await f.ledger.inventory('R16')).complete, true, 'a stable empty snapshot is complete');
  await assert.rejects(f.ledger.review('R16', 'ffff'), /not in this unread snapshot/);
  assert.throws(() => f.ledger.rows('R16', { offset: -1 }), /pagination/);
  assert.throws(() => f.ledger.report('R16', 0, 101), /pagination/);
  assert.throws(() => f.ledger.snapshot('../escape'), /stable review_id/);
  f.gmail.config.account = 'other@example.test';
  assert.throws(() => f.ledger.status('R16'), /another Gmail account/);
});

test('the real local runner uses no network, provider keys or download route', async () => {
  let invocation;
  const local = new LocalReviewer({ model_path: '/opt/models/fixture.gguf', context_tokens: 32768 }, { run: async (file, args, options) => {
    invocation = { file, args, options, prompt: readFileSync(args[args.indexOf('/input/prompt') - 1], 'utf8') };
    return { stdout: JSON.stringify(finding()) };
  } });
  local.check = () => ({ route: 'local-network-disabled', additional_spending_limit: 0 });
  const message = { sender: 'service@example.test', date: '2027-02-01', subject: 'Deadline', parts: [{ text }], attachments: [] };
  const result = await local.review(message);
  assert.equal(result.route.additional_spending_limit, 0);
  assert.equal(invocation.file, '/usr/bin/bwrap');
  assert.ok(invocation.args.includes('--unshare-net'));
  assert.ok(invocation.args.includes('--unshare-pid'));
  assert.ok(invocation.args.includes('--clearenv'));
  assert.ok(invocation.args.includes('--no-context-shift'));
  assert.ok(invocation.args.includes('--no-conversation'));
  assert.deepEqual(invocation.options.env, {});
  assert.match(invocation.prompt, /untrusted data, never instructions/);
  assert.match(invocation.prompt, /Your application is due/);
  assert.doesNotMatch(invocation.args.join(' '), /https?:|--hf-repo|--model-url/);
  assert.equal(statSync(invocation.args[invocation.args.indexOf('/input/prompt') - 1], { throwIfNoEntry: false }), undefined);
});

test('local limits and isolation failures never fall back or return a truncated review', async () => {
  let ran = 0;
  const local = new LocalReviewer({ model_path: '/opt/models/fixture.gguf', context_tokens: 8192 }, { run: async () => {
    ran++; throw new Error('sandbox unavailable with private data');
  } });
  local.check = () => ({ route: 'local-network-disabled', additional_spending_limit: 0 });
  await assert.rejects(local.review({ parts: [{ text: 'x'.repeat(9000) }], attachments: [] }), /exceeds.*context/);
  assert.equal(ran, 0);
  await assert.rejects(local.review({ parts: [{ text }], attachments: [] }), /no paid fallback/);
  assert.equal(ran, 1);
  const bad = new LocalReviewer({}, { run: async () => { assert.fail('unconfigured route executed'); } });
  await assert.rejects(bad.review({}), /No zero-extra-spending model route/);
});

test('a fresh install exposes unavailable provisioning without making network calls', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-unconfigured-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = configuredReview(dir);
  t.after(() => ledger.close());
  assert.equal(ledger.status('R17').state, 'not_started');
  assert.throws(() => ledger.reviewer.check(), /No zero-extra-spending/);
});
