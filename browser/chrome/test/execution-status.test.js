/*
 * The journal, the approval queue, and the hive record.
 *
 * The journal's one impure edge (storage) is injected, so the fake below is a
 * plain object with the storage.local get/set shape — the same
 * injected-edges discipline the brain and relay-peer tests use, with no
 * browser global mocked into place. The hive record builders are pure and
 * are held to the invariant the amendment demanded: a record, marked
 * claimed-by-this-node from creation, that can never be claimable Mac work.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APPROVAL_TTL_MS,
  BROWSER_TASK_RECORD_KIND,
  EXECUTION_STATUS_KEY,
  PENDING_APPROVALS_KEY,
  RECORD_TTL_MS,
  createExecutionJournal,
  hiveClaimRecordFor,
  hiveVerdictRecordFor,
} from '../src/execution-status.js'
import { normalizeRelayConfig, RELAY_ORIGIN_ALLOWLIST } from '../src/relay-peer.js'

/** storage.local's get/set shape over a plain map. */
function fakeStorage() {
  const data = {}
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(
        list.filter((key) => key in data).map((key) => [key, data[key]]),
      )
    },
    async set(values) {
      Object.assign(data, values)
    },
  }
}

const RELAY_CONFIG = normalizeRelayConfig({
  relayEnabled: true,
  relayUrl: RELAY_ORIGIN_ALLOWLIST[0],
  relayDeviceId: 'evan-safari-bridge',
  deviceToken: 'pdt_not_a_real_token',
})

/* ------------------------------------------------------------------ *
 * The journal.
 * ------------------------------------------------------------------ */

test('a run advances begin → steps → finish, observable from storage', async () => {
  const storage = fakeStorage()
  const journal = createExecutionJournal({ storage })

  await journal.beginRun({ runId: 'r1', command: 'check balances', route: 'local-brain' })
  await journal.recordStep('r1', { tool: 'read_page', effect: 'read', ok: true, summary: 'Read page' })
  await journal.finishRun('r1', {
    state: 'finished',
    verdict: 'recon-only',
    headline: 'Read-only run: changed nothing.',
  })

  const status = storage.data[EXECUTION_STATUS_KEY]
  assert.equal(status.runs.length, 1)
  const run = status.runs[0]
  assert.equal(run.state, 'finished')
  assert.equal(run.verdict, 'recon-only')
  assert.equal(run.steps.length, 1)
  assert.equal(run.executor, 'browser-extension')
  assert.ok(run.finishedAt)
})

test('the run list is bounded; newest first', async () => {
  const storage = fakeStorage()
  const journal = createExecutionJournal({ storage })
  for (let index = 0; index < 12; index += 1) {
    await journal.beginRun({ runId: `r${index}`, command: `c${index}` })
  }
  const runs = storage.data[EXECUTION_STATUS_KEY].runs
  assert.equal(runs.length, 8)
  assert.equal(runs[0].runId, 'r11')
})

/* ------------------------------------------------------------------ *
 * Parking: the refused step is recorded, bounded, and time-boxed.
 * ------------------------------------------------------------------ */

test('a parked step lands in storage with its reason and a deadline', async () => {
  const clock = Date.parse('2026-08-09T12:00:00.000Z')
  const storage = fakeStorage()
  const journal = createExecutionJournal({ storage, now: () => clock })

  await journal.beginRun({ runId: 'r1', command: 'cancel it' })
  const entry = await journal.parkStep('r1', {
    call: { type: 'click', params: { ref: 'e1' } },
    reason: 'commit point',
    targetName: 'Cancel recurring investment (button)',
  })

  const pending = storage.data[PENDING_APPROVALS_KEY]
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, entry.id)
  assert.equal(pending[0].state, 'pending')
  assert.equal(pending[0].call.type, 'click')
  assert.equal(pending[0].reason, 'commit point')
  /* The deadline is the freshness rule: a stale park must read as stale. */
  assert.equal(
    Date.parse(pending[0].expiresAt) - Date.parse(pending[0].requestedAt),
    APPROVAL_TTL_MS,
  )
  /* Distinct from the mesh approval surface (approvals.js uses
   * 'pendingApprovals' and 'approval:decide') — two queues, two keys, no
   * collision. */
  assert.notEqual(PENDING_APPROVALS_KEY, 'pendingApprovals')
})

/* ------------------------------------------------------------------ *
 * The hive record: visible, attributed, and structurally unclaimable.
 * ------------------------------------------------------------------ */

const RUN = {
  runId: 'run-42',
  command: 'open ibkr and cancel my recurring investments',
  origin: 'browser-extension',
  state: 'finished',
  verdict: 'parked',
  headline: 'Stopped before the irreversible step.',
  steps: [
    { tool: 'activate_tab', effect: 'act', ok: true, summary: 'Activated tab', at: 't1' },
    { tool: 'snapshot', effect: 'read', ok: true, summary: 'Snapshot: 12 elements', at: 't2' },
  ],
  startedAt: '2026-08-09T12:00:00.000Z',
  finishedAt: '2026-08-09T12:00:20.000Z',
}

test('the claim record is born claimed by this node, addressed to @relay', () => {
  const descriptor = hiveClaimRecordFor(RUN, RELAY_CONFIG)

  /* Existing endpoint, existing builder: POST /v1/node/messages via
   * relay-peer.sendRequest — no new relay surface invented here. */
  assert.equal(descriptor.method, 'POST')
  assert.equal(descriptor.path, '/v1/node/messages')
  assert.equal(descriptor.body.to, '@relay')
  assert.equal(descriptor.body.kind, BROWSER_TASK_RECORD_KIND)
  assert.equal(descriptor.body.ttlMs, RECORD_TTL_MS)

  const payload = descriptor.body.payload
  assert.equal(payload.record, 'claim')
  assert.equal(payload.claimable, false)
  assert.equal(payload.claimedBy, 'evan-safari-bridge')
  assert.equal(payload.executedBy, 'evan-safari-bridge')
  assert.equal(payload.status, 'executing')
  assert.equal(payload.taskId, 'run-42')
})

test('the verdict record carries the honest verdict and the step trace', () => {
  const descriptor = hiveVerdictRecordFor(RUN, RELAY_CONFIG)
  const payload = descriptor.body.payload
  assert.equal(payload.record, 'verdict')
  assert.equal(payload.verdict, 'parked')
  assert.equal(payload.steps.length, 2)
  assert.equal(payload.steps[0].tool, 'activate_tab')
  assert.equal(payload.claimable, false)
  assert.equal(descriptor.body.correlationId, 'run-42')
})

test('record payloads pass the secret scrub before they cross the wire', () => {
  const leaky = {
    ...RUN,
    command: 'log in — the password is hunter2 — then cancel',
    headline: 'Read the page. api_key sk-ABCDEFGHIJKLMNOPQRSTUVWX was visible.',
    steps: [{ tool: 'read_page', effect: 'read', ok: true, summary: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWX seen', at: 't' }],
  }
  const payload = hiveVerdictRecordFor(leaky, RELAY_CONFIG).body.payload
  assert.ok(!payload.command.includes('hunter2'))
  assert.ok(!payload.headline.includes('sk-ABCDEFGHIJKLMNOPQRSTUVWX'))
  assert.ok(!payload.steps[0].summary.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWX'))
})

test('why @relay: the Mac structurally cannot claim this record', () => {
  /*
   * The invariant, written down where it is depended on: the Mac's work feed
   * is store.claimNextJob behind GET /v1/bridge/work, and mesh mail is a
   * different store drained only by its addressee — cloud-relay/nodeMailbox.js
   * guards every drain with principalOwnsDevice, and only an admin principal
   * owns '@relay'. This test pins OUR half: records go to '@relay' and never
   * to a device that could treat them as work.
   */
  for (const descriptor of [
    hiveClaimRecordFor(RUN, RELAY_CONFIG),
    hiveVerdictRecordFor(RUN, RELAY_CONFIG),
  ]) {
    assert.equal(descriptor.body.to, '@relay')
    assert.notEqual(descriptor.path, '/v1/pendant/command')
    assert.ok(!descriptor.path.includes('/bridge/work'))
  }
})
