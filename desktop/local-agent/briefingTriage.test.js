import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_INTERRUPTION_POLICY,
  TRIAGE_SINKS,
  activePolicy,
  composeTriage,
  dedupeDecision,
  digestOf,
  findingsFromAccountReports,
  findingsFromEvents,
  findingsFromMailTriage,
  findingsFromReminders,
  fingerprintFinding,
  fitWords,
  matchBriefingTriageCommand,
  nextBriefingAt,
  normalizePolicy,
  rankFinding,
  redactForDelivery,
  registerBriefingTriageRoutes,
  renderTriageNote,
  runBriefingTriage,
  speakTriage,
  timeBand,
  triageFindings,
} from './briefingTriage.js'
import { reviewQueue, statePolicy } from './briefingQueue.js'

/*
 * Friday 7 August 2026, 07:30 — the same morning briefing.test.js pins its real
 * osascript captures to, so the two modules are reasoning about one day.
 */
const NOW = new Date(2026, 7, 7, 7, 30, 0)
const NEXT = nextBriefingAt({ now: NOW })

function tempQueue() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-briefing-triage-')),
    'queue.json',
  )
}

function at(hours, minutes = 0, day = 7) {
  return new Date(2026, 7, day, hours, minutes, 0).toISOString()
}

/* ------------------------------------------------------------- the horizon */

test('the next briefing is tomorrow morning, and Friday measures against Monday', () => {
  /* Friday 07:30 → the next weekday morning is Monday 07:00. A task due Saturday
   * that goes unmentioned on Friday is a task the owner misses, which is why the
   * weekend is skipped rather than counted. */
  const friday = nextBriefingAt({ now: new Date(2026, 7, 7, 7, 30) })
  assert.equal(friday.getDay(), 1)
  assert.equal(friday.getDate(), 10)
  assert.equal(friday.getHours(), 7)

  const monday = nextBriefingAt({ now: new Date(2026, 7, 10, 7, 30) })
  assert.equal(monday.getDate(), 11)
})

test('an interval schedule does not go through the weekday path at all', () => {
  const next = nextBriefingAt({
    policy: normalizePolicy({ schedule: { everyMs: 4 * 3_600_000 } }),
    now: new Date(2026, 7, 8, 12, 0),
  })
  assert.equal(next.getTime(), new Date(2026, 7, 8, 16, 0).getTime())
})

/* --------------------------------------------------------------- the table */

/*
 * The scoring table from DEFAULT_INTERRUPTION_POLICY, pinned. This is the test
 * that matters: it is the complete statement of what does and does not reach
 * the owner, and the placeholder threshold is only defensible while these
 * combinations hold.
 */
const CASES = [
  {
    name: 'a meeting today the owner attends alone',
    build: () =>
      findingsFromEvents(
        [{ uid: 'e1', title: 'Write the deck', start: at(14), end: at(15), attendees: [] }],
        { now: NOW },
      )[0],
    score: 4,
    spoken: true,
  },
  {
    name: 'a meeting today with other attendees',
    build: () =>
      findingsFromEvents(
        [
          {
            uid: 'e2',
            title: 'Summer Interview with Evan',
            start: at(22),
            end: at(23),
            attendees: ['Evan Liu', 'Ching Wei Kang'],
          },
        ],
        { now: NOW },
      )[0],
    score: 6,
    spoken: true,
  },
  {
    name: 'a reminder due before the next brief',
    build: () =>
      findingsFromReminders([{ id: 'r1', title: 'Send the redlines', due: at(17) }], {
        now: NOW,
      })[0],
    score: 6,
    spoken: true,
  },
  {
    name: 'a reminder that is already overdue',
    build: () =>
      findingsFromReminders([{ id: 'r2', title: 'File the form', due: at(9, 0, 5) }], {
        now: NOW,
      })[0],
    score: 5,
    spoken: true,
  },
  {
    name: 'a change on a page the owner asked to be watched',
    build: () =>
      findingsFromAccountReports(
        [
          {
            watchId: 'w1',
            name: 'Flight NH117',
            at: at(3),
            summary: 'Flight NH117: status On time → Delayed',
            changes: [{ field: 'status', before: 'On time', after: 'Delayed' }],
            capsuleIds: [],
          },
        ],
        { now: NOW },
      )[0],
    score: 4,
    spoken: true,
  },
  {
    name: 'an unread reply inside a thread the owner started',
    build: () =>
      findingsFromMailTriage(
        {
          buckets: {
            urgent: [],
            'reply-soon': [
              {
                messageId: 'm1',
                subject: 'Re: Contract redlines before Friday',
                sender: 'Dana Whitfield <dana@northwind.example>',
                senderName: 'Dana Whitfield',
                receivedAt: at(6, 30),
              },
            ],
          },
          drafts: [],
        },
        { now: NOW },
      )[0],
    score: 4,
    spoken: true,
  },
  {
    name: 'an unread first-contact email from a real person',
    build: () =>
      findingsFromMailTriage(
        {
          buckets: {
            urgent: [],
            'reply-soon': [
              {
                messageId: 'm2',
                subject: 'Lunch sometime?',
                sender: 'Sam <sam@example.org>',
                senderName: 'Sam',
                receivedAt: at(6, 45),
              },
            ],
          },
          drafts: [],
        },
        { now: NOW },
      )[0],
    score: 2,
    spoken: false,
  },
  {
    name: 'an all-day holiday',
    build: () =>
      findingsFromEvents(
        [
          {
            uid: 'e3',
            title: '立秋',
            start: at(0),
            end: at(23, 59),
            allDay: true,
            calendar: '台灣節日',
            attendees: [],
          },
        ],
        { now: NOW },
      )[0],
    score: 0,
    spoken: false,
  },
  {
    name: 'a solo calendar block after the next briefing',
    build: () =>
      findingsFromEvents(
        [{ uid: 'e4', title: 'Deep work', start: at(9, 0, 11), end: at(11, 0, 11), attendees: [] }],
        { now: NOW },
      )[0],
    score: 0,
    spoken: false,
  },
]

for (const testCase of CASES) {
  test(`scores ${testCase.score}: ${testCase.name}`, () => {
    const ranked = rankFinding(testCase.build(), { now: NOW, nextAt: NEXT })
    assert.equal(ranked.score, testCase.score)
    assert.equal(
      ranked.score >= DEFAULT_INTERRUPTION_POLICY.threshold,
      testCase.spoken,
      `expected ${testCase.name} to ${testCase.spoken ? 'reach' : 'not reach'} the owner`,
    )
  })
}

test('every scored finding can say why, in words the owner could argue with', () => {
  for (const testCase of CASES.filter((entry) => entry.spoken)) {
    const ranked = rankFinding(testCase.build(), { now: NOW, nextAt: NEXT })
    assert.ok(ranked.why.length, `${testCase.name} scored with no reason`)
    for (const reason of ranked.why) assert.match(reason, /[a-z]{4}/)
  }
})

test('an event that already finished is not a finding at all', () => {
  const found = findingsFromEvents(
    [{ uid: 'e5', title: 'Standup', start: at(6), end: at(6, 30), attendees: ['a', 'b'] }],
    { now: NOW },
  )
  assert.equal(found.length, 0)
})

test('urgency never reads the words in a title', () => {
  /* The same event, once called "URGENT: action required" and once not. A
   * keyword-driven ranker would separate these; this one must not. */
  const shape = { uid: 'e6', start: at(14), end: at(15), attendees: [] }
  const plain = rankFinding(findingsFromEvents([{ ...shape, title: 'Coffee' }], { now: NOW })[0], {
    now: NOW,
    nextAt: NEXT,
  })
  const shouty = rankFinding(
    findingsFromEvents([{ ...shape, title: 'URGENT: action required ASAP' }], { now: NOW })[0],
    { now: NOW, nextAt: NEXT },
  )
  assert.equal(plain.score, shouty.score)
})

/* -------------------------------------------------------------- provenance */

test('every finding carries where it came from', () => {
  const found = [
    ...findingsFromEvents([{ uid: 'e', title: 'x', start: at(14), attendees: [] }], { now: NOW }),
    ...findingsFromReminders([{ id: 'r', title: 'y', due: at(14) }], { now: NOW }),
    ...findingsFromAccountReports(
      [{ watchId: 'w', name: 'z', at: at(3), summary: 'z: a → b', changes: [], capsuleIds: ['cap_1'] }],
      { now: NOW },
    ),
  ]

  for (const item of found) {
    assert.ok(item.provenance.reader.startsWith('local-agent/'))
    assert.ok(item.provenance.observedAt)
    assert.ok(Array.isArray(item.provenance.capsuleIds))
  }
  /* Account findings are the ones with revocable evidence behind them. */
  assert.deepEqual(found.at(-1).provenance.capsuleIds, ['cap_1'])
})

/* ------------------------------------------------------------ the two gates */

test('the same open item is told once and then only queued', () => {
  const findings = findingsFromReminders([{ id: 'r1', title: 'File the form', due: at(17) }], {
    now: NOW,
  })

  const first = triageFindings({ findings, now: NOW, nextAt: NEXT })
  assert.equal(first.spoken.length, 1)

  const told = new Map([[first.spoken[0].fingerprint, { at: NOW.toISOString() }]])
  const second = triageFindings({ findings, now: NOW, nextAt: NEXT, told })

  assert.equal(second.spoken.length, 0, 'a repeat must not consume a spoken slot')
  assert.equal(second.queued.length, 1, 'but it is still open, so it stays in the queue')
  assert.equal(second.repeats, 1)
})

test('an item whose urgency band moved is news again', () => {
  /* Told on Monday, when the meeting was still Thursday's problem. On Thursday
   * morning the window closes before the next brief, so the fingerprint changes
   * and the owner hears about it — which is the whole point of putting the band
   * in the fingerprint. */
  const event = findingsFromEvents(
    [{ uid: 'e1', title: 'Board review', start: at(14, 0, 13), attendees: ['a', 'b'] }],
    { now: NOW },
  )[0]

  const monday = fingerprintFinding(event, timeBand(event, { now: NOW, nextAt: NEXT }))
  const thursdayNow = new Date(2026, 7, 13, 7, 30)
  const thursday = fingerprintFinding(
    event,
    timeBand(event, { now: thursdayNow, nextAt: nextBriefingAt({ now: thursdayNow }) }),
  )

  assert.notEqual(monday, thursday)
})

test('a fingerprint is stable across runs when nothing about the item moved', () => {
  const build = () =>
    findingsFromReminders([{ id: 'r1', title: 'File the form', due: at(17) }], { now: NOW })[0]
  assert.equal(fingerprintFinding(build(), 'closing'), fingerprintFinding(build(), 'closing'))
})

test('three is a hard cut, and the rest are queued rather than dropped', () => {
  const findings = findingsFromReminders(
    Array.from({ length: 6 }, (_, index) => ({
      id: `r${index}`,
      title: `Task ${index}`,
      due: at(9 + index),
    })),
    { now: NOW },
  )

  const triaged = triageFindings({ findings, now: NOW, nextAt: NEXT })
  assert.equal(triaged.spoken.length, 3)
  assert.equal(triaged.queued.length, 3)
  assert.equal(triaged.spoken.length + triaged.queued.length, findings.length)
})

test('the soonest deadline wins a tie on score', () => {
  const findings = findingsFromReminders(
    [
      { id: 'late', title: 'Later today', due: at(20) },
      { id: 'soon', title: 'Right after breakfast', due: at(9) },
    ],
    { now: NOW },
  )
  const triaged = triageFindings({ findings, now: NOW, nextAt: NEXT })
  assert.equal(triaged.spoken[0].title, 'Right after breakfast')
})

test('a raised threshold silences things the placeholder would have spoken', () => {
  const findings = findingsFromEvents(
    [{ uid: 'e1', title: 'Write the deck', start: at(14), attendees: [] }],
    { now: NOW },
  )
  const strict = normalizePolicy({ threshold: 5 })
  assert.equal(triageFindings({ findings, now: NOW, nextAt: NEXT }).spoken.length, 1)
  assert.equal(
    triageFindings({ findings, policy: strict, now: NOW, nextAt: NEXT }).spoken.length,
    0,
  )
})

test('repeatAfterMs lets an old finding be spoken again', () => {
  const findings = findingsFromReminders([{ id: 'r1', title: 'File the form', due: at(17) }], {
    now: NOW,
  })
  const fingerprint = triageFindings({ findings, now: NOW, nextAt: NEXT }).spoken[0].fingerprint
  const told = new Map([
    [fingerprint, { at: new Date(NOW.getTime() - 8 * 24 * 3_600_000).toISOString() }],
  ])

  assert.equal(triageFindings({ findings, now: NOW, nextAt: NEXT, told }).spoken.length, 0)
  assert.equal(
    triageFindings({
      findings,
      policy: normalizePolicy({ repeatAfterMs: 7 * 24 * 3_600_000 }),
      now: NOW,
      nextAt: NEXT,
      told,
    }).spoken.length,
    1,
  )
})

/* ------------------------------------------------------------- composition */

test('the digest fits a thirty-second read and stops on a sentence', () => {
  const findings = findingsFromReminders(
    Array.from({ length: 8 }, (_, index) => ({
      id: `r${index}`,
      title: `A task with a fairly long name number ${index}`,
      due: at(9 + index),
    })),
    { now: NOW },
  )
  const triaged = triageFindings({ findings, now: NOW, nextAt: NEXT })
  const composed = composeTriage({ ...triaged, now: NOW })

  const words = composed.narration.text.split(/\s+/).length
  assert.ok(words <= DEFAULT_INTERRUPTION_POLICY.digestWords, `${words} words is over budget`)
  assert.match(composed.narration.text, /\.$/)
  /* pendantSpeech hard-slices at 180 characters, so the spoken line must fit. */
  assert.ok(composed.spoken.text.length <= 180)
})

test('a quiet morning says it looked, and says what it could not read', () => {
  const composed = composeTriage({
    spoken: [],
    queued: [],
    suppressed: 12,
    unavailable: ['your logged-in accounts — the browser extension is offline'],
    now: NOW,
  })

  assert.match(composed.narration.text, /Nothing needs you right now/)
  assert.match(composed.narration.text, /12 other things/)
  assert.match(composed.narration.text, /could not read/)
})

test('a brief with things in the queue says so rather than sounding empty', () => {
  const queued = findingsFromMailTriage(
    {
      buckets: {
        urgent: [],
        'reply-soon': [
          { messageId: 'm2', subject: 'Lunch sometime?', senderName: 'Sam', receivedAt: at(6) },
        ],
      },
      drafts: [
        {
          message: { messageId: 'm2', subject: 'Lunch sometime?' },
          subject: 'Re: Lunch sometime?',
          body: 'Hi Sam,',
          to: 'sam@example.org',
          generatedBy: 'template',
        },
      ],
      draftPaths: ['/tmp/01-sam.md'],
    },
    { now: NOW },
  )
  const spoken = findingsFromReminders([{ id: 'r1', title: 'File the form', due: at(17) }], {
    now: NOW,
  })

  const triaged = triageFindings({ findings: [...spoken, ...queued], now: NOW, nextAt: NEXT })
  const composed = composeTriage({ ...triaged, now: NOW })

  assert.match(composed.narration.text, /review queue/)
  assert.match(composed.narration.text, /1 drafted reply nobody has sent/)
})

test('fitWords never returns an empty string just because the budget is tiny', () => {
  assert.equal(fitWords(['One two three four five.', 'Six.'], 2), 'One two three four five.')
})

/* --------------------------------------------------------------- redaction */

test('a secret in a subject line never reaches the text that leaves the Mac', () => {
  const secret = 'The garage code is 4829 and the door code is 1174'
  const { text, redaction } = redactForDelivery(secret)

  assert.equal(redaction.classification, 'secret')
  assert.ok(!text.includes('4829'), 'the value survived into deliverable text')
  assert.equal(redaction.classifier, 'local-agent/redaction.js classifySensitivity')
})

test('an email address is flagged rather than withheld', () => {
  /* The owner reads their own mail at full fidelity; the flag is what lets a
   * prompt builder decide, exactly as the capsules treat it. */
  const { text, redaction } = redactForDelivery('Dana Whitfield <dana@northwind.example> replied.')
  assert.equal(redaction.classification, 'sensitive')
  assert.ok(text.includes('dana@northwind.example'))
})

test('the spoken line and the note are both redacted, not just one of them', () => {
  const findings = findingsFromReminders(
    [{ id: 'r1', title: 'Remember the safe combination is 88-14-02', due: at(17) }],
    { now: NOW },
  )
  const triaged = triageFindings({ findings, now: NOW, nextAt: NEXT })
  const composed = composeTriage({ ...triaged, now: NOW })
  const note = renderTriageNote({
    title: 'Morning triage',
    spoken: composed.spoken.text,
    policySource: 'default',
    horizon: NEXT,
    told: triaged.spoken,
    queued: [],
    now: NOW,
  })

  assert.ok(!composed.spoken.text.includes('88-14-02'))
  assert.ok(!composed.narration.text.includes('88-14-02'))
  assert.ok(!note.text.includes('88-14-02'))
})

/* ------------------------------------------------------------------ dedupe */

test('a second run with nothing new renders no second brief', () => {
  const existing = [
    { id: 'brf_1', digest: 'abc123', played: false, createdAt: new Date(NOW.getTime() - 60_000).toISOString() },
  ]
  const decision = dedupeDecision({ digest: 'abc123', now: NOW, existing })

  assert.equal(decision.render, false)
  assert.equal(decision.reuse.id, 'brf_1')
  assert.deepEqual(decision.supersede, [])
})

test('a run with different news supersedes the unplayed brief rather than joining it', () => {
  /* The bug this replaces: two unplayed briefings minutes apart, with no way to
   * tell which was current. At most one unplayed triage brief may exist. */
  const existing = [
    { id: 'brf_1', digest: 'abc123', played: false, createdAt: new Date(NOW.getTime() - 60_000).toISOString() },
    { id: 'brf_2', digest: 'def456', played: false, createdAt: new Date(NOW.getTime() - 30_000).toISOString() },
  ]
  const decision = dedupeDecision({ digest: 'zzz999', now: NOW, existing })

  assert.equal(decision.render, true)
  assert.deepEqual(decision.supersede, ['brf_1', 'brf_2'])
})

test('an identical brief older than the rerun gap is replaced, not duplicated', () => {
  const existing = [
    {
      id: 'brf_1',
      digest: 'abc123',
      played: false,
      createdAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
    },
  ]
  const decision = dedupeDecision({ digest: 'abc123', now: NOW, existing })

  assert.equal(decision.render, true)
  assert.deepEqual(decision.supersede, ['brf_1'])
})

test('the digest changes when what the brief says changes', () => {
  const one = digestOf({ spoken: 'Two things need you.', told: [{ fingerprint: 'a' }] })
  const two = digestOf({ spoken: 'Two things need you.', told: [{ fingerprint: 'b' }] })
  assert.notEqual(one, two)
})

test('speakTriage declines to render, and never touches another producer briefing', () => {
  const deleted = []
  const rendered = []
  const shelf = [
    { id: 'brf_mine', producer: 'briefingTriage', digest: 'same', played: false, createdAt: NOW.toISOString(), wavPath: '/tmp/a.wav' },
    { id: 'brf_research', producer: 'research', digest: 'other', played: false, createdAt: NOW.toISOString() },
  ]

  const result = speakTriage(
    { digest: 'same', narration: 'x', spoken: 'x', title: 't', generatedAt: NOW.toISOString() },
    {
      now: NOW,
      render: (...args) => {
        rendered.push(args)
        return {}
      },
      listShelf: () => shelf,
      deleteShelf: (id) => deleted.push(id),
      saveShelf: (entry) => ({ id: 'brf_new', ...entry }),
    },
  )

  assert.equal(result.deduped, true)
  assert.equal(rendered.length, 0, 'say() must not run for a brief with no news')
  assert.deepEqual(deleted, [], "another producer's unplayed brief is not ours to retire")
})

test('speakTriage stamps the shelf row so only its own rows are ever superseded', () => {
  const saved = []
  const deleted = []
  speakTriage(
    { digest: 'new', narration: 'x', spoken: 'x', title: 't', generatedAt: NOW.toISOString() },
    {
      now: NOW,
      render: () => ({ wavPath: '/tmp/a.wav', opusPath: '/tmp/a.opus', seconds: 12, words: 40, pcmBytes: 1, opusBytes: 1 }),
      listShelf: () => [
        { id: 'brf_mine', producer: 'briefingTriage', digest: 'old', played: false, createdAt: NOW.toISOString() },
        { id: 'brf_research', producer: 'research', digest: 'old', played: false, createdAt: NOW.toISOString() },
      ],
      deleteShelf: (id) => deleted.push(id),
      saveShelf: (entry) => {
        saved.push(entry)
        return { id: 'brf_new', ...entry }
      },
    },
  )

  assert.equal(saved[0].producer, 'briefingTriage')
  assert.equal(saved[0].digest, 'new')
  assert.deepEqual(deleted, ['brf_mine'])
})

/* --------------------------------------------------------------- the run */

function fakeReaders({ events = [], reminders = [], mail = null, reports = [], browser = { online: true } } = {}) {
  return {
    readEvents: async () => events,
    readReminders: async () => reminders,
    triageMail: async () => mail ?? { buckets: { urgent: [], 'reply-soon': [] }, drafts: [] },
    readAccountReports: () => reports,
    browserStatus: () => browser,
    render: () => ({ wavPath: '/tmp/a.wav', opusPath: '/tmp/a.opus', seconds: 20, words: 60 }),
    listShelf: () => [],
    saveShelf: (entry) => ({ id: 'brf_test', ...entry }),
    deleteShelf: () => true,
  }
}

test('a full run tells three things, queues the rest, and sends nothing', async () => {
  const queueFilePath = tempQueue()
  const brief = await runBriefingTriage(
    { now: NOW, sinks: [], queueFilePath },
    fakeReaders({
      events: [
        { uid: 'e1', title: 'Summer Interview', start: at(22), end: at(23), attendees: ['Evan', 'Jorge'] },
        { uid: 'e2', title: '立秋', start: at(0), end: at(23, 59), allDay: true, attendees: [] },
      ],
      reminders: [
        { id: 'r1', title: 'Send the redlines', due: at(17) },
        { id: 'r2', title: 'File the form', due: at(9, 0, 5) },
        { id: 'r3', title: 'Buy milk', due: null },
      ],
      mail: {
        buckets: {
          urgent: [],
          'reply-soon': [
            { messageId: 'm1', subject: 'Lunch sometime?', senderName: 'Sam', receivedAt: at(6) },
          ],
        },
        drafts: [
          {
            message: { messageId: 'm1', subject: 'Lunch sometime?' },
            subject: 'Re: Lunch sometime?',
            body: 'Hi Sam,',
            to: 'sam@example.org',
            generatedBy: 'template',
          },
        ],
        draftPaths: ['/tmp/01-sam.md'],
      },
    }),
  )

  assert.equal(brief.sent, false)
  assert.equal(brief.acted, false)
  assert.equal(brief.counts.told, 3)
  assert.ok(brief.counts.queued >= 1)
  assert.equal(brief.counts.drafts, 1)
  /* The holiday and the undated reminder are below anything worth reporting. */
  assert.equal(brief.counts.suppressed, 1)
  assert.match(brief.note, /Review queue — nothing here was acted on/)
  assert.match(brief.note, /Draft reply prepared, not sent/)
})

test('a run refuses a sink that could transmit', async () => {
  await assert.rejects(
    () => runBriefingTriage({ now: NOW, sinks: ['email'], store: false }, fakeReaders()),
    /never sends/i,
  )
})

test('the run says the policy is a placeholder until the owner states one', async () => {
  const queueFilePath = tempQueue()
  const before = await runBriefingTriage({ now: NOW, sinks: [], queueFilePath }, fakeReaders())
  assert.equal(before.policySource, 'default')
  assert.match(before.policyNote, /has not stated/)
  assert.match(before.note, /you have not stated one yet/)

  statePolicy({ threshold: 6 }, { filePath: queueFilePath })
  const after = await runBriefingTriage({ now: NOW, sinks: [], queueFilePath }, fakeReaders())
  assert.equal(after.policySource, 'owner')
  assert.equal(after.policy.threshold, 6)
  assert.match(after.note, /the interruption policy you stated/)
})

test('an unreadable source is said out loud, never mistaken for a quiet morning', async () => {
  const queueFilePath = tempQueue()
  const readers = fakeReaders({ events: [{ uid: 'e1', title: 'x', start: at(14), attendees: [] }] })
  readers.readReminders = async () => {
    throw new Error('Apple data read timed out after 20000ms.')
  }

  const brief = await runBriefingTriage({ now: NOW, sinks: [], queueFilePath }, readers)

  assert.deepEqual(brief.unavailable, ['your reminders'])
  assert.match(brief.narration, /could not read your reminders/)
})

test('the spoken digest carries the short reason and the note carries the stack', async () => {
  /*
   * The first live run put four lines of raw AppleScript — including
   * `on pad2(n)` — into the spoken digest, which ate a third of the
   * thirty-second budget and is unlistenable. The detail has to survive
   * somewhere an engineer can read it, and that somewhere is not the speaker.
   */
  const queueFilePath = tempQueue()
  const readers = fakeReaders({ events: [{ uid: 'e1', title: 'x', start: at(14), attendees: [] }] })
  readers.triageMail = async () => {
    throw new Error('Command failed: osascript -e\non pad2(n)\n  set s to (n as integer) as string\nexecution error: Not authorized to send Apple events to Mail. (-1743)')
  }

  const brief = await runBriefingTriage({ now: NOW, sinks: [], queueFilePath }, readers)

  assert.deepEqual(brief.unavailable, ['your inbox'])
  assert.ok(!brief.narration.includes('pad2'), 'a shell stack must never be spoken')
  assert.ok(!/\n/.test(brief.problems[0]), 'the detail is flattened to one line')
  assert.match(brief.problems[0], /-1743/)
  assert.match(brief.note, /Why a source did not answer/)
  assert.match(brief.note, /-1743/)
})

test('an empty calendar AND an empty task list is reported as unreadable, not as a clear day', async () => {
  /*
   * Measured: appleData.js reads both through EventKit, whose authorization
   * callback never completes under osascript — so an unauthorised read returns
   * [] rather than throwing. From a process with no Automation grant, on a day
   * with four real events, listEvents returned 0 and listOpenReminders returned
   * 0. "Nothing needs you" said with total confidence is the worst answer this
   * feature can give.
   */
  const queueFilePath = tempQueue()
  const brief = await runBriefingTriage({ now: NOW, sinks: [], queueFilePath }, fakeReaders())

  assert.ok(brief.unavailable.includes('your calendar and reminders'))
  assert.match(brief.narration, /could not read your calendar and reminders/)
  assert.match(brief.problems.join(' '), /also what an unauthorised read looks like/)
})

test('one real row from either source is proof the store answered', async () => {
  const queueFilePath = tempQueue()
  const brief = await runBriefingTriage(
    { now: NOW, sinks: [], queueFilePath },
    fakeReaders({ reminders: [{ id: 'r1', title: 'Buy milk', due: null }] }),
  )

  assert.ok(!brief.unavailable.includes('your calendar and reminders'))
})

test('two polls of one watch are one finding, not two spoken slots', async () => {
  /*
   * The first live run against this Mac spent two of its three slots on the
   * same page: "UTC clock: 06:20:54 → 06:24:52" and then
   * "UTC clock: 06:24:52 → 06:26:08". The owner wants where it landed.
   */
  const reports = [
    {
      watchId: 'w1',
      name: 'UTC clock',
      at: at(6, 26),
      summary: 'UTC clock: utc_time 06:24:52 → 06:26:08',
      changes: [{ field: 'utc_time', before: '06:24:52', after: '06:26:08' }],
      capsuleIds: [],
    },
    {
      watchId: 'w1',
      name: 'UTC clock',
      at: at(6, 24),
      summary: 'UTC clock: utc_time 06:20:54 → 06:24:52',
      changes: [{ field: 'utc_time', before: '06:20:54', after: '06:24:52' }],
      capsuleIds: [],
    },
  ]

  const findings = findingsFromAccountReports(reports, { now: NOW })
  assert.equal(findings.length, 1)
  assert.match(findings[0].detail, /06:24:52 → 06:26:08/, 'the newest value is the one that is true')
  assert.match(findings[0].detail, /1 earlier change since you last looked/)
  assert.equal(findings[0].provenance.supersededPolls, 1)

  const queueFilePath = tempQueue()
  const brief = await runBriefingTriage(
    { now: NOW, sinks: [], queueFilePath },
    fakeReaders({ reports, reminders: [{ id: 'r1', title: 'Buy milk', due: null }] }),
  )
  assert.equal(brief.counts.told, 1)
})

test('two different watches stay two findings', () => {
  const findings = findingsFromAccountReports(
    [
      { watchId: 'w1', name: 'Flight NH117', at: at(6), summary: 'a', changes: [], capsuleIds: [] },
      { watchId: 'w2', name: 'Invoice status', at: at(5), summary: 'b', changes: [], capsuleIds: [] },
    ],
    { now: NOW },
  )
  assert.equal(findings.length, 2)
})

test('an offline extension is reported instead of implying the accounts are quiet', async () => {
  const queueFilePath = tempQueue()
  const brief = await runBriefingTriage(
    { now: NOW, sinks: [], queueFilePath },
    fakeReaders({ browser: { online: false, devices: [] } }),
  )

  assert.equal(brief.browserOnline, false)
  assert.ok(brief.unavailable.some((entry) => /extension is offline/.test(entry)))
})

test('a second run the same morning tells the owner nothing twice', async () => {
  const queueFilePath = tempQueue()
  const readers = fakeReaders({
    reminders: [{ id: 'r1', title: 'Send the redlines', due: at(17) }],
  })

  const first = await runBriefingTriage({ now: NOW, sinks: [], queueFilePath }, readers)
  const second = await runBriefingTriage(
    { now: new Date(NOW.getTime() + 4 * 60_000), sinks: [], queueFilePath },
    readers,
  )

  assert.equal(first.counts.told, 1)
  assert.equal(second.counts.told, 0)
  assert.equal(second.counts.repeats, 1)
  assert.match(second.spoken, /Nothing needs you right now/)
})

test('a rerun never replaces a brief the owner has not played with an emptier one', async () => {
  /*
   * The failure this pins, caught by running it: run one rendered "2 things
   * need you" and went unplayed; run two three minutes later found both
   * fingerprints already told, said "nothing needs you right now", and
   * superseded the audio the owner had never heard. A dedupe that loses the
   * content it deduplicated is worse than the duplicates.
   */
  const queueFilePath = tempQueue()
  const shelf = []
  const readers = {
    ...fakeReaders({ reminders: [{ id: 'r1', title: 'Send the redlines', due: at(17) }] }),
    listShelf: () => shelf,
    saveShelf: (entry) => {
      const row = { id: `brf_${shelf.length}`, played: false, createdAt: NOW.toISOString(), ...entry }
      shelf.unshift(row)
      return row
    },
    deleteShelf: (id) => {
      const index = shelf.findIndex((row) => row.id === id)
      if (index >= 0) shelf.splice(index, 1)
      return true
    },
  }

  const first = await runBriefingTriage(
    { now: NOW, sinks: ['speech'], queueFilePath },
    readers,
  )
  const second = await runBriefingTriage(
    { now: new Date(NOW.getTime() + 3 * 60_000), sinks: ['speech'], queueFilePath },
    readers,
  )

  assert.equal(first.counts.told, 1)
  assert.equal(second.counts.told, 1, 'unheard is not told, so it is still news')
  assert.equal(second.deduped, true, 'and saying the same thing renders nothing new')
  assert.equal(second.briefingId, first.briefingId)
  assert.equal(shelf.length, 1, 'at most one unplayed triage brief exists')

  /* Once it has been heard, the same finding stops consuming a spoken slot. */
  shelf[0].played = true
  const third = await runBriefingTriage(
    { now: new Date(NOW.getTime() + 10 * 60_000), sinks: ['speech'], queueFilePath },
    readers,
  )
  assert.equal(third.counts.told, 0)
  assert.equal(third.counts.repeats, 1)
})

test('the run leaves the finding in the review queue with its provenance and its draft', async () => {
  const queueFilePath = tempQueue()
  await runBriefingTriage(
    { now: NOW, sinks: [], queueFilePath },
    fakeReaders({
      mail: {
        buckets: {
          urgent: [],
          'reply-soon': [
            { messageId: 'm1', subject: 'Lunch sometime?', senderName: 'Sam', receivedAt: at(6) },
          ],
        },
        drafts: [
          {
            message: { messageId: 'm1', subject: 'Lunch sometime?' },
            subject: 'Re: Lunch sometime?',
            body: 'Hi Sam,',
            to: 'sam@example.org',
            generatedBy: 'template',
          },
        ],
        draftPaths: ['/tmp/01-sam.md'],
      },
    }),
  )

  const [item] = reviewQueue({ filePath: queueFilePath })
  assert.equal(item.status, 'waiting')
  assert.equal(item.acted, false)
  assert.equal(item.draft.sent, false)
  assert.equal(item.draft.path, '/tmp/01-sam.md')
  assert.match(item.provenance.reader, /mailTriage/)
})

/* ------------------------------------------------------------------ wiring */

test('the command matcher recognises the cross-account phrasings without a model', () => {
  for (const phrase of [
    'tell me the three things I need to know',
    'check my logged-in accounts for anything urgent',
    "what changed overnight",
    'give me a digest of what changed',
    "what's in my review queue",
  ]) {
    assert.deepEqual(matchBriefingTriageCommand(phrase), { kind: 'triage' }, phrase)
  }
  assert.equal(matchBriefingTriageCommand('play some music'), null)
  assert.equal(matchBriefingTriageCommand(''), null)
})

test('registration adds routes to an app without this module knowing about server.js', () => {
  const routes = []
  const app = {
    get: (route) => routes.push(`GET ${route}`),
    post: (route) => routes.push(`POST ${route}`),
  }

  const registered = registerBriefingTriageRoutes(app)

  assert.deepEqual(routes.sort(), registered.map((entry) => entry).sort())
  assert.ok(routes.includes('GET /briefing/review'))
  assert.ok(routes.includes('POST /briefing/triage'))
})

test('registration refuses anything that is not an app', () => {
  assert.throws(() => registerBriefingTriageRoutes({}), /Express-like app/)
})

test('the sink table has no transport in it', () => {
  assert.deepEqual([...TRIAGE_SINKS], ['file', 'speech'])
})

test('activePolicy never reports a placeholder as a decision', () => {
  const { policy, source, note } = activePolicy({ filePath: tempQueue() })
  assert.equal(source, 'default')
  assert.ok(note)
  assert.equal(policy, DEFAULT_INTERRUPTION_POLICY)

  const asked = activePolicy({ override: { maxSpoken: 5 } })
  assert.equal(asked.source, 'request')
  assert.equal(asked.policy.maxSpoken, 5)
  /* A partial override keeps the nested defaults rather than blanking them. */
  assert.equal(asked.policy.weights.closingWindow, 4)
})
