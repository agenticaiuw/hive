import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  adoptHandoff,
  contextIdFor,
  contextLocation,
  getContext,
  handoffFor,
  intentHashFor,
  listContexts,
  openContext,
  recordEvent,
  stampPlan,
} from './executionContext.js'
import {
  commitTransaction,
  planTransaction,
  readCommitted,
  stagingHomeFor,
  sweepStagingDirectories,
  verifyOutputs,
  WorkbenchTransactionError,
} from './workbenchTransaction.js'
import { registerWorkbenchRoutes } from './workbenchRoutes.js'

const moduleUrl = new URL('./workbenchTransaction.js', import.meta.url).href
const here = path.dirname(fileURLToPath(import.meta.url))

/* Every test gets its own base directory. Nothing in this file may touch
 * ~/AI-Pendant-Workspace, and nothing may read a production default. */
function createBase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-txn-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function read(basePath, relative) {
  return fs.readFileSync(path.join(basePath, relative), 'utf8')
}

const OLD = 'OLD-'.repeat(400)
const NEW = 'NEW-'.repeat(500)

test('commits a manifest, fsyncing the file and its directory before recording it', async (t) => {
  const basePath = createBase(t)

  const result = await commitTransaction({
    jobId: 'local_a',
    intent: { kind: 'briefing', label: 'morning', window: '2026-08-07' },
    outputs: [
      { path: 'briefings/morning.md', contents: '# Morning\n' },
      { path: 'briefings/latest.json', json: { kind: 'morning' } },
    ],
    basePath,
  })

  assert.equal(result.ok, true)
  assert.equal(result.applied, true)
  assert.equal(result.replayed, false)
  assert.equal(result.decision, 'fresh')
  assert.equal(read(basePath, 'briefings/morning.md'), '# Morning\n')
  assert.deepEqual(JSON.parse(read(basePath, 'briefings/latest.json')), { kind: 'morning' })

  assert.equal(result.durability.fileFsync, true)
  assert.equal(result.durability.fullFsync, false, 'Darwin fsync is not F_FULLFSYNC; say so')
  for (const state of Object.values(result.durability.directorySync)) {
    assert.equal(state, 'ok', 'the containing directory must be fsynced, not just the file')
  }

  const mode = fs.statSync(path.join(basePath, 'briefings/morning.md')).mode & 0o777
  assert.equal(mode, 0o600)

  const context = getContext(result.contextId, { filePath: contextLocation(basePath) })
  assert.equal(context.status, 'committed')
  assert.equal(context.outputs.length, 2)
  assert.deepEqual(fs.readdirSync(stagingHomeFor(basePath)), [], 'staging must be swept on commit')
  assert.deepEqual(
    fs.readdirSync(path.join(basePath, 'briefings')).filter((name) => name.startsWith('.wbx-')),
    [],
  )
})

test('a replayed job with the same id and intent is a no-op: produce is never called', async (t) => {
  const basePath = createBase(t)
  let produced = 0
  const intent = { kind: 'digest', label: 'catch-up', since: '2026-08-06T00:00:00Z' }

  const produce = async () => {
    produced += 1
    return [{ path: 'digests/catchup.md', contents: `run ${produced}\n` }]
  }

  const first = await commitTransaction({ jobId: 'local_b', intent, produce, basePath })
  const stat = fs.statSync(path.join(basePath, 'digests/catchup.md'))

  const second = await commitTransaction({ jobId: 'local_b', intent, produce, basePath })

  assert.equal(produced, 1, 'the expensive half must not run twice')
  assert.equal(second.replayed, true)
  assert.equal(second.applied, false)
  assert.equal(second.produced, false)
  assert.equal(second.decision, 'completed')
  assert.equal(second.contextId, first.contextId)
  assert.equal(read(basePath, 'digests/catchup.md'), 'run 1\n')
  assert.equal(
    fs.statSync(path.join(basePath, 'digests/catchup.md')).mtimeMs,
    stat.mtimeMs,
    'a no-op must not rewrite the destination',
  )

  const contexts = listContexts({ filePath: contextLocation(basePath), jobId: 'local_b' })
  assert.equal(contexts.length, 1, 'a retry must not open a second context')
  assert.equal(contexts[0].attempts, 1, 'a recognised replay is not a new attempt')
})

test('changed inputs are a different job, not a retry of the same one', async (t) => {
  const basePath = createBase(t)
  let produced = 0
  const produce = async () => {
    produced += 1
    return [{ path: 'digests/catchup.md', contents: `run ${produced}\n` }]
  }

  const first = await commitTransaction({
    jobId: 'local_c',
    intent: { kind: 'digest', since: '2026-08-06T00:00:00Z' },
    produce,
    basePath,
  })
  const second = await commitTransaction({
    jobId: 'local_c',
    intent: { kind: 'digest', since: '2026-08-07T00:00:00Z' },
    produce,
    basePath,
  })

  assert.equal(produced, 2, 'a re-run must actually run')
  assert.equal(second.decision, 'rerun')
  assert.notEqual(second.intentHash, first.intentHash)
  assert.notEqual(second.contextId, first.contextId)
  assert.equal(read(basePath, 'digests/catchup.md'), 'run 2\n')

  const context = getContext(second.contextId, { filePath: contextLocation(basePath) })
  assert.equal(context.supersedes, first.contextId, 'the chain must stay readable')
  assert.ok(context.sequence > first.sequence, 'the sequence is monotonic across contexts')
})

test('intent hashing is order-independent, input-sensitive, and refuses to hash a cycle', () => {
  const a = intentHashFor({ kind: 'brief', window: { to: 'b', from: 'a' } })
  const b = intentHashFor({ window: { from: 'a', to: 'b' }, kind: 'brief' })
  assert.equal(a, b, 'key order is not part of the intent')

  assert.notEqual(a, intentHashFor({ kind: 'brief', window: { from: 'a', to: 'c' } }))
  assert.notEqual(
    a,
    intentHashFor({ kind: 'brief', window: { to: 'b', from: 'a' } }, { destinations: ['x.md'] }),
    'the destination is part of the event',
  )

  const cyclic = { kind: 'brief' }
  cyclic.self = cyclic
  assert.throws(() => intentHashFor(cyclic), /cycle/)
  assert.throws(() => intentHashFor(undefined), /declared intent/)
})

/*
 * THE INTERRUPT TEST.
 *
 * An exception thrown inside this process unwinds through the transaction's
 * own cleanup, which is exactly the code under suspicion — it would tidy the
 * evidence away and prove nothing. So the transaction runs in a CHILD process
 * that calls process.exit() from the phase hook: no finally blocks, no
 * rollback, no flush. That is what a crash looks like.
 */
function runInterrupted(basePath, { marker, mode }) {
  const script = path.join(basePath, 'interrupt-child.mjs')
  fs.writeFileSync(
    script,
    `import { commitTransaction } from ${JSON.stringify(moduleUrl)}
const [basePath, marker, mode] = process.argv.slice(2)
const outputs = mode === 'double'
  ? [
      { path: 'briefings/first.md', contents: ${JSON.stringify(NEW)} },
      { path: 'briefings/second.md', contents: ${JSON.stringify(NEW)} },
    ]
  : [{ path: 'briefings/first.md', contents: ${JSON.stringify(NEW)} }]
await commitTransaction({
  jobId: 'local_interrupted',
  intent: { kind: 'briefing', label: 'overnight', mode },
  outputs,
  basePath,
  onPhase: (phase) => {
    if (phase === marker) process.exit(42)
  },
})
`,
    'utf8',
  )

  const child = spawnSync(process.execPath, [script, basePath, marker, mode], {
    cwd: here,
    encoding: 'utf8',
  })
  assert.equal(child.status, 42, `child should have been killed at ${marker}: ${child.stderr}`)
  return child
}

test('a crash between write and rename leaves the old file, never a mix', async (t) => {
  const basePath = createBase(t)
  fs.mkdirSync(path.join(basePath, 'briefings'), { recursive: true })
  fs.writeFileSync(path.join(basePath, 'briefings/first.md'), OLD)

  runInterrupted(basePath, { marker: 'before-rename', mode: 'single' })

  const after = read(basePath, 'briefings/first.md')
  assert.equal(after, OLD, 'the destination must be the old content, byte for byte')
  assert.notEqual(after, NEW)
  assert.equal(after.includes('NEW-'), false, 'no partial write may reach the destination')

  /* The child really did get as far as staging: the staged bytes are on disk,
   * just not at the destination. Without this the test would also pass if the
   * child had died before doing anything at all. */
  const stagingHome = stagingHomeFor(basePath)
  const stagedDirs = fs.readdirSync(stagingHome)
  assert.equal(stagedDirs.length, 1, 'the interrupted transaction left its staging directory')
  const stagedFiles = fs.readdirSync(path.join(stagingHome, stagedDirs[0]))
  assert.equal(stagedFiles.length, 1)
  assert.equal(fs.readFileSync(path.join(stagingHome, stagedDirs[0], stagedFiles[0]), 'utf8'), NEW)

  const filePath = contextLocation(basePath)
  const contextId = contextIdFor(
    'local_interrupted',
    intentHashFor(
      { kind: 'briefing', label: 'overnight', mode: 'single' },
      { destinations: ['briefings/first.md'] },
    ),
  )
  const context = getContext(contextId, { filePath })
  assert.equal(context.status, 'staging', 'an interrupted transaction is never "committed"')

  const outstanding = handoffFor('local_interrupted', { filePath }).outstanding
  assert.equal(outstanding.length, 1)
  assert.match(outstanding[0].reason, /interrupted between write and rename/)

  /* And the retry completes it. */
  const retry = await commitTransaction({
    jobId: 'local_interrupted',
    intent: { kind: 'briefing', label: 'overnight', mode: 'single' },
    outputs: [{ path: 'briefings/first.md', contents: NEW }],
    basePath,
  })
  assert.equal(retry.decision, 'retry')
  assert.equal(retry.applied, true)
  assert.equal(read(basePath, 'briefings/first.md'), NEW)
  assert.equal(getContext(contextId, { filePath }).status, 'committed')

  const swept = sweepStagingDirectories({ basePath, olderThanMs: 0 })
  assert.equal(swept.removed.length, 1, 'the orphaned staging directory is collectable')
})

test('a crash between two renames leaves each file whole and the set uncommitted', async (t) => {
  const basePath = createBase(t)
  fs.mkdirSync(path.join(basePath, 'briefings'), { recursive: true })
  fs.writeFileSync(path.join(basePath, 'briefings/first.md'), OLD)
  fs.writeFileSync(path.join(basePath, 'briefings/second.md'), OLD)

  runInterrupted(basePath, { marker: 'after-rename:0', mode: 'double' })

  const first = read(basePath, 'briefings/first.md')
  const second = read(basePath, 'briefings/second.md')
  assert.equal(first, NEW, 'the renamed file is entirely the new content')
  assert.equal(second, OLD, 'the un-renamed file is entirely the old content')
  for (const contents of [first, second]) {
    assert.ok(contents === OLD || contents === NEW, 'never a mix of old and new bytes')
  }

  /*
   * This is the case the commit record exists for: per-file atomicity held,
   * but the SET is half applied. A consumer must be able to find that out
   * rather than read two files that disagree.
   */
  const intent = { kind: 'briefing', label: 'overnight', mode: 'double' }
  const destinations = ['briefings/first.md', 'briefings/second.md']
  const status = readCommitted({ jobId: 'local_interrupted', intent, destinations, basePath })
  assert.equal(status.committed, false)
  assert.equal(status.reason, 'staging')

  const repaired = await commitTransaction({
    jobId: 'local_interrupted',
    intent,
    outputs: destinations.map((destination) => ({ path: destination, contents: NEW })),
    basePath,
  })
  assert.equal(repaired.applied, true)
  assert.equal(read(basePath, 'briefings/second.md'), NEW)
  assert.equal(
    readCommitted({ jobId: 'local_interrupted', intent, destinations, basePath }).committed,
    true,
  )
})

test('a failure we can see rolls the whole set back to what it found', async (t) => {
  const basePath = createBase(t)
  fs.mkdirSync(path.join(basePath, 'plans'), { recursive: true })
  fs.writeFileSync(path.join(basePath, 'plans/a.md'), OLD)
  /* plans/b.md does not exist: its rollback is an unlink, not a restore. */

  await assert.rejects(
    () =>
      commitTransaction({
        jobId: 'local_d',
        intent: { kind: 'tidy', label: 'downloads' },
        outputs: [
          { path: 'plans/a.md', contents: NEW },
          { path: 'plans/b.md', contents: NEW },
        ],
        basePath,
        onPhase: (phase) => {
          if (phase === 'after-rename:1') throw new Error('simulated failure after both renames')
        },
      }),
    (error) => {
      assert.ok(error instanceof WorkbenchTransactionError)
      assert.equal(error.phase, 'rename')
      assert.equal(error.rollback.complete, true)
      return true
    },
  )

  assert.equal(read(basePath, 'plans/a.md'), OLD, 'the pre-existing file is restored')
  assert.equal(fs.existsSync(path.join(basePath, 'plans/b.md')), false, 'a new file is removed')
  assert.deepEqual(
    fs.readdirSync(path.join(basePath, 'plans')).filter((name) => name.startsWith('.wbx-')),
    [],
    'no snapshot or temp litter survives a rollback',
  )
  assert.deepEqual(fs.readdirSync(stagingHomeFor(basePath)), [])

  const context = listContexts({ filePath: contextLocation(basePath), jobId: 'local_d' })[0]
  assert.equal(context.status, 'failed')
})

test('a committed record whose output drifted is rebuilt, not reported as done', async (t) => {
  const basePath = createBase(t)
  let produced = 0
  const intent = { kind: 'brief', label: 'weekly' }
  const produce = async () => {
    produced += 1
    return [{ path: 'briefs/weekly.md', contents: `built ${produced}\n` }]
  }

  await commitTransaction({ jobId: 'local_e', intent, produce, basePath })
  fs.rmSync(path.join(basePath, 'briefs/weekly.md'))

  const plan = planTransaction({
    jobId: 'local_e',
    intent,
    basePath,
  })
  assert.equal(plan.decision, 'repair')
  assert.match(plan.verification.reason, /missing output/)

  const repaired = await commitTransaction({ jobId: 'local_e', intent, produce, basePath })
  assert.equal(produced, 2)
  assert.equal(repaired.decision, 'repair')
  assert.equal(read(basePath, 'briefs/weekly.md'), 'built 2\n')

  /* An edit by the owner counts as drift too. */
  fs.writeFileSync(path.join(basePath, 'briefs/weekly.md'), 'built 2\n owner edit')
  const context = getContext(repaired.contextId, { filePath: contextLocation(basePath) })
  assert.equal(verifyOutputs(context, { basePath }).intact, false)
})

test('a destination on another device is staged beside itself, never renamed across', async (t) => {
  const basePath = createBase(t)

  /*
   * A real second filesystem would mean mounting a disk image, which is a
   * change to the machine, not to this test. Reporting a different device id
   * for the staging directory exercises the same branch: the transaction must
   * notice and stage the file as a sibling of its destination.
   */
  const realStat = fs.statSync
  t.mock.method(fs, 'statSync', (target, ...rest) => {
    const stats = realStat.call(fs, target, ...rest)
    if (String(target).includes('.pendant-workbench-stage')) {
      return new Proxy(stats, {
        get: (source, key) => (key === 'dev' ? source.dev + 1 : Reflect.get(source, key)),
      })
    }
    return stats
  })

  const result = await commitTransaction({
    jobId: 'local_f',
    intent: { kind: 'brief', label: 'external volume' },
    outputs: [{ path: 'external/brief.md', contents: NEW }],
    basePath,
  })

  assert.equal(result.staging.crossDevice, true)
  assert.equal(result.outputs[0].crossDevice, true)
  assert.equal(read(basePath, 'external/brief.md'), NEW)
  assert.deepEqual(
    fs.readdirSync(path.join(basePath, 'external')).filter((name) => name.startsWith('.wbx-')),
    [],
  )
})

test('an EXDEV rename is retried beside the destination, never turned into a copy', async (t) => {
  const basePath = createBase(t)
  const realRename = fs.renameSync
  let thrown = false

  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!thrown && String(to).endsWith('brief.md')) {
      thrown = true
      const error = new Error('EXDEV: cross-device link not permitted')
      error.code = 'EXDEV'
      throw error
    }
    return realRename.call(fs, from, to)
  })

  const result = await commitTransaction({
    jobId: 'local_g',
    intent: { kind: 'brief', label: 'exdev' },
    outputs: [{ path: 'volumes/brief.md', contents: NEW }],
    basePath,
  })

  assert.equal(thrown, true, 'the EXDEV branch must actually have been taken')
  assert.equal(read(basePath, 'volumes/brief.md'), NEW)
  assert.equal(result.outputs[0].crossDevice, true)
  assert.deepEqual(
    fs.readdirSync(path.join(basePath, 'volumes')).filter((name) => name.includes('.tmp')),
    [],
  )
})

test('refuses to write outside the base, including through a symlinked subdirectory', async (t) => {
  const basePath = createBase(t)
  const outside = createBase(t)
  fs.symlinkSync(outside, path.join(basePath, 'escape'))

  for (const destination of ['../elsewhere.md', '/etc/hosts', 'escape/note.md']) {
    await assert.rejects(
      () =>
        commitTransaction({
          jobId: 'local_h',
          intent: { kind: 'brief', label: 'escape' },
          outputs: [{ path: destination, contents: 'x' }],
          basePath,
        }),
      /outside the workbench base/,
      `${destination} must be refused`,
    )
  }

  assert.equal(fs.existsSync(path.join(outside, 'note.md')), false)
})

test('a manifest that names one destination twice is refused before anything is written', async (t) => {
  const basePath = createBase(t)
  await assert.rejects(
    () =>
      commitTransaction({
        jobId: 'local_i',
        intent: { kind: 'brief', label: 'dupe' },
        outputs: [
          { path: 'notes/a.md', contents: 'one' },
          { path: './notes/a.md', contents: 'two' },
        ],
        basePath,
      }),
    /twice/,
  )
  assert.equal(fs.existsSync(path.join(basePath, 'notes/a.md')), false)
})

test('the handoff tells a restarted job what it already did, and cannot be talked backwards', (t) => {
  const basePath = createBase(t)
  const filePath = contextLocation(basePath)

  const descriptor = stampPlan({
    jobId: 'local_j',
    parentId: 'local_parent',
    intent: { kind: 'investigation', label: 'overnight' },
  })
  assert.equal(descriptor.rootId, 'local_parent')
  const opened = openContext(descriptor, { filePath })
  assert.equal(opened.decision, 'fresh')
  assert.equal(openContext(descriptor, { filePath }).decision, 'retry')
  assert.equal(getContext(descriptor.contextId, { filePath }).attempts, 2)

  const foreign = adoptHandoff(
    {
      jobId: 'local_k',
      contextId: contextIdFor('local_k', descriptor.intentHash),
      intentHash: descriptor.intentHash,
      sequence: 9999,
      status: 'committed',
      references: [{ kind: 'plan', id: 'relay-plan-1' }],
    },
    { filePath },
  )
  assert.equal(foreign.adopted, true)
  const adopted = getContext(foreign.context.contextId, { filePath })
  assert.equal(adopted.status, 'adopted', 'a foreign commit describes a disk we cannot see')
  assert.equal(adopted.remoteSequence, 9999)
  assert.ok(adopted.sequence < 9999, 'a foreign counter never becomes the local one')

  assert.deepEqual(adoptHandoff({ jobId: 'x', contextId: 'y', intentHash: 'z' }, { filePath }), {
    adopted: false,
    reason: 'identity_mismatch',
  })
  assert.equal(adoptHandoff(null, { filePath }).adopted, false)

  const handoff = handoffFor('local_j', { filePath })
  assert.equal(handoff.known, true)
  assert.equal(handoff.contexts[0].contextId, descriptor.contextId)
  assert.equal(handoffFor('local_nothing', { filePath }).known, false)
})

test('an adopted foreign context never satisfies the local idempotency gate', async (t) => {
  const basePath = createBase(t)
  const filePath = contextLocation(basePath)
  const intent = { kind: 'brief', label: 'relayed' }
  const destinations = ['relayed/brief.md']
  const intentHash = intentHashFor(intent, { destinations })

  adoptHandoff(
    {
      jobId: 'local_l',
      contextId: contextIdFor('local_l', intentHash),
      intentHash,
      status: 'committed',
      sequence: 4,
    },
    { filePath },
  )

  let produced = 0
  const result = await commitTransaction({
    jobId: 'local_l',
    intent,
    outputs: [{ path: destinations[0], contents: 'real bytes\n' }],
    basePath,
    produce: async () => {
      produced += 1
      return []
    },
  })

  assert.equal(result.applied, true, 'a claim from elsewhere is not evidence about this disk')
  assert.equal(produced, 0, 'the static manifest was used, so produce was not needed')
  assert.equal(read(basePath, 'relayed/brief.md'), 'real bytes\n')
})

test('registerWorkbenchRoutes mounts read-and-record routes and runs nothing', (t) => {
  const basePath = createBase(t)
  const routes = { get: [], post: [] }
  const handlers = new Map()
  const app = {
    get: (route, handler) => {
      routes.get.push(route)
      handlers.set(`GET ${route}`, handler)
    },
    post: (route, handler) => {
      routes.post.push(route)
      handlers.set(`POST ${route}`, handler)
    },
  }

  registerWorkbenchRoutes(app, { filePath: contextLocation(basePath), basePath })

  assert.deepEqual(routes.post, ['/workbench/plan', '/workbench/contexts', '/workbench/handoff'])
  assert.deepEqual(routes.get, [
    '/workbench/contexts',
    '/workbench/contexts/:contextId',
    '/workbench/jobs/:jobId/handoff',
  ])
  assert.throws(() => registerWorkbenchRoutes({}), /Express-style app/)

  let body = null
  const response = {
    status(code) {
      this.code = code
      return this
    },
    json(payload) {
      body = payload
      return this
    },
  }

  handlers.get('POST /workbench/plan')(
    {
      body: {
        jobId: 'local_m',
        intent: { kind: 'brief', label: 'route' },
        outputs: [{ path: 'routed/brief.md', contents: 'ignored by a read-only route' }],
      },
    },
    response,
  )
  assert.equal(body.ok, true)
  assert.equal(body.executed, false)
  assert.equal(body.decision, 'fresh')
  assert.equal(fs.existsSync(path.join(basePath, 'routed')), false, 'planning writes no output')

  handlers.get('POST /workbench/contexts')(
    { body: { jobId: 'local_m', intent: { kind: 'brief', label: 'route' } } },
    response,
  )
  assert.equal(body.ok, true)
  assert.equal(response.code, 201)
  assert.equal(body.context.status, 'open')

  handlers.get('POST /workbench/plan')({ body: { outputs: [] } }, response)
  assert.equal(body.ok, false, 'a request with no intent is refused, not hashed as undefined')
})

/*
 * The directory fsync is the step most implementations skip, and it is
 * invisible from userspace: you cannot read back "was this rename durable".
 * What CAN be checked is that we opened the destination directory and called
 * fsync on that descriptor, which is the only thing the process controls.
 */
test('fsyncs the staged file and the destination directory, not just the file', async (t) => {
  const basePath = createBase(t)
  const realOpen = fs.openSync
  const realFsync = fs.fsyncSync
  const byDescriptor = new Map()
  const fsyncedPaths = []

  t.mock.method(fs, 'openSync', (target, ...rest) => {
    const descriptor = realOpen.call(fs, target, ...rest)
    byDescriptor.set(descriptor, String(target))
    return descriptor
  })
  t.mock.method(fs, 'fsyncSync', (descriptor) => {
    fsyncedPaths.push(byDescriptor.get(descriptor) ?? `fd:${descriptor}`)
    return realFsync.call(fs, descriptor)
  })

  const result = await commitTransaction({
    jobId: 'local_fsync',
    intent: { kind: 'brief', label: 'durability' },
    outputs: [{ path: 'durable/brief.md', contents: NEW }],
    basePath,
  })

  const destinationDirectory = path.join(basePath, 'durable')
  /* Strictly INSIDE the staging root: the root itself is a directory we also
   * fsync, and matching on the prefix alone would let a missing file fsync
   * pass on the strength of the directory's. */
  const isStagedFile = (target) => target.startsWith(`${result.staging.root}${path.sep}`)

  assert.ok(
    fsyncedPaths.includes(destinationDirectory),
    `the destination directory was never fsynced: ${fsyncedPaths.join(', ')}`,
  )
  assert.ok(fsyncedPaths.some(isStagedFile), 'the staged file itself was never fsynced')
  assert.ok(
    fsyncedPaths.indexOf(destinationDirectory) > fsyncedPaths.findIndex(isStagedFile),
    'the file must be durable before the rename that publishes it is',
  )
})

test('the store stays inside its budget and keeps interrupted contexts longest', (t) => {
  const basePath = createBase(t)
  const filePath = contextLocation(basePath)

  /* The state a real crash leaves: staged, never committed. Pruning must shed
   * settled contexts before this one, because it is the only record that says
   * "an interrupted write may have half-landed". */
  const interrupted = stampPlan({ jobId: 'local_survivor', intent: { kind: 'brief', n: 0 } })
  openContext(interrupted, { filePath })
  recordEvent(interrupted.contextId, { status: 'staging' }, { filePath })

  const fatReferences = Array.from({ length: 40 }, (_, index) => ({
    kind: 'evidence',
    id: `${index}-${'r'.repeat(600)}`,
  }))
  for (let index = 0; index < 30; index += 1) {
    openContext(
      stampPlan({
        jobId: `local_bulk_${index}`,
        intent: { kind: 'bulk', index },
        references: fatReferences,
      }),
      { filePath },
    )
  }

  const kept = listContexts({ filePath, limit: 500 })
  assert.ok(kept.length < 31, `pruning never ran: ${kept.length} contexts kept`)
  assert.ok(
    fs.statSync(filePath).size < 2 * 256 * 1024,
    `store outgrew its budget: ${fs.statSync(filePath).size} bytes`,
  )
  assert.ok(
    kept.some((context) => context.contextId === interrupted.contextId),
    'the interrupted context is the last thing that should be dropped',
  )
})
