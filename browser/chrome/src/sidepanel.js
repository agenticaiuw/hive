/*
 * Chrome's side panel (sidepanel.html): frames Hive's dashboard, the one beside the board Hive on this
 * Mac connected this browser to (page-rules-core.js dashboardUrl). The extension carries no cloud
 * address of its own, so until Hive has connected it the panel says so instead.
 */
import { boardKey } from './cloud-peer.js'
import { NO_BOARD, dashboardUrl } from './page-rules-core.js'

/** Points the panel's frame at the dashboard, or says why it can't; what it did. */
export async function showDashboard(doc = document, findBoard = boardKey) {
  const url = dashboardUrl(await findBoard().catch(() => null))
  const frame = doc.querySelector('iframe')
  const note = doc.getElementById('no-board')
  if (url) {
    frame.src = url
    return 'framed'
  }
  frame.hidden = true
  note.textContent = `${NO_BOARD}.`
  note.hidden = false
  return 'none'
}

if (globalThis.document?.querySelector?.('iframe')) void showDashboard()
