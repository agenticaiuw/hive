export const PRODUCT_SNAPSHOT_SCHEMA: 'product-snapshot.v1'
export const DEVICE_AGENT_REPORT_SCHEMA: 'device-agent-report.v1'

export type DeviceKind =
  | 'pendant'
  | 'mac'
  | 'ios'
  | 'browser_extension'
  | 'web'

export type DeviceStatus = 'online' | 'degraded' | 'offline' | 'unknown'

export type CapabilityAvailability =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'unknown'

export type PermissionState =
  | 'granted'
  | 'denied'
  | 'prompt'
  | 'not_applicable'
  | 'unknown'

export type CapabilityScope = 'device' | 'agent' | 'browser' | 'app'

export type RunStatus =
  | 'queued'
  | 'processing'
  | 'waiting_for_device'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface CapabilitySnapshot {
  capabilityId: string
  availability: CapabilityAvailability
  permission: PermissionState
  scope: CapabilityScope
  detail?: string
  checkedAt?: string
}

export interface DeviceAgentReportV1 {
  schemaVersion: 'device-agent-report.v1'
  accountId: string
  deviceId: string
  agentId: string
  sequence: number
  generatedAt: string
  expiresAt: string
  device: {
    kind: DeviceKind
    name: string
    platform?: string
    osVersion?: string
  }
  agent?: {
    name?: string
    version?: string
    build?: string
  }
  status: DeviceStatus
  capabilities: CapabilitySnapshot[]
  diagnostics?: {
    logAccess?: 'local_only' | 'redacted_cloud' | 'unavailable'
    healthEndpoint?: string
    logHint?: string
  }
}

export interface DeviceSummary {
  deviceId: string
  kind: DeviceKind
  name: string
  status: DeviceStatus
  lastSeenAt: string
  capabilitiesRevision?: number
}

export interface SessionSummary {
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
  lastTurnAt?: string
  turnCount: number
}

export interface RunSummary {
  runId: string
  sessionId?: string | null
  sourceDeviceId: string
  status: RunStatus
  command?: string
  createdAt: string
  updatedAt: string
}

export interface ProductSnapshotV1 {
  schemaVersion: 'product-snapshot.v1'
  accountId: string
  revision: number
  generatedAt: string
  devices: DeviceSummary[]
  sessions: SessionSummary[]
  runs: RunSummary[]
  memory?: {
    revision: number
    updatedAt?: string | null
  }
}

export const DEVICE_KINDS: readonly DeviceKind[]
export const DEVICE_STATUSES: readonly DeviceStatus[]
export const CAPABILITY_AVAILABILITY: readonly CapabilityAvailability[]
export const PERMISSION_STATES: readonly PermissionState[]
export const CAPABILITY_SCOPES: readonly CapabilityScope[]
export const RUN_STATUSES: readonly RunStatus[]

export function accountScopedStateKey(
  accountId: string,
  resource: string,
): string

export function assertProductSnapshot<T extends ProductSnapshotV1>(value: T): T

export function assertDeviceAgentReport<T extends DeviceAgentReportV1>(
  value: T,
): T
