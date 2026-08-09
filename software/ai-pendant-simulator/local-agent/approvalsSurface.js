/*
 * The Mac's window onto parked approvals: what is waiting, and a way to answer.
 *
 * This is the third delivery leg of approval-at-origin routing. A plan parked
 * from the pendant is spoken back on the pendant; one parked from a mesh node
 * gets a card pushed to that node; one parked from a Mac surface (the floating
 * HUD, the local dashboard, the bridge itself) lands HERE, because the Mac's
 * surfaces are pollers by construction — a menubar HUD asks, it is not rung.
 *
 * THE CONTRACT IS FROZEN. A Swift consumer is built against exactly:
 *
 *   GET  /approvals/pending
 *        → { approvals: [{ id, summary, detail, origin, risk,
 *                          createdAt, expiresAt }] }
 *   POST /approvals/:id/decision   body { "decision": "approve" | "deny" }
 *        → { ok: true, state }  or  { ok: false, error }
 *
 * Do not add, rename or re-nest those fields. Both routes sit behind the
 * agent's ordinary Bearer AGENT_TOKEN middleware (server.js mounts this after
 * it), and both FORWARD to the relay with the agent's own scoped device
 * credential — the decision is the relay's to keep, because the relay is the
 * body that is awake when this Mac is not.
 *
 * DELIBERATELY NOT FILTERED BY ORIGIN. Origin controls where the prompt is
 * pushed, never who may decide: this list shows every pending approval, so
 * the owner standing at the Mac can answer a question that was spoken to a
 * pendant left in another room.
 */
import {
  RELAY_API_KEY,
  RELAY_DEVICE_TOKEN,
  RELAY_DEVICE_TOKEN_FILE,
  RELAY_URL,
} from './bridgeConfig.js'
import { resolveRelayCredential } from './relayCredential.js'
import { riskLabelFor } from '../shared/approvalHandoff.js'

/* The device whose approval index the bridge writes parked plans into. One
 * list per fleet today; see createParkedApproval in bridge.js. */
export const APPROVALS_DEVICE_ID = 'nrf9160-pendant'

/**
 * One relay approval record → one frozen-shape row, or null for a record that
 * is not pending business (settled, expired, malformed). `summary` and
 * `detail` are derived from the readback the same way the mesh card derives
 * them (shared/approvalHandoff.js approvalPromptText does it for the relay);
 * here the relay already sent the readback, so the split is repeated locally
 * rather than re-fetched.
 */
export function pendingApprovalRow(record, { now = Date.now() } = {}) {
  if (!record?.approvalId) return null
  if (record.state !== 'pending') return null
  const expiresAt = Date.parse(String(record.expiresAt ?? ''))
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null

  const detail = String(record.readback ?? '').trim()
  const firstStop = detail.indexOf('. ')
  const summary =
    firstStop > 0 ? detail.slice(0, firstStop + 1) : detail.slice(0, 160) || 'An action is waiting for your approval.'

  return {
    id: record.approvalId,
    summary,
    detail,
    origin: record.origin ?? null,
    risk: riskLabelFor(record.risk),
    createdAt: record.createdAt ?? null,
    expiresAt: record.expiresAt ?? null,
  }
}

/**
 * The relay client half, injectable so the tests never need a live relay (or
 * the live agent — see approvalsSurface.test.js).
 */
export function createApprovalsSurface({
  relayUrl = RELAY_URL,
  credential = null,
  fetchImpl = fetch,
  deviceId = APPROVALS_DEVICE_ID,
} = {}) {
  /* Exactly the resolution the bridge itself performs (relayCredential.js):
   * scoped mac_bridge token first, admin key as the loud fallback. */
  const resolved =
    credential ??
    resolveRelayCredential({
      deviceToken: RELAY_DEVICE_TOKEN,
      deviceTokenFile: RELAY_DEVICE_TOKEN_FILE,
      adminKey: RELAY_API_KEY,
    })

  const headers = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${resolved.token}`,
  })

  return {
    /* kind/source only, never the token — same logging rule as the bridge. */
    credentialKind: resolved.kind,

    async listPending({ now = Date.now() } = {}) {
      if (!resolved.token) {
        return { ok: false, status: 503, error: 'No relay credential is configured on this Mac agent.' }
      }
      let response
      try {
        response = await fetchImpl(
          `${relayUrl}/v1/approvals?deviceId=${encodeURIComponent(deviceId)}`,
          { headers: headers() },
        )
      } catch (error) {
        return { ok: false, status: 502, error: `The relay could not be reached: ${error?.message ?? error}` }
      }
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) {
        return {
          ok: false,
          status: 502,
          error: payload?.error || `The relay answered ${response.status} to the approvals list.`,
        }
      }
      const rows = (Array.isArray(payload.approvals) ? payload.approvals : [])
        .map((record) => pendingApprovalRow(record, { now }))
        .filter(Boolean)
      return { ok: true, approvals: rows }
    },

    async decide({ approvalId, decision }) {
      if (!resolved.token) {
        return { ok: false, status: 503, error: 'No relay credential is configured on this Mac agent.' }
      }
      let response
      try {
        response = await fetchImpl(
          `${relayUrl}/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
          {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ decision, decidedBy: 'mac-agent' }),
          },
        )
      } catch (error) {
        return { ok: false, status: 502, error: `The relay could not be reached: ${error?.message ?? error}` }
      }
      const payload = await response.json().catch(() => null)
      if (payload?.ok) {
        return { ok: true, state: payload.state ?? (decision === 'approve' ? 'granted' : 'denied') }
      }
      return {
        ok: false,
        status: response.status >= 400 ? response.status : 502,
        error:
          payload?.why ||
          payload?.error ||
          (payload?.code === 'already_settled' && payload?.state
            ? `This approval was already ${payload.state}.`
            : `The relay refused the decision (${response.status}).`),
        state: payload?.state ?? null,
      }
    },
  }
}

/**
 * HTTP, as a registration function — mounted by local-agent/server.js under
 * the existing auth middleware. Options exist for the tests; production
 * passes none.
 */
export function registerApprovalsSurfaceRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerApprovalsSurfaceRoutes requires an Express-style app.')
  }
  const surface = createApprovalsSurface(options)

  app.get('/approvals/pending', async (_request, response) => {
    const result = await surface.listPending()
    if (!result.ok) {
      response.status(result.status ?? 502).json({ ok: false, error: result.error })
      return
    }
    /* The frozen success shape, exactly: { approvals: [...] }. */
    response.json({ approvals: result.approvals })
  })

  app.post('/approvals/:approvalId/decision', async (request, response) => {
    const decision = String(request.body?.decision ?? '').trim()
    if (!['approve', 'deny'].includes(decision)) {
      response.status(400).json({ ok: false, error: 'decision must be "approve" or "deny".' })
      return
    }
    const result = await surface.decide({
      approvalId: String(request.params?.approvalId ?? ''),
      decision,
    })
    if (result.ok) {
      response.json({ ok: true, state: result.state })
      return
    }
    response.status(result.status ?? 502).json({ ok: false, error: result.error })
  })

  return app
}
