import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REALTIME_TOOLS,
  mapGetMacStatusToActions,
} from '../cloud-relay/openaiRealtimeVoice.js'
import { SUPPORTED_ACTION_TYPES } from './computerControl.js'
import { isKnownActionType } from './llmPlanner.js'
import { describeActions } from './capabilityManifest.js'

/*
 * The Realtime planner runs on the relay and the executor runs on this Mac.
 * They agree on action type names by convention and nothing checked it, so the
 * relay could advertise a tool the Mac cannot dispatch and the failure would
 * only surface as a spoken "done" with nothing happening.
 *
 * These tests are the check. They read the relay's registry directly — the
 * relay is another process, so importing it here is deliberate and read-only.
 */

const dispatchable = new Set(SUPPORTED_ACTION_TYPES)

test('every action the Realtime status tool emits is dispatchable here', () => {
  const emitted = mapGetMacStatusToActions(['all']).map((action) => action.type)
  assert.ok(emitted.length > 0, 'get_mac_status expanded to nothing')

  for (const type of emitted) {
    assert.ok(
      dispatchable.has(type),
      `Realtime get_mac_status emits "${type}", which the Mac executor cannot dispatch`,
    )
  }
})

test('every action type the Realtime schema names is dispatchable here', () => {
  const schema = REALTIME_TOOLS.find((tool) => tool.name === 'mac_run_actions')
    ?.parameters?.properties?.actions?.items?.properties?.type?.description

  assert.ok(schema, 'the relay no longer describes executor action types')

  const named = schema
    .slice(schema.indexOf('Examples:') + 'Examples:'.length)
    .split(/[,.]/)
    .map((part) => part.trim())
    .filter((part) => /^[a-z][a-z0-9_]*$/.test(part))

  assert.ok(named.length >= 10, `only parsed ${named.length} example types`)

  for (const type of named) {
    assert.ok(
      dispatchable.has(type),
      `Realtime advertises "${type}", which the Mac executor cannot dispatch`,
    )
  }
})

test('an action the relay can send is not silently dropped by the local planner', () => {
  // llmPlanner.sanitizeActions removes any type isKnownActionType() rejects, so
  // a type the relay names but the planner does not know disappears without an
  // error the moment a plan is replayed locally.
  const named = mapGetMacStatusToActions(['all']).map((action) => action.type)
  for (const type of named) {
    assert.ok(
      isKnownActionType(type),
      `"${type}" is dispatchable but llmPlanner would drop it from a plan`,
    )
  }
})

test('the manifest names the registries that disagree instead of hiding them', () => {
  const { drift } = describeActions()

  // This is reported, not asserted to be empty: the drift is real today and
  // the fix lives in llmPlanner.js, which this change does not own. The
  // manifest's job is to make it visible rather than let it stay a surprise.
  assert.ok(Array.isArray(drift.dispatchableButNotPlannable))
  for (const type of drift.dispatchableButNotPlannable) {
    assert.ok(dispatchable.has(type))
    assert.equal(isKnownActionType(type), false)
  }
})

test('the relay tool list is the five the Mac side expects', () => {
  assert.deepEqual(
    REALTIME_TOOLS.map((tool) => tool.name),
    [
      'get_mac_status',
      'mac_run_actions',
      'browser_run_actions',
      'web_search',
      'mac_delegate',
    ],
  )
})
