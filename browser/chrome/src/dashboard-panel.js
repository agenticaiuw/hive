/*
 * Hive's one dashboard in the browser: the same page as the website, the iPhone app and Hive's
 * window on the Mac (every machine's tasks, folders, agents and the composer that sends to Hive).
 * Chrome shows it in its side panel, beside the page you're on (sidepanel.html frames it; the
 * extension's host permission for the dashboard is what lets its sign-in cookie ride in that
 * frame). Safari has no side panel, so there it opens in a tab.
 */
export const HIVE_DASHBOARD_URL = 'https://hive-dashboard.your-subdomain.workers.dev/'

/**
 * Opens the dashboard: the side panel where the browser has one, else (or if the panel won't
 * open, as in the standalone console's popup window) a tab. Call it straight from the click,
 * with the window id read beforehand: sidePanel.open needs the user's gesture, which an await
 * before it would lose. Resolves to 'panel' or 'tab'.
 */
export function openHiveDashboard(api, windowId) {
  const inTab = () => Promise.resolve(api.tabs.create({ url: HIVE_DASHBOARD_URL })).then(() => 'tab')
  if (typeof api.sidePanel?.open !== 'function' || windowId == null) return inTab()
  return Promise.resolve(api.sidePanel.open({ windowId })).then(() => 'panel', inTab)
}
