import { getCloudflareBindings } from '../cloudflareBindings.js'
import { createD1Store } from './d1Store.js'
import { createMemoryStore } from './memoryStore.js'

let storePromise

export async function getStore() {
  if (!storePromise) {
    storePromise = createStore()
  }

  return storePromise
}

async function createStore() {
  const cloudflareBindings = getCloudflareBindings()
  if (cloudflareBindings?.DB) {
    const store = createD1Store(cloudflareBindings.DB)
    await store.listDevices()
    console.log('[relay] Using Cloudflare D1 store')
    return store
  }

  console.log('[relay] Using in-memory store (local development mode)')
  return createMemoryStore()
}
