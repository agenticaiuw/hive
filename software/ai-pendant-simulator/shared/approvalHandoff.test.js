import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APPROVAL_DEFAULT_TTL_MS,
  APPROVAL_MAX_TTL_MS,
  APPROVAL_MIN_TTL_MS,
  APPROVAL_STORE_CONTRACT,
  CONFIRM_WORDS,
  MAX_INDEXED_APPROVALS,
  READBACK_MAX_CHARS,
  approvalControlFrame,
  approvalIndexKey,
  approvalIsLive,
  approvalReadback,
  approvalSpeech,
  approvalStateKey,
  attestApprovalDelivery,
  buildApprovalRequest,
  confirmWordFor,
  confirmWordRequired,
  evaluateApprovalGrant,
  indexApproval,
  matchApprovalUtterance,
  planDigestFor,
  presentApproval,
  selectApprovalToSpeak,
  settleApproval,
  worldFingerprintFor,
} from './approvalHandoff.js'

const NOW = Date.parse('2026-08-07T09:00:00.000Z')

/* A manifest shaped exactly like the one openLedger() writes, so these tests
 * exercise the same fields the real prepare path produces. Only the keys this
 * module reads are populated. */
function manifest(overrides = {}) {
  return {
    ledgerId: 'ldg_test',
    planKey: 'plan_abcdef',
    command: 'send sam the notes summary',
    title: 'Notes summary',
    risk: { tiers: { 'reversible-write': 1, 'off-machine': 1 }, steps: 2, irreversible: 1 },
    steps: [
      {
        seq: 0,
        stepKey: 'act_a#0',
        type: 'write_file',
        label: 'update the notes file',
        effect: 'write',
        riskTier: 'reversible-write',
        reversible: true,
        touches: [{ kind: 'path', ref: '/Users/o/notes.txt' }],
        intent: { contentSha256: 'aaa', contentBytes: 8 },
        params: { path: '/Users/o/notes.txt', content: 'new body' },
        resumable: true,
        preState: {
          kind: 'path',
          at: '2026-08-07T08:59:00.000Z',
          target: {
            path: '/Users/o/notes.txt',
            resolvable: true,
            existed: true,
            directory: false,
            bytes: 8,
            mtimeMs: 1,
            sha256: 'deadbeef',
            hashSkipped: null,
          },
        },
      },
      {
        seq: 1,
        stepKey: 'act_b#0',
        type: 'send_email',
        label: 'email the summary to sam@example.com',
        effect: 'write',
        riskTier: 'off-machine',
        reversible: false,
        touches: [{ kind: 'other', ref: 'sam@example.com' }],
        intent: null,
        params: { to: 'sam@example.com', subject: 'Summary' },
        resumable: true,
        preState: { kind: 'unobservable', at: '2026-08-07T08:59:00.000Z', why: 'A sent email leaves nothing behind.' },
      },
    ],
    ...overrides,
  }
}

/*
 * Both witnesses, in the order the real system produces them: the relay streams
 * the readback, and only then can an echo of the confirm word mean anything.
 * There is no shortcut past this in the module and there is none here either.
 */
function delivered(overrides = {}) {
  const record = buildApprovalRequest({ manifest: manifest(), now: NOW, ...overrides })
  const spoken = attestApprovalDelivery(record, {
    evidence: 'stream-complete',
    sentBytes: 4096,
    totalBytes: 4096,
    now: NOW + 1000,
  })
  assert.equal(spoken.ok, true, spoken.why)
  const heard = attestApprovalDelivery(spoken.record, {
    evidence: 'owner-echo',
    transcript: `approve ${record.confirmWord}`,
    now: NOW + 2000,
  })
  assert.equal(heard.ok, true, heard.why)
  return heard.record
}

/** Streamed and nothing more: bytes on a socket, which is not an ear. */
function spokenOnly(overrides = {}) {
  const record = buildApprovalRequest({ manifest: manifest(), now: NOW, ...overrides })
  return attestApprovalDelivery(record, {
    evidence: 'stream-complete',
    sentBytes: 4096,
    totalBytes: 4096,
    now: NOW + 1000,
  }).record
}

/* ------------------------------------------------------------- readback */

test('the readback names the irreversible step by its target rather than counting it', () => {
  const text = approvalReadback(manifest(), { confirmWord: 'falcon', ttlMs: APPROVAL_DEFAULT_TTL_MS })

  // The whole point: a count is not checkable by ear, a name is.
  assert.match(text, /cannot be undone/)
  assert.match(text, /sam@example\.com/)
  // The owner's own words come back so they can recognise what they asked for.
  assert.match(text, /send sam the notes summary/)
  // The reversible write is NAMED too, not counted — see below.
  assert.match(text, /update the notes file/)
})

test('every write is named, including the ones that can be undone', () => {
  // A single-step plan to delete a snapshot-recoverable file used to come out as
  // "1 change that can be undone", with the delete never spoken. Undoable is not
  // the same as unimportant, and a count cannot be checked against what the
  // owner asked for.
  const single = manifest({
    command: 'clear out the old tax folder',
    steps: [
      {
        seq: 0,
        type: 'delete_path',
        label: 'delete taxes-2019.zip',
        effect: 'write',
        riskTier: 'reversible-write',
        reversible: true,
        touches: [{ kind: 'path', ref: '/Users/o/taxes-2019.zip' }],
        preState: { kind: 'unobservable', why: 'n/a' },
      },
    ],
  })

  assert.match(approvalReadback(single, { confirmWord: 'kettle' }), /delete taxes-2019\.zip/)
})

test('reads stay a count, because a read changes nothing there is to verify', () => {
  const text = approvalReadback(
    manifest({
      steps: [
        ...manifest().steps,
        { seq: 2, type: 'read_file', label: 'read the invoice', effect: 'read', riskTier: 'observe', reversible: true, touches: [], preState: { kind: 'unobservable', why: 'n/a' } },
      ],
    }),
    { confirmWord: 'falcon' },
  )

  assert.match(text, /1 step that only looks at things/)
})

test('a delete always needs the confirm word, even when the vault could undo it', () => {
  // planPreview.js reaches the same conclusion: delete_path is the sole member
  // of its HARD_TO_REVERSE set. A small file's delete scores `reversible-write`
  // and would otherwise commit on a bare "yes".
  const deletion = manifest({
    steps: [
      {
        seq: 0,
        type: 'delete_path',
        label: 'delete taxes-2019.zip',
        effect: 'write',
        riskTier: 'reversible-write',
        reversible: true,
        touches: [],
        preState: { kind: 'unobservable', why: 'n/a' },
      },
    ],
  })

  assert.equal(confirmWordRequired(deletion), true)
})

test('the readback ends with the confirm word and the deadline, in that order', () => {
  const text = approvalReadback(manifest(), { confirmWord: 'falcon', ttlMs: 10 * 60 * 1000 })

  assert.match(text, /about 10 minutes/)
  // Recency is the only memory a screenless approval can rely on, so the word
  // the owner is about to say must be the last thing they hear about the plan.
  assert.ok(text.indexOf('approve falcon') > text.indexOf('10 minutes'))
  assert.match(text, /say cancel/)
})

test('a long digit run is masked, but the phrasing around it survives', () => {
  const text = approvalReadback(
    manifest({ command: 'pay it with card number 4111 1111 1111 1111', title: 'Pay the invoice' }),
    { confirmWord: 'falcon' },
  )

  // Nobody confirms a card number by ear, and a pendant is a speaker in a room.
  assert.ok(!text.includes('4111'), 'the card number must not reach the speaker')
  // But the sentence still has to be recognisable, or the readback verifies
  // nothing — so the words around the number stay.
  assert.match(text, /pay it with card number/)
  assert.match(text, /approve falcon/)
})

test('an email address IS read out, because that is what makes the approval checkable', () => {
  // redaction.js buckets an address as `sensitive` alongside a card number.
  // Spoken aloud they are nothing alike: naming the recipient is the entire
  // point, and withholding it would leave "send an email" — unverifiable.
  const text = approvalReadback(manifest(), { confirmWord: 'falcon' })

  assert.match(text, /sam@example\.com/)
})

test('a command classified as an outright secret falls back to the title', () => {
  const text = approvalReadback(
    manifest({ command: 'the wifi password is hunter2, put it in the form', title: 'Fill the network form' }),
    { confirmWord: 'falcon' },
  )

  assert.ok(!text.includes('hunter2'), 'the password must not reach the speaker')
  // The title is written by the planner, not dictated by the owner.
  assert.match(text, /Fill the network form/)
})

test('a secret command with no title says the wording was withheld rather than going silent', () => {
  const text = approvalReadback(
    manifest({ command: 'the gate code is 8842, open it', title: null }),
    { confirmWord: 'falcon' },
  )

  assert.ok(!text.includes('8842'))
  assert.match(text, /withheld/)
  assert.match(text, /approve falcon/)
})

test('the confirm word survives a plan too wordy to fit the readback budget', () => {
  // A plan whose labels alone would blow the budget: the middle must be shed,
  // never the tail, or the readback asks for a word it never said.
  const fat = manifest({
    command: 'x'.repeat(400),
    steps: Array.from({ length: 30 }, (_value, index) => ({
      seq: index,
      type: 'delete_path',
      label: `delete the very long path number ${index} ${'y'.repeat(120)}`,
      effect: 'write',
      riskTier: 'irreversible-write',
      reversible: false,
      touches: [{ kind: 'path', ref: `/Users/o/${'z'.repeat(200)}/${index}` }],
      preState: { kind: 'unobservable', why: 'n/a' },
    })),
  })

  const text = approvalReadback(fat, { confirmWord: 'marlin' })

  assert.ok(text.length <= READBACK_MAX_CHARS, `readback was ${text.length} chars`)
  assert.match(text, /approve marlin/)
})

test('the spoken readback is normalised the same way an announcement is', () => {
  const record = buildApprovalRequest({
    manifest: manifest({ command: '## Send **sam** the `notes` summary' }),
    now: NOW,
  })

  // Markdown from a planner would otherwise be spoken as "hash hash".
  assert.ok(!approvalSpeech(record).includes('##'))
  assert.ok(!approvalSpeech(record).includes('**'))
})

/* --------------------------------------------------------- confirm word */

test('the confirm word is required for anything that cannot be walked back', () => {
  assert.equal(confirmWordRequired(manifest()), true, 'send_email is off-machine')

  const gentle = manifest({
    steps: [{ seq: 0, type: 'read_file', effect: 'read', riskTier: 'observe', reversible: true, touches: [] }],
  })
  assert.equal(confirmWordRequired(gentle), false, 'a read-only plan needs no code word')
})

test('two pending approvals force a confirm word even for a harmless plan', () => {
  const gentle = manifest({
    steps: [{ seq: 0, type: 'read_file', effect: 'read', riskTier: 'observe', reversible: true, touches: [] }],
  })

  // "Yes" cannot identify one of two, and committing the wrong prepared plan is
  // precisely the accident this module exists to prevent.
  assert.equal(confirmWordRequired(gentle, { pendingCount: 2 }), true)
})

test('the confirm word is derived from the plan, so both bodies reach it independently', () => {
  const digest = planDigestFor(manifest())

  assert.equal(confirmWordFor(digest), confirmWordFor(digest))
  assert.ok(CONFIRM_WORDS.includes(confirmWordFor(digest)))
})

test('no confirm word can be mistaken by the firmware for a control token', () => {
  // main.c matches text downlink with strstr() on these three quoted tokens.
  for (const word of CONFIRM_WORDS) {
    assert.ok(!word.includes('started'), word)
    assert.ok(!word.includes('flush'), word)
    assert.ok(!word.includes('end'), word)
  }
})

/* ------------------------------------------------------------ listening */

test('a refusal beats an assent in the same breath', () => {
  // "don't approve that" contains "approve"; a loose match commits it.
  for (const said of ["no, don't approve that", 'cancel, do it later', 'wait, not yet']) {
    assert.equal(matchApprovalUtterance(said, { confirmWord: 'falcon' }).decision, 'denied', said)
  }
})

test('the confirm word on its own is not consent', () => {
  // The pendant may have caught the tail of its own readback, or the owner may
  // be repeating the word back while thinking.
  const heard = matchApprovalUtterance('falcon', { confirmWord: 'falcon', requiresConfirmWord: true })

  assert.equal(heard.decision, 'unclear')
  assert.equal(heard.matchedWord, 'falcon')
})

test('an assent without the required word is unclear, and says which word to use', () => {
  const heard = matchApprovalUtterance('yes go ahead', { confirmWord: 'falcon', requiresConfirmWord: true })

  assert.equal(heard.decision, 'unclear')
  assert.match(heard.why, /approve falcon/)
})

test('an assent with the wrong word does not grant', () => {
  const heard = matchApprovalUtterance('approve cobalt', { confirmWord: 'falcon', requiresConfirmWord: true })

  assert.equal(heard.decision, 'unclear')
  assert.equal(heard.matchedWord, null)
})

test('ASR punctuation does not stop the word matching', () => {
  const heard = matchApprovalUtterance('Approve, Falcon.', { confirmWord: 'falcon', requiresConfirmWord: true })

  assert.equal(heard.decision, 'granted')
  assert.equal(heard.matchedWord, 'falcon')
})

test('silence grants nothing', () => {
  assert.equal(matchApprovalUtterance('', { confirmWord: 'falcon' }).decision, 'unclear')
  assert.equal(matchApprovalUtterance('   ', { confirmWord: 'falcon' }).decision, 'unclear')
})

/* ------------------------------------------------------------- verdicts */

test('an approval whose readback was never spoken is refused', () => {
  // Nobody can have heard what they were approving.
  const record = buildApprovalRequest({ manifest: manifest(), now: NOW })
  const verdict = evaluateApprovalGrant(record, {
    utterance: `approve ${record.confirmWord}`,
    now: NOW + 1000,
  })

  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'not-delivered')
})

test('a delivered approval with the right word is granted', () => {
  const record = delivered()
  const verdict = evaluateApprovalGrant(record, {
    utterance: `approve ${record.confirmWord}`,
    now: NOW + 60_000,
  })

  assert.equal(verdict.ok, true)
  assert.equal(verdict.decision, 'granted')
  // The partial world check is reported at the boundary, not buried.
  assert.equal(verdict.blindSteps, 1)
})

test('an approval that arrives hours late is refused, not honoured', () => {
  const record = delivered()
  const verdict = evaluateApprovalGrant(record, {
    utterance: `approve ${record.confirmWord}`,
    now: NOW + 4 * 60 * 60 * 1000,
  })

  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'expired')
  // The refusal explains itself in words that can be read out loud.
  assert.match(verdict.why, /expired/)
  assert.match(verdict.why, /Prepare it again/)
})

test('an approval is answered once; a replayed grant does not commit twice', () => {
  const record = delivered()
  const first = evaluateApprovalGrant(record, { utterance: `approve ${record.confirmWord}`, now: NOW + 60_000 })
  const settled = settleApproval(record, first, { now: NOW + 60_000 })

  const second = evaluateApprovalGrant(settled, { utterance: `approve ${record.confirmWord}`, now: NOW + 90_000 })

  assert.equal(second.ok, false)
  assert.equal(second.reason, 'already-decided')
})

test('a refusal about the record state does not overwrite the decision already recorded', () => {
  const record = delivered()
  const granted = settleApproval(record, { ok: true, decision: 'granted' }, { now: NOW + 1 })
  const replay = evaluateApprovalGrant(granted, { utterance: 'approve falcon', now: NOW + 2 })

  // "already-decided" describes the record, so applying it must leave the
  // original grant intact rather than downgrading it to 'refused'.
  assert.equal(settleApproval(granted, replay, { now: NOW + 3 }).state, 'granted')
})

test('a plan that changed after the readback is refused', () => {
  const record = delivered()
  const verdict = evaluateApprovalGrant(record, {
    utterance: `approve ${record.confirmWord}`,
    planDigest: 'a-different-plan-entirely',
    now: NOW + 60_000,
  })

  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'plan-changed')
})

test('a world that moved under the plan is refused even inside the window', () => {
  const record = delivered()
  const verdict = evaluateApprovalGrant(record, {
    utterance: `approve ${record.confirmWord}`,
    worldNow: { hash: 'something-else', observedSteps: 1, blindSteps: 1 },
    now: NOW + 60_000,
  })

  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'world-moved')
})

test('a spoken refusal is recorded as denied rather than as a failure', () => {
  const record = delivered()
  const verdict = evaluateApprovalGrant(record, { utterance: 'no, cancel that', now: NOW + 60_000 })

  assert.equal(verdict.ok, false)
  assert.equal(verdict.decision, 'denied')
  assert.equal(settleApproval(record, verdict, { now: NOW + 60_000 }).state, 'denied')
})

test('a missing record refuses instead of throwing', () => {
  const verdict = evaluateApprovalGrant(null, { utterance: 'approve falcon' })

  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'not-found')
})

/* ------------------------------------------------------------- requests */

test('a request carries the readback it was built with, fixed at prepare time', () => {
  const record = buildApprovalRequest({ manifest: manifest(), now: NOW })

  // Stored rather than re-derived, so a body running a different version of this
  // file cannot produce a second, differently-worded description of the same
  // decision.
  assert.equal(record.readback, approvalReadback(manifest(), {
    confirmWord: record.confirmWord,
    ttlMs: APPROVAL_DEFAULT_TTL_MS,
  }))
  assert.equal(record.state, 'pending')
  assert.equal(record.deliveredAt, null)
  assert.equal(record.ledgerId, 'ldg_test')
})

test('the ttl is clamped rather than trusted', () => {
  const tiny = buildApprovalRequest({ manifest: manifest(), ttlMs: 1, now: NOW })
  const huge = buildApprovalRequest({ manifest: manifest(), ttlMs: 99 * 60 * 60 * 1000, now: NOW })

  assert.equal(Date.parse(tiny.expiresAt) - NOW, APPROVAL_MIN_TTL_MS)
  assert.equal(Date.parse(huge.expiresAt) - NOW, APPROVAL_MAX_TTL_MS)
})

test('an approval must point at a manifest with steps', () => {
  assert.throws(() => buildApprovalRequest({ manifest: null }), /plan manifest/)
  assert.throws(() => buildApprovalRequest({ manifest: manifest({ steps: [] }) }), /at least one step/)
})

test('the presented approval hides nothing, because there is nothing to hide', () => {
  const record = delivered()
  const shown = presentApproval(record)

  // The confirm word is spoken aloud by design, so withholding it from a
  // response would only make the record harder to debug.
  assert.equal(shown.confirmWord, record.confirmWord)
  assert.equal(shown.readback, record.readback)
})

/* -------------------------------------------------------------- world */

test('the world fingerprint counts what it could not see', () => {
  const world = worldFingerprintFor(manifest())

  assert.equal(world.observedSteps, 1, 'only the write_file has a target')
  assert.equal(world.blindSteps, 1, 'send_email leaves nothing to compare')
})

test('a changed content hash changes the fingerprint; a touched mtime does not', () => {
  const before = worldFingerprintFor(manifest())

  const touched = manifest()
  touched.steps[0].preState.target.mtimeMs = 999_999
  assert.equal(worldFingerprintFor(touched).hash, before.hash, 'a touch is not a change')

  const edited = manifest()
  edited.steps[0].preState.target.sha256 = 'cafebabe'
  assert.notEqual(worldFingerprintFor(edited).hash, before.hash, 'different bytes are a change')
})

test('a file that grew past the hash ceiling reads as changed, not as unchanged', () => {
  const before = worldFingerprintFor(manifest())

  const unhashable = manifest()
  unhashable.steps[0].preState.target.sha256 = null
  unhashable.steps[0].preState.target.hashSkipped = 'larger than 33554432 bytes'

  assert.notEqual(worldFingerprintFor(unhashable).hash, before.hash)
})

/* ----------------------------------------------------------- delivery */

test('only one approval is read out at a time, and the rest are counted', () => {
  const first = { ...delivered(), approvalId: 'apv_1', state: 'pending', createdAt: '2026-08-07T09:00:00.000Z' }
  const second = { ...delivered(), approvalId: 'apv_2', state: 'pending', createdAt: '2026-08-07T09:05:00.000Z' }

  const chosen = selectApprovalToSpeak([second, first], { now: NOW + 60_000 })

  // Reading two back to back is how the owner approves the second while
  // picturing the first.
  assert.equal(chosen.approval.approvalId, 'apv_1', 'oldest first')
  assert.equal(chosen.waiting, 2)
  assert.match(chosen.speech, /1 other prepared action is waiting/)
})

test('an expired approval is never spoken', () => {
  const stale = delivered()

  assert.equal(approvalIsLive(stale, NOW + 60_000), true)
  assert.equal(approvalIsLive(stale, NOW + APPROVAL_MAX_TTL_MS), false)
  assert.equal(selectApprovalToSpeak([stale], { now: NOW + APPROVAL_MAX_TTL_MS }).approval, null)
})

test('speaking is recorded once however many attempts it takes', () => {
  const record = buildApprovalRequest({ manifest: manifest(), now: NOW })
  const once = attestApprovalDelivery(record, {
    evidence: 'stream-complete', sentBytes: 4096, totalBytes: 4096, now: NOW + 1000,
  }).record
  const twice = attestApprovalDelivery(once, {
    evidence: 'stream-complete', sentBytes: 4096, totalBytes: 4096, now: NOW + 9000,
  }).record

  // The first time it went out is the moment; the retries are a count, not a
  // new fact.
  assert.equal(twice.spokenAt, once.spokenAt)
  assert.equal(twice.attempts, 2)
  // And however many times it is streamed, streaming never becomes hearing.
  assert.equal(twice.deliveredAt, null)
  assert.equal(twice.deliveryState, 'spoken')
})

test('an approval control frame stays inside what the firmware will accept', () => {
  const frame = approvalControlFrame({ approvalId: 'apv_abc123', seconds: 12 })

  assert.match(frame, /"approval"/)
  assert.ok(!frame.includes('"started"'))
  assert.ok(!frame.includes('"end"'))
  // An id with a quote or a brace in it would be a way to smuggle a token past
  // the guard; safeId() in announce.js rejects it.
  assert.throws(() => approvalControlFrame({ approvalId: 'a"flush"b' }))
})

/* ------------------------------------------------------------ storage */

test('the relay contract needs no new store method', () => {
  // The store modules are being edited elsewhere; a feature that can ship on the
  // existing saveState/getState pair should.
  assert.equal(approvalStateKey('apv_1'), 'approval:apv_1')
  assert.equal(approvalIndexKey('nrf9160-pendant'), 'approvals:nrf9160-pendant')
  assert.match(APPROVAL_STORE_CONTRACT.note, /no new store method/)
})

test('the per-device index is bounded and drops what has expired', () => {
  const live = { ...delivered(), approvalId: 'apv_live', expiresAt: new Date(NOW + 600_000).toISOString() }
  const dead = { approvalId: 'apv_dead', expiresAt: new Date(NOW - 1).toISOString(), createdAt: '2026-08-07T08:00:00.000Z' }

  const index = indexApproval({ entries: [dead] }, live, { now: NOW })

  assert.deepEqual(index.entries.map((entry) => entry.approvalId), ['apv_live'])
})

test('the index never grows without bound', () => {
  let index = { entries: [] }
  for (let count = 0; count < MAX_INDEXED_APPROVALS + 10; count += 1) {
    index = indexApproval(
      index,
      { approvalId: `apv_${count}`, deviceId: 'p', expiresAt: new Date(NOW + 600_000).toISOString(), createdAt: new Date(NOW + count).toISOString() },
      { now: NOW },
    )
  }

  assert.equal(index.entries.length, MAX_INDEXED_APPROVALS)
  assert.equal(index.entries[0].approvalId, `apv_${MAX_INDEXED_APPROVALS + 9}`, 'newest first')
})

test('re-indexing the same approval does not duplicate it', () => {
  const record = { approvalId: 'apv_1', deviceId: 'p', expiresAt: new Date(NOW + 600_000).toISOString(), createdAt: new Date(NOW).toISOString() }
  const index = indexApproval(indexApproval({ entries: [] }, record, { now: NOW }), record, { now: NOW })

  assert.equal(index.entries.length, 1)
})
