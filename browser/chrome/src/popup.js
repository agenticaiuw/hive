/*
 * The toolbar popup: the ask box (ask-hive.js, the same one the dashboard and Hive's floating window
 * have), the one-time grant that lets Hive's agents act in this browser's pages (offered once Hive
 * reaches this browser through the cloud; the toolbar badge says whether it does), and Hive's
 * dashboard beside the page.
 */
import { initAskHive } from './ask-hive.js'
import { CLOUD_STATUS_KEY, boardKey, connectionBadge } from './cloud-peer.js'
import { openHiveDashboard } from './dashboard-panel.js'
import { NO_BOARD, dashboardUrl } from './page-rules-core.js'

const api = globalThis.browser ?? globalThis.chrome
const WEBSITE_ORIGINS = ['http://*/*', 'https://*/*']
const $ = (id) => document.getElementById(id)

initAskHive()

/* ===== Whether Hive reaches this browser ===== */
function renderStatus(cloud) {
  void renderGrantPages(connectionBadge(cloud).state === 'connected')
}

/* The listener goes when the popup does, so a closed popup leaves nothing behind. */
const onStorageChanged = (changes, areaName) => {
  if (areaName === 'local' && changes[CLOUD_STATUS_KEY]) renderStatus(changes[CLOUD_STATUS_KEY].newValue)
}
api.storage.onChanged.addListener(onStorageChanged)
addEventListener('pagehide', () => api.storage.onChanged.removeListener(onStorageChanged))
void api.storage.local
  .get([CLOUD_STATUS_KEY])
  .then((stored) => renderStatus(stored[CLOUD_STATUS_KEY]))
  .catch(() => renderStatus(undefined))

/* ===== Website access =====
 * permissions.request must run inside the click (a user gesture), so the popup offers it as a
 * button: shown only while Hive reaches this browser and the grant is missing. */
async function renderGrantPages(connected) {
  let granted = true
  try {
    granted = await api.permissions.contains({ origins: WEBSITE_ORIGINS })
  } catch {
    /* A browser that can't answer isn't offered a button that can't work. */
  }
  $('grant-pages').hidden = !connected || granted
}

$('grant-pages').addEventListener('click', async () => {
  let granted = false
  try {
    granted = await api.permissions.request({ origins: WEBSITE_ORIGINS })
  } catch {
    granted = false
  }
  $('grant-pages').hidden = granted
})

/* ===== Hive's dashboard =====
 * The website's dashboard in Chrome's side panel beside this page, or a tab where there is none.
 * The window id and the dashboard's address (beside the board Hive connected this browser to) are
 * read now, since sidePanel.open must run inside the click's gesture. */
let currentWindowId = null
let currentDashboard = ''
void Promise.resolve(api.windows?.getCurrent?.())
  .then((win) => {
    currentWindowId = win?.id ?? null
  })
  .catch(() => {})
void boardKey()
  .then((board) => {
    currentDashboard = dashboardUrl(board)
  })
  .catch(() => {})

$('open-dashboard').addEventListener('click', () => {
  void openHiveDashboard(api, currentWindowId, currentDashboard).then((opened) => {
    if (opened === 'none') $('open-dashboard').title = NO_BOARD
  })
})
