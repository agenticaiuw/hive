// The toolbar popup: connect this browser to Hive, ask Hive from any page (the request goes to the orchestrator with the
// page as context) and follow what it's doing, and see the owner's rules for this site.
import { api, conf, tailnet } from './hive.js';

import { openDashboard } from './dashboard.js';

const $ = (id) => document.getElementById(id);

async function show() {
  const c = await conf();
  $('main').hidden = !c;
  if (!c) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let site = '';
  try { site = /^https?:$/.test(new URL(tab.url).protocol) ? new URL(tab.url).hostname : ''; } catch {}
  $('ask').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('text').value.trim();
    if (!text) return;
    $('reply').textContent = 'Sending…';
    try {
      const context = { browser: c.id, ...(site ? { site, url: tab.url, title: tab.title } : {}) };
      const r = await api(c, '/api/requests?wait=1', { text, node: `${c.name} (browser)`, context });
      $('reply').textContent = r.reply || 'Hive has it.';
      $('text').value = '';
      await chrome.storage.local.set({ last: (r.tasks || []).map((t) => t.id) });
      work(c);
    } catch (err) {
      $('reply').textContent = err.message;
    }
  };
  work(c);
  setInterval(() => work(c), 3000);
  $('text').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('ask').requestSubmit(); };
  if (site) {
    // Only this site's own rules: the owner's general rules apply everywhere and aren't about this page.
    const rules = (await api(c, `/api/rules?site=${encodeURIComponent(site)}`).catch(() => [])).filter((r) => r.scope?.startsWith('site:'));
    $('site').textContent = site;
    $('rules').replaceChildren(...rules.map((r) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      const button = document.createElement('button');
      label.textContent = r.text;
      button.textContent = 'Delete';
      button.setAttribute('aria-label', `Delete rule: ${r.text}`);
      button.onclick = async () => {
        button.disabled = true;
        $('rulesNote').textContent = '';
        try {
          await api(c, `/api/rules/${r.id}`, undefined, 'DELETE');
          item.remove();
          $('rulesBox').hidden = !$('rules').children.length;
        } catch (err) {
          $('rulesNote').textContent = err.message;
          button.disabled = false;
        }
      };
      item.append(label, button);
      return item;
    }));
    $('rulesBox').hidden = !rules.length;
  }
}

// The tasks the last thing sent from here went to, each with its status, its agent's first line (what it will do and about
// how long it will take) and what it said last.
async function work(c) {
  const { last = [] } = await chrome.storage.local.get('last');
  const tasks = (await Promise.all(last.map((id) => api(c, `/api/tasks/${id}`).catch(() => null)))).filter(Boolean);
  $('work').replaceChildren(...tasks.map(({ task, log }) => {
    const said = log.filter((l) => l.who === 'agent' || l.who === 'needs you');
    const lines = [...new Set([said[0]?.text, said.at(-1)?.text])].filter(Boolean).map((t) => t.slice(0, 240));
    return Object.assign(document.createElement('li'), { textContent: `#${task.id} ${task.title} (${task.status})${lines.length ? `: ${lines.join(' … ')}` : ''}` });
  }));
  $('workBox').hidden = !tasks.length;
}

// Keep reconnection available when the saved server has moved. The worker finishes pairing if the sign-in tab closes the popup.
let signIn = false;
let session = 'checking';
let probing = false;
async function checkSession() {
  if (probing) return;
  probing = true;
  let timer;
  try {
    const c = await conf();
    if (!c) return;
    const request = tailnet.fetch(`${c.server}/api/me`, {
      headers: { authorization: `Bearer ${c.token}` }, timeout: 5000,
    });
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), 7000); });
    const response = await Promise.race([request, deadline]);
    session = response?.status === 200 && JSON.parse(response.body).ok === true ? 'connected' : 'offline';
  } catch { session = 'offline'; }
  finally { clearTimeout(timer); probing = false; await tailscale(); }
}
async function tailscale() {
  const { hive, tailnet: t, joining, pairNote, serverChoices = [] } = await chrome.storage.local.get(['hive', 'tailnet', 'joining', 'pairNote', 'serverChoices']);
  const url = t?.state !== 'Running' && t?.url;
  const connected = hive && session === 'connected';
  const login = $('loginLink');
  login.hidden = !joining || !url || connected;
  if (!login.hidden) login.href = url;
  $('discover').hidden = !hive || session !== 'offline' || !pairNote;
  $('join').textContent = joining ? 'Retry connection' : t?.state === 'Running' && hive ? 'Reconnect to Hive' : 'Sign in with Tailscale';
  $('join').hidden = !!hive && (connected || session === 'checking');
  $('server').textContent = !hive ? 'Connect this browser to your Hive Server.' : connected ? `Connected to ${hive.server}` :
    session === 'checking' ? `Checking connection to ${hive.server}…` : `Saved server: ${hive.server}`;
  $('footer').hidden = !hive;
  if (hive) $('dashboard').href = new URL('/', hive.server).href;
  if (signIn && url) { signIn = false; chrome.tabs.create({ url }).catch(() => { $('pairNote').textContent = 'Continue sign-in using the link below.'; }); }
  $('pairNote').textContent = connected ? '' : pairNote || (joining ? 'Connecting through Tailscale…' : '');
  $('serverChoices').replaceChildren(...(connected ? [] : serverChoices).map(server => {
    const button = document.createElement('button');
    button.textContent = new URL(server).hostname;
    button.onclick = () => join(server);
    return button;
  }));
}
chrome.storage.onChanged.addListener((ch) => { if (ch.hive) location.reload(); else if (ch.tailnet || ch.joining || ch.pairNote || ch.serverChoices) tailscale(); });
tailscale();

async function join(server) {
  signIn = true;
  $('pairNote').textContent = 'Connecting through Tailscale…';
  if (server === undefined) {
    const saved = (await conf())?.server;
    server = saved && /^http:\/\/[^/]+\.ts\.net$/i.test(saved) ? saved : true;
  }
  await chrome.storage.local.set({ joining: server, pairNote: '', serverChoices: [] });
  chrome.runtime.sendMessage({ hiveJoin: true }).catch(() => {});
  await tailscale();
}
$('join').onclick = () => join();
$('discover').onclick = () => join(true);
$('dashboard').onclick = async (event) => {
  event.preventDefault();
  if ($('dashboard').ariaBusy === 'true') return;
  $('dashboard').ariaBusy = 'true';
  $('dashboardNote').textContent = 'Opening dashboard…';
  try { await openDashboard(await conf()); window.close(); }
  catch (err) { $('dashboardNote').textContent = err.message; }
  finally { $('dashboard').ariaBusy = 'false'; }
};
checkSession();
setInterval(checkSession, 15000);
show();
