import './loadEnv.js'
import { startBridge } from './bridge.js'

startBridge().catch((error) => {
  console.error(`[bridge] Fatal error: ${error.message}`)
  process.exit(1)
})
