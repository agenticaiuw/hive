import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExecutionJournal } from '../src/execution-status.js'
import { mirrorRunsToBoard } from '../src/board-runs.js'
import { BOARD_KEY } from '../src/page-rules-core.js'

/** storage.local's get/set shape over a plain map. */
function fakeStorage(data = {}) {
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]))
    },
    async set(values) {
      Object.assign(data, values)
    },
  }
}

function fakeBoard() {
  const posts = []
  let down = false
  return {
    posts,
    setDown: (value) => { down = value },
    fetchImpl: async (url, init) => {
      if (down) throw new TypeError('Failed to fetch')
      posts.push({ url, authorization: init.headers.authorization, body: JSON.parse(init.body) })
      return { ok: true, status: 200 }
    },
  }
}

test("this browser's agent runs reach the board as it runs them: begun, each step, how it ended", async () => {
  const storage = fakeStorage({ [BOARD_KEY]: { url: 'https://board.test', key: 'ext.chrome.abc' } })
  const board = fakeBoard()
  const journal = mirrorRunsToBoard(createExecutionJournal({ storage }), { storage, fetchImpl: board.fetchImpl })

  await journal.beginRun({ runId: 'r1', command: 'Summarize this page', route: 'local-brain' })
  await journal.settled()
  await journal.recordStep('r1', { tool: 'read_page', effect: 'read', ok: true, summary: 'Example Domain' })
  await journal.recordStep('r1', { tool: 'click', effect: 'page', ok: false, summary: 'No such button' })
  await journal.finishRun('r1', { state: 'finished', verdict: 'achieved', headline: 'It is the IANA example page.' })
  await journal.settled()

  assert.equal(board.posts[0].url, 'https://board.test/v1/runs')
  assert.equal(board.posts[0].authorization, 'Bearer ext.chrome.abc')
  assert.deepEqual(board.posts[0].body, { run: 'r1', agent: 'browser', title: 'Summarize this page', steps: [] })
  const steps = board.posts.flatMap((p) => p.body.steps.map((s) => [s.n, s.kind, s.text]))
  assert.deepEqual(steps, [
    [1, 'action', 'read_page: Example Domain'],
    [2, 'failed', 'click: No such button'],
    [3, 'done', 'It is the IANA example page.'],
  ])
  assert.equal(board.posts.at(-1).body.status, 'done')
  // The journal itself is untouched by the mirror.
  const [run] = (await journal.getStatus()).runs
  assert.equal(run.steps.length, 2)
  assert.equal(run.verdict, 'achieved')
})

test('a board that is away misses nothing it can get later, and a handed-off run reads as stopped', async () => {
  const storage = fakeStorage({ [BOARD_KEY]: { key: 'ext.safari.abc' } })
  const board = fakeBoard()
  const journal = mirrorRunsToBoard(createExecutionJournal({ storage }), { storage, fetchImpl: board.fetchImpl })
  board.setDown(true)
  await journal.beginRun({ runId: 'r2', command: 'Check my email' })
  await journal.recordStep('r2', { tool: 'memory_lookup', ok: true, summary: 'email/account.personal' })
  await journal.settled()
  assert.equal(board.posts.length, 0)
  board.setDown(false)
  await journal.finishRun('r2', { state: 'finished', verdict: 'handed-off', headline: 'Handed to the Mac: needs Mail' })
  await journal.settled()
  assert.equal(board.posts.length, 1)
  assert.match(board.posts[0].url, /\/v1\/runs$/)
  assert.deepEqual(board.posts[0].body, {
    run: 'r2', agent: 'browser', title: 'Check my email', status: 'stopped',
    steps: [
      { ...board.posts[0].body.steps[0], n: 1, kind: 'action', text: 'memory_lookup: email/account.personal' },
      { ...board.posts[0].body.steps[1], n: 2, kind: 'done', text: 'Handed to the Mac: needs Mail' },
    ],
  })
})

test('with no board key yet, runs go on and nothing is sent', async () => {
  const storage = fakeStorage()
  const board = fakeBoard()
  const journal = mirrorRunsToBoard(createExecutionJournal({ storage }), { storage, fetchImpl: board.fetchImpl })
  await journal.beginRun({ runId: 'r3', command: 'x' })
  await journal.finishRun('r3', { state: 'failed', verdict: 'failed', headline: 'Stopped' })
  await journal.settled()
  assert.equal(board.posts.length, 0)
  assert.equal((await journal.getStatus()).runs[0].state, 'failed')
})

test('a task handed to this browser lands in the run it came on, numbered on from its last step', async () => {
  const storage = fakeStorage({ [BOARD_KEY]: { url: 'https://board.test', key: 'ext.mac-browser.abc' } })
  const board = fakeBoard()
  const journal = mirrorRunsToBoard(createExecutionJournal({ storage }), { storage, fetchImpl: board.fetchImpl })

  // The first message on a run the Mac made for it: steps from 1, under the board's run id, its title kept.
  await journal.link('local-a', 'handoff-7')
  await journal.beginRun({ runId: 'local-a', command: 'Find my Canvas grades' })
  await journal.recordStep('local-a', { tool: 'navigate', ok: true, summary: 'canvas.test' })
  await journal.finishRun('local-a', { state: 'finished', verdict: 'achieved', headline: 'A in CS 400.' })
  await journal.settled()
  assert.ok(board.posts.every((p) => p.body.run === 'handoff-7' && p.body.title === ''))
  assert.equal(board.posts[0].body.status, 'working')
  assert.equal(board.posts.at(-1).body.status, 'done')

  // The owner says more on that run, from a new context: it carries on at step 3 and works again.
  const later = mirrorRunsToBoard(createExecutionJournal({ storage }), { storage, fetchImpl: board.fetchImpl })
  board.posts.length = 0
  await later.link('local-b', 'handoff-7')
  await later.beginRun({ runId: 'local-b', command: 'and email them to me' })
  await later.recordStep('local-b', { tool: 'read_page', ok: true, summary: 'grades' })
  await later.settled()
  assert.equal(board.posts[0].body.status, 'working')
  assert.deepEqual(board.posts.flatMap((p) => p.body.steps.map((s) => [s.n, s.text])), [[3, 'read_page: grades']])
  assert.ok(board.posts.every((p) => p.body.run === 'handoff-7'))
})
