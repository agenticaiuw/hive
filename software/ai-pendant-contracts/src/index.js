export const PRODUCT_SNAPSHOT_SCHEMA = 'product-snapshot.v1'
export const DEVICE_AGENT_REPORT_SCHEMA = 'device-agent-report.v1'

export const DEVICE_KINDS = Object.freeze([
  'pendant',
  'mac',
  'ios',
  'browser_extension',
  'web',
])

export const DEVICE_STATUSES = Object.freeze([
  'online',
  'degraded',
  'offline',
  'unknown',
])

export const CAPABILITY_AVAILABILITY = Object.freeze([
  'available',
  'degraded',
  'unavailable',
  'unknown',
])

export const PERMISSION_STATES = Object.freeze([
  'granted',
  'denied',
  'prompt',
  'not_applicable',
  'unknown',
])

export const CAPABILITY_SCOPES = Object.freeze([
  'device',
  'agent',
  'browser',
  'app',
])

export const RUN_STATUSES = Object.freeze([
  'queued',
  'processing',
  'waiting_for_device',
  'completed',
  'failed',
  'cancelled',
])

export function accountScopedStateKey(accountId, resource) {
  return `${assertId('accountId', accountId)}:${assertId('resource', resource)}`
}

export function assertProductSnapshot(value) {
  assertObject('snapshot', value)
  assertEqual('snapshot.schemaVersion', value.schemaVersion, PRODUCT_SNAPSHOT_SCHEMA)
  assertId('snapshot.accountId', value.accountId)
  assertNonNegativeInteger('snapshot.revision', value.revision)
  assertIsoDate('snapshot.generatedAt', value.generatedAt)
  assertArray('snapshot.devices', value.devices)
  assertArray('snapshot.sessions', value.sessions)
  assertArray('snapshot.runs', value.runs)

  for (const device of value.devices) {
    assertDeviceSummary(device)
  }
  for (const session of value.sessions) {
    assertSessionSummary(session)
  }
  for (const run of value.runs) {
    assertRunSummary(run)
  }

  return value
}

export function assertDeviceAgentReport(value) {
  assertObject('report', value)
  assertEqual(
    'report.schemaVersion',
    value.schemaVersion,
    DEVICE_AGENT_REPORT_SCHEMA,
  )
  assertId('report.accountId', value.accountId)
  assertId('report.deviceId', value.deviceId)
  assertId('report.agentId', value.agentId)
  assertNonNegativeInteger('report.sequence', value.sequence)
  assertIsoDate('report.generatedAt', value.generatedAt)
  assertIsoDate('report.expiresAt', value.expiresAt)
  assertObject('report.device', value.device)
  assertOneOf('report.device.kind', value.device.kind, DEVICE_KINDS)
  assertNonEmptyString('report.device.name', value.device.name)
  assertOneOf('report.status', value.status, DEVICE_STATUSES)
  assertArray('report.capabilities', value.capabilities)

  if (new Date(value.expiresAt).getTime() <= new Date(value.generatedAt).getTime()) {
    throw new TypeError('report.expiresAt must be later than report.generatedAt')
  }

  const capabilityIds = new Set()
  for (const capability of value.capabilities) {
    assertCapability(capability)
    if (capabilityIds.has(capability.capabilityId)) {
      throw new TypeError(
        `report.capabilities contains duplicate capabilityId ${capability.capabilityId}`,
      )
    }
    capabilityIds.add(capability.capabilityId)
  }

  return value
}

function assertDeviceSummary(device) {
  assertObject('device', device)
  assertId('device.deviceId', device.deviceId)
  assertOneOf('device.kind', device.kind, DEVICE_KINDS)
  assertNonEmptyString('device.name', device.name)
  assertOneOf('device.status', device.status, DEVICE_STATUSES)
  assertIsoDate('device.lastSeenAt', device.lastSeenAt)
}

function assertSessionSummary(session) {
  assertObject('session', session)
  assertId('session.sessionId', session.sessionId)
  assertNonEmptyString('session.title', session.title)
  assertIsoDate('session.createdAt', session.createdAt)
  assertIsoDate('session.updatedAt', session.updatedAt)
  assertNonNegativeInteger('session.turnCount', session.turnCount)
}

function assertRunSummary(run) {
  assertObject('run', run)
  assertId('run.runId', run.runId)
  assertId('run.sourceDeviceId', run.sourceDeviceId)
  assertOneOf('run.status', run.status, RUN_STATUSES)
  assertIsoDate('run.createdAt', run.createdAt)
  assertIsoDate('run.updatedAt', run.updatedAt)
}

function assertCapability(capability) {
  assertObject('capability', capability)
  assertId('capability.capabilityId', capability.capabilityId)
  assertOneOf(
    'capability.availability',
    capability.availability,
    CAPABILITY_AVAILABILITY,
  )
  assertOneOf('capability.permission', capability.permission, PERMISSION_STATES)
  assertOneOf('capability.scope', capability.scope, CAPABILITY_SCOPES)
}

function assertObject(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
}

function assertArray(name, value) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`)
  }
}

function assertEqual(name, value, expected) {
  if (value !== expected) {
    throw new TypeError(`${name} must equal ${expected}`)
  }
}

function assertId(name, value) {
  const text = String(value || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) {
    throw new TypeError(`${name} must be a stable identifier`)
  }
  return text
}

function assertNonEmptyString(name, value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
}

function assertNonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`)
  }
}

function assertIsoDate(name, value) {
  if (
    typeof value !== 'string' ||
    !value.includes('T') ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new TypeError(`${name} must be an ISO-8601 timestamp`)
  }
}

function assertOneOf(name, value, values) {
  if (!values.includes(value)) {
    throw new TypeError(`${name} must be one of: ${values.join(', ')}`)
  }
}
