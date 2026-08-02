import {
  exportMemoryRecords,
  restoreMemoryRecords,
} from './contextGraph.js'
import {
  exportSessionState,
  restoreSessionState,
  SINGLE_OWNER_ACCOUNT_ID,
} from './sessionStore.js'
import {
  mergeProductSync,
  normalizeProductSync,
} from '../shared/productSync.js'

const DEFAULT_PRODUCT_STATE_PATH = '/v1/product/state'

export function buildLocalProductState({
  accountId = SINGLE_OWNER_ACCOUNT_ID,
  sourceDeviceId,
} = {}) {
  const sessionState = exportSessionState({ accountId, sourceDeviceId })
  return normalizeProductSync({
    ...sessionState,
    sourceDeviceId: sourceDeviceId || sessionState.sourceDeviceId,
    memory: exportMemoryRecords(),
  })
}

export function applyProductStateLocally(
  input,
  {
    accountId = SINGLE_OWNER_ACCOUNT_ID,
    sourceDeviceId,
  } = {},
) {
  const state = normalizeProductSync(input)
  if (state.accountId !== accountId) {
    throw new TypeError('Product state belongs to a different account')
  }
  restoreSessionState(state, {
    accountId,
    sourceDeviceId: sourceDeviceId || state.sourceDeviceId,
  })
  restoreMemoryRecords(state.memory)
  return state
}

export async function synchronizeProductState({
  relayUrl,
  authorization,
  accountId = SINGLE_OWNER_ACCOUNT_ID,
  sourceDeviceId,
  fetchImpl = fetch,
  statePath = DEFAULT_PRODUCT_STATE_PATH,
  readLocalState = buildLocalProductState,
  applyLocalState = applyProductStateLocally,
} = {}) {
  const baseUrl = String(relayUrl || '').replace(/\/$/, '')
  if (!baseUrl) throw new TypeError('relayUrl is required')
  if (!sourceDeviceId) throw new TypeError('sourceDeviceId is required')

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(authorization ? { Authorization: authorization } : {}),
  }
  const local = normalizeProductSync(
    readLocalState({ accountId, sourceDeviceId }),
  )

  // Pull first so a fresh/reinstalled Mac restores D1 before it publishes.
  const getResponse = await fetchImpl(
    `${baseUrl}${statePath}/${encodeURIComponent(accountId)}`,
    { headers },
  )
  let cloud = null
  let merged = local
  if (getResponse.ok) {
    const payload = await getResponse.json()
    cloud = normalizeProductSync(payload.state)
    merged = mergeProductSync(local, cloud)
  } else if (getResponse.status !== 404) {
    throw new Error(
      `Product-state restore failed with HTTP ${getResponse.status}`,
    )
  }

  applyLocalState(merged, { accountId, sourceDeviceId })

  if (cloud && productRecordsMatch(cloud, merged)) {
    return cloud
  }

  const outgoing = normalizeProductSync({
    ...merged,
    sourceDeviceId,
    generatedAt: new Date().toISOString(),
  })
  const putResponse = await fetchImpl(`${baseUrl}${statePath}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ state: outgoing }),
  })
  const putPayload = await putResponse.json().catch(() => ({}))
  if (!putResponse.ok) {
    throw new Error(
      putPayload.error ||
        `Product-state publish failed with HTTP ${putResponse.status}`,
    )
  }
  const canonical = normalizeProductSync(putPayload.state || merged)
  applyLocalState(canonical, { accountId, sourceDeviceId })
  return canonical
}

function productRecordsMatch(leftInput, rightInput) {
  const left = normalizeProductSync(leftInput)
  const right = normalizeProductSync(rightInput)
  return (
    left.accountId === right.accountId &&
    JSON.stringify(left.sessions) === JSON.stringify(right.sessions) &&
    JSON.stringify(left.memory) === JSON.stringify(right.memory)
  )
}
