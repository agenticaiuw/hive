import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DRAFTED_BUCKETS,
  MAIL_TRIAGE_BUCKETS,
  assertScriptNeverSends,
  classifyMessage,
  cleanBody,
  draftReplies,
  formatReview,
  matchMailTriageCommand,
  parseEnvelopes,
  templateDraft,
  triageInbox,
} from './mailTriage.js'

const NOW = new Date('2026-08-07T09:00:00')

const FIELD = String.fromCharCode(31)
const RECORD = String.fromCharCode(30)

function envelopeRow({
  account = 'iCloud',
  owner = 'Evan Liu',
  index = 1,
  receivedAt = '2026-08-07T08:30:00',
  read = 'false',
  sender = 'Dana Vogel <dana@lab.example>',
  messageId = '<abc@lab.example>',
  subject = 'Probe rerun',
}) {
  return [account, owner, index, receivedAt, read, sender, messageId, subject].join(FIELD)
}

function message(overrides = {}) {
  return {
    account: 'iCloud',
    accountOwner: 'Evan Liu',
    index: 1,
    receivedAt: '2026-08-07T08:30:00',
    read: false,
    sender: 'Dana Vogel <dana@lab.example>',
    messageId: '<abc@lab.example>',
    subject: 'Probe rerun',
    ...overrides,
  }
}

/* ---------- the read ---------- */

test('the envelope read keeps only unread mail inside the date window', () => {
  const stdout = [
    envelopeRow({ index: 1, receivedAt: '2026-08-07T08:30:00' }),
    envelopeRow({ index: 2, receivedAt: '2026-08-07T07:00:00', read: 'true', subject: 'Already read' }),
    envelopeRow({ index: 3, receivedAt: '2026-06-01T09:00:00', subject: 'Ancient' }),
    envelopeRow({ index: 4, receivedAt: '2026-08-06T22:00:00', subject: 'Yesterday evening' }),
  ].join(RECORD)

  const parsed = parseEnvelopes(stdout, {
    floor: new Date('2026-08-04T09:00:00'),
  })

  assert.deepEqual(
    parsed.map((entry) => entry.subject),
    ['Probe rerun', 'Yesterday evening'],
  )
  /* Newest first: the review list is read from the top. */
  assert.equal(parsed[0].index, 1)
  assert.equal(parsed[0].accountOwner, 'Evan Liu')
})

test('a subject containing tabs and commas survives the delimiters', () => {
  const subject = 'Re: budget\tv2, final — please\treview'
  const parsed = parseEnvelopes(envelopeRow({ subject }), {})
  assert.equal(parsed[0].subject, subject)
})

test('mail whose timestamp cannot be parsed is kept rather than silently dropped', () => {
  const parsed = parseEnvelopes(envelopeRow({ receivedAt: 'not-a-date' }), {
    floor: new Date('2026-08-04T09:00:00'),
  })
  assert.equal(parsed.length, 1)
})

/* ---------- classification ---------- */

test('the four buckets are the four the owner named', () => {
  assert.deepEqual([...MAIL_TRIAGE_BUCKETS], ['urgent', 'reply-soon', 'reference', 'noise'])
  assert.deepEqual([...DRAFTED_BUCKETS], ['urgent', 'reply-soon'])
})

test('a person naming a deadline is urgent', () => {
  const { bucket, reasons } = classifyMessage(
    message({ subject: 'Action required: sign the lease by Friday' }),
    { now: NOW },
  )
  assert.equal(bucket, 'urgent')
  assert.match(reasons.join(' '), /deadline/i)
})

test('a person asking a question is reply-soon', () => {
  assert.equal(
    classifyMessage(message({ subject: 'Can you review the BOM?' }), { now: NOW }).bucket,
    'reply-soon',
  )
  assert.equal(
    classifyMessage(message({ subject: 'Re: pendant enclosure' }), { now: NOW }).bucket,
    'reply-soon',
  )
})

test('a receipt from a no-reply address is reference, never a draft', () => {
  const { bucket, reasons } = classifyMessage(
    message({
      sender: 'Amazon <no-reply@amazon.com>',
      subject: 'Your order has shipped',
    }),
    { now: NOW },
  )
  assert.equal(bucket, 'reference')
  assert.ok(!DRAFTED_BUCKETS.includes(bucket))
  assert.match(reasons.join(' '), /nothing to reply to/i)
})

test('marketing is noise even when it is shouting about a deadline', () => {
  /* The deadline words are the whole trick in promo mail. Reply-ability and
   * marketing shape are both decided before urgency for exactly this case. */
  assert.equal(
    classifyMessage(
      message({
        sender: 'REI <deals@notifications.rei.com>',
        subject: 'Last chance: 40% off ends tonight',
      }),
      { now: NOW },
    ).bucket,
    'noise',
  )
})

test('a stranger with nothing to answer is filed, not thrown away', () => {
  assert.equal(
    classifyMessage(
      message({ sender: 'Registrar <registrar@wisc.edu>', subject: 'Fall term dates' }),
      { now: NOW },
    ).bucket,
    'reference',
  )
})

/*
 * Envelopes copied verbatim out of the first run against this Mac's real
 * inbox. Two of them were filed wrong, and the shape of the mistake is not
 * something a made-up fixture would have produced: a Hide My Email relay hides
 * the fact that a promo is automated, and a bulk DOMAIN is not the same claim
 * as a marketing SENDER.
 */
test('the real inbox: promos behind a Hide My Email relay are noise, not reference', () => {
  const relayed = message({
    sender:
      '"Rappi" <rappi_at_hello_rappi_com_mx_6s8c57w82c_21669c14@privaterelay.appleid.com>',
    subject: 'La comida mejor rankeada de tu zona',
  })
  const result = classifyMessage(relayed, { now: NOW })
  assert.equal(result.bucket, 'noise')
  /* And crucially: never a draft addressed to a relay nobody reads. */
  assert.ok(!DRAFTED_BUCKETS.includes(result.bucket))
})

test('the real inbox: a subscription expiring is a record, not an advert', () => {
  assert.equal(
    classifyMessage(
      message({ sender: 'Apple <no_reply@email.apple.com>', subject: 'Your Subscription is Expiring' }),
      { now: NOW },
    ).bucket,
    'reference',
  )
})

test('the real inbox: an offer from the same bulk domain is still noise', () => {
  assert.equal(
    classifyMessage(
      message({
        sender: 'Apple <News@InsideApple.Apple.com>',
        subject: 'Your $300 new Apple Card offer is waiting. Limited time only.',
      }),
      { now: NOW },
    ).bucket,
    'noise',
  )
})

test('the real inbox: newsletters and percentage-off blasts are noise', () => {
  for (const [sender, subject] of [
    [
      'Goodreads <no-reply_at_mail_goodreads_com_hnvnj2bg4b_e341c67c@privaterelay.appleid.com>',
      '\u{1F4DA} The Newsletter: What to Read This August',
    ],
    [
      'MuseScore <info_at_mail_musescore_com_s78s427yw2_26bfa8e4@privaterelay.appleid.com>',
      '[Last call] 90% off playing in the sun',
    ],
  ]) {
    assert.equal(classifyMessage(message({ sender, subject }), { now: NOW }).bucket, 'noise', subject)
  }
})

/*
 * The second real run drafted two replies to this sender. A rhetorical question
 * in an advert is not detectable as text; the address is.
 */
test('the real inbox: a rhetorical question from a role address earns no draft', () => {
  const promo = message({
    sender: 'Valerie from Holafly <community@team.holafly.com>',
    subject: 'What if your next destination is here?',
  })
  const result = classifyMessage(promo, { now: NOW })
  assert.ok(!DRAFTED_BUCKETS.includes(result.bucket), `got ${result.bucket}`)
  assert.match(result.reasons.join(' '), /role address/i)
})

test('the real inbox: a brand display name is not a person, whatever it asks', () => {
  const result = classifyMessage(
    message({
      sender: 'Premium★Tesla <Sales.SG@premiumtesla.com>',
      subject: 'Is your Tesla road-trip ready? \u{1F5FA}️',
    }),
    { now: NOW },
  )
  assert.ok(!DRAFTED_BUCKETS.includes(result.bucket), `got ${result.bucket}`)
})

test('a person with an ordinary name and an ordinary address still gets a draft', () => {
  /* The brand and role rules must not swallow the case they exist to protect. */
  for (const sender of [
    'Dana Vogel <dana@lab.example>',
    '"Liu, Evan" <evan@wisc.edu>',
    'jorge.peralta@partner.example',
  ]) {
    assert.equal(
      classifyMessage(message({ sender, subject: 'Can you look at this?' }), { now: NOW }).bucket,
      'reply-soon',
      sender,
    )
  }
})

test('a thread the owner started with a role address is still a conversation', () => {
  /* The owner wrote into the queue first, so there is something to reply to —
   * which is the whole distinction the role-address rule turns on. */
  assert.equal(
    classifyMessage(
      message({ sender: 'Support <support@vendor.example>', subject: 'Re: ticket 4471 — can you confirm?' }),
      { now: NOW },
    ).bucket,
    'reply-soon',
  )
})

test('a reason is never printed twice', () => {
  const { reasons } = classifyMessage(
    message({ sender: 'deals@shop.example', subject: '50% off — unsubscribe here' }),
    { now: NOW },
  )
  assert.equal(reasons.length, new Set(reasons).size)
})

test('every classification comes back with at least one reason', () => {
  const cases = [
    { subject: 'Deadline tomorrow' },
    { subject: 'Can you send it?' },
    { subject: 'Your receipt', sender: 'no-reply@shop.example' },
    { subject: '50% off everything' },
    { subject: 'Notes' },
  ]
  for (const overrides of cases) {
    const result = classifyMessage(message(overrides), { now: NOW })
    assert.ok(result.reasons.length > 0, JSON.stringify(overrides))
    assert.ok(MAIL_TRIAGE_BUCKETS.includes(result.bucket))
  }
})

/* ---------- never sends ---------- */

test('a Mail script containing the send verb never reaches osascript', () => {
  assert.throws(
    () => assertScriptNeverSends('tell application "Mail" to send outgoing message 1'),
    /never transmits/i,
  )
})

test('"sender" is not "send" — the guard does not block reading the envelope', () => {
  assert.equal(
    assertScriptNeverSends('set snds to sender of msgs\nset dts to date received of msgs'),
    true,
  )
})

test('triageInbox refuses a sink that transmits', async () => {
  await assert.rejects(
    triageInbox({ sinks: ['file', 'email'] }, { readEnvelopes: async () => [] }),
    /never sends/i,
  )
})

test('a completed run says, in the payload, that nothing was sent', async () => {
  const run = await triageInbox(
    { now: NOW, store: false },
    {
      readEnvelopes: async () => [message({ subject: 'Can you confirm Thursday?' })],
      readBodies: async () => new Map(),
      draft: async (candidates) =>
        candidates.map((candidate) => ({
          ...templateDraft(candidate),
          message: candidate,
          to: candidate.sender,
        })),
    },
  )
  assert.equal(run.sent, false)
  assert.match(run.review, /Nothing has been sent/i)
  assert.match(run.spoken, /Nothing was sent/i)
})

/* ---------- drafting ---------- */

test('drafts go to the top of the two reply buckets, urgent first', async () => {
  const drafted = []
  const run = await triageInbox(
    { now: NOW, store: false, maxDrafts: 2 },
    {
      readEnvelopes: async () => [
        message({ index: 1, subject: 'Quick question?', sender: 'Ana <ana@x.example>' }),
        message({ index: 2, subject: 'Deadline Friday: signature needed', sender: 'Bo <bo@x.example>' }),
        message({ index: 3, subject: 'Re: enclosure', sender: 'Cy <cy@x.example>' }),
        message({ index: 4, subject: '40% off', sender: 'shop@mail.example' }),
      ],
      readBodies: async () => new Map(),
      draft: async (candidates) => {
        drafted.push(...candidates.map((candidate) => candidate.subject))
        return candidates.map((candidate) => ({
          ...templateDraft(candidate),
          message: candidate,
          to: candidate.sender,
        }))
      },
    },
  )

  assert.equal(drafted.length, 2)
  assert.match(drafted[0], /Deadline Friday/)
  assert.equal(run.counts.noise, 1)
  /* Cut at maxDrafts, so the third repliable message has no draft — and the
   * review has to say so rather than look like it was overlooked. */
  assert.match(run.review, /past the draft limit/i)
})

test('the template draft brackets what it does not know instead of inventing it', () => {
  const draft = templateDraft(
    message({ sender: '"Liu, Evan" <evan@wisc.edu>', subject: 'Re: probe rerun' }),
    { body: 'Hi — can you rerun the probe before Thursday?', signature: 'Evan Liu' },
  )
  assert.equal(draft.subject, 'Re: probe rerun')
  assert.match(draft.body, /^Hi Evan,/)
  assert.match(draft.body, /can you rerun the probe before Thursday\?/)
  assert.match(draft.body, /\[your answer\]/)
  assert.match(draft.body, /Evan Liu$/)
  assert.equal(draft.generatedBy, 'template')
})

test('a model outage costs draft quality, never the triage', async () => {
  const drafts = await draftReplies([message({ subject: 'Can you confirm?' })], {
    llm: async () => {
      throw new Error('LLM is not configured (set LLM_API_KEY).')
    },
  })
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].generatedBy, 'template')
})

test('model output that is not JSON falls back rather than shipping a fragment', async () => {
  const drafts = await draftReplies([message({})], { llm: async () => 'Sure! Here you go:' })
  assert.equal(drafts[0].generatedBy, 'template')
})

test('a model draft is signed with the name the owner sends mail under', async () => {
  const drafts = await draftReplies([message({})], {
    signature: 'Evan Liu',
    llm: async () =>
      JSON.stringify({ drafts: [{ n: 1, subject: 'Re: Probe rerun', body: 'Running it Thursday.' }] }),
  })
  assert.equal(drafts[0].generatedBy, 'model')
  assert.equal(drafts[0].body, 'Running it Thursday.\n\nBest,\nEvan Liu')
  assert.equal(drafts[0].to, 'Dana Vogel <dana@lab.example>')
  assert.equal(drafts[0].inReplyTo, '<abc@lab.example>')
})

test('a draft the model skipped keeps the template rather than going out empty', async () => {
  const drafts = await draftReplies([message({ index: 1 }), message({ index: 2 })], {
    llm: async () => JSON.stringify({ drafts: [{ n: 2, subject: 'Re: two', body: 'Answered.' }] }),
  })
  assert.equal(drafts[0].generatedBy, 'template')
  assert.equal(drafts[1].generatedBy, 'model')
})

/* ---------- body cleanup ---------- */

test('the quoted history under a reply is not fed to the drafter', () => {
  const cleaned = cleanBody(
    [
      'Can you rerun the probe?',
      '',
      'On Aug 6, 2026, Evan wrote:',
      '> the last run was noisy',
      '> and I lost the log',
    ].join('\n'),
  )
  assert.equal(cleaned, 'Can you rerun the probe?')
})

test('a bare tracking URL on its own line is dropped', () => {
  assert.equal(
    cleanBody('Please confirm.\nhttps://click.example/track/abcdef\nThanks'),
    'Please confirm.\nThanks',
  )
})

/* ---------- the spoken and written surfaces ---------- */

test('the review names the bucket counts and both no-draft buckets', async () => {
  const run = await triageInbox(
    { now: NOW, store: false },
    {
      readEnvelopes: async () => [
        message({ index: 1, subject: 'Urgent: contract signature needed' }),
        message({ index: 2, subject: 'Your receipt', sender: 'no-reply@shop.example' }),
        message({ index: 3, subject: 'Weekly digest', sender: 'news@mail.example' }),
      ],
      readBodies: async () => new Map(),
      draft: async (candidates) =>
        candidates.map((candidate) => ({
          ...templateDraft(candidate),
          message: candidate,
          to: candidate.sender,
        })),
    },
  )

  const review = formatReview(run)
  assert.match(review, /## Urgent \(1\)/)
  assert.match(review, /## Reply soon \(0\)/)
  assert.match(review, /## Reference \(1\)/)
  assert.match(review, /## Noise \(1\)/)
  assert.match(review, /Draft reply/)
  assert.match(run.spoken, /1 urgent/)
})

test('an empty window says so instead of pretending to have triaged', async () => {
  const run = await triageInbox(
    { now: NOW, store: false, sinceHours: 24 },
    { readEnvelopes: async () => [], readBodies: async () => new Map() },
  )
  assert.equal(run.scanned, 0)
  assert.equal(run.drafts.length, 0)
  assert.match(run.spoken, /No unread mail in the last 24 hours/)
})

/* ---------- routing ---------- */

test('the spoken phrasings the owner used all reach triage', () => {
  const yes = [
    'triage my inbox',
    'Triage my inbox.',
    'inbox triage',
    'triage my email',
    'classify my unread mail',
    'prioritize my unread messages',
  ]
  for (const command of yes) {
    assert.notEqual(matchMailTriageCommand(command), null, command)
  }
})

test('"the top three" caps the drafts wherever it appears in the sentence', () => {
  assert.deepEqual(
    matchMailTriageCommand(
      'Turn my unread mail into a priority list and draft replies for the top three',
    ),
    { maxDrafts: 3 },
  )
  assert.deepEqual(matchMailTriageCommand('triage my inbox, top 3 drafts'), { maxDrafts: 3 })
  assert.deepEqual(matchMailTriageCommand('triage my inbox'), {})
})

test('mail requests that are not triage are left to the planner', () => {
  for (const command of [
    'what did I miss in email',
    'read my schedule',
    'send an email to Dana',
    'what time is it',
  ]) {
    assert.equal(matchMailTriageCommand(command), null, command)
  }
})

/*
 * Registration, not behaviour. A capability the router cannot reach and the
 * executor cannot dispatch is a module, not a feature — and both tables are
 * derived from source, so this is the check that catches a half-wired seam.
 */
test('"triage my inbox" reaches the executor with no model in the loop', async () => {
  const { matchDeterministic } = await import('./policyRouter.js')
  const matched = await matchDeterministic('Triage my inbox.')
  assert.equal(matched.intent, 'triage_inbox')
  assert.equal(matched.actions[0].type, 'triage_inbox')

  const capped = await matchDeterministic('triage my inbox, top 3')
  assert.equal(capped.actions[0].params.maxDrafts, 3)
})

test('the two new actions are dispatchable and known to the planner', async () => {
  const { SUPPORTED_ACTION_TYPES } = await import('./computerControl.js')
  const { isKnownActionType } = await import('./llmPlanner.js')

  for (const type of ['triage_inbox', 'meeting_followup']) {
    assert.ok(SUPPORTED_ACTION_TYPES.includes(type), `${type} is not dispatchable`)
    assert.ok(isKnownActionType(type), `${type} is not in the planner registry`)
  }
})
