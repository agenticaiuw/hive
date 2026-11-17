/*
 * The extension's background: it keeps this browser reachable by Hive's agents through the cloud.
 * cloud-peer.js asks the cloud board for the next command for this browser and runs it with
 * executor.js; it needs only the board key, which Hive on this Mac hands over (cloud-peer.js
 * boardKey). An alarm wakes it every half minute, so a browser whose worker was put to sleep comes
 * back by itself, and a new board key starts it at once.
 */
import { runCloudPeer } from './cloud-peer.js'
import { executeCommand, getConfig, refreshBadge } from './executor.js'
import { BOARD_KEY } from './page-rules-core.js'

const api = globalThis.browser ?? globalThis.chrome
const WAKE_ALARM = 'hive-wake'

let activeCloudPeer = null

function startCloudPeer() {
  if (activeCloudPeer) return activeCloudPeer
  activeCloudPeer = runCloudPeer({
    executeCommand,
    getConfig,
    /* The badge says ON while Hive reaches this browser through the cloud. */
    onStatus: () => refreshBadge().catch(() => {}),
  })
    .catch((error) => console.warn(`cloud peer stopped: ${error?.message || error}`))
    .finally(() => {
      activeCloudPeer = null
    })
  return activeCloudPeer
}

async function wake() {
  await api.alarms.create(WAKE_ALARM, { periodInMinutes: 0.5 })
  void startCloudPeer()
}

api.runtime.onInstalled.addListener(() => void wake())
api.runtime.onStartup.addListener(() => void wake())
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WAKE_ALARM) void startCloudPeer()
})
api.storage.onChanged.addListener((changes, areaName) => {
  /* The popup just got the board key (from Hive, or set by hand): start listening to the cloud now. */
  if (areaName === 'local' && changes[BOARD_KEY]?.newValue) void startCloudPeer()
})

/* Evaluated on every worker start, not just install or browser start. */
void startCloudPeer()
