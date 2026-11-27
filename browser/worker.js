// This browser as a Hive node: it says hello with its tools, runs the calls Hive's agents make, and applies the owner's site
// rules (their page code) on every page as it loads. It needs nothing else on the computer.
import { api, conf, joinTailnet, tailnet } from './hive.js';
import { start, storage } from './tailnet.js';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const tool = (name, description, properties, required, extra) =>
  ({ name, description, inputSchema: { type: 'object', properties, required }, ...extra });
const TAB = num('The tab id (from browser_tabs or browser_open).');
const EL = num('The element number from browser_read.');
const TOOLS = [
  tool('browser_tabs', "The open tabs in the owner's browser: id, title, address, and which are in front.", {}, []),
  tool('browser_open', 'Load an address in a new background tab, or in tab, and wait for it; returns the tab id.',
    { url: str('The address.'), tab: num('A tab to load it in; 0 for a new background tab.') }, ['url', 'tab']),
  tool('browser_read', "A tab's title, text, and its numbered links, buttons and fields (for browser_click and browser_type).", { tab: TAB }, ['tab']),
  tool('browser_click', 'Click element i of a tab.', { tab: TAB, i: EL }, ['tab', 'i']),
  tool('browser_type', 'Type into field i of a tab, replacing what it held; enter presses Enter after.',
    { tab: TAB, i: EL, text: str('What to type.'), enter: { type: 'boolean', description: 'Press Enter after.' } }, ['tab', 'i', 'text', 'enter']),
  tool('browser_js', "Run JavaScript in a tab's page and get the value of its last expression (a promise is awaited).",
    { tab: TAB, code: str('JavaScript.') }, ['tab', 'code']),
  tool('browser_screenshot', 'See an already visible tab without switching tabs. For background tabs, use browser_read or browser_js.', { tab: TAB }, ['tab'], { lock: 'screen' }),
  tool('browser_close', 'Close a tab.', { tab: TAB }, ['tab']),
];
const NOTES = "The owner's own browser, signed in to their sites: browser_* tools. Tabs you open stay in the background; close them when done.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inTab = async (tab, func, args = []) =>
  (await chrome.scripting.executeScript({ target: { tabId: tab }, func, args }))[0]?.result;

async function loaded(tab) {
  for (let t = 0; t < 120; t++) {
    const x = await chrome.tabs.get(tab);
    if (x.status === 'complete' && !x.pendingUrl) return x;
    await sleep(250);
  }
  return chrome.tabs.get(tab);
}

/** JavaScript from Hive: as a user script when the owner allows them for Hive, else in the page (which some sites' rules block). */
async function runJs(tab, code) {
  try {
    await chrome.userScripts.getScripts();
  } catch {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab }, world: 'MAIN', func: (c) => (0, eval)(c), args: [code] })
      .catch((e) => { throw new Error(`${e.message}. Turning on "Allow user scripts" for Hive in chrome://extensions lets it run here.`); });
    return r?.result;
  }
  const [r] = await chrome.userScripts.execute({ target: { tabId: tab }, js: [{ code }], world: 'USER_SCRIPT' });
  if (r?.error) throw new Error(r.error);
  return r?.result;
}

const RUN = {
  browser_tabs: async () => (await chrome.tabs.query({})).map((t) => `${t.id}${t.active ? ' (front)' : ''}: ${t.title} — ${t.url}`).join('\n'),
  browser_open: async ({ url, tab }) => {
    const t = tab ? await chrome.tabs.update(tab, { url }) : await chrome.tabs.create({ url, active: false });
    const x = await loaded(t.id);
    return `Tab ${x.id}: ${x.title}\n${x.url}`;
  },
  browser_read: ({ tab }) => inTab(tab, () => {
    const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=option],[role=treeitem],[contenteditable=""],[contenteditable=true]';
    for (const el of document.querySelectorAll('[data-hive]')) delete el.dataset.hive;
    const els = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden' || el.type === 'hidden') continue;
      el.dataset.hive = els.length + 1;
      const label = (el.innerText || (el.type === 'password' ? '' : el.value) || el.getAttribute('aria-label') || el.placeholder || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const what = el.tagName === 'A' ? ` → ${el.href.slice(0, 150)}` : el.type ? ` (${el.type})` : '';
      els.push(`[${els.length + 1}] ${el.tagName.toLowerCase()} ${JSON.stringify(label)}${what}`);
    }
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 30000);
    return `${document.title}\n${location.href}\n\n${text}\n\nElements:\n${els.join('\n')}`.slice(0, 60000);
  }),
  browser_click: ({ tab, i }) => inTab(tab, (i) => {
    const el = document.querySelector(`[data-hive="${i}"]`);
    if (!el) return `There's no element ${i} now: read the page again.`;
    el.scrollIntoView({ block: 'center' });
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    el.click();
    return 'Clicked.';
  }, [i]),
  browser_type: ({ tab, i, text, enter }) => inTab(tab, (i, text, enter) => {
    const field = 'input:not([type=hidden]),textarea,[contenteditable=""],[contenteditable=true]';
    const hit = document.querySelector(`[data-hive="${i}"]`);
    if (!hit) return `There's no element ${i} now: read the page again.`;
    const el = hit.matches(field) ? hit : hit.querySelector(field);
    if (!el) return `Element ${i} isn't a text field.`;
    const shown = () => (el.isContentEditable ? el.innerText : el.value);
    el.focus();
    // Typed the way a person types, so pages that ignore a bare value change (Google's own fields) still see it.
    if (el.isContentEditable) document.execCommand('selectAll'); else el.select();
    document.execCommand(text ? 'insertText' : 'delete', false, text);
    if (shown() !== text && !el.isContentEditable) {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (enter) {
      const key = (type) => {
        const e = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
        for (const k of ['keyCode', 'which']) Object.defineProperty(e, k, { get: () => 13 });
        el.dispatchEvent(e);
        return e;
      };
      const down = key('keydown');
      key('keyup');
      if (!down.defaultPrevented) el.form?.requestSubmit();
    }
    return `Typed. The field now shows ${JSON.stringify(shown().slice(0, 200))}.`;
  }, [i, text, !!enter]),
  browser_type_password: async ({ tab, i, site, password, credential_error }) => {
    if (credential_error) throw new Error(credential_error);
    if (typeof password !== 'string') throw new Error('No saved password was delivered.');
    return inTab(tab, (i, site, password) => {
      let expected;
      try { expected = new URL(site.includes('://') ? site : `https://${site}`).hostname.toLowerCase(); }
      catch { throw new Error('Invalid login site.'); }
      if (!['https:', 'http:'].includes(location.protocol) || location.hostname.toLowerCase() !== expected)
        throw new Error('The tab is not on the requested login site.');
      const el = document.querySelector(`[data-hive="${i}"]`);
      if (!(el instanceof HTMLInputElement) || el.type !== 'password') throw new Error('Read the page again and select a password field.');
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, password);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Filled the saved password.';
    }, [i, site, password]);
  },
  browser_js: async ({ tab, code }) => {
    const v = await runJs(tab, code);
    return v === undefined ? 'Done (no value).' : typeof v === 'string' ? v : JSON.stringify(v, null, 1);
  },
  browser_screenshot: async ({ tab }) => {
    const t = await chrome.tabs.get(tab);
    if (!t.active) throw new Error('This tab is in the background. Use browser_read or browser_js; screenshots never switch the owner’s tabs.');
    return { text: `${t.title}\n${t.url}`, images: [await chrome.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 80 })] };
  },
  browser_close: async ({ tab }) => { await chrome.tabs.remove(tab); return 'Closed.'; },
};

async function run(c, call) {
  let result;
  try {
    const f = RUN[call.tool];
    if (!f) throw new Error(`This browser has no tool called ${call.tool}.`);
    result = await f(call.args || {});
    if (typeof result !== 'object' || result === null) result = { text: String(result) };
  } catch (e) {
    result = { error: String(e?.message || e) };
  }
  await api(c, '/api/node/result', { id: call.id, result }).catch(() => {});
}

// Hello every minute and take calls; a call runs while the next is awaited, so agents work in parallel. The alarm restarts the
// loop whenever Chrome has stopped the worker.
let running = false;
async function loop() {
  if (running) return;
  running = true;
  try {
    let hello = 0;
    for (let c = await conf(); c; c = await conf()) {
      if (Date.now() - hello > 60_000) {
        await api(c, '/api/node/hello', { id: c.id, kind: 'browser', name: c.name, version: chrome.runtime.getManifest().version, notes: c.name === "Safari on iPhone" ? NOTES + " This is iPhone Safari. Use phone_open_app to open Safari if iOS has suspended the extension. Coordinate with the phone agent before native touch; both share the phone." : NOTES, tools: TOOLS });
        hello = Date.now();
      }
      const call = await api(c, `/api/node/next?id=${encodeURIComponent(c.id)}`);
      if (call) run(c, call);
    }
  } catch (e) {
    console.warn('Hive:', e.message);
  } finally {
    running = false;
  }
}
chrome.alarms.create('hive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { loop(); pending(); });
chrome.storage.onChanged.addListener((ch) => {
  if (ch.hive?.newValue) loop();
  if (ch.joining?.newValue || ch.tailnet?.newValue?.state === 'Running') pending();
});
loop();

// This browser's Tailscale, which reaches the Hive Server on its owner's tailnet (tailnet.js). Chrome's runs in offscreen.html, which keeps
// its state and status through here; Safari's runs here, in its background page, and answers the popup's requests.
if (!chrome.offscreen) {
  let node;
  tailnet.call = (op, ...args) => (node ||= start(storage)).then((n) => n[op](...args)).catch((e) => ({ error: String(e?.message || e) }));
}
chrome.runtime.onMessage.addListener((m, _, reply) => {
  if (m.hiveJoin) { pending().then(() => reply(true)); return true; }
  if (m.tailnet === 'load') { storage.load().then(reply); return true; }
  if (m.tailnet === 'save') storage.save(m.key, m.value);
  if (m.tailnet === 'status') storage.status(m.status);
  if (m.tailnet === 'call' && !chrome.offscreen) { tailnet.call(m.op, ...m.args).then(reply); return true; }
});

// Joining happens here, not in the popup, which closes when Tailscale's sign-in tab opens (the popup's "Sign in with
// Tailscale": find the owner's Hive Server on their tailnet and join it). Until this browser's Tailscale is signed in each try just fails quietly, and runs again once it is
// (and every half minute while no Hive Server is online yet).
let busy = false;
async function pending() {
  const { joining } = await chrome.storage.local.get('joining');
  if (!joining || busy) return;
  busy = true;
  try {
    await joinTailnet(typeof joining === 'string' ? joining : undefined);
    await chrome.storage.local.remove(['joining', 'pairNote', 'serverChoices']);
  } catch (e) {
    if (e.servers) {
      await chrome.storage.local.set({ serverChoices: e.servers, pairNote: e.message });
      await chrome.storage.local.remove('joining');
    } else if ((await chrome.storage.local.get('tailnet')).tailnet?.state === 'Running' || !e.again) {
      await chrome.storage.local.set({ pairNote: e.message });
      if (!e.again) await chrome.storage.local.remove('joining');
    }
  } finally {
    busy = false;
  }
}
pending();

// Site rules: their CSS goes in as each page starts, their JavaScript runs once it has loaded (and after in-page navigation).
const cache = new Map();
async function pageCode(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  const c = await conf();
  if (!c || !/^https?:$/.test(u.protocol) || u.origin === new URL(c.server).origin) return [];
  const key = `${c.server}/${u.hostname}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.code;
  const rules = await api(c, `/api/rules?site=${encodeURIComponent(u.hostname)}&node=browser`).catch(() => []);
  const code = rules.filter((r) => r.code).map((r) => { try { return JSON.parse(r.code); } catch { return {}; } });
  cache.set(key, { at: Date.now(), code });
  return code;
}
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url }) => {
  if (frameId) return;
  loop(); // Safari resumes its nonpersistent background page on navigation.
  for (const { css, js } of await pageCode(url)) {
    const redirect = js?.match(/^\/\/ hive-redirect: (\/\S*|\/) (\/\S*)$/m);
    if (redirect && new URL(url).pathname === redirect[1]) {
      await chrome.tabs.update(tabId, { url: new URL(redirect[2], url).href }).catch(() => {});
      return;
    }
    if (css) chrome.scripting.insertCSS({ target: { tabId }, css }).catch(() => {});
  }
});
const pageJs = async ({ tabId, frameId, url }) => {
  if (frameId) return;
  for (const { js } of await pageCode(url)) if (js) runJs(tabId, js).catch((e) => console.warn('Hive rule:', e.message));
};
chrome.webNavigation.onCompleted.addListener(pageJs);
chrome.webNavigation.onHistoryStateUpdated?.addListener(pageJs); // Safari has no onHistoryStateUpdated
