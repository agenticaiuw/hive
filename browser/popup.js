// The toolbar popup: connect this browser to Hive, ask Hive from any page (the request goes to the orchestrator with the
// page as context) and follow what it's doing, and see the owner's rules for this site.
import { api, conf, onTailnet, pair } from './hive.js';

const $ = (id) => document.getElementById(id);

async function show() {
  const c = await conf();
  $('pair').hidden = !!c;
  $('main').hidden = !c;
  if (!c) return;
  $('dash').href = `${c.server}/#key=${encodeURIComponent(c.token)}`; // signs that tab in by itself, as the Mac app's window does
  $('dash').hidden = onTailnet(c.server); // the browser's own tabs aren't on the tailnet, only the extension is
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

// This browser's Tailscale. Unpaired, "Sign in with Tailscale" asks the worker to join the owner's Hive Server through it,
// and opens Tailscale's sign-in page as soon as there is one (the worker carries on once the popup closes for it). Paired,
// it's the button to sign in again when Tailscale asks.
let signIn = false;
async function tailscale() {
  const { hive, tailnet: t, pairing, joining, pairNote } = await chrome.storage.local.get(['hive', 'tailnet', 'pairing', 'joining', 'pairNote']);
  const url = t?.state !== 'Running' && t?.url;
  $('ts').hidden = !hive || !url;
  $('tsLogin').onclick = () => chrome.tabs.create({ url });
  if (signIn && url) { signIn = false; chrome.tabs.create({ url }); }
  if (pairNote || pairing || joining) $('pairNote').textContent = pairNote || (url ? 'Sign in to Tailscale in the tab that opened, then this browser connects by itself.' : 'Connecting through Tailscale…');
}
chrome.storage.onChanged.addListener((ch) => { tailscale(); if (ch.hive?.newValue) show(); });
tailscale();

$('join').onclick = async () => {
  signIn = true;
  await chrome.storage.local.set({ joining: true, pairNote: '' });
  tailscale();
};
$('linkForm').onsubmit = async (e) => {
  e.preventDefault();
  $('pairNote').textContent = 'Connecting…';
  const link = $('link').value.trim();
  if (onTailnet(link)) { signIn = true; return chrome.storage.local.set({ pairing: link, pairNote: '' }); }
  try {
    await pair(link);
    show();
  } catch (err) {
    $('pairNote').textContent = err.message;
  }
};
show();
