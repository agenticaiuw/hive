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
 *
 * A run can also carry on one the board already has (`link`): a task another agent handed to this
 * browser, or the owner talking to this browser's agent from a dashboard, comes in as a message on a
 * board run (cloud-peer.js), and what the agent does about it lands in that run, numbered on from
 * its last step, so the owner reads one conversation. The links and each run's last step number are
 * kept in storage, so a context that wakes up mid-run carries on in the same place.
 */
import { BOARD_KEY, BOARD_URL } from './page-rules-core.js'

const MOST_UNSENT = 100
/* { [journal run id]: {run: board run id, at} } and { [board run id]: {n: last step number, at} } */
export const BOARD_RUN_LINKS_KEY = 'boardRunLinks'
export const BOARD_RUN_COUNTS_KEY = 'boardRunCounts'
const MOST_REMEMBERED = 200

/**
 * `journal` (createExecutionJournal's), with each run also sent to the board.
 * @param {object} journal
 * @param {{storage: {get: Function}, fetchImpl?: typeof fetch}} options
 */
export function mirrorRunsToBoard(journal, { storage, fetchImpl = (...args) => fetch(...args) }) {
  /** board run id → {title, count, unsent, status, shown, reopen} */
  const runs = new Map()
  let sending = Promise.resolve()

  /* The links and step numbers kept in storage, read once per context. */
  let memory = null
  const remembered = async () => {
    if (!memory) {
      const got = (await storage.get([BOARD_RUN_LINKS_KEY, BOARD_RUN_COUNTS_KEY]).catch(() => null)) ?? {}
      memory = { links: { ...(got[BOARD_RUN_LINKS_KEY] ?? {}) }, counts: { ...(got[BOARD_RUN_COUNTS_KEY] ?? {}) } }
    }
    return memory
  }
  const newest = (map) =>
    Object.fromEntries(Object.entries(map).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, MOST_REMEMBERED))
  let saving = Promise.resolve()
  const save = () => {
    saving = saving
      .then(() => storage.set?.({ [BOARD_RUN_LINKS_KEY]: newest(memory.links), [BOARD_RUN_COUNTS_KEY]: newest(memory.counts) }))
      .catch(() => {})
    return saving
  }

  /* The board's run for a journal run: the one it was linked to, else its own id. */
  const boardRunOf = async (runId) => (await remembered()).links[runId]?.run ?? runId

  const runOf = (boardRun, title = '') => {
    if (!runs.has(boardRun)) {
      const linked = Object.values(memory?.links ?? {}).some((link) => link.run === boardRun)
      runs.set(boardRun, {
        /* A linked run keeps the title the board gave it. */
        title: linked ? '' : title,
        count: memory?.counts[boardRun]?.n ?? 0,
        unsent: [],
        status: null,
        shown: false,
        reopen: false,
      })
    }
    return runs.get(boardRun)
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
        ...(run.status ? { status: run.status } : run.reopen ? { status: 'working' } : {}),
        steps,
      }),
    })
    if (!response.ok) throw new Error(`the board said ${response.status}`)
    const through = steps.at(-1)?.n ?? 0
    run.unsent = run.unsent.filter((step) => step.n > through)
    run.shown = true
    run.reopen = false
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
          if (run.shown && !run.unsent.length && !run.status && !run.reopen) continue
          await post(board, runId, run)
        }
      })
      .catch((error) => console.warn(`hive board: a run wasn't sent: ${error?.message || error}`))
    return sending
  }

  const step = (boardRun, run, kind, text) => {
    run.count += 1
    run.unsent.push({ n: run.count, at: Math.floor(Date.now() / 1000), kind, text: String(text).slice(0, 500) })
    if (run.unsent.length > MOST_UNSENT) run.unsent = run.unsent.slice(-MOST_UNSENT)
    memory.counts[boardRun] = { n: run.count, at: Date.now() }
    void save()
  }

  return {
    ...journal,

    /** What journal run `runId` does goes to the board's run `boardRun` (before beginRun). */
    async link(runId, boardRun) {
      const kept = await remembered()
      kept.links[runId] = { run: String(boardRun), at: Date.now() }
      await save()
    },

    async beginRun(args) {
      const begun = await journal.beginRun(args)
      const boardRun = await boardRunOf(args.runId)
      const run = runOf(boardRun, String(args.command ?? '').slice(0, 300))
      if (boardRun !== args.runId) {
        /* Carrying on a run the board has: it is working again, whatever it said last. */
        run.status = null
        run.reopen = true
      }
      void send()
      return begun
    },

    async recordStep(runId, done) {
      const written = await journal.recordStep(runId, done)
      const boardRun = await boardRunOf(runId)
      /* A context that woke up mid-run counts on from what the journal kept. */
      const run = runOf(boardRun, written?.command ?? '')
      if (!run.count && !(boardRun in memory.counts)) run.count = Math.max(0, (written?.steps?.length ?? 1) - 1)
      const tool = String(done?.tool ?? done?.type ?? 'step')
      const summary = String(done?.summary ?? '').trim()
      step(boardRun, run, done?.ok === false ? 'failed' : 'action', summary ? `${tool}: ${summary}` : tool)
      void send()
      return written
    },

    async finishRun(runId, outcome = {}) {
      const finished = await journal.finishRun(runId, outcome)
      const boardRun = await boardRunOf(runId)
      const run = runOf(boardRun, finished?.command ?? '')
      if (!run.count && !(boardRun in memory.counts)) run.count = finished?.steps?.length ?? 0
      const failed = outcome.state === 'failed' || outcome.verdict === 'failed'
      run.status = outcome.verdict === 'handed-off' ? 'stopped' : failed ? 'failed' : 'done'
      run.reopen = false
      const headline = String(outcome.headline ?? finished?.headline ?? '').trim()
      if (headline) step(boardRun, run, failed ? 'failed' : 'done', headline)
      void send()
      return finished
    },

    /** Resolves once everything sent so far has been tried (tests). */
    settled: () => sending,
  }
}
