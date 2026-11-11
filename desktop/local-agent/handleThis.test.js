import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/* Keep the offline recall path off the owner's real capsule store. */
const EVIDENCE_DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-handle-this-'))
process.env.PENDANT_EVIDENCE_STORE_PATH = path.join(EVIDENCE_DIRECTORY, 'capsules.json')
/* A closed port, so nothing here reaches the developer's running agent. */
process.env.LOCAL_AGENT_URL = 'http://127.0.0.1:1'

const { VERDICT } = await import('./handleThisReconcile.js')
const {
  describeInvestigation,
  gatherAcrossTabs,
  getInvestigation,
  handleThis,
  listInvestigations,
  normalizeQuestions,
  willHappen,
} = await import('./handleThis.js')

test.after(() => fs.rmSync(EVIDENCE_DIRECTORY, { force: true, recursive: true }))

function withTemporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-handle-this-store-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  return path.join(directory, 'handle-this.json')
}

const digest = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`

const QUESTIONS = [
  { key: 'order.total', prompt: 'the order total', labels: ['Order total'] },
  { key: 'order.id', prompt: 'the order number', labels: ['Order number'] },
]

const ONLINE = {
  online: true,
  devices: [{ extensionId: 'ext-a', online: true, browserName: 'Safari', tabCount: 3 }],
}

/* One lens's reading of one page, in the shape inspectInParallel emits. */
const reading = (inspector, questionKey, answer, url, region = 'main_text') => ({
  inspector,
  questionKey,
  answer,
  excerpt: answer ? `…${answer}…` : null,
  capsuleId: `cap_${digest(`${url}${region}${answer}`).slice(7, 19)}`,
  contentHash: digest(`${url}|${region}|${answer}`),
  capsuleState: 'live',
  confidence: { score: 1, reasons: [] },
  sourceKey: url.replace('https://', ''),
  sourceUrl: url,
  regionKey: `${region}|`,
  observedAt: '2026-08-07T10:00:00.000Z',
  error: null,
})

/* A stand-in panel: whatever readings the test wants, per page. */
const panelReturning = (byUrl) => async ({ url, questions }) => ({
  status: 'inspected',
  url,
  disposition: 'reloaded',
  lenses: ['main-text', 'full-text'],
  readings: (byUrl[url] ?? []).filter((entry) =>
    questions.some((question) => question.key === entry.questionKey),
  ),
  caveats: [],
})

const tabsReturning = (urls) => async () => ({
  tabs: urls.map((url) => ({ url, host: new URL(url).host, origin: new URL(url).origin })),
  skipped: [],
})

/* -------------------------------------------------------------- questions */

test('a question with no way to match anything is refused up front', () => {
  assert.throws(
    () => normalizeQuestions([{ key: 'order.total' }]),
    /no patterns and no labels/,
  )
  assert.throws(() => normalizeQuestions([]), /at least one question/i)
})

/* -------------------------------------------------------------- gathering */

test('readings from different tabs are pooled, so two tabs disagreeing is visible', async () => {
  /*
   * Reconciling per page and merging the page answers afterwards would report
   * two confident totals and let the last merge win. Pooled, the two tabs are
   * two sides of one conflict with their evidence attached, which is the true
   * shape of "your shop and your bank say different things".
   */
  const shop = 'https://shop.example.com/orders/1'
  const bank = 'https://bank.example.com/activity'

  const investigation = await gatherAcrossTabs(
    { ask: 'handle this', questions: QUESTIONS, anchorUrl: shop },
    {
      status: ONLINE,
      scan: tabsReturning([bank]),
      inspect: panelReturning({
        [shop]: [
          reading('main-text', 'order.total', '$41.98', shop),
          reading('full-text', 'order.total', '$41.98', shop, 'text'),
          reading('main-text', 'order.id', 'A-771', shop),
        ],
        [bank]: [
          reading('main-text', 'order.total', '$52.10', bank),
          reading('main-text', 'order.id', 'A-771', bank),
        ],
      }),
    },
  )

  const total = investigation.verdicts.find((item) => item.questionKey === 'order.total')
  assert.equal(total.status, VERDICT.disputed)
  assert.equal(total.answer, null)
  assert.equal(total.conflict.kind, 'page')

  /* The order number is corroborated across two genuinely different pages. */
  const id = investigation.verdicts.find((item) => item.questionKey === 'order.id')
  assert.equal(id.status, VERDICT.agreed)
  assert.equal(id.answer, 'A-771')
  assert.equal(id.corroboration, 'independent')
  assert.deepEqual(investigation.disputed, ['order.total'])
})

test('the anchor page is not inspected twice when it is also an open tab', async () => {
  /* Two inspections of one page is precisely the fake corroboration the whole
   * reconciler is built to refuse, so it must not be manufactured here. */
  const shop = 'https://shop.example.com/orders/1'
  const inspected = []

  await gatherAcrossTabs(
    { questions: QUESTIONS, anchorUrl: shop },
    {
      status: ONLINE,
      scan: tabsReturning([shop, 'https://shop.example.com/orders/1?utm=mail']),
      inspect: async ({ url }) => {
        inspected.push(url)
        return { url, readings: [], lenses: [], caveats: [] }
      },
    },
  )

  assert.deepEqual(inspected, [shop], 'one page, one inspection, however many tabs show it')
})

test('a source that could not be read is reported, not silently dropped', async () => {
  const shop = 'https://shop.example.com/orders/1'
  const dead = 'https://bank.example.com/activity'

  const investigation = await gatherAcrossTabs(
    { questions: QUESTIONS, anchorUrl: shop },
    {
      status: ONLINE,
      scan: tabsReturning([dead]),
      inspect: async ({ url }) => {
        if (url === dead) throw new Error('No matching browser tab is available')
        return {
          url,
          lenses: ['main-text'],
          caveats: [],
          readings: [reading('main-text', 'order.total', '$41.98', url)],
        }
      },
    },
  )

  const failed = investigation.sources.find((source) => !source.ok)
  assert.equal(failed.url, dead)
  assert.match(investigation.caveats.join(' '), /could not be read/)
  /* A two-source question that became a one-source question must not still be
   * described as corroborated. */
  const total = investigation.verdicts.find((item) => item.questionKey === 'order.total')
  assert.equal(total.status, VERDICT.single)
})

test('with no browser connected nothing is scanned and nothing is queued', async () => {
  let touched = false

  const investigation = await gatherAcrossTabs(
    { questions: QUESTIONS, anchorUrl: 'https://shop.example.com/orders/1' },
    {
      status: { online: false, devices: [] },
      scan: async () => {
        touched = true
        return { tabs: [], skipped: [] }
      },
    },
  )

  assert.equal(touched, false)
  assert.equal(investigation.status, 'recalled')
  assert.deepEqual(investigation.sources, [])
})

/* ---------------------------------------------------------------- the report */

test('the report names the disagreements as the finding, not as a footnote', async () => {
  const shop = 'https://shop.example.com/orders/1'
  const bank = 'https://bank.example.com/activity'

  const investigation = await gatherAcrossTabs(
    { questions: QUESTIONS, anchorUrl: shop },
    {
      status: ONLINE,
      scan: tabsReturning([bank]),
      inspect: panelReturning({
        [shop]: [reading('main-text', 'order.total', '$41.98', shop)],
        [bank]: [reading('main-text', 'order.total', '$52.10', bank)],
      }),
    },
  )

  const report = describeInvestigation(investigation)
  assert.match(report, /They disagree on 1:/)
  assert.match(report, /\$41\.98/)
  assert.match(report, /\$52\.10/)
  assert.match(report, /shop\.example\.com/)
  assert.match(report, /bank\.example\.com/)
})

/* -------------------------------------------------------------- the drafting */

test('a disputed value never reaches the form, and the form says which one', async (t) => {
  const filePath = withTemporaryStore(t)
  const shop = 'https://shop.example.com/orders/1'
  const bank = 'https://bank.example.com/activity'
  let filled = null

  const outcome = await handleThis(
    {
      ask: 'refund this order',
      questions: QUESTIONS,
      anchorUrl: shop,
      form: {
        url: 'https://shop.example.com/refunds/new',
        fields: { amount: 'order.total', order_number: 'order.id' },
      },
    },
    {
      filePath,
      status: ONLINE,
      scan: tabsReturning([bank]),
      inspect: panelReturning({
        [shop]: [
          reading('main-text', 'order.total', '$41.98', shop),
          reading('main-text', 'order.id', 'A-771', shop),
        ],
        [bank]: [
          reading('main-text', 'order.total', '$52.10', bank),
          reading('main-text', 'order.id', 'A-771', bank),
        ],
      }),
      prepareForm: async (request) => {
        filled = request
        return {
          id: 'fpv_1',
          status: 'awaiting-approval',
          payload: { text: 'amount=&order_number=A-771', sha256: 'abc', complete: false },
          approval: { required: true, status: 'pending', confirm: '1234' },
          caveats: [],
        }
      },
    },
  )

  /*
   * The join between the two halves. The total was disputed, so it is simply
   * not a value — not a filled field with a warning beside it, because the
   * warning lives in a preview the owner skims and the field is what gets
   * submitted.
   */
  assert.ok(!Object.hasOwn(filled.values, 'amount'), 'a disputed value must not be filled')
  assert.equal(filled.values.order_number, 'A-771')
  assert.match(filled.note, /Left blank because the readings did not settle: amount/)

  const blocked = outcome.blocked.find((entry) => entry.field === 'amount')
  assert.equal(blocked.questionKey, 'order.total')
  assert.match(blocked.narrative, /unsettled/)

  t.diagnostic(outcome.report)
})

test('a settled value carries the capsules it is standing on', async (t) => {
  const filePath = withTemporaryStore(t)
  const shop = 'https://shop.example.com/orders/1'

  const outcome = await handleThis(
    {
      questions: QUESTIONS,
      anchorUrl: shop,
      form: { url: 'https://shop.example.com/refunds/new', fields: { order_number: 'order.id' } },
    },
    {
      filePath,
      status: ONLINE,
      scan: tabsReturning([]),
      inspect: panelReturning({
        [shop]: [
          reading('main-text', 'order.id', 'A-771', shop),
          reading('full-text', 'order.id', 'A-771', shop, 'text'),
        ],
      }),
      prepareForm: async () => ({
        id: 'fpv_2',
        status: 'awaiting-approval',
        payload: { text: 'order_number=A-771', sha256: 'abc' },
        approval: { required: true, confirm: '1234' },
        caveats: [],
      }),
    },
  )

  const [standing] = outcome.draft.standingOn
  assert.equal(standing.field, 'order_number')
  assert.equal(standing.value, 'A-771')
  assert.equal(standing.corroboration, 'independent')
  assert.equal(standing.capsuleIds.length, 2, '"why is that in the form" resolves to capsules')
  t.diagnostic(JSON.stringify(standing.readBy))
})

test('an unsettled placeholder stays visibly unresolved in a drafted message', async (t) => {
  const filePath = withTemporaryStore(t)
  const shop = 'https://shop.example.com/orders/1'
  const bank = 'https://bank.example.com/activity'
  let drafted = null

  await handleThis(
    {
      questions: QUESTIONS,
      anchorUrl: shop,
      message: {
        to: 'support@shop.example.com',
        subject: 'Order {{order.id}}',
        body: 'Please refund {{order.total}} on order {{order.id}}.',
        fields: { 'order.total': 'order.total', 'order.id': 'order.id' },
      },
    },
    {
      filePath,
      status: ONLINE,
      scan: tabsReturning([bank]),
      inspect: panelReturning({
        [shop]: [
          reading('main-text', 'order.total', '$41.98', shop),
          reading('main-text', 'order.id', 'A-771', shop),
        ],
        [bank]: [reading('main-text', 'order.total', '$52.10', bank)],
      }),
      prepareMessage: async (request) => {
        drafted = request
        return {
          id: 'fpv_3',
          status: 'awaiting-approval',
          payload: { text: 'draft', sha256: 'abc' },
          approval: { required: true, confirm: '1234' },
          caveats: [],
        }
      },
    },
  )

  /*
   * formPreview resolves placeholders from `values` and deliberately leaves an
   * unresolved one visible. Withholding the disputed key here is therefore all
   * it takes: the owner reads "Please refund {{order.total}}" and cannot
   * approve past it by accident, which is strictly better than a plausible
   * number two of their tabs disagreed about.
   */
  assert.ok(!Object.hasOwn(drafted.values, 'order.total'))
  assert.equal(drafted.values['order.id'], 'A-771')
  t.diagnostic(JSON.stringify(drafted.values))
})

test('nothing is drafted at all when not one value came back settled', async (t) => {
  const filePath = withTemporaryStore(t)
  const shop = 'https://shop.example.com/orders/1'
  const bank = 'https://bank.example.com/activity'
  let prepared = false

  const outcome = await handleThis(
    {
      questions: [QUESTIONS[0]],
      anchorUrl: shop,
      form: { url: 'https://shop.example.com/refunds/new', fields: { amount: 'order.total' } },
    },
    {
      filePath,
      status: ONLINE,
      scan: tabsReturning([bank]),
      inspect: panelReturning({
        [shop]: [reading('main-text', 'order.total', '$41.98', shop)],
        [bank]: [reading('main-text', 'order.total', '$52.10', bank)],
      }),
      prepareForm: async () => {
        prepared = true
        return {}
      },
    },
  )

  /* An approval prompt whose entire content is missing trains exactly the
   * reflex this flow depends on the owner not having. */
  assert.equal(prepared, false)
  assert.equal(outcome.status, 'blocked')
  assert.equal(outcome.draft, null)
  assert.match(outcome.caveats.join(' '), /not one of the values this needed came back settled/)
})

/* ------------------------------------------------------------ never submits */

test('nothing is ever submitted, and the record says so on its face', async (t) => {
  const filePath = withTemporaryStore(t)
  const shop = 'https://shop.example.com/orders/1'

  const outcome = await handleThis(
    {
      questions: [QUESTIONS[1]],
      anchorUrl: shop,
      form: { url: 'https://shop.example.com/refunds/new', fields: { order_number: 'order.id' } },
    },
    {
      filePath,
      status: ONLINE,
      scan: tabsReturning([]),
      inspect: panelReturning({
        [shop]: [reading('main-text', 'order.id', 'A-771', shop)],
      }),
      prepareForm: async () => ({
        id: 'fpv_4',
        status: 'awaiting-approval',
        payload: { text: 'order_number=A-771', sha256: 'abc' },
        approval: { required: true, status: 'pending', confirm: '1234' },
        caveats: [],
      }),
    },
  )

  assert.equal(outcome.submitted, false)
  assert.equal(outcome.draft.status, 'awaiting-approval')

  const next = outcome.willHappen
  assert.equal(next.submitted, false)
  assert.match(next.soFar, /Nothing was submitted/)
  assert.match(next.awaiting, /confirm code/)
  assert.ok(next.payload, 'the literal payload comes from formPreview, not from a second rendering')
})

test('an investigation with no form and no message reads pages and stops', async (t) => {
  const filePath = withTemporaryStore(t)
  const shop = 'https://shop.example.com/orders/1'

  const outcome = await handleThis(
    { ask: 'what does this say', questions: [QUESTIONS[0]], anchorUrl: shop },
    {
      filePath,
      status: ONLINE,
      scan: tabsReturning([]),
      inspect: panelReturning({
        [shop]: [reading('main-text', 'order.total', '$41.98', shop)],
      }),
    },
  )

  assert.equal(outcome.draft, null)
  assert.equal(willHappen(outcome).soFar, 'Pages were read. Nothing was filled, drafted, or sent.')
})

test('a draft that could not be made leaves nothing filled and says why', async (t) => {
  const filePath = withTemporaryStore(t)
  const shop = 'https://shop.example.com/orders/1'

  const outcome = await handleThis(
    {
      questions: [QUESTIONS[1]],
      anchorUrl: shop,
      form: { url: 'https://shop.example.com/refunds/new', fields: { order_number: 'order.id' } },
    },
    {
      filePath,
      status: ONLINE,
      scan: tabsReturning([]),
      inspect: panelReturning({ [shop]: [reading('main-text', 'order.id', 'A-771', shop)] }),
      prepareForm: async () => {
        throw new Error('the refund page has no form')
      },
    },
  )

  assert.equal(outcome.status, 'draft-failed')
  assert.equal(outcome.draft, null)
  assert.equal(outcome.submitted, false)
  assert.match(outcome.caveats.join(' '), /Nothing was filled and nothing was sent/)
})

test('one act at a time', async (t) => {
  await assert.rejects(
    () =>
      handleThis(
        { questions: QUESTIONS, form: { url: 'https://x.example.com/' }, message: { to: 'a@b.c' } },
        { filePath: withTemporaryStore(t) },
      ),
    /One act at a time/,
  )
})

/* -------------------------------------------------------------- persistence */

test('an investigation is kept so "why did it fill that" is answerable later', async (t) => {
  const filePath = withTemporaryStore(t)
  const shop = 'https://shop.example.com/orders/1'

  const outcome = await handleThis(
    { ask: 'handle this', questions: [QUESTIONS[0]], anchorUrl: shop },
    {
      filePath,
      status: ONLINE,
      scan: tabsReturning([]),
      inspect: panelReturning({
        [shop]: [reading('main-text', 'order.total', '$41.98', shop)],
      }),
    },
  )

  const stored = getInvestigation(outcome.investigationId, { filePath })
  assert.equal(stored.ask, 'handle this')
  assert.equal(stored.submitted, false)
  assert.equal(stored.readings[0].capsuleId, outcome.readings[0].capsuleId)
  assert.equal(listInvestigations({ limit: 5 }, { filePath }).length, 1)
})
