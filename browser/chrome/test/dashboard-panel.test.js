import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { openHiveDashboard } from '../src/dashboard-panel.js'
import { NO_BOARD, boardUrl, dashboardUrl } from '../src/page-rules-core.js'
import { showDashboard } from '../src/sidepanel.js'

const DASHBOARD = 'https://hive-dashboard.your-subdomain.workers.dev/'

const src = (name) => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')

function fakeApi({ panel = 'works' } = {}) {
  const calls = []
  const api = {
    tabs: { create: async (options) => { calls.push(['tab', options.url]) } },
  }
  if (panel !== 'missing') {
    api.sidePanel = {
      open: async (options) => {
        calls.push(['panel', options.windowId])
        if (panel === 'refuses') throw new Error('No side panel in a popup window')
      },
    }
  }
  return { api, calls }
}

test("the dashboard opens in Chrome's side panel for the window the popup belongs to", async () => {
  const { api, calls } = fakeApi()
  assert.equal(await openHiveDashboard(api, 7, DASHBOARD), 'panel')
  assert.deepEqual(calls, [['panel', 7]])
})

test('with no side panel (Safari), no window id yet, or a panel that refuses, it opens in a tab', async () => {
  for (const [panel, windowId, expected] of [
    ['missing', 7, [['tab', DASHBOARD]]],
    ['works', null, [['tab', DASHBOARD]]],
    ['refuses', 3, [['panel', 3], ['tab', DASHBOARD]]],
  ]) {
    const { api, calls } = fakeApi({ panel })
    assert.equal(await openHiveDashboard(api, windowId, DASHBOARD), 'tab')
    assert.deepEqual(calls, expected)
  }
})

test('with no board from Hive yet there is no dashboard to open, and nothing is opened', async () => {
  const { api, calls } = fakeApi()
  assert.equal(await openHiveDashboard(api, 7, ''), 'none')
  assert.deepEqual(calls, [])
})

test("the addresses are the ones Hive on the Mac handed over, never built in: the dashboard sits beside the board", () => {
  const board = { url: 'https://hive-tasks.your-subdomain.workers.dev/', key: 'ext.chrome.x' }
  assert.equal(boardUrl(board), 'https://hive-tasks.your-subdomain.workers.dev')
  assert.equal(dashboardUrl(board), DASHBOARD)
  for (const bad of [null, {}, { url: '' }, { url: 'http://hive-tasks.your-subdomain.workers.dev' }, { url: 'not a url' }]) {
    assert.equal(boardUrl(bad), '', JSON.stringify(bad))
    assert.equal(dashboardUrl(bad), '')
  }
  assert.equal(dashboardUrl({ url: 'https://board.example.com' }), '', 'a board not named hive-tasks has no known dashboard')
  for (const name of ['manifest.json', 'sidepanel.html', 'page-rules-core.js', 'dashboard-panel.js', 'cloud-peer.js', 'ask-hive.js', 'page-rules.js']) {
    assert.doesNotMatch(src(name), /your-subdomain|workers\.dev\/v1|hive-(tasks|dashboard)\.[a-z0-9-]+\.workers\.dev/, `${name} names no cloud of its own`)
  }
})

test("the side panel frames the dashboard beside the board, or says Hive hasn't connected this browser yet", async () => {
  const page = () => {
    const frame = { src: '', hidden: false }
    const note = { textContent: '', hidden: true }
    return { frame, note, doc: { querySelector: () => frame, getElementById: () => note } }
  }
  const a = page()
  assert.equal(await showDashboard(a.doc, async () => ({ url: 'https://hive-tasks.your-subdomain.workers.dev', key: 'k' })), 'framed')
  assert.equal(a.frame.src, DASHBOARD)
  const b = page()
  assert.equal(await showDashboard(b.doc, async () => null), 'none')
  assert.equal(b.frame.hidden, true)
  assert.equal(b.note.hidden, false)
  assert.equal(b.note.textContent, `${NO_BOARD}.`)
  const manifest = JSON.parse(src('manifest.json'))
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html')
  assert.ok(manifest.permissions.includes('sidePanel'))
  assert.ok(manifest.host_permissions.includes('https://*.workers.dev/*'), "any account's Hive Workers, so the dashboard's sign-in rides in the frame")
  assert.match(src('sidepanel.html'), /<script src="sidepanel\.js"><\/script>/)
  assert.match(src('popup.js'), /openHiveDashboard\(api, currentWindowId, currentDashboard\)/)
})
