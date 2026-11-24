// The toolbar popup: connect this browser to Hive, ask Hive from any page (the request goes to the orchestrator with the
// page as context) and follow what it's doing, and see the owner's rules for this site.
import { api, conf } from './hive.js';

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
      const context = site ? { site, url: tab.url, title: tab.title } : {};
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
    $('rules').replaceChildren(...rules.map((r) => Object.assign(document.createElement('li'), { textContent: r.text })));
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
async function tailscale() {
  const { hive, tailnet: t, joining, pairNote, serverChoices = [] } = await chrome.storage.local.get(['hive', 'tailnet', 'joining', 'pairNote', 'serverChoices']);
  const url = t?.state !== 'Running' && t?.url;
  $('server').textContent = hive ? `Saved server: ${hive.server}` : 'Connect this browser to your Hive Server.';
  if (signIn && url) { signIn = false; chrome.tabs.create({ url }); }
  $('pairNote').textContent = pairNote || (joining ? 'Connecting through Tailscale…' : '');
  $('serverChoices').replaceChildren(...serverChoices.map(server => {
    const button = document.createElement('button');
    button.textContent = new URL(server).hostname;
    button.onclick = () => join(server);
    return button;
  }));
}
chrome.storage.onChanged.addListener((ch) => { if (ch.hive?.newValue) location.reload(); else tailscale(); });
tailscale();

async function join(server = true) {
  signIn = true;
  await chrome.storage.local.set({ joining: server, pairNote: '', serverChoices: [] });
  await tailscale();
}
$('join').onclick = () => join();
show();
