import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  INPUT_REACHABILITY_STATES,
  annotateInputReachability,
  describeProbeHost,
  getInputReachability,
  inputPostingFromReachability,
  postsSyntheticInput,
  probeInputReachability,
  resetInputReachability,
  startInputReachabilityMonitor,
} from './inputReachability.js'
import { buildActionReceipt } from './actionReceipts.js'
import { observeHost } from './executionJournal.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function appBundleFixture(bundleId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reachability-'))
  const bundle = path.join(root, 'Probe Host.app')
  fs.mkdirSync(path.join(bundle, 'Contents', 'Resources'), { recursive: true })
  fs.writeFileSync(
    path.join(bundle, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
</dict></plist>`,
  )
  const execPath = path.join(bundle, 'Contents', 'Resources', 'node')
  fs.writeFileSync(execPath, '')
  return { root, bundle, execPath }
}

test('the three states are exactly verified, unverified and failed', () => {
  assert.deepEqual([...INPUT_REACHABILITY_STATES], [
    'verified',
    'unverified',
    'failed',
  ])
})

test('the host recorded is the bundle whose grant is being tested', () => {
  const fixture = appBundleFixture('com.example.probehost')

  try {
    const embedded = describeProbeHost({
      execPath: fixture.execPath,
      env: { __CFBundleIdentifier: 'com.apple.Terminal' },
    })
    // Accessibility is per-binary, so the .app the executable actually lives in
    // is the subject, not whatever happened to launch the tree.
    assert.equal(embedded.bundleId, 'com.example.probehost')
    assert.equal(embedded.bundlePath, fixture.bundle)
    assert.equal(embedded.launchedBy, 'com.apple.Terminal')
    assert.equal(embedded.source, 'app-bundle Info.plist')

    // An unbundled node under a terminal has no .app of its own; the
    // responsible bundle is the terminal's, and saying so is the whole point.
    const unbundled = describeProbeHost({
      execPath: '/opt/homebrew/bin/node',
      env: { __CFBundleIdentifier: 'dev.warp.Warp' },
    })
    assert.equal(unbundled.bundleId, 'dev.warp.Warp')
    assert.equal(unbundled.bundlePath, null)
    assert.match(unbundled.source, /not in an app bundle/)

    const anonymous = describeProbeHost({ execPath: '/usr/local/bin/node', env: {} })
    assert.equal(anonymous.bundleId, null)
    assert.equal(anonymous.source, 'unknown')
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('unprobed is "unverified" and says so — never "assumed fine"', () => {
  resetInputReachability()

  const snapshot = getInputReachability()
  assert.equal(snapshot.status, 'unverified')
  assert.equal(snapshot.checkedAt, null)
  assert.match(snapshot.detail, /Not probed/)
  // The failure this entry exists to fix: reporting an assumption as a
  // measurement. An unprobed host must not feed the inputPosting contract.
  assert.equal(inputPostingFromReachability(snapshot), null)
})

test('a posted event records verified with the bundle and the timestamp', async () => {
  resetInputReachability()

  const result = await probeInputReachability({
    probeImpl: async () => ({ axTrusted: true, secureInput: false }),
    host: { bundleId: 'com.aipendant.agent', execPath: '/x/node' },
    now: () => new Date('2026-08-07T09:00:00.000Z'),
  })

  assert.equal(result.status, 'verified')
  assert.equal(result.checkedAt, '2026-08-07T09:00:00.000Z')
  assert.equal(result.host.bundleId, 'com.aipendant.agent')
  assert.match(result.detail, /com\.aipendant\.agent/)
  assert.deepEqual(getInputReachability(), result)

  assert.deepEqual(inputPostingFromReachability(result), {
    granted: true,
    secureInput: false,
    detail: `${result.detail} (probed 2026-08-07T09:00:00.000Z)`,
  })
})

test('an untrusted binary is "failed", and so is a probe that cannot run', async () => {
  resetInputReachability()

  const swallowed = await probeInputReachability({
    probeImpl: async () => ({ axTrusted: false }),
    host: { bundleId: 'com.aipendant.agent' },
  })
  assert.equal(swallowed.status, 'failed')
  assert.match(swallowed.detail, /granted to a different binary/)
  assert.equal(inputPostingFromReachability(swallowed).granted, false)

  // Posting events is the helper's whole job, so failing to run it is failing
  // to post — not "unknown". permissions.js and executionJournal.js agree.
  const broken = await probeInputReachability({
    probeImpl: async () => {
      throw new Error('helper not built')
    },
    host: { bundleId: 'com.aipendant.agent' },
  })
  assert.equal(broken.status, 'failed')
  assert.match(broken.detail, /helper not built/)
})

test('overlapping probes post one event, not two', async () => {
  resetInputReachability()

  let calls = 0
  const probeImpl = async () => {
    calls += 1
    await wait(10)
    return { axTrusted: true }
  }

  const [a, b] = await Promise.all([
    probeInputReachability({ probeImpl }),
    probeInputReachability({ probeImpl }),
  ])

  assert.equal(calls, 1)
  assert.equal(a, b)
})

test('the monitor probes at startup and again on the interval', async () => {
  resetInputReachability()

  let calls = 0
  const seen = []
  const monitor = startInputReachabilityMonitor({
    intervalMs: 15,
    probeImpl: async () => {
      calls += 1
      return { axTrusted: true }
    },
    onResult: (result) => seen.push(result.status),
  })

  try {
    await wait(80)
    assert.ok(calls >= 2, `expected a startup probe and at least one more, got ${calls}`)
    assert.ok(seen.every((status) => status === 'verified'))
  } finally {
    monitor.stop()
  }

  const startupOnly = getInputReachability()
  assert.equal(startupOnly.status, 'verified')
})

test('a disabled monitor probes nothing and leaves the status unverified', async () => {
  resetInputReachability()

  let calls = 0
  const monitor = startInputReachabilityMonitor({
    intervalMs: 0,
    probeImpl: async () => {
      calls += 1
      return { axTrusted: true }
    },
  })

  await wait(20)
  monitor.stop()

  assert.equal(monitor.enabled, false)
  assert.equal(calls, 0)
  // Off is not the same as fine. Nothing measured, nothing claimed.
  assert.equal(getInputReachability().status, 'unverified')
})

test('only steps that post events carry the annotation', () => {
  assert.equal(postsSyntheticInput('ui_click'), true)
  assert.equal(postsSyntheticInput('type_text'), true)
  assert.equal(postsSyntheticInput('mouse_drag'), true)
  // Reads of the accessibility tree do not post, so whether events post is
  // irrelevant to them and a warning there would be noise.
  assert.equal(postsSyntheticInput('ui_snapshot'), false)
  assert.equal(postsSyntheticInput('read_file'), false)

  const verified = {
    status: 'verified',
    checkedAt: '2026-08-07T09:00:00.000Z',
    host: { bundleId: 'com.aipendant.agent' },
  }
  assert.equal(annotateInputReachability('read_file', verified), null)
  assert.deepEqual(annotateInputReachability('ui_click', verified), {
    status: 'verified',
    bundleId: 'com.aipendant.agent',
    checkedAt: '2026-08-07T09:00:00.000Z',
    warning: null,
  })

  const failed = { ...verified, status: 'failed' }
  assert.match(annotateInputReachability('ui_click', failed).warning, /may have been a no-op/)

  const unverified = { status: 'unverified', checkedAt: null, host: {} }
  assert.match(
    annotateInputReachability('press_keys', unverified).warning,
    /never been probed/,
  )
})

test('receipts annotate a possible no-op without changing the verdict', () => {
  const failed = {
    status: 'failed',
    checkedAt: '2026-08-07T09:00:00.000Z',
    host: { bundleId: 'com.aipendant.agent' },
  }

  const receipt = buildActionReceipt({
    action: { type: 'ui_click', params: { title: 'Send' } },
    result: { ok: true, status: 'success', message: 'Clicked Send' },
    startedAt: '2026-08-07T09:00:00.000Z',
    finishedAt: '2026-08-07T09:00:00.200Z',
    reachability: failed,
  })

  assert.equal(receipt.inputReachability.status, 'failed')
  assert.equal(receipt.inputReachability.bundleId, 'com.aipendant.agent')
  assert.match(receipt.inputReachability.warning, /ui_click may have been a no-op/)
  // Annotation only. The step ran, the executor said success, and nothing here
  // is allowed to overturn or withhold that.
  assert.equal(receipt.ok, true)
  assert.equal(receipt.status, 'success')
  assert.equal(receipt.effect, 'write')

  const readOnly = buildActionReceipt({
    action: { type: 'read_file', params: { path: '/tmp/x' } },
    result: { ok: true, status: 'success' },
    startedAt: '2026-08-07T09:00:00.000Z',
    reachability: failed,
  })
  assert.equal(readOnly.inputReachability, null)
})

test('/observe reports the recorded measurement and honours "not probed"', async () => {
  resetInputReachability()

  const permissions = {
    hostApp: 'AI Pendant Agent',
    accessibility: { trusted: true, detail: 'Accessibility is granted' },
    screenRecording: { granted: true },
    requiredMissing: [],
  }
  const execFileImpl = async () => ({ stdout: '' })

  const unprobed = await observeHost({ roots: [], permissions, execFileImpl })
  assert.equal(unprobed.inputReachability.status, 'unverified')
  // The contract projectAccessibility depends on: absent means NOT PROBED, so
  // an unprobed host still reports eventsPost as unknown rather than as true.
  assert.equal(unprobed.accessibility.eventsPost, null)
  assert.match(unprobed.accessibility.consequence, /^Unverified:/)

  await probeInputReachability({
    probeImpl: async () => ({ axTrusted: true, secureInput: false }),
    host: { bundleId: 'com.aipendant.agent' },
    now: () => new Date('2026-08-07T09:00:00.000Z'),
  })

  const probed = await observeHost({ roots: [], permissions, execFileImpl })
  assert.equal(probed.inputReachability.status, 'verified')
  assert.equal(probed.inputReachability.host.bundleId, 'com.aipendant.agent')
  assert.equal(probed.inputReachability.checkedAt, '2026-08-07T09:00:00.000Z')
  assert.equal(probed.accessibility.eventsPost, true)
  assert.equal(probed.accessibility.uiActionsWillReachTheScreen, true)
  assert.equal(probed.accessibility.consequence, null)

  resetInputReachability()
})

test('a failed probe annotates /observe and still gates nothing', async () => {
  resetInputReachability()

  await probeInputReachability({
    probeImpl: async () => ({ axTrusted: false }),
    host: { bundleId: 'com.aipendant.agent' },
  })

  const observed = await observeHost({
    roots: [],
    permissions: {
      hostApp: 'AI Pendant Agent',
      accessibility: { trusted: true, detail: 'Accessibility is granted' },
      screenRecording: { granted: true },
      requiredMissing: [],
    },
    execFileImpl: async () => ({ stdout: '' }),
  })

  assert.equal(observed.inputReachability.status, 'failed')
  assert.equal(observed.accessibility.eventsPost, false)
  assert.match(observed.accessibility.consequence, /report success while doing nothing/)
  // /observe is a camera. Even a failed reachability leaves it read-only.
  assert.equal(observed.ok, true)
  assert.equal(observed.readOnly, true)

  resetInputReachability()
})
