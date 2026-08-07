import { workspacePath } from './config.js'
import {
  adoptHandoff,
  contextLocation,
  getContext,
  handoffFor,
  listContexts,
  openContext,
  stampPlan,
} from './executionContext.js'
import { planTransaction, verifyOutputs } from './workbenchTransaction.js'

/*
 * HTTP for the execution-context store, as a registration function.
 *
 * A function rather than routes in server.js for the reason
 * actionLedgerRoutes.js gives: server.js is a large shared surface that
 * several people edit at once, and a module that mounts in one line is a
 * module that does not collide. Wire it with:
 *
 *     registerWorkbenchRoutes(app)
 *
 * NOTHING HERE RUNS A TRANSACTION. Every route either reads the store or
 * records intent; none of them touch the workspace. `commitTransaction` is
 * called from the capability that owns the work, next to the abort controller
 * and the job tracker that already govern it — a resume endpoint that both
 * decides and acts is a resume nobody can audit. `sweepStagingDirectories`
 * deletes, so it is likewise not exposed here.
 *
 * The one non-idempotent-looking route, POST /workbench/contexts, is
 * idempotent by construction: opening the same (jobId, intentHash) twice
 * returns the same context with decision `retry`, not a second one.
 */

const DECISIONS = 'fresh | retry | completed | repair | rerun'

export function registerWorkbenchRoutes(
  app,
  { filePath = contextLocation(), basePath = workspacePath } = {},
) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerWorkbenchRoutes requires an Express-style app.')
  }

  /* Plan: what would this transaction do? Reads only. */
  app.post('/workbench/plan', (request, response) => {
    try {
      const plan = planTransaction({
        jobId: request.body?.jobId ?? null,
        parentId: request.body?.parentId ?? null,
        intent: request.body?.intent,
        outputs: manifestPathsFrom(request.body?.outputs),
        references: request.body?.references ?? [],
        basePath,
        statePath: filePath,
      })
      response.json({
        ok: true,
        executed: false,
        decisions: DECISIONS,
        ...plan,
      })
    } catch (error) {
      response.status(400).json({ ok: false, error: String(error?.message ?? error) })
    }
  })

  /* Stamp and durably open a context. Records what a job intends. Runs nothing. */
  app.post('/workbench/contexts', (request, response) => {
    try {
      const descriptor = stampPlan({
        jobId: request.body?.jobId ?? null,
        parentId: request.body?.parentId ?? null,
        rootId: request.body?.rootId ?? null,
        intent: request.body?.intent,
        destinations: manifestPathsFrom(request.body?.outputs)?.map((entry) => entry.path) ?? [],
        references: request.body?.references ?? [],
      })
      const opened = openContext(descriptor, { filePath })
      response.status(opened.decision === 'retry' ? 200 : 201).json({
        ok: true,
        executed: false,
        note: 'The context is on disk. Nothing has run.',
        decisions: DECISIONS,
        ...opened,
      })
    } catch (error) {
      response.status(400).json({ ok: false, error: String(error?.message ?? error) })
    }
  })

  app.get('/workbench/contexts', (request, response) => {
    const limit = Number.parseInt(String(request.query?.limit ?? ''), 10)
    response.json({
      readOnly: true,
      contexts: listContexts({
        filePath,
        jobId: request.query?.jobId ? String(request.query.jobId) : null,
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    })
  })

  app.get('/workbench/contexts/:contextId', (request, response) => {
    const context = getContext(String(request.params.contextId), { filePath })
    if (!context) {
      response.status(404).json({ ok: false, error: 'No such execution context.' })
      return
    }
    response.json({
      readOnly: true,
      context,
      /* What the record claims versus what is on disk right now. The gap
       * between those two is the only reason to look at this route. */
      verification:
        context.status === 'committed' ? verifyOutputs(context, { basePath }) : null,
    })
  })

  /* What a job resumed after a restart already did. */
  app.get('/workbench/jobs/:jobId/handoff', (request, response) => {
    response.json({
      readOnly: true,
      handoff: handoffFor(String(request.params.jobId), { filePath }),
    })
  })

  /* Take a context envelope from another body. Cannot lower a local status. */
  app.post('/workbench/handoff', (request, response) => {
    const result = adoptHandoff(request.body?.handoff ?? request.body, { filePath })
    response.status(result.adopted ? 200 : 400).json({ ok: result.adopted, ...result })
  })

  return app
}

/*
 * A planning request sends destinations, never contents — the point of asking
 * is to avoid producing the contents. Anything else in the entry is dropped so
 * a caller cannot smuggle a write through a read-only route.
 */
function manifestPathsFrom(outputs) {
  if (!Array.isArray(outputs)) return null
  return outputs
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path))
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => ({ path: entry }))
}
