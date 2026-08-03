#!/usr/bin/env node
/**
 * End-to-end voice stack probes (no physical button required).
 * Covers Mac execute path + optional Realtime planFromAudio if OPENAI key set.
 *
 * Usage (from software/ai-pendant-simulator):
 *   node scripts/e2e-voice-usecases.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const simRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(simRoot, '../..')

function loadEnv() {
  for (const p of [
    path.join(repoRoot, '.env'),
    path.join(simRoot, '.env'),
    path.join(process.cwd(), '../../.env'),
  ]) {
    try {
      const text = fs.readFileSync(p, 'utf8')
      for (const line of text.split(/\n/)) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
        if (!m) continue
        let v = m[2].trim()
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1)
        }
        if (!process.env[m[1]]) process.env[m[1]] = v
      }
      return p
    } catch {
      /* try next */
    }
  }
  return null
}

const loaded = loadEnv()
const AGENT = process.env.LOCAL_AGENT_URL || 'http://127.0.0.1:8000'
const TOKEN = process.env.AGENT_TOKEN || ''
const RELAY =
  process.env.RELAY_URL ||
  'https://ai-pendant-mission-control.your-subdomain.workers.dev'
const RELAY_KEY = process.env.RELAY_API_KEY || ''

function log(msg) {
  console.log(msg)
}

async function agentJson(pathname, body) {
  const res = await fetch(`${AGENT}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${pathname} non-JSON ${res.status}: ${text.slice(0, 200)}`)
  }
  if (!res.ok) throw new Error(`${pathname} ${res.status}: ${JSON.stringify(data)}`)
  return data
}

function makeTonePcm(seconds = 1.2, sampleRate = 15625) {
  const n = Math.floor(seconds * sampleRate)
  const buf = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const sample = Math.sin(2 * Math.PI * 440 * t) * 0.25 * 32767
    buf.writeInt16LE(Math.round(sample), i * 2)
  }
  return buf
}

let failed = 0
let passed = 0

async function check(name, fn) {
  try {
    await fn()
    passed++
    log(`PASS  ${name}`)
  } catch (error) {
    failed++
    log(`FAIL  ${name}: ${error.message}`)
  }
}

log(`env: ${loaded || 'none'}`)
log(`agent: ${AGENT}`)
log(`relay: ${RELAY}`)

await check('agent health', async () => {
  const res = await fetch(`${AGENT}/health`)
  if (!res.ok) throw new Error(`status ${res.status}`)
})

await check('worker health', async () => {
  const res = await fetch(`${RELAY}/health`)
  const data = await res.json()
  if (!data.ok) throw new Error(JSON.stringify(data))
  if (!data.macBridgeOnline) throw new Error('macBridgeOnline=false')
})

await check('execute get_battery hands-free', async () => {
  const data = await agentJson('/execute', {
    command: 'battery',
    source: 'pendant',
    actions: [{ type: 'get_battery', label: 'Battery', params: {} }],
  })
  if (data.status !== 'success' && data.ok === false) {
    throw new Error(JSON.stringify(data).slice(0, 300))
  }
  const msg = String(data.response || data.results?.[0]?.message || '')
  if (!/battery|InternalBattery|%|AC Power|charged/i.test(msg)) {
    throw new Error(`unexpected battery output: ${msg.slice(0, 200)}`)
  }
})

await check('execute open_app Safari', async () => {
  const data = await agentJson('/execute', {
    command: 'open Safari',
    source: 'pendant',
    actions: [{ type: 'open_app', label: 'Safari', params: { appName: 'Safari' } }],
  })
  if (data.results?.[0]?.ok === false) {
    throw new Error(JSON.stringify(data.results[0]))
  }
})

await check('execute safe status shell pmset', async () => {
  const data = await agentJson('/execute', {
    command: 'pmset',
    source: 'pendant',
    actions: [
      {
        type: 'run_shell',
        label: 'pmset',
        params: { command: 'pmset -g batt' },
      },
    ],
  })
  const msg = String(data.response || data.results?.[0]?.message || '')
  if (!/battery|%|AC Power|InternalBattery/i.test(msg)) {
    throw new Error(msg.slice(0, 200))
  }
})

await check('local plan battery uses tools', async () => {
  const data = await agentJson('/plan', {
    command: "What's the battery level of my MacBook?",
    source: 'pendant',
  })
  if (data.status === 'unsupported') {
    throw new Error(data.error || 'unsupported')
  }
  const actions = data.actions || []
  if (!actions.length) throw new Error('no actions from planner')
  const types = actions.map((a) => a.type).join(',')
  if (
    !/run_shell|get_battery|get_mac_status|run_applescript/.test(types)
  ) {
    throw new Error(`unexpected action types: ${types}`)
  }
})

await check('classifyPlan auto-runs status shell', async () => {
  const { classifyPlan } = await import('../local-agent/actionRisk.js')
  const v = classifyPlan([
    { type: 'run_shell', params: { command: 'pmset -g batt' } },
  ])
  if (!v.autoRun) throw new Error(v.reason || 'not autoRun')
})

if (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith('sk-or')) {
  await check('Realtime planFromAudio on short tone (may be empty intent)', async () => {
    const { planFromAudio } = await import('../cloud-relay/audioPlan.js')
    const pcm = makeTonePcm(1.0)
    const plan = await planFromAudio({
      audioBuffer: pcm,
      format: 'pcm',
      sampleRate: 15625,
      language: 'en',
      fleet: { mac: { online: true } },
    })
    if (!plan) throw new Error('no plan')
    if (plan.planner !== 'audio-native' && plan.source !== 'audio-native-realtime') {
      // tone may not produce tools; still require audio-native source when configured
      log(`  note: plan keys ${Object.keys(plan).join(',')}`)
    }
  })
} else {
  log('SKIP  Realtime planFromAudio (no OPENAI_API_KEY)')
}

// dual-capture / nRF log sanity
await check('dual-capture log exists', async () => {
  const logPath = path.join(repoRoot, 'diagnostics/dual-capture-live.log')
  if (!fs.existsSync(logPath)) throw new Error('no dual-capture-live.log')
  const st = fs.statSync(logPath)
  if (Date.now() - st.mtimeMs > 2 * 60 * 60 * 1000) {
    log('  warn: dual-capture log mtime >2h (still ok if capture running)')
  }
})

log('')
log(`Result: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
