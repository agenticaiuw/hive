import { ledgerLocation } from './actionLedger.js'
import { planVisionLoop, runVisionLoop, visionLoopStatus } from './visionLoop.js'
import { recentActions, speakHistory } from './visionLoopHistory.js'
import { preflight } from './visionLoopPreflight.js'
import { describeOffload } from './visionLoopRelay.js'

/*
 * HTTP for the accessibility-mode loop, as a registration function.
 *
 * Same shape and same reason as registerActionLedgerRoutes: server.js is a
 * large shared surface with several people in it, and a module that mounts in
 * one line does not collide. Wire it with:
 *
 *     registerVisionLoopRoutes(app)
 *
 * SIX ROUTES, FIVE OF THEM READ-ONLY. The sixth, POST /vision-loop/run, is the
 * only one that could ever dispatch anything, and on this machine it cannot:
 * runVisionLoop checks the preflight and returns without touching the executor.
 * Its response says `executed: false` and `dispatched: 0` explicitly rather
 * than leaving that to be inferred from an absence.
 *
 * There is deliberately NO undo route here. Undo already has one —
 * POST /jobs/:jobId/undo in server.js — and that one both reverses the job and
 * marks it undone. A second undo route that skipped the marking would let the
 * same job be undone twice, and the second pass would write a stale snapshot
 * over whatever the owner had done since. The history returns the existing
 * route's path; it does not grow a rival.
 */

export function registerVisionLoopRoutes(
  app,
  /* `preflightImpl` is injected only so tests can mount these routes without
   * touching TCC. Production mounts it as `registerVisionLoopRoutes(app)` and
   * gets the real permission read. */
  { filePath = ledgerLocation(), preflightImpl = preflight } = {},
) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerVisionLoopRoutes requires an Express-style app.')
  }

  /* Where the capability stands: the vocabulary, the grants, the exact binary
   * that needs them, and what the loop can honestly do meanwhile. */
  app.get('/vision-loop/status', async (_request, response) => {
    response.json(await visionLoopStatus({ preflightImpl }))
  })

  /*
   * Validate a plan. Runs nothing and checks no permissions — a plan is well
   * formed or not on its own terms, and keeping that separate is what lets a
   * plan be reviewed today for a grant that lands next week.
   */
  app.post('/vision-loop/plan', (request, response) => {
    const plan = planVisionLoop({
      goal: request.body?.goal ?? '',
      app: request.body?.app ?? '',
      steps: Array.isArray(request.body?.steps) ? request.body.steps : [],
    })

    response.status(plan.ok ? 200 : 400).json({
      ...plan,
      readOnly: true,
      executed: false,
      note: plan.ok
        ? 'Nothing has run. POST /vision-loop/run to attempt it; on this machine that will report what it would do and dispatch nothing.'
        : 'Rejected as a whole. A plan with one unreachable step is not a shorter plan — the rest were written assuming that step happened.',
    })
  })

  /*
   * Attempt the run.
   *
   * POST because it is the verb that would apply if the grant were held, and a
   * route that changes method the day a permission lands is a route every
   * caller has to be updated for.
   */
  app.post('/vision-loop/run', async (request, response) => {
    const plan = planVisionLoop({
      goal: request.body?.goal ?? '',
      app: request.body?.app ?? '',
      steps: Array.isArray(request.body?.steps) ? request.body.steps : [],
    })

    /* No `execute` is passed. Wiring the executor in is the last change this
     * feature needs, and it is deliberately not made until the grant exists —
     * an execute path that has never been able to run is an execute path nobody
     * has tested, and it should not sit armed behind a permission check. */
    const outcome = await runVisionLoop(plan, { ledgerPath: filePath, preflightImpl })

    response.status(outcome.ok ? 200 : 409).json({ ...outcome, plan })
  })

  /* The history, narrated. `?all=1` widens past this loop's own runs. */
  app.get('/vision-loop/history', (request, response) => {
    const limit = Number.parseInt(String(request.query?.limit ?? ''), 10)
    const history = recentActions({
      filePath,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
      all: String(request.query?.all ?? '') === '1',
    })
    response.json({ ...history, spoken: speakHistory(history) })
  })

  /* The permission position on its own, for a dashboard tile that should not
   * have to fetch the whole policy to render one line. */
  app.get('/vision-loop/preflight', async (_request, response) => {
    response.json(await preflightImpl())
  })

  /*
   * What a relay offload would contain, computed locally and sent nowhere.
   *
   * GET, and it takes no element list: today there is no accessibility tree to
   * digest, so this returns the shape and the gates rather than a digest of
   * live windows. It is the read an owner should get BEFORE deciding whether to
   * consent to uploads, which is the only point at which that decision is
   * informed.
   */
  app.get('/vision-loop/offload', async (_request, response) => {
    const gate = await preflightImpl()
    response.json(
      describeOffload({
        accessibilityHeld: Boolean(
          gate.grants.find((entry) => entry.grant === 'accessibility')?.held,
        ),
      }),
    )
  })

  return app
}
