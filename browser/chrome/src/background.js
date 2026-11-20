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
import { newCodeWatcher, noteLoadedCode } from './version.js'

const api = globalThis.browser ?? globalThis.chrome
const WAKE_ALARM = 'hive-wake'

let activeCloudPeer = null
/* Commands running now: new code on disk waits for them (version.js). */
let running = 0
const checkForNewCode = newCodeWatcher({ busy: () => running > 0 })

/* The config (which tab a command acts in) comes from cloud-peer.js with the command: pass it on. */
async function runCommand(command, config) {
  running += 1
  try {
    return await executeCommand(command, config)
  } finally {
    running -= 1
  }
}

function startCloudPeer() {
  if (activeCloudPeer) return activeCloudPeer
  activeCloudPeer = runCloudPeer({
    executeCommand: runCommand,
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

/* Installed, reloaded or the browser started: this is the code now loaded (version.js). */
api.runtime.onInstalled.addListener(() => {
  void noteLoadedCode().catch(() => {})
  void wake()
})
api.runtime.onStartup.addListener(() => {
  void noteLoadedCode().catch(() => {})
  void wake()
})
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WAKE_ALARM) return
  void startCloudPeer()
  void checkForNewCode().catch(() => {})
})
api.storage.onChanged.addListener((changes, areaName) => {
  /* The popup just got the board key (from Hive, or set by hand): start listening to the cloud now. */
  if (areaName === 'local' && changes[BOARD_KEY]?.newValue) void startCloudPeer()
})

/* A frame inside a page (page-rules.js in a document viewer from another site) asks which page it's in. */
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'hive:page') return false
  sendResponse({ url: sender.tab?.url || '' })
  return false
})

/* Evaluated on every worker start, not just install or browser start. */
void startCloudPeer()
