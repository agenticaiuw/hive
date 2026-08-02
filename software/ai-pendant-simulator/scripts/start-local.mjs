import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const children = []

function run(label, command, args, delayMs = 0) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const child = spawn(command, args, {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
      })

      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[start-local] ${label} exited with code ${code}`)
        }
      })

      children.push({ label, child })
      resolve(child)
    }, delayMs)
  })
}

console.log('[start-local] Starting relay, agent, bridge, and web UI...')
console.log('[start-local] Press Ctrl+C to stop all services.')

await run('relay', 'node', ['cloud-relay/server.js'])
await run('agent', 'node', ['local-agent/server.js'], 500)
await run('bridge', 'node', ['local-agent/runBridge.js'], 1500)
await run('dev', 'node', ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'], 2000)

function shutdown() {
  console.log('\n[start-local] Shutting down...')
  children.forEach(({ label, child }) => {
    if (!child.killed) {
      child.kill('SIGTERM')
      console.log(`[start-local] stopped ${label}`)
    }
  })
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
