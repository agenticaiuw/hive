// The toolbar popup: connect this browser to Hive, ask Hive from any page (the request goes to the orchestrator with the
// page as context), and see the owner's rules for this site.
import { api, conf, pair } from './hive.js';

const $ = (id) => document.getElementById(id);

async function show() {
  const c = await conf();
  $('pair').hidden = !!c;
  $('main').hidden = !c;
  if (!c) return;
  $('dash').href = c.server;
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
    } catch (err) {
      $('reply').textContent = err.message;
    }
  };
  $('text').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('ask').requestSubmit(); };
  if (site) {
    // Only this site's own rules: the owner's general rules apply everywhere and aren't about this page.
    const rules = (await api(c, `/api/rules?site=${encodeURIComponent(site)}`).catch(() => [])).filter((r) => r.scope?.startsWith('site:'));
    $('site').textContent = site;
    $('rules').replaceChildren(...rules.map((r) => Object.assign(document.createElement('li'), { textContent: r.text })));
    $('rulesBox').hidden = !rules.length;
  }
}

$('pair').onsubmit = async (e) => {
  e.preventDefault();
  $('pairNote').textContent = 'Connecting…';
  try {
    await pair($('link').value);
    show();
  } catch (err) {
    $('pairNote').textContent = err.message;
  }
};
show();
