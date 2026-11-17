/*
 * THIS BROWSER'S AGENT, LIVE ON THE OWNER'S BOARD (2026-11-16).
 *
 * The owner: every agent on every node is live on the dashboard, "since all are streamed to the
 * cloud and streamed onto each individual node". Each run this browser's own agent makes (a command
 * it plans and runs here, or thinks through itself, console-engine.js) goes to the cloud board as one
 * of the owner's runs (POST /v1/runs, cloud/tasks/worker.js) while it runs: that it began, each step
 * as it lands, and how it ended. Every dashboard shows it beside Hive on the Mac and Hive in the cloud.
 *
 * It mirrors the execution journal instead of threading calls through every run path, so whatever
 * writes the journal (the plan path, the brain loop, approvals) reaches the board too. Best effort,
 * like the hive record: with no board key yet (Hive on the Mac hands it over, ask-hive.js) or a board
 * that's down, the board misses its copy and the run goes on. Steps are numbered here, per run, so a
 * step sent twice lands once, and what a post couldn't deliver goes with the next one.
 */
import { BOARD_KEY, BOARD_URL } from './page-rules-core.js'

const MOST_UNSENT = 100

/**
 * `journal` (createExecutionJournal's), with each run also sent to the board.
 * @param {object} journal
 * @param {{storage: {get: Function}, fetchImpl?: typeof fetch}} options
 */
export function mirrorRunsToBoard(journal, { storage, fetchImpl = (...args) => fetch(...args) }) {
  /** runId → {title, count, unsent, status, shown} */
  const runs = new Map()
  let sending = Promise.resolve()

  const runOf = (runId, title = '') => {
    if (!runs.has(runId)) runs.set(runId, { title, count: 0, unsent: [], status: null, shown: false })
    return runs.get(runId)
  }

  const post = async (board, runId, run) => {
    const steps = run.unsent.slice()
    const response = await fetchImpl(`${board.url || BOARD_URL}/v1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${board.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        run: runId,
        agent: 'browser',
        title: run.title,
        ...(run.status ? { status: run.status } : {}),
        steps,
      }),
    })
    if (!response.ok) throw new Error(`the board said ${response.status}`)
    const through = steps.at(-1)?.n ?? 0
    run.unsent = run.unsent.filter((step) => step.n > through)
    run.shown = true
    if (run.status && !run.unsent.length) runs.delete(runId)
  }

  /* Everything the board hasn't got, one post at a time, in order. A post that fails stops this
   * round (the board is away); its steps go with the next round. Never the run's problem. */
  const send = () => {
    sending = sending
      .then(async () => {
        const board = (await storage.get(BOARD_KEY))?.[BOARD_KEY]
        if (!board?.key) return
        for (const [runId, run] of [...runs]) {
          if (run.shown && !run.unsent.length && !run.status) continue
          await post(board, runId, run)
        }
      })
      .catch((error) => console.warn(`hive board: a run wasn't sent: ${error?.message || error}`))
    return sending
  }

  const step = (run, kind, text) => {
    run.count += 1
    run.unsent.push({ n: run.count, at: Math.floor(Date.now() / 1000), kind, text: String(text).slice(0, 500) })
    if (run.unsent.length > MOST_UNSENT) run.unsent = run.unsent.slice(-MOST_UNSENT)
  }

  return {
    ...journal,

    async beginRun(args) {
      const begun = await journal.beginRun(args)
      runOf(args.runId, String(args.command ?? '').slice(0, 300))
      void send()
      return begun
    },

    async recordStep(runId, done) {
      const written = await journal.recordStep(runId, done)
      /* A context that woke up mid-run counts on from what the journal kept. */
      const run = runOf(runId, written?.command ?? '')
      if (!run.count) run.count = Math.max(0, (written?.steps?.length ?? 1) - 1)
      const tool = String(done?.tool ?? done?.type ?? 'step')
      const summary = String(done?.summary ?? '').trim()
      step(run, done?.ok === false ? 'failed' : 'action', summary ? `${tool}: ${summary}` : tool)
      void send()
      return written
    },

    async finishRun(runId, outcome = {}) {
      const finished = await journal.finishRun(runId, outcome)
      const run = runOf(runId, finished?.command ?? '')
      if (!run.count) run.count = finished?.steps?.length ?? 0
      const failed = outcome.state === 'failed' || outcome.verdict === 'failed'
      run.status = outcome.verdict === 'handed-off' ? 'stopped' : failed ? 'failed' : 'done'
      const headline = String(outcome.headline ?? finished?.headline ?? '').trim()
      if (headline) step(run, failed ? 'failed' : 'done', headline)
      void send()
      return finished
    },

    /** Resolves once everything sent so far has been tried (tests). */
    settled: () => sending,
  }
}
