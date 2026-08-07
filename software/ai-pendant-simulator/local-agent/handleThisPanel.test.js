import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/*
 * Set before the import: evidenceCapsules reads the environment on every call
 * to capsulesLocation(), so pointing it at a temp file here keeps the offline
 * recall path off the owner's real capsule store without deferring any import.
 * pageWatch.test.js does the same thing for the same reason.
 */
const EVIDENCE_DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-handle-this-panel-'))
process.env.PENDANT_EVIDENCE_STORE_PATH = path.join(EVIDENCE_DIRECTORY, 'capsules.json')

/*
 * Point the agent lookup at a closed port.
 *
 * panelPreflight consults the running agent over loopback when its in-process
 * view says offline, which is the whole fix for the bug where a non-agent
 * process saw a permanently disconnected browser. Left at the default, a test
 * run on this machine would reach the developer's real agent, discover their
 * real Safari, and start reading their real tabs. Connection-refused is both
 * hermetic and instant.
 */
process.env.LOCAL_AGENT_URL = 'http://127.0.0.1:1'

const { CORROBORATION, VERDICT } = await import('./handleThisReconcile.js')
const {
  DEFAULT_LENSES,
  LENSES,
  PANEL_ACTIONS,
  extractAnswer,
  inspectInParallel,
  panelPreflight,
  recallFromEvidence,
  scanOpenTabs,
} = await import('./handleThisPanel.js')

test.after(() => fs.rmSync(EVIDENCE_DIRECTORY, { force: true, recursive: true }))

const QUESTION = {
  key: 'order.total',
  prompt: 'the order total',
  labels: ['Order total'],
  patterns: [/grand total\s*\$?([\d.,]+)/i],
}

const ONLINE = {
  online: true,
  devices: [{ extensionId: 'ext-a', online: true, browserName: 'Safari', tabCount: 3 }],
}

/*
 * The extension result shape, as browserPage.runBrowserActions returns it.
 *
 * The hash is a real digest of the content, not a stand-in. evidenceCapsules
 * content-addresses for real, and a fixture that hashed by length would make
 * two different readings of the same length look byte-identical — which is the
 * difference between a region conflict and an interpretation one.
 */
const digest = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`

const lensResult = (content, evidence = {}) => ({
  ok: true,
  message: 'read',
  error: null,
  data: {
    content,
    url: 'https://shop.example.com/orders/1',
    title: 'Order A-771',
    evidence: {
      capsuleId: `cap_${digest(content).slice(7, 19)}`,
      contentHash: digest(content),
      state: 'live',
      confidence: { score: 1, reasons: [] },
      ...evidence,
    },
    provenance: { extensionId: 'ext-a', url: 'https://shop.example.com/orders/1' },
  },
})

/* --------------------------------------------------------------- the lenses */

test('no lens can act on a page', () => {
  /* Structural, not a promise: browserPage.runBrowserActions throws before the
   * trip on anything outside this set, so a submit is unreachable from here
   * even for a caller that asks for one. */
  for (const forbidden of ['click', 'type', 'select', 'press_key', 'scroll']) {
    assert.equal(PANEL_ACTIONS.has(forbidden), false, `${forbidden} must not be reachable`)
  }
  assert.ok(PANEL_ACTIONS.has('read_page'))
})

test('every default lens exists and reads a different part of the page', () => {
  const regions = DEFAULT_LENSES.map((name) => {
    assert.ok(LENSES[name], `${name} is not a lens`)
    return LENSES[name].region
  })
  assert.equal(new Set(regions).size, regions.length, 'two lenses on one region would agree by construction')
})

/* -------------------------------------------------------------- extraction */

test('a label picks up what follows it and stops at the end of the line', () => {
  const found = extractAnswer('Shipping: free\nOrder total: $41.98\nPaid with Visa', QUESTION)
  assert.equal(found.answer, '$41.98')
  assert.match(found.via, /label/)
  assert.match(found.excerpt, /Order total/)
})

test('a pattern beats no label, and a miss is null rather than a guess', () => {
  assert.equal(extractAnswer('Grand total $52.10', QUESTION).answer, '52.10')
  assert.equal(extractAnswer('nothing relevant here', QUESTION), null)
})

/* --------------------------------------------------------------- preflight */

test('two connected browsers is declared, because a disagreement might just be two logins', async () => {
  const preflight = await panelPreflight({
    status: {
      online: true,
      devices: [
        { extensionId: 'a', online: true, browserName: 'Safari' },
        { extensionId: 'b', online: true, browserName: 'Chrome' },
      ],
    },
  })

  assert.equal(preflight.devices.length, 2)
  assert.match(preflight.caveats[0], /two login states/)
})

test('an unreachable agent is offline, not a crash', async () => {
  /*
   * REGRESSION, found live. panelPreflight used to read browserBridge's
   * in-process heartbeat map directly, which is only truthful inside the agent
   * process. Run anywhere else it reported `online: false` forever — while the
   * very same module's tab scan, which goes over loopback to the agent, was
   * happily listing the owner's three real Safari tabs. A panel that can see
   * your tabs and simultaneously believes your browser is disconnected answers
   * every question from cache and never says why.
   *
   * LOCAL_AGENT_URL points at a closed port for this whole file, so this
   * exercises the fallback: no agent reachable, and offline is the answer
   * rather than a thrown fetch error.
   */
  const preflight = await panelPreflight()
  assert.equal(preflight.online, false)
  assert.deepEqual(preflight.devices, [])
})

/* -------------------------------------------------------------- inspection */

test('all the lenses ride one fetch, addressed by url and never by tab id', async (t) => {
  const calls = []
  const outcome = await inspectInParallel(
    { url: 'https://shop.example.com/orders/1', questions: [QUESTION] },
    {
      status: ONLINE,
      address: async () => ({
        target: { urlContains: 'shop.example.com/orders/1' },
        url: 'https://shop.example.com/orders/1',
        disposition: 'reloaded',
      }),
      run: async (batch, options) => {
        calls.push({ batch, options })
        return batch.map(() => lensResult('Order total: $41.98'))
      },
    },
  )

  assert.equal(calls.length, 1, 'one batched /execute for the whole panel, not one per lens')
  assert.equal(calls[0].batch.length, DEFAULT_LENSES.length)
  for (const action of calls[0].batch) {
    assert.equal(action.params.urlContains, 'shop.example.com/orders/1')
    assert.equal(action.params.tabId, undefined, 'Safari renumbers tab ids between commands')
  }
  /*
   * One urlContains across the batch is also what gets the whole panel onto one
   * browser: browserBridge derives its session id from exactly that needle, so
   * the reads share a session and its affinity.
   */
  assert.equal(new Set(calls[0].batch.map((action) => action.params.urlContains)).size, 1)
  assert.equal(outcome.status, 'inspected')
  t.diagnostic(outcome.verdicts[0].narrative)
})

test('lenses that read the same bytes agree without earning independent corroboration', async () => {
  const outcome = await inspectInParallel(
    { url: 'https://shop.example.com/orders/1', questions: [QUESTION] },
    {
      status: ONLINE,
      address: async () => ({ target: { urlContains: 'x' }, url: 'https://shop.example.com/orders/1' }),
      /* Identical text from every lens — so identical content hashes. */
      run: async (batch) => batch.map(() => lensResult('Order total: $41.98')),
    },
  )

  const [verdict] = outcome.verdicts
  assert.equal(verdict.status, VERDICT.agreed)
  assert.equal(verdict.answer, '$41.98')
  assert.equal(verdict.corroboration, CORROBORATION.sameSource)
  assert.equal(verdict.distinctEvidence, 1)
})

test('a total in the footer that main_text cannot see is reported as a disagreement', async () => {
  /*
   * The real case this panel is for. <main> says one number, a sticky cart
   * summary in the footer says another, and body.innerText sees both. A single
   * reader picks whichever lens it happened to use and is confidently wrong
   * half the time.
   */
  const byLens = {
    'main-text': 'Order total: $41.98',
    'full-text': 'Order total: $52.10',
    landmarks: 'h1: Your order',
  }

  const outcome = await inspectInParallel(
    { url: 'https://shop.example.com/orders/1', questions: [QUESTION] },
    {
      status: ONLINE,
      address: async () => ({ target: { urlContains: 'x' }, url: 'https://shop.example.com/orders/1' }),
      run: async (batch) =>
        batch.map((action) => lensResult(byLens[action.label.split(': ')[1]] ?? '')),
    },
  )

  const [verdict] = outcome.verdicts
  assert.equal(verdict.status, VERDICT.disputed)
  assert.equal(verdict.answer, null)
  assert.equal(verdict.conflict.kind, 'region')
  assert.deepEqual(verdict.conflict.sides.map((side) => side.answer).sort(), ['$41.98', '$52.10'])
  /* The lens that saw nothing is silent, not a third opinion. */
  assert.deepEqual(verdict.silent.map((entry) => entry.inspector), ['landmarks'])
})

test('a lens that fails is recorded as inadmissible rather than dropped', async () => {
  const outcome = await inspectInParallel(
    { url: 'https://shop.example.com/orders/1', questions: [QUESTION] },
    {
      status: ONLINE,
      address: async () => ({ target: { urlContains: 'x' }, url: 'https://shop.example.com/orders/1' }),
      run: async (batch) =>
        batch.map((action, index) =>
          index === 0
            ? { ok: false, error: 'the tab went away', data: null }
            : lensResult('Order total: $41.98'),
        ),
    },
  )

  const [verdict] = outcome.verdicts
  assert.equal(verdict.inadmissible.length, 1)
  assert.match(verdict.inadmissible[0].reason, /the read itself failed/)
})

test('a reading with no capsule is answered but its agreement is called unverified', async () => {
  const outcome = await inspectInParallel(
    { url: 'https://shop.example.com/orders/1', questions: [QUESTION] },
    {
      status: ONLINE,
      address: async () => ({ target: { urlContains: 'x' }, url: 'https://shop.example.com/orders/1' }),
      /* An older extension mints nothing, which is the state this project's
       * own live server was in while this was written. */
      run: async (batch) =>
        batch.map(() => ({
          ok: true,
          data: { content: 'Order total: $41.98', url: 'https://shop.example.com/orders/1' },
        })),
    },
  )

  assert.equal(outcome.verdicts[0].corroboration, CORROBORATION.unverified)
  assert.match(outcome.caveats.join(' '), /no way to prove they read different text/)
})

/* ----------------------------------------------------------------- offline */

test('an offline browser gets no queued commands at all', async () => {
  let ran = false

  const outcome = await inspectInParallel(
    { url: 'https://shop.example.com/orders/1', questions: [QUESTION] },
    {
      status: { online: false, devices: [] },
      address: async () => {
        ran = true
        return {}
      },
      run: async () => {
        ran = true
        return []
      },
    },
  )

  /*
   * Not "queue it and answer when Safari comes back". browserBridge documents
   * where that goes: the command outlives the caller and the next extension to
   * connect runs it, opening tabs hours later with nothing to return them to.
   */
  assert.equal(ran, false, 'nothing may be queued for a browser that is not there')
  assert.equal(outcome.status, 'recalled')
  assert.match(outcome.caveats.join(' '), /Nothing was queued for the browser/)
})

test('recalled evidence is dated by when the text was first seen, and says so', () => {
  const recalled = recallFromEvidence(
    { questions: [QUESTION], hosts: ['shop.example.com'] },
    {
      list: () => [
        {
          capsuleId: 'cap_old',
          contentHash: 'sha256:old',
          state: 'live',
          content: 'Order total: $41.98',
          source: { url: 'https://shop.example.com/orders/1', host: 'shop.example.com' },
          region: { kind: 'main_text', selector: null },
          capturedAt: '2026-07-01T09:00:00.000Z',
          confidence: { score: 1, reasons: [] },
        },
      ],
    },
  )

  assert.equal(recalled.length, 1)
  assert.equal(recalled[0].answer, '$41.98')
  assert.equal(recalled[0].live, false)
  /* capturedAt is FIRST-seen, never last-fetched. Using it as freshness is the
   * one trap evidenceCapsules calls out, so offline readings carry it as an age
   * and are labelled rather than presented as current. */
  assert.equal(recalled[0].observedAt, '2026-07-01T09:00:00.000Z')
  assert.equal(recalled[0].inspector, 'recalled:main_text')
})

/* ---------------------------------------------------------------- the tabs */

test('the tab scan reads only what is already open, and never a search page', async () => {
  const { tabs, skipped } = await scanOpenTabs(
    {},
    {
      run: async () => [
        {
          ok: true,
          data: {
            tabs: [
              { url: 'https://shop.example.com/orders/1', title: 'Order' },
              { url: 'https://www.google.com/search?q=order+total', title: 'order total - Google' },
              { url: 'about:blank', title: 'New Tab' },
            ],
          },
        },
      ],
    },
  )

  assert.deepEqual(tabs.map((tab) => tab.host), ['shop.example.com'])
  assert.equal(tabs[0].needle, 'shop.example.com/orders/1')
  assert.match(
    skipped.find((entry) => entry.url.includes('google')).why,
    /search page is not evidence/,
  )
  assert.equal(skipped.length, 2)
})

test('the scan honours the origins it was scoped to', async () => {
  const { tabs, skipped } = await scanOpenTabs(
    { origins: ['https://shop.example.com'] },
    {
      run: async () => [
        {
          ok: true,
          data: {
            tabs: [
              { url: 'https://shop.example.com/orders/1' },
              { url: 'https://mail.google.com/mail/u/0/#inbox' },
            ],
          },
        },
      ],
    },
  )

  assert.equal(tabs.length, 1)
  assert.match(skipped[0].why, /outside the origins/)
})
