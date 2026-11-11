import {
  acknowledgeReports,
  checkWatch,
  createWatch,
  deleteWatch,
  getWatch,
  listWatches,
  pageWatchLocation,
  pendingReports,
  suppressedChanges,
  updateWatch,
  watchHealth,
} from './pageWatch.js'
import {
  approveDraft,
  discardDraft,
  draftHandoff,
  getDraft,
  listDrafts,
  pageWatchDraftsLocation,
} from './pageWatchDrafts.js'

/*
 * The HTTP surface, as a function the server calls rather than a block inside
 * it.
 *
 * server.js is edited by several people at once and is the file most likely to
 * conflict; a feature that owns its own routes can be added, moved or removed
 * in one line there. This supersedes the inline `/watches` block — mount one or
 * the other, not both, since Express answers with whichever was registered
 * first and a half-replaced block would silently serve the old shape.
 *
 * Every route here is a read, a definition change, or an acknowledgement. The
 * two that touch the outside world are POST /watches/:id/check, which reads the
 * page, and POST /drafts/:id/approve, which writes down that the owner said yes
 * and still sends nothing. There is deliberately no route that submits a form:
 * the handoff endpoint returns the arguments for one and lets the caller decide,
 * which is where the owner is.
 */
export function registerPageWatchRoutes(app, { basePath = '' } = {}) {
  const route = (suffix) => `${basePath}${suffix}`

  const fail = (response, error, code = 400) =>
    response.status(code).json({ ok: false, error: String(error?.message || error) })

  app.get(route('/watches'), (_request, response) => {
    response.json({
      ok: true,
      watches: listWatches(),
      storePath: pageWatchLocation(),
    })
  })

  app.post(route('/watches'), (request, response) => {
    try {
      response.json({ ok: true, watch: createWatch(request.body || {}) })
    } catch (error) {
      fail(response, error)
    }
  })

  /*
   * Fixed segments before /watches/:watchId, or Express reads "reports" as a
   * watch id and every one of them 404s.
   */
  app.get(route('/watches/reports'), (_request, response) => {
    const reports = pendingReports()
    const health = watchHealth()
    response.json({
      ok: true,
      reports,
      health,
      /*
       * "Nothing changed" and "nothing could be checked" are different answers
       * and the pendant must not say the first when it means the second. This
       * is the sentence that gets spoken, so the distinction is made here
       * rather than left to the caller to remember.
       */
      summary: reports.length
        ? reports.map((report) => report.summary).join(' ')
        : health.online
          ? 'Nothing you are watching has changed.'
          : 'Nothing to report — but the browser extension is not connected, so nothing has been checked.',
    })
  })

  app.get(route('/watches/health'), (_request, response) => {
    response.json({ ok: true, ...watchHealth() })
  })

  /* ------------------------------------------------------------- drafts
   *
   * Registered above /watches/:watchId. Express matches in registration order,
   * so with these below it "drafts" is read as a watch id and every draft route
   * 404s — which is how the first cut of this file behaved.
   */

  app.get(route('/watches/drafts'), (request, response) => {
    response.json({
      ok: true,
      drafts: listDrafts({
        watchId: request.query.watchId || null,
        status: request.query.status || null,
      }),
      storePath: pageWatchDraftsLocation(),
      note: 'Prepared, not sent. Nothing here has been submitted.',
    })
  })

  app.get(route('/watches/drafts/:draftId'), (request, response) => {
    const draft = getDraft(request.params.draftId)
    if (!draft) {
      response.status(404).json({ ok: false, error: 'No such draft.' })
      return
    }
    response.json({ ok: true, draft })
  })

  app.delete(route('/watches/drafts/:draftId'), (request, response) => {
    response.json({ ok: discardDraft(request.params.draftId) })
  })

  app.post(route('/watches/drafts/:draftId/approve'), (request, response) => {
    const draft = approveDraft(request.params.draftId)
    if (!draft) {
      response.status(404).json({ ok: false, error: 'No such draft.' })
      return
    }
    response.json({
      ok: true,
      draft,
      /*
       * The approval and the sending are separate calls on purpose. This
       * returns what a fill WOULD be handed; it does not perform one, and the
       * fill it describes stops before the submit control anyway. Two brakes in
       * series, neither of which a scheduler running at 4am can release.
       */
      handoff: draftHandoff(request.params.draftId),
    })
  })

  /* -------------------------------------------------------------- watches */

  app.get(route('/watches/:watchId'), (request, response) => {
    const watch = getWatch(request.params.watchId)
    if (!watch) {
      response.status(404).json({ ok: false, error: 'No such watch.' })
      return
    }
    response.json({ ok: true, watch })
  })

  app.patch(route('/watches/:watchId'), (request, response) => {
    try {
      const watch = updateWatch(request.params.watchId, request.body || {})
      if (!watch) {
        response.status(404).json({ ok: false, error: 'No such watch.' })
        return
      }
      response.json({ ok: true, watch })
    } catch (error) {
      fail(response, error)
    }
  })

  app.delete(route('/watches/:watchId'), (request, response) => {
    response.json({ ok: deleteWatch(request.params.watchId) })
  })

  app.post(route('/watches/:watchId/check'), async (request, response) => {
    try {
      response.json({ ok: true, ...(await checkWatch(request.params.watchId)) })
    } catch (error) {
      fail(response, error)
    }
  })

  app.post(route('/watches/:watchId/ack'), (request, response) => {
    response.json({
      ok: true,
      acknowledged: acknowledgeReports(request.params.watchId),
    })
  })

  /* What this watch decided was not worth saying, with the scores. A quiet
   * watcher and a broken one look the same from outside; this is the endpoint
   * that tells them apart, and the one to hit before lowering a threshold. */
  app.get(route('/watches/:watchId/suppressed'), (request, response) => {
    response.json({
      ok: true,
      suppressed: suppressedChanges(request.params.watchId),
    })
  })

  return {
    mounted: [
      'GET/POST /watches',
      'GET /watches/reports',
      'GET /watches/health',
      'GET/PATCH/DELETE /watches/:watchId',
      'POST /watches/:watchId/check',
      'POST /watches/:watchId/ack',
      'GET /watches/:watchId/suppressed',
      'GET/DELETE /watches/drafts[/:draftId]',
      'POST /watches/drafts/:draftId/approve',
    ],
  }
}
