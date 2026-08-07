import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CALIBRATION_COOLDOWN_MS,
  HALF_LIFE_MS,
  NEED_THRESHOLD,
  SESSION_NEED,
  compareReadings,
  describeSessionNeed,
  forgetOrigin,
  judgeSessionNeed,
  listSessionNeeds,
  mentionsOwnerPrivateData,
  observationFromComparison,
  originOf,
  readSessionNeedStore,
  recordSessionObservation,
  sessionNeedFor,
  shouldCalibrate,
  sweepSessionNeeds,
} from './sessionNeedSignal.js'

/* A store per test, so nothing here can learn from — or teach — the owner's
 * real one. */
function store(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-need-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'session-need.json')
}

const T0 = Date.parse('2026-08-07T09:00:00.000Z')
const SHOP = 'https://shop.example/orders/4471'

/* Two readings of the same page, one taken with a session and one without.
 * Deliberately plausible rather than adversarial: this is the case the whole
 * signal exists for — the logged-out page renders 200 OK and looks fine. */
const PUBLIC_VIEW =
  'Acme Storefront. Browse the catalogue of widgets, gadgets and sprockets. ' +
  'Shipping information, returns policy, contact us. Sign in to see your orders.'
const OWNER_VIEW =
  'Acme Storefront. Order 4471 shipped Tuesday by courier. Order 4482 arrives Friday. ' +
  'Order 4490 is being packed now. Manage returns, track a parcel, change delivery address.'

const FORECAST =
  'Weather for Tuesday: a high of 22 degrees and a low of 14, with light rain in the ' +
  'afternoon clearing by evening. Sunrise at 06:12 and sunset at 20:41.'

/* The other shape of divergence: the logged-out browser sees MORE, because it
 * got the consent gate instead of the page. */
const CONSENT_WALL =
  'We value your privacy. We and our partners store or access information on a device, ' +
  'such as cookies, and process personal data such as unique identifiers and standard ' +
  'information sent by a device for personalised advertising and content, advertising ' +
  'and content measurement, audience research and services development. Manage options, ' +
  'reject all, accept all, vendor list, legitimate interest, purposes and features.'

/* ------------------------------------------------------------ comparison */

test('two readings of the same page compare as the same page', () => {
  const comparison = compareReadings(FORECAST, `${FORECAST} Updated at 09:00.`)
  assert.equal(comparison.verdict, 'same')
  assert.ok(comparison.jaccard > 0.8, `overlap was ${comparison.jaccard}`)
})

test('a logged-out storefront and the owner\'s order list compare as different', () => {
  const comparison = compareReadings(PUBLIC_VIEW, OWNER_VIEW)
  assert.equal(comparison.verdict, 'different')
  assert.ok(comparison.onlyInAuthenticated > 5, 'the owner view should carry words the public one lacks')
})

test('unrelated pages are different and a stub is different from a real page', () => {
  assert.equal(compareReadings(FORECAST, OWNER_VIEW).verdict, 'different')

  /* The classic wall: a handful of words where a page should be. */
  const stub = compareReadings('Please sign in to continue.', OWNER_VIEW)
  assert.equal(stub.verdict, 'different')
  assert.equal(stub.direction, 'authenticated-richer')
})

test('an empty logged-out reading is divergence, an empty owner reading proves nothing', () => {
  assert.equal(compareReadings('', OWNER_VIEW).verdict, 'different')
  /* The Mac returning nothing is a broken read, not evidence about the page. */
  assert.equal(compareReadings(PUBLIC_VIEW, '').verdict, 'inconclusive')
  assert.equal(compareReadings('', '').verdict, 'inconclusive')
})

test('a comparison becomes an observation only when it settles something', () => {
  const same = observationFromComparison(compareReadings(FORECAST, FORECAST))
  assert.equal(same.kind, 'converged')
  assert.ok(same.weight < 0)

  const different = observationFromComparison(compareReadings(PUBLIC_VIEW, OWNER_VIEW))
  assert.equal(different.kind, 'divergent')
  assert.ok(different.weight > 0)

  /* Divergence where the logged-out page is the bigger one is usually a consent
   * or ad wall, so it counts for less than the owner seeing more. */
  const inverted = observationFromComparison(compareReadings(CONSENT_WALL, 'Order 4471 shipped Tuesday.'))
  assert.equal(inverted.kind, 'divergent')
  assert.ok(
    inverted.weight < different.weight,
    'a public-richer divergence must not weigh as much as an authenticated-richer one',
  )

  assert.equal(observationFromComparison({ verdict: 'inconclusive' }), null)
})

/* -------------------------------------------------------------- verdicts */

test('an unobserved origin is unknown — there is no built-in list of sites', () => {
  const filePath = store(test)
  for (const url of [
    'https://mail.example.com/inbox',
    'https://bank.example.org/accounts',
    'https://news.example.net/story',
  ]) {
    const need = sessionNeedFor(url, { filePath, now: T0 })
    assert.equal(need.verdict, SESSION_NEED.UNKNOWN, `${url} should start unjudged`)
    assert.equal(need.observations, 0)
  }
})

test('one sign-in wall settles an origin, and the verdict decays back to unknown', () => {
  const filePath = store(test)
  recordSessionObservation(
    { url: SHOP, kind: 'login-wall', detail: 'rendered a sign-in wall' },
    { filePath, now: T0 },
  )

  const fresh = sessionNeedFor(SHOP, { filePath, now: T0 })
  assert.equal(fresh.verdict, SESSION_NEED.REQUIRED)
  assert.ok(fresh.score >= NEED_THRESHOLD)
  assert.match(fresh.basis[0], /login-wall/)

  /* Halved at the half-life, which drops it under the threshold: a wall seen a
   * week ago is not a standing fact about the origin. */
  const aged = sessionNeedFor(SHOP, { filePath, now: T0 + HALF_LIFE_MS })
  assert.equal(aged.verdict, SESSION_NEED.UNKNOWN)
  assert.ok(aged.score < fresh.score, 'the score must fall as the observation ages')

  const older = sessionNeedFor(SHOP, { filePath, now: T0 + 3 * HALF_LIFE_MS })
  assert.ok(older.score < aged.score)
})

test('a divergence outweighs a wall and survives a week', () => {
  const filePath = store(test)
  const comparison = compareReadings(PUBLIC_VIEW, OWNER_VIEW)
  const observation = observationFromComparison(comparison)
  recordSessionObservation(
    { url: SHOP, kind: observation.kind, weight: observation.weight, stats: comparison },
    { filePath, now: T0 },
  )

  assert.equal(sessionNeedFor(SHOP, { filePath, now: T0 }).verdict, SESSION_NEED.REQUIRED)
  assert.equal(
    sessionNeedFor(SHOP, { filePath, now: T0 + HALF_LIFE_MS }).verdict,
    SESSION_NEED.REQUIRED,
    'a divergence is heavy enough to still stand a week later',
  )
})

test('proof that the two browsers agree pulls an origin back off the Mac', () => {
  const filePath = store(test)
  recordSessionObservation({ url: SHOP, kind: 'login-wall' }, { filePath, now: T0 })
  assert.equal(sessionNeedFor(SHOP, { filePath, now: T0 }).verdict, SESSION_NEED.REQUIRED)

  recordSessionObservation({ url: SHOP, kind: 'converged' }, { filePath, now: T0 })
  assert.equal(
    sessionNeedFor(SHOP, { filePath, now: T0 }).verdict,
    SESSION_NEED.UNKNOWN,
    'one convergence should cancel the wall rather than lose to it',
  )

  recordSessionObservation({ url: SHOP, kind: 'converged' }, { filePath, now: T0 })
  assert.equal(sessionNeedFor(SHOP, { filePath, now: T0 }).verdict, SESSION_NEED.PUBLIC)
})

test('a page that merely looked fine logged out cannot declare an origin public on its own', () => {
  const filePath = store(test)
  recordSessionObservation({ url: SHOP, kind: 'public-read-ok' }, { filePath, now: T0 })
  assert.equal(
    sessionNeedFor(SHOP, { filePath, now: T0 }).verdict,
    SESSION_NEED.UNKNOWN,
    'one clean logged-out read is the weakest evidence there is',
  )

  recordSessionObservation({ url: SHOP, kind: 'public-read-ok' }, { filePath, now: T0 })
  assert.equal(sessionNeedFor(SHOP, { filePath, now: T0 }).verdict, SESSION_NEED.PUBLIC)
})

test('a verdict belongs to an origin, not a path, and does not leak to its neighbours', () => {
  const filePath = store(test)
  recordSessionObservation({ url: SHOP, kind: 'login-wall' }, { filePath, now: T0 })

  assert.equal(
    sessionNeedFor('https://shop.example/account/settings', { filePath, now: T0 }).verdict,
    SESSION_NEED.REQUIRED,
  )
  assert.equal(
    sessionNeedFor('https://blog.example/post', { filePath, now: T0 }).verdict,
    SESSION_NEED.UNKNOWN,
  )
  assert.equal(originOf('https://SHOP.example:443/x?y=1'), 'https://shop.example')
  assert.equal(originOf('ftp://shop.example'), null)
})

test('the store survives a reopen, lists what it knows, and can be forgotten', () => {
  const filePath = store(test)
  recordSessionObservation({ url: SHOP, kind: 'login-wall' }, { filePath, now: T0 })
  recordSessionObservation({ url: 'https://news.example/a', kind: 'converged' }, { filePath, now: T0 })

  const reopened = readSessionNeedStore({ filePath })
  assert.ok(reopened.origins['https://shop.example'])

  const listed = listSessionNeeds({ filePath, now: T0 })
  assert.equal(listed.length, 2)
  assert.ok(Math.abs(listed[0].score) >= Math.abs(listed[1].score), 'heaviest first')

  assert.equal(forgetOrigin(SHOP, { filePath }).forgotten, true)
  assert.equal(sessionNeedFor(SHOP, { filePath, now: T0 }).verdict, SESSION_NEED.UNKNOWN)
})

test('sweeping drops observations that have decayed past usefulness', () => {
  const filePath = store(test)
  recordSessionObservation({ url: SHOP, kind: 'login-wall' }, { filePath, now: T0 })
  assert.equal(sweepSessionNeeds({ filePath, now: T0 }).originsAfter, 1)
  assert.equal(
    sweepSessionNeeds({ filePath, now: T0 + 60 * 24 * 60 * 60 * 1000 }).originsAfter,
    0,
    'a two-month-old observation is clutter, not evidence',
  )
})

test('an unknown observation kind is refused rather than silently weighted zero', () => {
  const filePath = store(test)
  assert.throws(
    () => recordSessionObservation({ url: SHOP, kind: 'looked-sketchy' }, { filePath, now: T0 }),
    /Unknown session-need observation/,
  )
  assert.throws(
    () => recordSessionObservation({ url: 'not a url', kind: 'login-wall' }, { filePath, now: T0 }),
    /http\(s\) origin/,
  )
})

/* -------------------------------------------------------------- phrasing */

test('phrasing spots the owner\'s own records without naming a single service', () => {
  assert.equal(mentionsOwnerPrivateData('what is my account balance').private, true)
  assert.equal(mentionsOwnerPrivateData('check our invoices for this month').private, true)
  assert.equal(mentionsOwnerPrivateData('am I still signed in there').private, true)

  assert.equal(mentionsOwnerPrivateData('who won the game last night').private, false)
  assert.equal(
    mentionsOwnerPrivateData('explain the order of operations in maths').private,
    false,
    'a private noun with no possessive is not the owner\'s record',
  )
  assert.equal(
    mentionsOwnerPrivateData('read my favourite recipe for lemon cake').private,
    false,
    'a possessive with no private record is not the owner\'s record',
  )
})

/* ------------------------------------------------------------ judgement */

test('phrasing can move a job onto the Mac, but only while nothing is known', () => {
  const filePath = store(test)
  const guessed = judgeSessionNeed({
    url: SHOP,
    requestText: 'check my orders',
    filePath,
    now: T0,
  })
  assert.equal(guessed.verdict, SESSION_NEED.REQUIRED)
  assert.equal(guessed.guessed, true)
  assert.ok(guessed.confidence < 0.5, 'a guess must not be priced like an observation')

  const plain = judgeSessionNeed({ url: SHOP, requestText: 'what is the weather', filePath, now: T0 })
  assert.equal(plain.verdict, SESSION_NEED.UNKNOWN)
})

test('two browsers that agreed beat the request phrasing', () => {
  const filePath = store(test)
  recordSessionObservation({ url: SHOP, kind: 'converged' }, { filePath, now: T0 })
  recordSessionObservation({ url: SHOP, kind: 'converged' }, { filePath, now: T0 })

  const judged = judgeSessionNeed({ url: SHOP, requestText: 'check my orders', filePath, now: T0 })
  assert.equal(
    judged.verdict,
    SESSION_NEED.PUBLIC,
    'a guess about wording must not overturn two fetches that actually matched',
  )
  assert.notEqual(judged.guessed, true)
})

test('a wall hit in this run outranks anything remembered', () => {
  const filePath = store(test)
  recordSessionObservation({ url: SHOP, kind: 'converged' }, { filePath, now: T0 })
  recordSessionObservation({ url: SHOP, kind: 'converged' }, { filePath, now: T0 })

  const judged = judgeSessionNeed({
    url: SHOP,
    probe: { likelyLoginWall: true },
    filePath,
    now: T0,
  })
  assert.equal(judged.verdict, SESSION_NEED.REQUIRED)
  assert.equal(judged.source, 'probe')
  assert.equal(judged.confidence, 1)
})

test('the owner marking an origin is an observation, not a setting — it decays too', () => {
  const filePath = store(test)
  recordSessionObservation({ url: SHOP, kind: 'owner-marked' }, { filePath, now: T0 })
  assert.equal(sessionNeedFor(SHOP, { filePath, now: T0 }).verdict, SESSION_NEED.REQUIRED)
  assert.equal(
    sessionNeedFor(SHOP, { filePath, now: T0 + 3 * HALF_LIFE_MS }).verdict,
    SESSION_NEED.UNKNOWN,
    'even the owner saying so must fade rather than become permanent configuration',
  )
})

/* ----------------------------------------------------------- calibration */

test('calibration is spent only on unjudged origins, only when the Mac is there', () => {
  const unknown = { verdict: SESSION_NEED.UNKNOWN, lastCalibratedAt: null }

  assert.equal(shouldCalibrate(unknown, { bridgeUp: true, now: T0 }).calibrate, true)
  assert.equal(shouldCalibrate(unknown, { bridgeUp: null, now: T0 }).calibrate, true)
  assert.equal(shouldCalibrate(unknown, { bridgeUp: false, now: T0 }).calibrate, false)
  assert.equal(shouldCalibrate(unknown, { bridgeUp: true, now: T0, enabled: false }).calibrate, false)

  assert.equal(
    shouldCalibrate({ verdict: SESSION_NEED.PUBLIC }, { bridgeUp: true, now: T0 }).calibrate,
    false,
    'a settled origin should not keep costing a Mac round-trip',
  )

  const justCalibrated = {
    verdict: SESSION_NEED.UNKNOWN,
    lastCalibratedAt: new Date(T0).toISOString(),
  }
  assert.equal(shouldCalibrate(justCalibrated, { bridgeUp: true, now: T0 + 60_000 }).calibrate, false)
  assert.equal(
    shouldCalibrate(justCalibrated, { bridgeUp: true, now: T0 + CALIBRATION_COOLDOWN_MS + 1 }).calibrate,
    true,
  )
})

test('recording a comparison is what resets the calibration cooldown', () => {
  const filePath = store(test)
  recordSessionObservation({ url: SHOP, kind: 'login-wall' }, { filePath, now: T0 })
  assert.equal(sessionNeedFor(SHOP, { filePath, now: T0 }).lastCalibratedAt, null)

  recordSessionObservation({ url: SHOP, kind: 'divergent' }, { filePath, now: T0 })
  assert.ok(sessionNeedFor(SHOP, { filePath, now: T0 }).lastCalibratedAt)
})

test('a verdict can explain itself out loud', () => {
  const filePath = store(test)
  recordSessionObservation(
    { url: SHOP, kind: 'login-wall', detail: 'the cloud browser rendered a sign-in wall' },
    { filePath, now: T0 },
  )
  const spoken = describeSessionNeed(sessionNeedFor(SHOP, { filePath, now: T0 }))
  assert.match(spoken, /shop\.example/)
  assert.match(spoken, /your own browser/)
})

test('page text is never written to the store', () => {
  const filePath = store(test)
  const comparison = compareReadings(PUBLIC_VIEW, OWNER_VIEW)
  recordSessionObservation(
    {
      url: SHOP,
      kind: 'divergent',
      weight: 1.5,
      detail: comparison.why,
      stats: comparison,
    },
    { filePath, now: T0 },
  )

  const raw = fs.readFileSync(filePath, 'utf8')
  assert.ok(!raw.includes('Order 4490'), 'the owner\'s page text must not land on disk here')
  assert.ok(!raw.includes('sprockets'))
  assert.match(raw, /jaccard/, 'the two comparison numbers are what gets kept')
})
