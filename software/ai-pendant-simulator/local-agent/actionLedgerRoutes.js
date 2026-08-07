import {
  getLedger,
  interruptedLedgers,
  ledgerLocation,
  listLedgers,
  openLedger,
  presentLedger,
  resumeLedger,
} from './actionLedger.js'

/*
 * HTTP for the action ledger, as a registration function.
 *
 * It is a function rather than route definitions in server.js because server.js
 * is 69 000 characters of shared surface that several people are editing at
 * once; a module that can be mounted in one line is a module that does not
 * collide. capabilityManifest.js already reads the live router, so these routes
 * describe themselves there for free once mounted.
 *
 * Wire it with:
 *
 *     registerActionLedgerRoutes(app)
 *
 * FOUR OF THE FIVE ROUTES ARE GET AND CHANGE NOTHING. The fifth, POST /ledger,
 * writes a plan manifest and DOES NOT RUN IT — that is the entire point of it.
 * If you are here to add a route that executes a resume, put it in server.js
 * next to /execute where the abort controller, the job tracker and the focus
 * coordinator already live. This module has no business owning execution, and
 * a resume that both decides and acts is a resume nobody can audit.
 */

const RESUME_DECISIONS = 'completed | skip | rerun | ask | blocked'

export function registerActionLedgerRoutes(app, { filePath = ledgerLocation() } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerActionLedgerRoutes requires an Express-style app.')
  }

  /*
   * Prepare: persist what a plan intends to do, before anything runs.
   *
   * This is the durable half of "prepare this action on my Mac, and let me
   * approve it from the pendant". The response carries the risk summary an
   * approval would be given on a device with no screen — how many steps change
   * something, how many cannot be taken back, and how many would be
   * unanswerable if the run were interrupted.
   */
  app.post('/ledger', (request, response) => {
    const actions = Array.isArray(request.body?.actions) ? request.body.actions : []
    if (!actions.length) {
      response.status(400).json({ ok: false, error: 'No actions provided.' })
      return
    }

    try {
      const manifest = openLedger({
        command: String(request.body?.command ?? ''),
        actions,
        jobId: request.body?.jobId ?? null,
        sessionId: String(request.body?.sessionId ?? '').trim() || null,
        source: String(request.body?.source ?? 'local'),
        title: request.body?.title ?? null,
        filePath,
      })

      response.status(201).json({
        ok: true,
        executed: false,
        note: 'The manifest is on disk. Nothing has run — hand the actions to /execute when they are approved.',
        ledger: presentLedger(manifest),
      })
    } catch (error) {
      response.status(400).json({ ok: false, error: String(error?.message ?? error) })
    }
  })

  app.get('/ledger', (request, response) => {
    const limit = Number.parseInt(String(request.query?.limit ?? ''), 10)
    response.json({
      readOnly: true,
      ...listLedgers({
        filePath,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
        status: String(request.query?.status ?? '').trim() || null,
      }),
    })
  })

  /* Registered before /ledger/:ledgerId so the literal wins the match. */
  app.get('/ledger/interrupted', (_request, response) => {
    response.json(interruptedLedgers({ filePath }))
  })

  app.get('/ledger/:ledgerId', (request, response) => {
    const manifest = getLedger(String(request.params?.ledgerId ?? ''), { filePath })
    if (!manifest) {
      response.status(404).json({ ok: false, error: 'Ledger not found.' })
      return
    }
    response.json({ ok: true, readOnly: true, ledger: presentLedger(manifest) })
  })

  /*
   * What an interrupted run actually finished, what is safe to continue, and
   * where it stops to ask.
   *
   * GET, because deciding is not doing. `runnable` is a list of actions for the
   * caller to send to /execute; it stops at the first step whose outcome could
   * not be established, and `question` is what to put to the owner instead of
   * the rest of the plan.
   *
   * These actions carry real parameters — they are the same actions /execute
   * was going to be handed, coming back out the way they went in. Every other
   * route here drops parameters (see presentLedger); this one cannot, because
   * an action without its parameters is not a resumable action.
   */
  app.get('/ledger/:ledgerId/resume', (request, response) => {
    const plan = resumeLedger(String(request.params?.ledgerId ?? ''), { filePath })
    if (!plan) {
      response.status(404).json({ ok: false, error: 'Ledger not found.' })
      return
    }
    response.json({
      ...plan,
      readOnly: true,
      executed: false,
      decisions: RESUME_DECISIONS,
      note: `${plan.note} Nothing on this path ran anything; send \`runnable\` to /execute to continue.`,
    })
  })

  return app
}
