import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(here, '..', 'src')
const src = (name) => fs.readFileSync(path.join(srcDir, name), 'utf8')

/*
 * THE DEFECT, measured on the real built bundle 2026-08-10 by cycling the
 * popup document through five open/close rounds against ONE shared extension
 * context: listeners registered 1, 2, 3, 4, 5 — none ever released.
 *
 * storage.onChanged lives on the EXTENSION's context, which outlives any one
 * popover document, but the callback closes over that document's `elements`.
 * Every closed popup therefore left a listener behind that pinned a dead page
 * and still ran on every write the worker made. "Works the first time, then
 * stops" is what that looks like from the outside.
 *
 * These are source-shape assertions rather than a DOM test because the leak is
 * a property of REGISTRATION, not of rendering — the rendering was fine
 * throughout, which is exactly why it took so long to find.
 *
 * This file used to sweep options.js too; the options page was deleted at the
 * owner's order (2026-08-12: "delete the entire settings page"), so the popup
 * is the only document left that can leak.
 */
test('popup.js releases its storage listener when the document goes away', () => {
  const text = src('popup.js')

  /* A named function, because an inline arrow cannot be handed back. */
  assert.match(
    text,
    /api\.storage\.onChanged\.addListener\(onStorageChanged\)/,
    'listener must be registered by reference',
  )
  assert.match(
    text,
    /api\.storage\.onChanged\.removeListener\(onStorageChanged\)/,
    'the same reference must be removed',
  )
  /* And the removal has to be on the teardown event, not somewhere hopeful. */
  const pagehideBlock = text.slice(text.indexOf("addEventListener('pagehide'"))
  assert.ok(
    pagehideBlock.includes('removeListener(onStorageChanged)'),
    'removal must happen on pagehide',
  )
  /* No anonymous registration may sneak back in beside it. */
  assert.equal(
    /onChanged\.addListener\(\s*\(/.test(text),
    false,
    'no inline listener — it could never be removed',
  )
})

test('the popover is never closed from script', () => {
  /*
   * Calling window.close() on a Safari popover does not merely dismiss it:
   * Safari keeps one web view for the toolbar popover and reuses it, so
   * closing it from script can leave that view dead. Unnecessary too — the
   * new window takes focus and the browser dismisses the popover itself.
   */
  const text = src('popup.js').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(text.includes('window.close()'), false)
})

/*
 * THE SETTINGS PAGE IS DELETED, AND STAYS DELETED. The owner, 2026-08-12:
 * "having a settings page is lowkey kind of weird ... actually, delete the
 * entire settings page." Setup lives in the popup now. These assertions keep
 * a well-meaning refactor from resurrecting any half of it: the files, the
 * manifest entry, or code paths that send the owner to a page that no longer
 * exists.
 */
test('the options page is gone: no files, no manifest entry, no openers', () => {
  assert.equal(fs.existsSync(path.join(srcDir, 'options.html')), false)
  assert.equal(fs.existsSync(path.join(srcDir, 'options.js')), false)

  const manifest = JSON.parse(src('manifest.json'))
  assert.equal('options_ui' in manifest, false)
  assert.equal('options_page' in manifest, false)

  for (const file of ['popup.js', 'popup.html', 'background.js', 'command-console.js']) {
    assert.equal(
      src(file).includes('openOptionsPage'),
      false,
      `${file} must not open a settings page that does not exist`,
    )
  }
})

/*
 * THE PAIRING OUTCOME MUST NOT RIDE THE MESSAGE CHANNEL — that channel is the
 * root cause of "Pairing failed: the agent returned no token." on a healthy
 * agent: Safari drops the worker's async sendResponse when the agent's relay
 * leg runs long, the popup sees `undefined`, and the minted credential is
 * lost with the reply. The cure has two halves, and each is asserted where it
 * lives:
 *
 *   worker half — background.js applies the storage patch ITSELF when the
 *   fetch completes and writes the outcome record, so a lost reply can no
 *   longer lose a credential;
 *
 *   popup half — popup.js reads the outcome from storage.onChanged, and the
 *   undefined-reply path says pairing is still finishing, never the default
 *   "returned no token".
 */
test('the worker owns the pairing storage writes and the outcome record', () => {
  const text = src('background.js')
  const handler = text.slice(text.indexOf("message?.type === 'pair:run'"))
  assert.ok(handler.length > 100, 'the pair:run handler exists')

  assert.match(handler, /pairStoragePatch\(/, 'the worker applies the patch itself')
  assert.match(
    handler,
    /storage\.local\s*\.?\s*set\(\{ \[PAIR_OUTCOME_KEY\]/,
    'the worker writes the outcome under PAIR_OUTCOME_KEY',
  )
  /* The session-only sentinel is planted at pair time; its absence at the
   * next worker start is how "browser closed" is detected. */
  assert.match(handler, /pairSessionAlive/, 'session pairing plants the sentinel')
})

test('the popup reads the pairing outcome from storage, not the reply', () => {
  const text = src('popup.js')
  assert.match(
    text,
    /changes\[PAIR_OUTCOME_KEY\]/,
    'storage.onChanged carries the authoritative outcome',
  )
  assert.equal(
    text.replace(/\/\*[\s\S]*?\*\//g, '').includes('returned no token'),
    false,
    'the popup never prints the default no-token message on its own',
  )
})

/*
 * THE POPUP MUST BE ABLE TO PAIR WITH NO BACKGROUND AT ALL. Measured
 * 2026-08-12 on the owner's Safari (macOS 26): the background never evaluates
 * — not as service_worker, not as a background.scripts page — across
 * relaunches, a cache reset and a full re-registration, while the popup
 * document always runs and fetches loopback fine. So an unanswered 'pair:run'
 * is no longer narrated as "still pairing" (a promise nobody is keeping): the
 * popup waits one bounded window, consults pairFallbackVerdict, and then runs
 * the exchange ITSELF via runDirectPairing (page-engine.js) under the
 * worker's exact storage contract.
 */
test('the popup escalates a silent worker to the page-side pairing exchange', () => {
  const text = src('popup.js')
  assert.match(
    text,
    /PAIR_REPLY_TIMEOUT_MS/,
    'the worker gets a bounded reply window, not forever',
  )
  assert.match(
    text,
    /pairFallbackVerdict\(/,
    'the escalation decision is the pure verdict, not an inline guess',
  )
  assert.match(
    text,
    /runDirectPairing\(api,/,
    'the popup runs the direct exchange when the verdict says to',
  )
  /* The old dead-end message must stay gone: with a background that never
   * runs, "still pairing in the background" is a lie the owner waits on. */
  assert.equal(
    text.replace(/\/\*[\s\S]*?\*\//g, '').includes('Still pairing'),
    false,
    'no still-pairing narration — the popup acts instead of promising',
  )
})

test('the page-side exchange honours the worker\'s pairing storage contract', () => {
  const text = src('page-engine.js')
  assert.match(text, /pairStoragePatch\(/, 'the same patch policy decides what to store')
  assert.match(
    text,
    /storage\.local\.set\(\{ \[PAIR_OUTCOME_KEY\]/,
    'the outcome record lands under PAIR_OUTCOME_KEY',
  )
  assert.match(text, /pairSessionAlive/, 'session pairing plants the sentinel')
  assert.match(text, /shouldEscrow\(/, 'session-only pairings are never escrowed')
  /* The lifecycle discipline extends to the new module: nothing here may
   * register a storage listener it cannot hand back. */
  assert.equal(
    /onChanged\.addListener/.test(text),
    false,
    'page-engine.js registers no storage listeners at all',
  )
})

test('the worker enforces the credential lifetime on startup and alarms', () => {
  const text = src('background.js')
  assert.match(text, /enforceCredentialLifetime/, 'the enforcement function exists')
  const startPeers = text.slice(text.indexOf('function startPeers'))
  assert.ok(
    startPeers.slice(0, startPeers.indexOf('}')).includes('enforceCredentialLifetime'),
    'startPeers (startup + every alarm) runs the check',
  )
  assert.match(text, /PAIR_WIPE_KEYS/, 'an expiry wipes exactly the shared key list')
})

/*
 * STAGE 2 (1.7.6): THE PAGE ENGINE. When the background never evaluates, a
 * popup document runs the bridge loops itself. The discipline that keeps that
 * safe is asserted here, in the same source-shape style as the listener leak
 * above — these are properties of REGISTRATION and TEARDOWN, not rendering.
 */
test('the page engine dies with its document and releases what it held', () => {
  const popup = src('popup.js')
  /* pagehide is the teardown event for popovers Safari suspends rather than
   * destroys — the engine must stop there, beside the listener removal. */
  const pagehideBlocks = popup
    .split("addEventListener('pagehide'")
    .slice(1)
    .join('')
  assert.ok(
    pagehideBlocks.includes('pageEngine.stop'),
    'the engine is stopped on pagehide',
  )

  const engine = src('page-engine.js')
  const stopBlock = engine.slice(engine.indexOf('async function stop'))
  assert.match(
    stopBlock.slice(0, stopBlock.indexOf('/* The lease heartbeat')),
    /clearInterval\(leaseTimer\)/,
    'stop() drops the lease heartbeat timer',
  )
  assert.match(stopBlock, /mesh\.close\(\)/, 'stop() closes the doorbell socket')
  assert.match(stopBlock, /releaseLease\(\)/, 'stop() releases the lease it held')
  /* The lifecycle discipline extends to the engine module: no storage
   * listeners at all — the lease heartbeat polls, it does not subscribe. */
  assert.equal(/onChanged\.addListener/.test(engine), false)
})

test('the background always wins the engine lease', () => {
  const background = src('background.js')
  const startPeers = background.slice(background.indexOf('function startPeers'))
  const body = startPeers.slice(0, startPeers.indexOf('/*\n * CREDENTIAL ESCROW'))
  assert.match(
    body,
    /ENGINE_LEASE_KEY\]: \{ holder: BACKGROUND_HOLDER/,
    'startPeers (evaluation + every alarm) claims the lease',
  )

  const engine = src('page-engine.js')
  assert.match(
    engine,
    /the background always wins/,
    'leaseDecision encodes the background-first rule',
  )
})

test('one executor, one console: the engines share modules instead of forking', () => {
  const background = src('background.js')
  /* The executor left background.js whole — a copy left behind would be the
   * fork this extraction exists to prevent. */
  for (const marker of ['function runInPage', 'sanitizeExtraction', 'function executeCommand']) {
    assert.equal(
      background.includes(marker),
      false,
      `background.js must not keep its own "${marker}" — executor.js owns it`,
    )
  }
  assert.match(background, /from '\.\/executor\.js'/)
  assert.match(background, /from '\.\/console-engine\.js'/)

  const engine = src('page-engine.js')
  assert.match(engine, /from '\.\/executor\.js'/)
  assert.match(engine, /from '\.\/console-engine\.js'/)
})

test('the page engine inherits identity from storage, never invents its own', () => {
  /*
   * The coordinator's parity requirement: the fleet map's Browser Extension
   * node and the agent's /browser/status registry must light up identically
   * whichever engine heartbeats. That holds because BOTH identities live in
   * storage and are read through the same functions — extensionId via
   * getConfig()'s stored instanceId, relay deviceId via getRelayConfig() —
   * so the engine module must never assemble an identity of its own.
   */
  const engine = src('page-engine.js')
  assert.match(engine, /getConfig\(\)/, 'agent identity comes from getConfig')
  assert.match(engine, /getRelayConfig\(\)/, 'relay identity comes from getRelayConfig')
  assert.equal(
    engine.includes('ai-pendant-'),
    false,
    'the extensionId template lives in executor.js alone',
  )

  const executor = src('executor.js')
  assert.match(
    executor,
    /ai-pendant-\$\{api\.runtime\.id\}-\$\{values\.instanceId\}/,
    'executor.js builds the one extensionId both engines send',
  )
})

/*
 * LIVE FEEDBACK, 2026-08-12, minutes after the first successful direct pair
 * ("Paired. This browser is browser-24bf5f on the relay"): the popup asked
 * for the pairing code AGAIN, because "credentials stored, brain not live
 * yet" rendered as the full pairing card. And the freshly minted identity
 * has to reach a running engine's relay socket without waiting out a sweep.
 */
test('a stored credential is never re-asked for: the card has a compact state', () => {
  const text = src('popup.js')
  assert.match(
    text,
    /const compact = agentConfigured && !brainWorking && !forceFullSetup/,
    'compact = paired but not live (unless the owner asked for the full card)',
  )
  assert.match(
    text,
    /classList\.toggle\('setup-compact', compact\)/,
    'the compact state is a class the CSS collapses',
  )
  /* The collapse must actually collapse the code box. */
  const css = src('ui.css')
  const compactRule = css.slice(css.indexOf('.setup-compact'))
  assert.match(
    compactRule.slice(0, compactRule.indexOf('}')),
    /display: none/,
    'compact mode hides the code input and its row',
  )
  /* And the way back exists for the stored-but-dead credential. */
  assert.match(text, /forceFullSetup = true/, 'the re-pair link restores the full card')
})

test('a fresh pairing reaches a running engine\'s relay peer immediately', () => {
  const engine = src('page-engine.js')
  const changed = engine.slice(engine.indexOf('configChanged() {'))
  const body = changed.slice(0, changed.indexOf('},'))
  assert.match(body, /mesh\.clearRefusal\(\)/, 'a dead credential\'s refusal latch lifts')
  assert.match(body, /mesh\.close\(\)/, 'the socket under the old identity closes')
  assert.match(body, /relayWake/, 'the relay loop wakes instead of sleeping out a sweep')

  const popup = src('popup.js')
  assert.match(
    popup,
    /pageEngine\.configChanged\(\)/,
    'the popup\'s storage listener rings the engine on credential changes',
  )
  /* The relay loop runs in EVERY engine host — the owner who just pasted the
   * code into the popover is watching the brain chip in that popover. */
  const start = engine.slice(engine.indexOf('async start()'))
  assert.match(
    start.slice(0, start.indexOf('stop,')),
    /void relayLoop\(\)/,
    'start() launches the relay loop unconditionally',
  )
})

test('the setup card hides only when the brain is actually working', () => {
  /*
   * 2026-08-12, twice in one night: first the card was gated on the agent
   * token alone; then on stored-credential presence — and a stored-but-dead
   * relay credential kept it hidden while the chip said "No brain". The gate
   * must use describeBrainState's verdict, the same function the chip
   * renders from, so the two surfaces cannot disagree.
   */
  const text = src('popup.js')
  assert.match(
    text,
    /elements\.setup\.hidden = agentConfigured && brainWorking/,
    'hiding the setup card requires a WORKING brain, not a merely stored credential',
  )
  assert.match(
    text,
    /brainWorking: brainView\.brain === 'local'/,
    'the gate derives from describeBrainState, the same source as the chip',
  )
  assert.match(
    text,
    /type: 'bridge:poll-now' \}\)/,
    'the popup wakes the worker on open — Safari fires neither onStartup nor stale alarms reliably',
  )
})
