export const DEFAULT_AGENT_URL = 'http://127.0.0.1:8000'
export const DEFAULT_TARGET_MODE = 'last-focused'
export const MAX_SELECTOR_LENGTH = 2_000
export const MAX_TEXT_LENGTH = 50_000

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const TARGET_MODES = new Set(['last-focused', 'current-active', 'new-tab'])

/** Commands the extension can execute. Keep in sync with background.js. */
export const COMMAND_TYPES = new Set([
  'navigate',
  'click',
  'type',
  'read_page',
  'snapshot',
  'wait_for',
  'scroll',
  'select',
  'list_tabs',
  'capture',
  'press_key',
  /*
   * Find-or-open. "Open ibkr" should focus the tab that is already signed in,
   * not clobber whatever the active tab was showing — `navigate` without
   * newTab does the clobbering, which is why this is its own verb rather than
   * a navigate flag. Given urlContains it activates the freshest matching tab;
   * given url it opens one only when no match exists.
   */
  'activate_tab',
])

const READ_MODES = new Set([
  'text',
  'main_text',
  'html',
  'forms',
  'landmarks',
])

/*
 * The MAC agent's URL, and only ever the Mac agent's.
 *
 * This deliberately did NOT grow an https branch when the extension learned to
 * talk to the relay directly. The value returned here is the base URL that
 * background.js sends `Authorization: Bearer <agentToken>` to, and agentToken
 * is the Mac's credential — so a single field accepting both origins is a
 * single field that can aim either credential at either host, silently, since
 * both hosts answer a wrong token with the same 401. The relay peer has its
 * own field, its own allowlist and its own token in relay-peer.js
 * (normalizeRelayUrl); one credential is bound to each, and a misconfiguration
 * costs a failed request instead of a leaked token.
 *
 * The two endpoints are not interchangeable in any case: the Mac serves
 * /browser/poll and /plan, the relay serves /v1/node/*. Pointing this at the
 * relay would produce a poller 404ing forever against a host now holding the
 * Mac's token.
 */
export function normalizeAgentUrl(value) {
  const candidate = String(value ?? '').trim() || DEFAULT_AGENT_URL
  let url

  try {
    url = new URL(candidate)
  } catch {
    throw new Error('Agent URL must be a valid URL.')
  }

  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      'Agent URL must use http://127.0.0.1 or http://localhost. ' +
        'The relay is reached through the relay peer (relayUrl), not this field.',
    )
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Agent URL cannot contain credentials, a query, or a hash.')
  }

  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Agent URL must not contain a path.')
  }

  return url.origin
}

export function normalizeConfig(values = {}) {
  const targetMode = TARGET_MODES.has(values.targetMode)
    ? values.targetMode
    : DEFAULT_TARGET_MODE

  return {
    agentUrl: normalizeAgentUrl(values.agentUrl),
    agentToken: String(values.agentToken ?? '').trim(),
    deviceName: String(values.deviceName ?? '').trim().slice(0, 80),
    targetMode,
  }
}

export function validateNavigationUrl(value) {
  let url

  try {
    url = new URL(String(value ?? ''))
  } catch {
    throw new Error('The navigation command did not contain a valid URL.')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http:// and https:// navigation is allowed.')
  }

  return url.href
}

export function originPattern(value) {
  const url = new URL(value)
  return `${url.protocol}//${url.host}/*`
}

/*
 * How old a queued command may be before this extension refuses it.
 *
 * The agent has its own expiry, but the agent is a long-lived process the owner
 * does not restart, and a fix to it only takes effect when they do. Right now
 * there is a live agent, started before that fix, holding queued commands from
 * hours ago — they would run the moment this extension next connected, opening
 * tabs in the owner's Safari with no relation to anything they were doing.
 *
 * So the extension refuses on its own account rather than trusting the sender.
 * It is the side that can be fixed without the owner restarting anything: a
 * browser extension reloads with the browser.
 *
 * 90s matches the agent's own COMMAND_TTL_MS (local-agent/browserBridge.js),
 * which is twice the 45s a caller waits. Past that nobody is left to receive an
 * answer, so running the command can only surprise someone.
 */
export const MAX_COMMAND_AGE_MS = 90_000

export function validateCommand(command, now = Date.now()) {
  if (!command || typeof command !== 'object') {
    throw new Error('The local agent sent an invalid browser command.')
  }

  /* Checked before the action is inspected: a stale command should be refused
   * whatever it asks for, and a malformed stale one is not more welcome. */
  const queuedAt = Date.parse(command.createdAt ?? '')
  if (Number.isFinite(queuedAt) && now - queuedAt > MAX_COMMAND_AGE_MS) {
    throw new Error(
      `Refused a browser command queued ${Math.round((now - queuedAt) / 1000)}s ago. ` +
        'Nothing is still waiting for it, so running it now would act on the ' +
        "owner's browser unprompted.",
    )
  }

  const action = command.action
  const type = action?.type
  const params = action?.params ?? {}

  if (!COMMAND_TYPES.has(type)) {
    throw new Error(`Unsupported browser command: ${String(type ?? '')}`)
  }

  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Browser command parameters must be an object.')
  }

  if (type === 'navigate') {
    validateNavigationUrl(params.url)
  }

  if (type === 'activate_tab') {
    const hasNeedle = String(params.urlContains ?? '').trim()
    const hasUrl = String(params.url ?? '').trim()
    if (!hasNeedle && !hasUrl) {
      throw new Error('activate_tab requires urlContains or url.')
    }
    /* The fallback open goes through the same gate a navigate would. */
    if (hasUrl) validateNavigationUrl(params.url)
  }

  if (type === 'click' || type === 'type' || type === 'select' || type === 'scroll') {
    const hasSelector = String(params.selector ?? '').trim()
    const hasRef = String(params.ref ?? '').trim()
    if (!hasSelector && !hasRef) {
      throw new Error('A CSS selector or snapshot ref is required.')
    }
    if (hasSelector && hasSelector.length > MAX_SELECTOR_LENGTH) {
      throw new Error('A valid, reasonably sized CSS selector is required.')
    }
  }

  if (type === 'type' && String(params.text ?? '').length > MAX_TEXT_LENGTH) {
    throw new Error(`Typed text is limited to ${MAX_TEXT_LENGTH} characters.`)
  }

  if (type === 'select' && String(params.value ?? params.label ?? '').trim() === '') {
    throw new Error('select requires value or label.')
  }

  if (type === 'wait_for') {
    const hasSelector = String(params.selector ?? '').trim()
    const hasText = String(params.textContains ?? params.text ?? '').trim()
    if (!hasSelector && !hasText) {
      throw new Error('wait_for requires selector or textContains.')
    }
  }

  if (type === 'read_page' && params.mode != null) {
    const mode = String(params.mode).trim()
    if (mode && !READ_MODES.has(mode)) {
      throw new Error(
        `read_page mode must be one of: ${[...READ_MODES].join(', ')}.`,
      )
    }
  }

  if (type === 'press_key' && !String(params.key ?? '').trim()) {
    throw new Error('press_key requires key.')
  }

  if (
    params.tabId !== undefined &&
    (!Number.isInteger(params.tabId) || params.tabId < 0)
  ) {
    throw new Error('tabId must be a non-negative integer.')
  }

  if (
    params.windowId !== undefined &&
    (!Number.isInteger(params.windowId) || params.windowId < 0)
  ) {
    throw new Error('windowId must be a non-negative integer.')
  }

  return { type, params }
}

export function pickTargetTab(tabs, params = {}, targetMode = DEFAULT_TARGET_MODE) {
  const candidates = tabs.filter((tab) => Number.isInteger(tab?.id))

  if (Number.isInteger(params.tabId)) {
    return candidates.find((tab) => tab.id === params.tabId) ?? null
  }

  const urlNeedle = String(params.urlContains ?? '').trim().toLowerCase()
  if (urlNeedle) {
    return (
      candidates
        .filter((tab) => String(tab.url ?? '').toLowerCase().includes(urlNeedle))
        .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ??
      null
    )
  }

  const titleNeedle = String(params.titleContains ?? '').trim().toLowerCase()
  if (titleNeedle) {
    return (
      candidates
        .filter((tab) =>
          String(tab.title ?? '').toLowerCase().includes(titleNeedle),
        )
        .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ??
      null
    )
  }

  if (Number.isInteger(params.windowId)) {
    return (
      candidates.find(
        (tab) => tab.windowId === params.windowId && tab.active === true,
      ) ?? null
    )
  }

  if (targetMode === 'current-active') {
    return candidates.find((tab) => tab.active === true) ?? null
  }

  return (
    candidates
      .filter((tab) => tab.active === true)
      .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ??
    null
  )
}

export function isScriptableUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export function truncateTitle(title, max = 80) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

export function retryDelay(attempt, baseMs = 750, maximumMs = 15_000) {
  const boundedAttempt = Math.max(0, Math.min(Number(attempt) || 0, 8))
  return Math.min(maximumMs, baseMs * 2 ** boundedAttempt)
}

/* ===================================================================== *
 * Idempotency: a retried command must not act twice.
 * ===================================================================== */

/**
 * The identity a replay would arrive under.
 *
 * The agent's own lease expires at 45s and its caller gives up at 45s, so the
 * dangerous sequence is entirely invisible from the agent's side: the extension
 * runs `click`, the POST of the result fails (postResultWithRetry gives up after
 * three attempts), and the command is still sitting in the agent's map. Anything
 * that hands it out again — a re-poll, a redelivery, an agent that decided to
 * retry — makes the same click happen a second time. The agent cannot tell
 * whether the first one landed; only the side that ran it can.
 *
 * An explicit idempotencyKey lets a caller declare two enqueues to be the same
 * act. Without one the commandId is still a perfectly good identity for the
 * replay case, which is the case that actually bites.
 */
export function commandIdentity(command) {
  const declared = String(command?.idempotencyKey ?? '').trim()
  if (declared) return `idem:${declared.slice(0, 200)}`

  const commandId = String(command?.commandId ?? '').trim()
  return commandId ? `cmd:${commandId}` : ''
}

const TEXT_ENCODER = new TextEncoder()

export function byteLengthOf(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return TEXT_ENCODER.encode(text).length
}

/*
 * Bounded in BYTES, not in entries.
 *
 * A count cap is a budget written in the wrong unit: a hundred `read_page`
 * results at 50 KB each is five megabytes while the counter still reads
 * "100 of 500". This store lives in a service worker that Safari is free to
 * kill, so the cost of being wrong is the whole bridge going quiet.
 */
const LEDGER_MAX_BYTES = 128 * 1024

/*
 * Nothing older than this can be replayed: validateCommand above refuses any
 * command whose createdAt is more than MAX_COMMAND_AGE_MS in the past, so a
 * ledger entry older than a few multiples of that can never be consulted again.
 * Age eviction runs before byte eviction so the store sheds dead weight before
 * it sheds anything that could still stop a double action.
 */
const LEDGER_TTL_MS = 5 * MAX_COMMAND_AGE_MS

/**
 * Remember what this extension has already done, so a replay is answered rather
 * than re-executed.
 *
 * Under byte pressure a full entry is first downgraded to a stub — the fact of
 * execution, without the result — because forgetting the *result* costs the
 * caller one repeated read, while forgetting the *execution* costs the owner a
 * second click on a real page. Only when stubs alone still exceed the budget is
 * an entry dropped, oldest first.
 */
export function createCommandLedger({
  maxBytes = LEDGER_MAX_BYTES,
  ttlMs = LEDGER_TTL_MS,
} = {}) {
  /* Insertion-ordered, so "oldest" is just the first key. */
  const entries = new Map()
  let bytes = 0

  const sizeOf = (entry) => byteLengthOf(entry.result) + byteLengthOf(entry.key) + 64

  const drop = (key) => {
    const entry = entries.get(key)
    if (!entry) return
    bytes -= entry.bytes
    entries.delete(key)
  }

  const stub = (entry) => {
    if (entry.stubbed) return false
    bytes -= entry.bytes
    entry.result = {
      ok: false,
      error:
        'This command already ran in the browser. Its result was dropped to stay ' +
        'inside the extension result budget; re-running it was refused because ' +
        'the first run may have changed the page.',
    }
    entry.stubbed = true
    entry.bytes = sizeOf(entry)
    bytes += entry.bytes
    return true
  }

  const reclaim = (now) => {
    for (const [key, entry] of entries) {
      if (now - entry.storedAt > ttlMs) drop(key)
    }

    /* Each pass strictly shrinks the store, so both loops terminate. */
    for (const entry of entries.values()) {
      if (bytes <= maxBytes) break
      stub(entry)
    }

    for (const key of [...entries.keys()]) {
      if (bytes <= maxBytes) break
      drop(key)
    }
  }

  return {
    recall(key, now = Date.now()) {
      if (!key) return null
      const entry = entries.get(key)
      if (!entry) return null
      if (now - entry.storedAt > ttlMs) {
        drop(key)
        return null
      }
      return entry
    },

    remember(key, result, now = Date.now()) {
      if (!key) return null
      drop(key)
      const entry = { key, result, storedAt: now, stubbed: false, bytes: 0 }
      entry.bytes = sizeOf(entry)
      /* A single result larger than the whole budget is stubbed on arrival
       * rather than refused: the fact that it ran is the part worth keeping. */
      if (entry.bytes > maxBytes) {
        entries.set(key, entry)
        bytes += entry.bytes
        stub(entry)
      } else {
        entries.set(key, entry)
        bytes += entry.bytes
      }
      reclaim(now)
      return entries.get(key) ?? null
    },

    stats() {
      return { entries: entries.size, bytes, maxBytes, ttlMs }
    },

    clear() {
      entries.clear()
      bytes = 0
    },
  }
}

/* ===================================================================== *
 * Privacy boundary: what is not allowed to leave Safari at all.
 * ===================================================================== */

export const WITHHELD = '[withheld]'

/**
 * The rules, in one place, because there is no way to share code across the
 * extension boundary.
 *
 * local-agent/redaction.js owns the same job on the agent side and the two
 * lists will drift; that is a known cost, taken deliberately. The extension
 * cannot import a Node module, and the whole point of this boundary is that it
 * runs *before* anything crosses to the agent — a rule that only exists on the
 * far side has already lost. Kept structural (field types and autofill tokens)
 * rather than a prose copy of redaction.js, so the two lists overlap as little
 * as possible and neither pretends to be the other.
 */
export const PRIVACY_RULES = {
  /* An input of this type is a credential whatever it is called. */
  withheldInputTypes: ['password'],

  /* WHATWG autofill field names — the only machine-readable signal a site
   * gives, and the one password managers key off. */
  credentialAutocomplete: ['current-password', 'new-password', 'one-time-code'],
  paymentAutocomplete: [
    'cc-number',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year',
    'cc-csc',
    'cc-type',
    'cc-name',
    'cc-given-name',
    'cc-family-name',
    'cc-additional-name',
  ],

  /* Most sites set no autocomplete at all, so name/id/label carry the signal.
   * Matched against the attributes with non-alphanumerics stripped, which is
   * what makes "card-number", "cardNumber" and "card number" one token. */
  credentialTokens: [
    'password',
    'passwd',
    'pwd',
    'passphrase',
    'onetimecode',
    'otpcode',
    'totp',
    'mfacode',
    '2facode',
    'securityanswer',
    'apikey',
    'accesstoken',
    'sessiontoken',
    'privatekey',
    'clientsecret',
  ],
  paymentTokens: [
    'cardnumber',
    'creditcard',
    'cardnum',
    'ccnumber',
    'ccnum',
    'cvv',
    'cvc',
    'csc',
    'securitycode',
    'cardexp',
    'expmonth',
    'expyear',
    'iban',
    'routingnumber',
    'accountnumber',
    'sortcode',
  ],

  /*
   * Text that *announces* a secret. These match the label, not the value, so a
   * span replacement over them would strip the word "password" and leave the
   * password — the bug local-agent/redaction.js used to have, where
   * maskSecretValue turned "The wifi password is hunter2." into
   * "The wifi password is hunter2.: [withheld]". That module now splits its
   * patterns the same way this one does. A label match therefore withholds the
   * whole segment, and withholdSecrets verifies that it did.
   */
  secretLabelPatterns: [
    '\\b(pass(?:word|phrase|code)|secret|api[\\s_-]?key|auth\\s*token|access\\s*token|private\\s*key)\\b',
    '\\b(lock|door|gate|garage|safe|alarm|bike|locker|keypad|entry|wifi|router|sim)\\s*(code|combination|pin|password)\\b',
    '\\b(pin|passcode|combination|security\\s+code|access\\s+code|cvv|cvc)\\b\\s*(is|are|=|:)',
  ],

  /*
   * Text that *is* a secret. These match the value itself, so replacing the
   * match removes the secret and the surrounding sentence stays readable.
   */
  /*
   * The vocabulary a secret is *announced* in, as opposed to written in.
   *
   * Used to audit the value patterns rather than the text: if a value pattern's
   * match is nothing but these words, it matched the announcement and not the
   * secret, and replacing its span would strip the word "password" while
   * leaving the password — the shape of the bug local-agent/redaction.js used
   * to have. withholdSecrets refuses to trust such a match.
   */
  secretLabelWords: [
    'password',
    'passwd',
    'pwd',
    'passphrase',
    'passcode',
    'secret',
    'api',
    'apikey',
    'key',
    'token',
    'auth',
    'pin',
    'cvv',
    'cvc',
    'csc',
    'code',
    'combination',
    'credential',
    'credentials',
    'login',
    'wifi',
    'is',
    'the',
    'my',
  ],

  secretValuePatterns: [
    '\\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}',
    '\\bgh[pousr]_[A-Za-z0-9]{20,}',
    '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
    '\\bAKIA[0-9A-Z]{16}\\b',
    '\\bey[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]*',
    '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
    /* Bootstrap JSON in an inline <script> is how a page hands its own
     * front-end an API key, and read_page mode:"html" ships it verbatim. */
    '"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)"\\s*:\\s*"[^"]*"',
    /* A card number, grouped or not. 13 digits is longer than any phone
     * number, so ordinary page text is not swept up by this. */
    '\\b(?:\\d[ -]?){13,19}\\b',
  ],
}

const compile = (sources, flags = 'gi') =>
  sources.map((source) => new RegExp(source, flags))

const squash = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')

/**
 * What kind of field this is, from its own description of itself.
 *
 * Errs towards credential/payment: over-classifying costs one withheld value
 * the agent could have read, under-classifying puts a card number in a prompt.
 */
export function classifyFieldSensitivity(field = {}, rules = PRIVACY_RULES) {
  const type = String(field.type ?? field.inputType ?? '').toLowerCase()
  if (rules.withheldInputTypes.includes(type)) return 'credential'

  const tokens = String(field.autocomplete ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.some((token) => rules.credentialAutocomplete.includes(token))) {
    return 'credential'
  }
  if (tokens.some((token) => rules.paymentAutocomplete.includes(token))) {
    return 'payment'
  }

  const haystack = squash(
    [
      field.name,
      field.fieldName,
      field.id,
      field.ariaLabel,
      field.placeholder,
      field.label,
      field.autocomplete,
    ]
      .filter(Boolean)
      .join(' '),
  )
  if (!haystack) return 'normal'

  if (rules.credentialTokens.some((token) => haystack.includes(token))) {
    return 'credential'
  }
  if (rules.paymentTokens.some((token) => haystack.includes(token))) {
    return 'payment'
  }
  return 'normal'
}

/**
 * Did the withholding actually withhold anything?
 *
 * This is the check evidenceCapsules.js had to bolt on after the fact, kept
 * here as a first-class function so it can be tested directly rather than
 * inferred from a passing pipeline. A mask that appends its marker to the
 * original — "The wifi password is hunter2.: [withheld]" — leaves every word of
 * the secret in place while the caller records action:"withheld". A store that
 * lies about what it withheld is worse than one that never tried.
 */
export function verifyWithheld(original, emitted) {
  const survivors = String(original ?? '')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length >= 4)
  const text = String(emitted ?? '')
  return !survivors.some((word) => text.includes(word))
}

/**
 * Cut the text into the smallest pieces that can be withheld independently.
 *
 * The size of a segment is the blast radius of a label match, and the first
 * version of this got that badly wrong on markup: read_page mode:"html" returns
 * the whole document as a single line with no sentence breaks, so one `<p>`
 * mentioning a password withheld the entire page. Splitting at tag boundaries
 * costs nothing on plain text — `><` does not occur in prose — and turns
 * "the page is unreadable" back into "that paragraph is withheld".
 *
 * Every split either keeps its separator or is zero-width, so joining the
 * segments back together reproduces the input exactly.
 */
function segmentsOf(text) {
  const segments = []

  for (const [index, line] of String(text).split('\n').entries()) {
    if (index) segments.push({ text: '\n', literal: true })

    for (const chunk of line.split(/(?<=>)(?=<)/)) {
      for (const piece of chunk.split(/((?<=[.!?])\s+)/)) {
        if (!piece) continue
        segments.push({ text: piece, literal: /^\s+$/.test(piece) })
      }
    }
  }

  return segments
}

/**
 * Did this pattern match a secret, or only the word announcing one?
 *
 * A pattern in the value list is trusted to have consumed the secret, so its
 * span is replaced and the rest of the sentence is kept. A pattern that matches
 * only label words has not consumed anything — replacing its span produces
 * "The wifi [withheld] is hunter2.", which is the redaction.js failure wearing
 * a different hat. A match with no letters at all (a bare card number) is a
 * value by construction.
 */
function matchedOnlyTheLabel(match, rules) {
  const words = String(match)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
  if (!words.length) return false
  return words.every((word) => rules.secretLabelWords?.includes(word))
}

/**
 * Strip secrets from extracted text, then prove they are gone.
 *
 * Two mechanisms, because secrets come in two shapes:
 *   - a label pattern says "a secret is nearby" but not where it ends, so the
 *     whole segment is withheld;
 *   - a value pattern *is* the secret, so only its span goes and the sentence
 *     around it stays readable.
 *
 * Whichever fired, the result is verified against the original: if any
 * non-trivial word of a segment that was supposed to be withheld survives, the
 * segment is replaced outright and `verified` is false so the caller knows the
 * rules, not the text, are what needs fixing.
 */
export function withholdSecrets(value, rules = PRIVACY_RULES) {
  const labels = compile(rules.secretLabelPatterns)
  const values = compile(rules.secretValuePatterns)
  const out = []
  let withheld = 0
  let verified = true

  for (const segment of segmentsOf(String(value ?? ''))) {
    if (segment.literal || !segment.text) {
      out.push(segment.text)
      continue
    }

    const announced = labels.some((pattern) => {
      pattern.lastIndex = 0
      return pattern.test(segment.text)
    })

    if (announced) {
      withheld += 1
      /* Whole segment: a label says a secret is here, not where it stops. */
      out.push(WITHHELD)
      if (!verifyWithheld(segment.text, WITHHELD)) verified = false
      continue
    }

    let emitted = segment.text
    const removed = []
    for (const pattern of values) {
      pattern.lastIndex = 0
      emitted = emitted.replace(pattern, (match) => {
        removed.push(match)
        return WITHHELD
      })
    }

    if (removed.length) {
      withheld += removed.length

      /* Two ways a span replacement can be a lie, and both end the same way:
       * the whole segment goes, and `verified` says the rules — not the text —
       * are what needs fixing.
       *
       * 1. The pattern matched only the label, so the value it announced is
       *    still sitting in the segment.
       * 2. Words of the removed span survived the replacement, which means the
       *    replacement appended rather than replaced. */
      const label = removed.some((match) => matchedOnlyTheLabel(match, rules))
      const survived = !removed.every((match) => verifyWithheld(match, emitted))

      if (label || survived) {
        verified = false
        emitted = WITHHELD
      }
    }

    out.push(emitted)
  }

  return { text: out.join(''), withheld, verified }
}

const INPUT_TAG = /<input\b[^>]*>/gi
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g

/**
 * Scrub values out of the markup before it is serialized to the agent.
 *
 * read_page mode:"html" returns document.documentElement.outerHTML, which is
 * every hidden input on the page — session ids, CSRF and bearer tokens — plus
 * any server-rendered value= on a card or password field. That markup then
 * crosses to the agent, is stored with the result, and is exactly the kind of
 * text that ends up pasted into a third-party prompt.
 *
 * This is attribute surgery, not parsing: it is a second layer under the
 * text pass, and both run before anything leaves the browser.
 */
export function withholdMarkupValues(html, rules = PRIVACY_RULES) {
  let withheld = 0

  const scrubbed = String(html ?? '').replace(INPUT_TAG, (tag) => {
    const field = {}
    ATTRIBUTE.lastIndex = 0
    let match
    while ((match = ATTRIBUTE.exec(tag)) !== null) {
      const raw = match[2]
      field[match[1].toLowerCase()] =
        raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw
    }

    const type = String(field.type ?? '').toLowerCase()
    const sensitivity = classifyFieldSensitivity(
      {
        type,
        name: field.name,
        id: field.id,
        autocomplete: field.autocomplete,
        placeholder: field.placeholder,
        ariaLabel: field['aria-label'],
      },
      rules,
    )

    /* Hidden inputs are the ones nobody thinks about: they are invisible on
     * the page, absent from a snapshot, and carry the site's auth tokens. */
    if (sensitivity === 'normal' && type !== 'hidden') return tag
    if (!('value' in field)) return tag

    withheld += 1
    return tag.replace(
      /(\bvalue\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/i,
      `$1"${WITHHELD}"`,
    )
  })

  return { html: scrubbed, withheld }
}

/* ===================================================================== *
 * Provenance: where a reading came from, asserted by the side that took it.
 * ===================================================================== */

/**
 * Every extraction says which tab it came from, what it was pointed at, and
 * when — stamped in the browser rather than reconstructed by the agent, which
 * only knows what it asked for and not where the tab actually ended up.
 */
export function provenanceFor({ command, tab, result, locator, now = Date.now() }) {
  const params = command?.action?.params ?? {}
  return {
    commandId: command?.commandId ?? null,
    action: command?.action?.type ?? null,
    tabId: Number.isInteger(tab?.id) ? tab.id : (result?.tabId ?? null),
    windowId: Number.isInteger(tab?.windowId) ? tab.windowId : (result?.windowId ?? null),
    /* The URL the tab is actually on. A navigate can be redirected, and the
     * requested URL is kept separately so a mismatch stays visible. */
    url: String(result?.url ?? tab?.url ?? ''),
    requestedUrl: String(params.url ?? ''),
    title: truncateTitle(result?.title ?? tab?.title ?? '', 200),
    /* What the command was pointed at, so a stored reading can be re-taken.
     * "document" rather than "" when a whole page was read: an empty locator
     * reads as missing provenance, and this one is not missing. */
    locator:
      String(locator ?? '').trim() ||
      String(params.ref ?? '').trim() ||
      String(params.selector ?? '').trim() ||
      'document',
    observedAt: new Date(now).toISOString(),
  }
}

/**
 * The last thing that runs before a result crosses out of the browser.
 *
 * Everything here is deliberately after execution and before the POST: the
 * agent is a different process with its own log, its own store and a cloud
 * relay attached, so a value that reaches it has effectively left the machine.
 */
export function sanitizeExtraction(result, { rules = PRIVACY_RULES } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { result, privacy: { withheld: 0, verified: true, fields: [] } }
  }

  const clean = { ...result }
  let withheld = 0
  let verified = true

  if (typeof clean.content === 'string' && clean.content) {
    if (String(clean.mode ?? '') === 'html') {
      const markup = withholdMarkupValues(clean.content, rules)
      clean.content = markup.html
      withheld += markup.withheld
    }
    const text = withholdSecrets(clean.content, rules)
    clean.content = text.text
    withheld += text.withheld
    verified = verified && text.verified
  }

  /*
   * A tab's own URL is a result too. list_tabs returns full URLs on purpose —
   * the agent targets tabs with urlContains — but a magic-link or password-reset
   * tab carries its token in the query string, and that token crosses to the
   * agent with everything else. Only the value patterns run here: a label pass
   * would withhold the whole of https://example.com/account/password and break
   * the targeting this field exists for.
   */
  if (Array.isArray(clean.tabs)) {
    const valuesOnly = { ...rules, secretLabelPatterns: [] }
    clean.tabs = clean.tabs.map((tab) => {
      const scrubbed = withholdSecrets(String(tab?.url ?? ''), valuesOnly)
      if (!scrubbed.withheld) return tab
      withheld += scrubbed.withheld
      return { ...tab, url: scrubbed.text, urlWithheld: true }
    })
  }

  const fields = []
  if (Array.isArray(clean.elements)) {
    clean.elements = clean.elements.map((element) => {
      const sensitivity = classifyFieldSensitivity(
        {
          type: element?.inputType,
          name: element?.fieldName,
          id: element?.id,
          autocomplete: element?.autocomplete,
          label: element?.name,
        },
        rules,
      )
      if (sensitivity === 'normal') return element

      fields.push({ ref: element?.ref ?? null, sensitivity })
      /* The ref and role stay: an agent still needs to know a password field
       * is there to tell the owner to fill it in. What it never gets is any
       * text the field is carrying. */
      return {
        ...element,
        sensitivity,
        fieldName: undefined,
        value: undefined,
        name: sensitivity === 'credential' ? WITHHELD : element?.name,
      }
    })
    withheld += fields.length
  }

  const privacy = {
    withheld,
    verified,
    fields,
    /* Named in the result so a reader of the agent's stored copy can tell
     * whether it passed the boundary at all, without having to find out by
     * experiment which side did the withholding. */
    boundary: 'browser-extension/src/bridge-core.js sanitizeExtraction',
  }

  return { result: { ...clean, privacy }, privacy }
}
