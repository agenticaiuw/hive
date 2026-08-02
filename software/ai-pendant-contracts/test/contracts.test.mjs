import assert from 'node:assert/strict'
import test from 'node:test'

import {
  accountScopedStateKey,
  assertDeviceAgentReport,
  assertProductSnapshot,
} from '../src/index.js'

const now = '2026-08-02T20:00:00.000Z'

test('accepts a cloud product snapshot with stable account and device IDs', () => {
  const snapshot = {
    schemaVersion: 'product-snapshot.v1',
    accountId: 'acct_evan',
    revision: 12,
    generatedAt: now,
    devices: [
      {
        deviceId: 'dev_home_mac',
        kind: 'mac',
        name: 'Home Mac',
        status: 'online',
        lastSeenAt: now,
        capabilitiesRevision: 7,
      },
    ],
    sessions: [
      {
        sessionId: 'sess_01',
        title: 'Open Finder',
        createdAt: now,
        updatedAt: now,
        turnCount: 2,
      },
    ],
    runs: [
      {
        runId: 'run_01',
        sessionId: 'sess_01',
        sourceDeviceId: 'dev_pendant',
        status: 'completed',
        command: 'Open Finder',
        createdAt: now,
        updatedAt: now,
      },
    ],
    memory: {
      revision: 4,
      updatedAt: now,
    },
  }

  assert.equal(assertProductSnapshot(snapshot), snapshot)
  assert.equal(accountScopedStateKey(snapshot.accountId, 'dashboard'), 'acct_evan:dashboard')
})

test('accepts a local agent capability and permission report', () => {
  const report = {
    schemaVersion: 'device-agent-report.v1',
    accountId: 'acct_evan',
    deviceId: 'dev_home_mac',
    agentId: 'agent_mac_01',
    sequence: 8,
    generatedAt: now,
    expiresAt: '2026-08-02T20:01:00.000Z',
    device: {
      kind: 'mac',
      name: 'Home Mac',
      platform: 'macOS',
    },
    agent: {
      name: 'AI Pendant Agent',
      version: '0.5.0',
    },
    status: 'degraded',
    capabilities: [
      {
        capabilityId: 'mac.accessibility',
        availability: 'unavailable',
        permission: 'denied',
        scope: 'agent',
        detail: 'Grant Accessibility to the installed agent app.',
        checkedAt: now,
      },
      {
        capabilityId: 'browser.control',
        availability: 'available',
        permission: 'granted',
        scope: 'browser',
        checkedAt: now,
      },
    ],
    diagnostics: {
      logAccess: 'local_only',
      healthEndpoint: 'http://127.0.0.1:8000/health',
    },
  }

  assert.equal(assertDeviceAgentReport(report), report)
})

test('rejects duplicate capabilities and unscoped snapshots', () => {
  const capability = {
    capabilityId: 'mac.accessibility',
    availability: 'available',
    permission: 'granted',
    scope: 'agent',
  }

  assert.throws(
    () =>
      assertDeviceAgentReport({
        schemaVersion: 'device-agent-report.v1',
        accountId: 'acct_evan',
        deviceId: 'dev_home_mac',
        agentId: 'agent_mac_01',
        sequence: 1,
        generatedAt: now,
        expiresAt: '2026-08-02T20:01:00.000Z',
        device: { kind: 'mac', name: 'Home Mac' },
        status: 'online',
        capabilities: [capability, capability],
      }),
    /duplicate capabilityId/,
  )

  assert.throws(
    () =>
      assertProductSnapshot({
        schemaVersion: 'product-snapshot.v1',
        revision: 1,
        generatedAt: now,
        devices: [],
        sessions: [],
        runs: [],
      }),
    /accountId/,
  )
})
