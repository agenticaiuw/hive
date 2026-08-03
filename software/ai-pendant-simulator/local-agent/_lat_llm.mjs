import dotenv from 'dotenv'
dotenv.config({ path: '/Users/you/agentic-gadget/software/ai-pendant-simulator/.env', quiet: true })
import { getMachineContext, formatMachineContextForPrompt } from './machineContext.js'

const t0 = Date.now()
const machine = await getMachineContext()
const machinePrompt = formatMachineContextForPrompt(machine)
console.log(`machineContext(cold) ${Date.now() - t0}ms  promptChars=${machinePrompt.length}`)
const t1 = Date.now()
await getMachineContext()
console.log(`machineContext(warm) ${Date.now() - t1}ms`)

// Approximate the real system prompt size
const { readFileSync } = await import('node:fs')
const src = readFileSync('./llmPlanner.js', 'utf8')
const schemaChars = src.slice(src.indexOf('const FULL_CONTROL_ACTION_SCHEMA'), src.indexOf('const SAFE_ACTION_SCHEMA')).length
console.log(`action schema source chars ~${schemaChars}`)

const KEY = process.env.LLM_API_KEY
const BASE = process.env.LLM_API_BASE_URL
const MODEL = process.env.LLM_MODEL

async function timeCall(label, body) {
  const t = Date.now()
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  })
  const p = await r.json().catch(() => ({}))
  const dt = Date.now() - t
  const usage = p.usage || {}
  console.log(`${label} ${dt}ms status=${r.status} prompt_tok=${usage.prompt_tokens} completion_tok=${usage.completion_tokens} reasoning_tok=${usage.completion_tokens_details?.reasoning_tokens ?? '-'} out=${JSON.stringify(p.choices?.[0]?.message?.content||p.error||'').slice(0,140)}`)
  return dt
}

const sys = `You are the planning layer for a Mac computer-control agent with FULL access to the user's machine.
Return ONLY valid JSON: {"status":"ready"|"instant"|"unsupported","response":"...","actions":[{"type":"...","label":"...","params":{}}]}
${machinePrompt}`
const user = 'Current request:\nOpen Outlook.'

for (let i = 0; i < 3; i++) {
  await timeCall(`openrouter low  run${i+1}`, {
    model: MODEL, temperature: 0.1, max_tokens: 1024,
    response_format: { type: 'json_object' }, reasoning: { effort: 'low' },
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
  })
}
for (let i = 0; i < 2; i++) {
  await timeCall(`openrouter NOreason run${i+1}`, {
    model: MODEL, temperature: 0.1, max_tokens: 1024,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
  })
}
