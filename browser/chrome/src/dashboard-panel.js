/*
 * Hive's one dashboard in the browser: the same page as the website, the iPhone app and Hive's
 * window on the Mac (every machine's tasks, folders, agents and the composer that sends to Hive).
 * Chrome shows it in its side panel, beside the page you're on (sidepanel.html frames it; the
 * extension's host permission for the dashboard is what lets its sign-in cookie ride in that
 * frame). Safari has no side panel, so there it opens in a tab.
 */
/*
 * Its address isn't built in: it's the one beside the board Hive on this Mac connected this browser
 * to (page-rules-core.js dashboardUrl), so a build carries nobody's cloud.
 */

/**
 * Opens the dashboard at `url`: the side panel where the browser has one, else (or if the panel
 * won't open, as in the standalone console's popup window) a tab. Call it straight from the click,
 * with the window id and address read beforehand: sidePanel.open needs the user's gesture, which an
 * await before it would lose. Resolves to 'panel', 'tab', or 'none' while there's no address yet.
 */
export function openHiveDashboard(api, windowId, url) {
  if (!url) return Promise.resolve('none')
  const inTab = () => Promise.resolve(api.tabs.create({ url })).then(() => 'tab')
  if (typeof api.sidePanel?.open !== 'function' || windowId == null) return inTab()
  return Promise.resolve(api.sidePanel.open({ windowId })).then(() => 'panel', inTab)
}
