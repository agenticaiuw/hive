import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { HIVE_DASHBOARD_URL, openHiveDashboard } from '../src/dashboard-panel.js'

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
  assert.equal(await openHiveDashboard(api, 7), 'panel')
  assert.deepEqual(calls, [['panel', 7]])
})

test('with no side panel (Safari), no window id yet, or a panel that refuses, it opens in a tab', async () => {
  for (const [panel, windowId, expected] of [
    ['missing', 7, [['tab', HIVE_DASHBOARD_URL]]],
    ['works', null, [['tab', HIVE_DASHBOARD_URL]]],
    ['refuses', 3, [['panel', 3], ['tab', HIVE_DASHBOARD_URL]]],
  ]) {
    const { api, calls } = fakeApi({ panel })
    assert.equal(await openHiveDashboard(api, windowId), 'tab')
    assert.deepEqual(calls, expected)
  }
})

test("the side panel frames the same dashboard, and the manifest lets its sign-in ride along", () => {
  const frame = /<iframe[^>]*\ssrc="([^"]+)"/.exec(src('sidepanel.html'))
  assert.equal(frame?.[1], HIVE_DASHBOARD_URL)
  const manifest = JSON.parse(src('manifest.json'))
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html')
  assert.ok(manifest.permissions.includes('sidePanel'))
  assert.ok(manifest.host_permissions.includes(`${new URL(HIVE_DASHBOARD_URL).origin}/*`))
  assert.match(src('popup.js'), /openHiveDashboard\(api, currentWindowId\)/)
})
