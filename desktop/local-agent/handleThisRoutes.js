import {
  describeInvestigation,
  gatherAcrossTabs,
  getInvestigation,
  handleThis,
  listInvestigations,
  willHappen,
} from './handleThis.js'
import { DEFAULT_LENSES, LENSES } from './handleThisPanel.js'

/*
 * HTTP for "handle this" and for the parallel inspection.
 *
 * Kept out of handleThis.js so the feature can be imported and tested without
 * an express app anywhere near it, which is how every other route module in
 * this directory is arranged (pageWatchRoutes.js, actionLedgerRoutes.js).
 *
 * server.js is owned by someone else right now, so nothing here is mounted yet.
 * The shape is the one server.js already calls five times — `registerX(app)`,
 * synchronous, every option defaulted — so mounting it is one import and one
 * line whenever that file is free.
 *
 * NO ROUTE HERE SUBMITS ANYTHING. There is deliberately no approve endpoint and
 * no send endpoint: approval lives in formPreview.js behind a confirm code, and
 * putting a second door onto it from here would be a second place to get that
 * wrong.
 */

/*
 * A caller-supplied regular expression is run over page text, so its cost is
 * bounded by two things: how long it is, and how much text it sees. The text is
 * already capped at 12k chars by the panel; this caps the pattern.
 */
const MAX_PATTERN_CHARS = 200
const MAX_QUESTIONS = 12

function parseQuestions(input) {
  if (!Array.isArray(input)) throw new Error('`questions` must be an array.')
  if (input.length > MAX_QUESTIONS) {
    throw new Error(`At most ${MAX_QUESTIONS} questions per investigation.`)
  }

  return input.map((entry) => ({
    key: String(entry?.key ?? '').trim(),
    prompt: entry?.prompt ? String(entry.prompt) : null,
    /*
     * Compiled here rather than in handleThis so a bad pattern is a 400 with the
     * offending source in it, instead of a throw from inside a browser read that
     * has already opened a tab.
     */
    patterns: (Array.isArray(entry?.patterns) ? entry.patterns : []).map((pattern) => {
      const source = String(pattern).slice(0, MAX_PATTERN_CHARS)
      try {
        return new RegExp(source, 'i')
      } catch (error) {
        throw new Error(
          `Question "${entry?.key}" has an invalid pattern (${source}): ${error.message}`,
          { cause: error },
        )
      }
    }),
    labels: (Array.isArray(entry?.labels) ? entry.labels : []).map((label) => String(label)),
  }))
}

const asList = (value) =>
  (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean)

/**
 * @param filePath   where investigations are kept. Injectable so a test can run
 *                   these routes without writing into the owner's workspace.
 * @param ledgerPath passed through to formPreview for the submit manifest.
 */
export function registerHandleThisRoutes(
  app,
  { basePath = '', filePath = undefined, ledgerPath = null, previewPath = undefined } = {},
) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerHandleThisRoutes requires an Express-style app.')
  }

  const route = (suffix) => `${basePath}${suffix}`
  const store = filePath ? { filePath } : {}
  const fail = (response, error, code = 400) =>
    response.status(code).json({ ok: false, error: String(error?.message ?? error) })

  /* What the panel can be asked for, so a caller does not have to guess lens
   * names or discover them from a 400. */
  app.get(route('/handle-this/lenses'), (_request, response) => {
    response.json({
      ok: true,
      lenses: Object.entries(LENSES).map(([name, lens]) => ({
        name,
        sees: lens.sees,
        region: lens.region,
      })),
      default: DEFAULT_LENSES,
      note: 'Every lens is read-only. No lens can click, type, or submit.',
    })
  })

  /*
   * Registered before the `:investigationId` route: express matches in
   * registration order, and `/handle-this/investigations/recent` would
   * otherwise be read as an id. pageWatchRoutes.js has the same ordering
   * comment for the same reason.
   */
  app.get(route('/handle-this/investigations'), (request, response) => {
    const limit = Number.parseInt(String(request.query?.limit ?? ''), 10)
    response.json({
      ok: true,
      readOnly: true,
      investigations: listInvestigations(
        { limit: Number.isFinite(limit) && limit > 0 ? limit : 10 },
        store,
      ),
    })
  })

  app.get(route('/handle-this/investigations/:investigationId'), (request, response) => {
    const investigation = getInvestigation(String(request.params?.investigationId ?? ''), store)
    if (!investigation) {
      response.status(404).json({ ok: false, error: 'No such investigation.' })
      return
    }
    response.json({
      ok: true,
      readOnly: true,
      investigation,
      report: describeInvestigation(investigation),
      willHappen: willHappen(investigation),
    })
  })

  /* Inspect only: several lenses, reconciled, nothing filled and nothing drafted. */
  app.post(route('/handle-this/investigate'), async (request, response) => {
    try {
      const body = request.body ?? {}
      const investigation = await gatherAcrossTabs({
        ask: body.ask ?? null,
        questions: parseQuestions(body.questions ?? []),
        origins: asList(body.origins),
        anchorUrl: body.anchorUrl ?? body.url ?? null,
        lenses: body.lenses ? asList(body.lenses) : DEFAULT_LENSES,
        reload: body.reload !== false,
        ...(Number.isFinite(Number(body.maxSources))
          ? { maxSources: Number(body.maxSources) }
          : {}),
      })

      response.json({
        ok: true,
        submitted: false,
        investigation,
        report: describeInvestigation(investigation),
        /* Surfaced at the top level because it is the finding, not a detail of
         * one. A caller that reads only the summary must still see it. */
        disagreements: investigation.disputed ?? [],
      })
    } catch (error) {
      fail(response, error)
    }
  })

  /* Gather and draft. Still nothing submitted — the draft waits on formPreview. */
  app.post(route('/handle-this'), async (request, response) => {
    try {
      const body = request.body ?? {}
      const outcome = await handleThis(
        {
          ask: body.ask ?? null,
          questions: parseQuestions(body.questions ?? []),
          origins: asList(body.origins),
          anchorUrl: body.anchorUrl ?? null,
          lenses: body.lenses ? asList(body.lenses) : DEFAULT_LENSES,
          reload: body.reload !== false,
          form: body.form ?? null,
          message: body.message ?? null,
          note: body.note ?? null,
        },
        { ...store, ledgerPath, ...(previewPath ? { previewPath } : {}) },
      )

      response.status(201).json({
        ok: true,
        submitted: false,
        note: 'Nothing was submitted or sent. The draft is held behind its confirm code.',
        investigation: outcome,
        report: outcome.report,
        willHappen: outcome.willHappen ?? willHappen(outcome),
        disagreements: outcome.disputed ?? [],
        leftBlank: outcome.blocked ?? [],
      })
    } catch (error) {
      fail(response, error)
    }
  })

  return {
    mounted: [
      'GET /handle-this/lenses',
      'GET /handle-this/investigations',
      'GET /handle-this/investigations/:investigationId',
      'POST /handle-this/investigate',
      'POST /handle-this',
    ],
  }
}
