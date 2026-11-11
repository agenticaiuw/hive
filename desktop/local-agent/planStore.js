import { ensureJsonStore, readJsonWithRecovery, writeJsonAtomic } from './atomicJsonStore.js'

// Resolve the path on each operation so callers can use separate stores and tests can redirect them.
export function createPlanStore(storePath, limit = 20) {
  const validate = (value) => value && Array.isArray(value.plans)
  return {
    load() {
      const filePath = storePath()
      ensureJsonStore(filePath, { plans: [] }, { validate })
      return readJsonWithRecovery(filePath, { fallback: { plans: [] }, validate })
    },
    save(store) {
      store.plans = store.plans.slice(-limit)
      writeJsonAtomic(storePath(), store, { validate })
    },
  }
}
