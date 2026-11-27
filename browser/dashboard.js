const desktop = 'http://127.0.0.1:8791/';

async function healthy(root) {
  try {
    const r = await fetch(new URL('health', root), {
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(1800),
    });
    return r.ok && (await r.json()).ok === true;
  } catch { return false; }
}

// Runs in a dashboard tab so Safari can use its first-party dashboard session. The
// desktop app can be paired to a different Hive. Check for this browser's live ID.
async function desktopMatches(id, origin) {
  if (location.origin !== origin) return false;
  for (let i = 0; i < 5; i++) {
    const r = await fetch('/api/state?view=dashboard', { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const { now, nodes } = await r.json();
      return nodes.some(n => n.kind === 'browser' && n.id === id && Math.abs(now - n.seen) < 90_000);
    }
    if (r.status !== 401) break;
    await new Promise(resolve => setTimeout(resolve, 250)); // dashboard may still be signing itself in
  }
  return false;
}

async function dashboardTab(root) {
  // Extension match patterns can't express the desktop helper's explicit port.
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.find(tab => {
    if (!tab.url) return false;
    const url = new URL(tab.url);
    return url.origin + url.pathname === root;
  });
}

export async function openDashboard(c) {
  const root = new URL('/', c.server).href;
  if (await healthy(root)) {
    const tab = await dashboardTab(root);
    return tab ? chrome.tabs.update(tab.id, { active: true }) : chrome.tabs.create({ url: root });
  }
  if (await healthy(desktop)) {
    const existing = await dashboardTab(desktop);
    const tab = existing || await chrome.tabs.create({ url: desktop, active: false });
    let keep = false;
    try {
      for (let i = 0; i < 30 && (await chrome.tabs.get(tab.id)).status !== 'complete'; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const [check] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: desktopMatches, args: [c.id, new URL(desktop).origin] });
      if (check?.result) {
        await chrome.tabs.update(tab.id, { active: true });
        keep = true;
        return;
      }
    } finally {
      if (!existing && !keep) await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  throw new Error('To open this dashboard, connect this computer to the same Tailscale network or open its paired Hive desktop app.');
}
