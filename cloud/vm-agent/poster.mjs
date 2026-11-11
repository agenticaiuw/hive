// Put one approved post into a site's composer, check it reads back exactly, submit it once,
// and look for proof that it was published.
import { normalizeText } from './sites.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function poll(check, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await check(); } catch { /* page may be navigating */ }
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

export const DEFAULT_TIMEOUTS = { arriveMs: 30_000, readbackMs: 4_000, attachMs: 45_000, proofMs: 30_000, proofWithFilesMs: 90_000 };

// Open a recipe URL and report whether the owner is signed in there.
export async function arrive(browser, recipe, url, timeoutMs = DEFAULT_TIMEOUTS.arriveMs) {
  await browser.goto(url);
  const state = await poll(async () => {
    if (await browser.call(recipe.page.loggedOut)) return 'needs_login';
    return (await browser.call(recipe.page.ready)) ? 'ready' : null;
  }, timeoutMs);
  const host = new URL(await browser.url()).hostname;
  if (!recipe.allowedHosts.includes(host)) return { state: 'wrong_site', host };
  return { state: state ?? 'not_ready', host };
}

async function clearComposer(browser, recipe) {
  await browser.clickSelector(recipe.composer);
  await browser.selectAll();
  await browser.press('Backspace');
  return poll(async () => normalizeText(await browser.call(recipe.page.readComposer) ?? 'x') === '', 2_000, 100);
}

// Returns { status: 'sent' | 'failed' | 'unknown', detail }. `failed` always means nothing was submitted.
export async function deliver(browser, recipe, post, { resolveUpload, saveEvidence = async () => null, timeouts = {} } = {}) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const notSubmitted = (reason, extra = {}) => ({ status: 'failed', detail: { reason, submitted: false, ...extra } });
  const target = recipe.parseDestination(post.destination);
  const text = normalizeText(post.text);

  const arrival = await arrive(browser, recipe, target.url, limits.arriveMs);
  if (arrival.state !== 'ready') return notSubmitted(arrival.state === 'not_ready' ? 'composer_not_found' : arrival.state, { host: arrival.host });
  if (!(await clearComposer(browser, recipe))) return notSubmitted('composer_not_clear');

  if (post.attachments.length) {
    const paths = post.attachments.map(resolveUpload);
    if (!(await browser.setFiles(recipe.fileInput, paths))) return notSubmitted('file_input_not_found');
    const attached = await poll(async () => (await browser.call(recipe.page.attachmentCount)) >= paths.length, limits.attachMs);
    if (!attached) { await browser.goto('about:blank'); return notSubmitted('attachment_not_accepted'); }
    await browser.clickSelector(recipe.composer);
  }

  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line) await browser.insertText(line);
    if (index < lines.length - 1) await browser.press(recipe.newline.key, { modifiers: recipe.newline.modifiers });
  }
  let seen = null;
  const matches = await poll(async () => { seen = normalizeText(await browser.call(recipe.page.readComposer) ?? ''); return seen === text; }, limits.readbackMs, 150);
  if (!matches) {
    await clearComposer(browser, recipe).catch(() => null);
    return notSubmitted('composer_mismatch', { expectedLength: text.length, seenLength: seen?.length ?? null });
  }
  const blocker = await browser.call(recipe.page.blocked);
  if (blocker) { await clearComposer(browser, recipe).catch(() => null); return notSubmitted('composer_blocked', { blocker }); }

  const before = await browser.call(recipe.page.messageIds);
  const evidenceBefore = await saveEvidence('before', await browser.screenshot());

  // Point of no return: one submit, never repeated.
  if (recipe.submit.key) await browser.press(recipe.submit.key);
  else await browser.clickSelector(recipe.submit.click);

  const proofMs = post.attachments.length ? limits.proofWithFilesMs : limits.proofMs;
  const proof = await poll(() => browser.call(recipe.page.sentProbe, text, before, post.attachments.length > 0), proofMs);
  const evidenceAfter = await saveEvidence('after', await browser.screenshot().catch(() => null));
  const evidence = { before: evidenceBefore, after: evidenceAfter };
  if (proof && !proof.failed) return { status: 'sent', detail: { submitted: true, ...proof, evidence, observedAt: Date.now() } };
  return { status: 'unknown', detail: { submitted: true, reason: proof?.failed ?? 'no_proof_of_delivery', evidence, observedAt: Date.now() } };
}
