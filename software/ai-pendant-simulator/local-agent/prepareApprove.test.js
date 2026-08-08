import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  PENDANT_DELIVERY_REALITY,
  actionsForCommit,
  commitApproval,
  currentWorldFingerprint,
  prepareAction,
  registerPrepareApproveRoutes,
} from './prepareApprove.js'
import { getLedger } from './actionLedger.js'
import { attestApprovalDelivery } from '../shared/approvalHandoff.js'

/*
 * These tests run against a REAL ledger file and a REAL temp directory rather
 * than a stubbed manifest. The whole staleness mechanism is a comparison of two
 * filesystem readings taken at different times, so a fake filesystem would test
 * the assertion and not the thing.
 */
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-approve-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    ledger: path.join(dir, 'ledger.json'),
    file(name, body) {
      const target = path.join(dir, name)
      fs.writeFileSync(target, body)
      return target
    },
  }
}

function plan(space) {
  const target = space.file('notes.txt', 'the original body')
  return [
    { type: 'write_file', label: 'update the notes file', params: { path: target, content: 'a new body' } },
    {
      type: 'send_email',
      label: 'email the summary to sam@example.com',
      params: { to: 'sam@example.com', subject: 'Summary', body: 'here it is' },
    },
  ]
}

/*
 * Prepare, then record what the relay's speaking actually witnessed.
 *
 * This is HALF of delivery and deliberately stops there — a stream is witnessed
 * by a socket, and a socket is not an ear. The other half is the confirm word
 * coming back, which commitApproval() attests from the utterance itself, so
 * every test below that passes a `approve <word>` utterance is exercising the
 * real two-witness path rather than a record pre-stamped as heard.
 */
function spokenToPendant(record) {
  const attested = attestApprovalDelivery(record, {
    evidence: 'stream-complete',
    sentBytes: 4096,
    totalBytes: 4096,
  })
  assert.equal(attested.ok, true, attested.why)
  return attested.record
}

function preparedAndHeard(space, overrides = {}) {
  const actions = overrides.actions ?? plan(space)
  const prepared = prepareAction({
    command: 'send sam the notes summary',
    actions,
    filePath: space.ledger,
    ...overrides,
  })
  return { prepared, actions, approval: spokenToPendant(prepared.approval) }
}

/* ------------------------------------------------------------- prepare */

test('preparing writes a manifest and runs nothing', (t) => {
  const space = workspace(t)
  const actions = plan(space)

  const prepared = prepareAction({ command: 'send sam the notes summary', actions, filePath: space.ledger })

  assert.equal(prepared.executed, false)
  assert.equal(prepared.approval.state, 'pending')
  // The file the plan intends to overwrite is untouched.
  assert.equal(fs.readFileSync(path.join(space.dir, 'notes.txt'), 'utf8'), 'the original body')
  // And the manifest is durable, because the owner is expected to walk away and
  // the Mac is expected to sleep.
  assert.ok(getLedger(prepared.approval.ledgerId, { filePath: space.ledger }))
})

test('the prepared approval carries a readback naming the irreversible step', (t) => {
  const space = workspace(t)
  const { prepared } = preparedAndHeard(space)

  assert.match(prepared.approval.readback, /cannot be undone/)
  assert.match(prepared.approval.readback, /sam@example\.com/)
  assert.match(prepared.approval.readback, new RegExp(`approve ${prepared.approval.confirmWord}`))
})

test('the prepared response says where the relay should park the record', (t) => {
  const space = workspace(t)
  const { prepared } = preparedAndHeard(space)

  // It lives on the relay, not in Mac memory, because a sleeping Mac cannot be
  // asked for it during exactly the interval it exists for.
  assert.equal(prepared.relay.stateKey, `approval:${prepared.approval.approvalId}`)
  assert.match(prepared.relay.contract.note, /no new store method/)
})

test('preparing an empty plan refuses rather than creating an approval for nothing', (t) => {
  const space = workspace(t)

  assert.throws(() => prepareAction({ command: 'do it', actions: [], filePath: space.ledger }), /at least one action/)
})

/* ------------------------------------------------------------- commit */

test('a delivered approval with the right word yields actions, and still runs nothing', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)

  const result = commitApproval({
    approval,
    utterance: `approve ${approval.confirmWord}`,
    actions,
    filePath: space.ledger,
  })

  assert.equal(result.ok, true)
  assert.equal(result.committed, true)
  // A commit produces actions; it does not perform them.
  assert.equal(result.executed, false)
  assert.equal(result.actions.length, 2)
  assert.equal(fs.readFileSync(path.join(space.dir, 'notes.txt'), 'utf8'), 'the original body')
})

test('a commit reports how much of the world nothing could vouch for', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)

  const result = commitApproval({ approval, utterance: `approve ${approval.confirmWord}`, actions, filePath: space.ledger })

  assert.equal(result.verified.observedSteps, 1)
  // send_email leaves nothing local to compare, and a caller logging "verified"
  // should be able to see that.
  assert.equal(result.verified.blindSteps, 1)
  assert.match(result.verified.note, /leave no local state/)
})

test('an approval whose readback was never spoken is refused', (t) => {
  const space = workspace(t)
  const { prepared, actions } = preparedAndHeard(space)

  const result = commitApproval({
    approval: prepared.approval, // never marked delivered
    utterance: `approve ${prepared.approval.confirmWord}`,
    actions,
    filePath: space.ledger,
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-delivered')
})

/* --------------------------------------------------------- staleness */

test('an approval that arrives hours late for a plan is refused, not honoured', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)

  const result = commitApproval({
    approval,
    utterance: `approve ${approval.confirmWord}`,
    actions,
    filePath: space.ledger,
    now: Date.now() + 6 * 60 * 60 * 1000,
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
  assert.equal(result.approval.state, 'refused')
})

test('a world that moved under the plan refuses the commit inside the window', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)

  // Somebody else edits the file the plan was going to overwrite.
  fs.writeFileSync(path.join(space.dir, 'notes.txt'), 'edited by someone else')

  const result = commitApproval({ approval, utterance: `approve ${approval.confirmWord}`, actions, filePath: space.ledger })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'world-moved')
  assert.match(result.why, /no longer as it was when this was described to you/)
})

test('a touched mtime is not a moved world', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)

  // Same bytes, new mtime — a `touch`, or a restore from a snapshot. Refusing
  // here would reject approvals for edits that never happened.
  const target = path.join(space.dir, 'notes.txt')
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(target, later, later)

  const result = commitApproval({ approval, utterance: `approve ${approval.confirmWord}`, actions, filePath: space.ledger })

  assert.equal(result.ok, true)
})

test('the file coming back to its original bytes is not a moved world either', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)
  const target = path.join(space.dir, 'notes.txt')

  fs.writeFileSync(target, 'a detour')
  fs.writeFileSync(target, 'the original body')

  // Content is the verdict, so a round trip back to the described state is
  // genuinely the described state.
  assert.equal(commitApproval({ approval, utterance: `approve ${approval.confirmWord}`, actions, filePath: space.ledger }).ok, true)
})

test('a deleted target is a moved world', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)

  fs.rmSync(path.join(space.dir, 'notes.txt'))

  assert.equal(
    commitApproval({ approval, utterance: `approve ${approval.confirmWord}`, actions, filePath: space.ledger }).reason,
    'world-moved',
  )
})

test('the world route reports staleness without committing anything', (t) => {
  const space = workspace(t)
  const { prepared } = preparedAndHeard(space)
  const app = fakeApp()
  registerPrepareApproveRoutes(app, { filePath: space.ledger })

  const fresh = app.call('get', '/prepare/:ledgerId/world', { params: { ledgerId: prepared.approval.ledgerId } })
  assert.equal(fresh.body.matches, true)
  assert.equal(fresh.body.readOnly, true)

  fs.writeFileSync(path.join(space.dir, 'notes.txt'), 'changed')
  const stale = app.call('get', '/prepare/:ledgerId/world', { params: { ledgerId: prepared.approval.ledgerId } })

  // The relay uses this to avoid spending a button press reading out a plan that
  // is already doomed.
  assert.equal(stale.body.matches, false)
})

/* -------------------------------------------------------- the decision */

test('a spoken refusal is a denial, not a fault', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)

  const result = commitApproval({ approval, utterance: 'no, cancel that', actions, filePath: space.ledger })

  assert.equal(result.decision, 'denied')
  assert.equal(result.approval.state, 'denied')
})

test('a denial does not depend on the plan still being on disk', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)

  // The ledger store is bounded and drops the oldest records, so an approval can
  // outlive its plan. "You declined" must not come back as "I lost the plan",
  // which reads as a fault worth retrying.
  fs.rmSync(space.ledger)

  const result = commitApproval({ approval, utterance: 'no, forget it', actions, filePath: space.ledger })

  assert.equal(result.decision, 'denied')
  assert.equal(result.reason, 'denied')
})

test('an assent without the required confirm word commits nothing', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)

  const result = commitApproval({ approval, utterance: 'yes go ahead', actions, filePath: space.ledger })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unclear')
  assert.match(result.why, new RegExp(`approve ${approval.confirmWord}`))
})

test('a commit against a plan that is no longer on this Mac refuses', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)

  // A fresh store rather than an unlinked file: atomicJsonStore keeps a backup
  // and recovers a deleted ledger from it, so deleting the path does not
  // actually simulate a plan this Mac has never seen.
  const elsewhere = path.join(space.dir, 'a-different-ledger.json')

  const result = commitApproval({ approval, utterance: `approve ${approval.confirmWord}`, actions, filePath: elsewhere })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'plan-missing')
})

/* --------------------------------------------------------- the actions */

test('actions supplied for a commit are checked against the plan, not trusted', (t) => {
  const space = workspace(t)
  const { approval } = preparedAndHeard(space)

  const substituted = [{ type: 'delete_path', params: { path: path.join(space.dir, 'notes.txt') } }]
  const result = commitApproval({ approval, utterance: `approve ${approval.confirmWord}`, actions: substituted, filePath: space.ledger })

  // Otherwise the commit is a channel for swapping in a plan nobody read back.
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'plan-changed')
})

test('a plan with no secrets can be rebuilt from the manifest alone', (t) => {
  const space = workspace(t)
  const { approval } = preparedAndHeard(space)

  const result = commitApproval({ approval, utterance: `approve ${approval.confirmWord}`, filePath: space.ledger })

  assert.equal(result.ok, true)
  assert.equal(result.actionsFrom, 'manifest')
})

test('a plan whose parameters were withheld as secret cannot be committed from the manifest', (t) => {
  const space = workspace(t)
  const actions = [
    {
      type: 'write_file',
      label: 'write the deploy config',
      params: { path: space.file('config.env', 'old'), content: 'api_key: sk-live_ABCDEFGHIJKLMNOPQRSTUV' },
    },
  ]
  const { approval } = preparedAndHeard(space, { actions })

  const fromManifest = commitApproval({ approval, utterance: `approve ${approval.confirmWord}`, filePath: space.ledger })

  // actionLedger.js masks secret parameters on the way to disk, so the action
  // genuinely cannot be reconstructed. Reporting that beats executing a masked
  // value as if it were the real one.
  assert.equal(fromManifest.ok, false)
  assert.equal(fromManifest.reason, 'plan-unreadable')
  assert.match(fromManifest.why, /prepare the plan again/)

  // Supplying the originals is the supported way through, and they are still
  // checked against the prepared plan. The world check still works here: only
  // `content` was withheld, and the world is re-read by `path`.
  const supplied = commitApproval({ approval, utterance: `approve ${approval.confirmWord}`, actions, filePath: space.ledger })
  assert.equal(supplied.ok, true)
  assert.equal(supplied.actionsFrom, 'supplied')
  assert.equal(supplied.verified.observedSteps, 1)
})

test('a secret CONTENT does not block the world check, but a secret PATH does', (t) => {
  const space = workspace(t)
  const { prepared } = preparedAndHeard(space)
  const manifest = getLedger(prepared.approval.ledgerId, { filePath: space.ledger })

  // Losing the bytes a step would write costs the ability to replay it. It does
  // not cost the ability to check whether the file it names has changed.
  manifest.steps[0].withheldParams = ['content']
  assert.equal(currentWorldFingerprint(manifest).degraded.length, 0)

  // Losing the path it navigates by costs exactly that, and must be reported as
  // "cannot look" rather than as "someone changed your file".
  manifest.steps[0].withheldParams = ['path']
  const degraded = currentWorldFingerprint(manifest).degraded
  assert.equal(degraded.length, 1)
  assert.match(degraded[0].why, /cannot be re-read/)
})

test('actionsForCommit reports unreadable steps rather than emitting empty params', (t) => {
  const space = workspace(t)
  const { prepared } = preparedAndHeard(space)
  const manifest = getLedger(prepared.approval.ledgerId, { filePath: space.ledger })

  manifest.steps[0].resumable = false
  manifest.steps[0].notResumableReason = 'its parameters were shed to fit the byte budget.'

  const recovered = actionsForCommit(manifest, null)

  assert.equal(recovered.ok, false)
  assert.equal(recovered.reason, 'plan-unreadable')
  assert.match(recovered.why, /prepare the plan again/)
})

/* ----------------------------------------------------------- the world */

test('an unreadable step is reported as unverifiable, never as movement', (t) => {
  const space = workspace(t)
  const { prepared } = preparedAndHeard(space)
  const manifest = getLedger(prepared.approval.ledgerId, { filePath: space.ledger })

  manifest.steps[0].params = null
  manifest.steps[0].paramsElided = { elided: 'params exceeded the ledger byte budget', bytes: 900 }

  const world = currentWorldFingerprint(manifest)

  // "We shredded the parameter" must not be announced as "someone changed your
  // file" — that is the worse lie of the two.
  assert.equal(world.degraded.length, 1)
  assert.equal(world.hash, currentWorldFingerprint(manifest).hash, 'and it stays stable')
})

test('a commit whose world cannot be re-read refuses, and does not claim movement', (t) => {
  const space = workspace(t)
  const { approval, actions } = preparedAndHeard(space)

  /* The realistic route into this branch: a plan large enough that
   * pruneLedgers() shed its parameters, committed by a caller who still holds
   * the originals. The actions check out against the plan, so the commit gets
   * past actionsForCommit — but the manifest no longer names a file to re-read,
   * so staleness cannot be established either way. */
  const store = JSON.parse(fs.readFileSync(space.ledger, 'utf8'))
  const manifest = store.ledgers.find((entry) => entry.ledgerId === approval.ledgerId)
  manifest.steps[0].params = null
  manifest.steps[0].paramsElided = { elided: 'params exceeded the ledger byte budget', bytes: 900 }
  fs.writeFileSync(space.ledger, JSON.stringify(store))

  const result = commitApproval({ approval, utterance: `approve ${approval.confirmWord}`, actions, filePath: space.ledger })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'world-unverifiable')
  // Refusing a commit whose staleness cannot be established is the point; saying
  // the world moved when nothing is known to have moved would be a lie.
  assert.notEqual(result.reason, 'world-moved')
  assert.match(result.why, /cannot be re-checked/)
})

/* ------------------------------------------------------------- routes */

test('the routes prepare and decide, and neither one executes', (t) => {
  const space = workspace(t)
  const app = fakeApp()
  registerPrepareApproveRoutes(app, { filePath: space.ledger })

  const actions = plan(space)
  const prepared = app.call('post', '/prepare', { body: { command: 'send sam the summary', actions } })
  assert.equal(prepared.status, 201)
  assert.equal(prepared.body.executed, false)

  const approval = spokenToPendant(prepared.body.approval)
  const decided = app.call('post', '/approve', {
    body: { approval, utterance: `approve ${approval.confirmWord}`, actions },
  })

  assert.equal(decided.body.ok, true)
  assert.equal(decided.body.executed, false)
  assert.equal(fs.readFileSync(path.join(space.dir, 'notes.txt'), 'utf8'), 'the original body')
})

test('a refusal is a 200 so nobody retries it as a transport failure', (t) => {
  const space = workspace(t)
  const app = fakeApp()
  registerPrepareApproveRoutes(app, { filePath: space.ledger })

  const actions = plan(space)
  const prepared = app.call('post', '/prepare', { body: { command: 'send it', actions } })
  const approval = spokenToPendant(prepared.body.approval)
  fs.writeFileSync(path.join(space.dir, 'notes.txt'), 'moved on')

  const refused = app.call('post', '/approve', {
    body: { approval, utterance: `approve ${approval.confirmWord}`, actions },
  })

  // A retried commit against a moved world is the accident this path prevents.
  assert.equal(refused.status, 200)
  assert.equal(refused.body.reason, 'world-moved')
})

test('a prepare with no actions is a 400', (t) => {
  const space = workspace(t)
  const app = fakeApp()
  registerPrepareApproveRoutes(app, { filePath: space.ledger })

  assert.equal(app.call('post', '/prepare', { body: { command: 'go', actions: [] } }).status, 400)
})

test('the routes refuse an app that is not Express-shaped', () => {
  assert.throws(() => registerPrepareApproveRoutes({}), /Express-style app/)
})

/* ----------------------------------------------------------- delivery */

test('the module states plainly what the firmware cannot do today', () => {
  // The relay cannot tell the pendant an approval is waiting: binary downlink is
  // dropped unless convo_started is set, and text downlink is matched with
  // strstr() against only "started", "flush" and "end".
  assert.equal(PENDANT_DELIVERY_REALITY.worksToday, 'reply-audio')
  assert.equal(PENDANT_DELIVERY_REALITY.doesNotWorkToday, 'unprompted-push')
  assert.ok(PENDANT_DELIVERY_REALITY.firmwareWorkNeeded.length >= 3)
})

/* -------------------------------------------------------------- harness */

/** The smallest thing that answers to app.get/app.post and records a response. */
function fakeApp() {
  const routes = new Map()
  const app = {
    get(routePath, handler) {
      routes.set(`get ${routePath}`, handler)
      return app
    },
    post(routePath, handler) {
      routes.set(`post ${routePath}`, handler)
      return app
    },
    call(method, routePath, request = {}) {
      const handler = routes.get(`${method} ${routePath}`)
      if (!handler) throw new Error(`no route ${method} ${routePath}`)
      const captured = { status: 200, body: null }
      const response = {
        status(code) {
          captured.status = code
          return response
        },
        json(body) {
          captured.body = body
          return response
        },
      }
      handler({ body: {}, params: {}, query: {}, ...request }, response)
      return captured
    },
  }
  return app
}
