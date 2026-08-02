import dotenv from 'dotenv'

dotenv.config()

export const RELAY_URL = process.env.RELAY_URL || 'http://localhost:8787'
export const RELAY_API_KEY = process.env.RELAY_API_KEY || ''
export const PAIRING_CODE = process.env.PAIRING_CODE || ''
export const BRIDGE_DEVICE_ID =
  process.env.BRIDGE_DEVICE_ID || 'home-macbook-bridge'
export const LOCAL_AGENT_URL =
  process.env.LOCAL_AGENT_URL || 'http://127.0.0.1:8000'
export const AGENT_TOKEN = process.env.AGENT_TOKEN || ''
export const HEARTBEAT_INTERVAL_MS = Number(
  process.env.BRIDGE_HEARTBEAT_INTERVAL_MS || 30000,
)
export const WORK_POLL_INTERVAL_MS = Number(
  process.env.BRIDGE_WORK_POLL_INTERVAL_MS || 1000,
)
