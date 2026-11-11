import {
  contextGraphSize,
  lastContextGraphRetention,
  sweepContextGraph,
} from './contextGraph.js'
import { contextGraphRetentionPolicy } from './contextGraphRetention.js'

/*
 * HTTP for the context graph's byte bound, as a registration function.
 *
 * Wire it with:
 *
 *     registerContextGraphRetentionRoutes(app)
 *
 * The bound is enforced at every write (contextGraph.js writeGraph), so these
 * routes are for ANSWERING rather than for correctness — with one exception. A
 * machine that has executed nothing since the policy changed never calls
 * writeGraph, so it would sit over budget with nobody to notice; POST /sweep is
 * how you make it notice.
 *
 * GET changes nothing and says what enforcement would do from here, which is
 * the question worth asking before turning a knob.
 */
export function registerContextGraphRetentionRoutes(app) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerContextGraphRetentionRoutes requires an Express-style app.')
  }

  app.get('/memory/graph/retention', (request, response) => {
    response.set('Cache-Control', 'private, no-store')
    response.json({
      ok: true,
      ...contextGraphSize(),
      observedAt: new Date().toISOString(),
    })
  })

  app.post('/memory/graph/retention/sweep', (request, response) => {
    /*
     * A caller may tighten the budget for one sweep, and only tighten it in a
     * direction the policy already sanctions — the same normalizer runs, so a
     * zero or a negative still means "the default", never "delete everything".
     */
    const policy = contextGraphRetentionPolicy({
      maxBytes: request.body?.maxBytes,
      telemetryTtlMs: request.body?.telemetryTtlMs,
    })

    try {
      const report = sweepContextGraph({ policy })
      response.set('Cache-Control', 'private, no-store')
      response.json({
        ok: true,
        ...report,
        lastEnforcement: lastContextGraphRetention(),
        observedAt: new Date().toISOString(),
      })
    } catch (error) {
      response.status(500).json({ ok: false, error: String(error?.message ?? error) })
    }
  })

  return app
}
