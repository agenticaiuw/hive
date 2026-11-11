// Screenshot redaction, kept in a leaf module with no dependencies.
//
// It lives here rather than in screenCapture.js because the processes that most
// need it — the cloud bridge above all — must be able to strip image bytes
// without importing the capture stack (child_process, the Swift UI helper, the
// on-disk capture directory). screenCapture.js re-exports it for the callers
// that already had it.

// Everything that persists or forwards an execution result — the activity log,
// the session store, the context graph, the job tracker, the cloud relay upload
// — flows from the same result objects. Strip the bytes once, here, rather than
// remembering to do it at each sink.
export function stripImageBytes(value) {
  if (Array.isArray(value)) {
    return value.map(stripImageBytes)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const clean = {}

  for (const [key, entry] of Object.entries(value)) {
    if (key === 'imageBase64' || key === 'dataUrl' || key === 'imageDataUrl') {
      continue
    }

    clean[key] = stripImageBytes(entry)
  }

  return clean
}

// Credential shapes that must never be pasted into a prompt bound for a
// third-party model, even though the owner can read them back through the API.
//
// The list is split in two because masking and classifying need different
// things from it. classifySensitivity only asks "is a secret in here", and the
// union answers that. maskSecretValue has to remove the secret, which means it
// has to know *where* it is — and a pattern that matches the announcement
// ("password:") locates the label, not the value. Replacing that span strips
// the word "password" and leaves the password. So the two kinds are kept apart
// here, in one file, deriving from one source: two independent credential lists
// drift, and the copy that drifts is always the one nobody remembers exists.

/* Patterns whose match IS the secret. Replacing the span removes the value and
 * leaves the surrounding sentence readable. */
const SECRET_VALUE_PATTERNS = [
  /\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/,
  /* Anchored to the END line so the span covers the key body. A header with no
   * matching footer does not match here at all — it is still caught for
   * classification below, and an unlocatable secret is withheld whole. */
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
]

/* Patterns that ANNOUNCE a secret. The match is the label; the value beside it
 * has no machine-readable shape, so it cannot be cut out precisely. */
const SECRET_LABEL_PATTERNS = [
  /\b(password|passcode|secret|api[\s_-]?key|token|private[\s_-]?key)\b\s*[:=]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Secrets the owner says out loud to a worn pendant. "Remember this: my bike
  // lock code is 4829" carries none of the machine-generated shapes above — it
  // is four digits and a noun — so without this the value reached a
  // third-party prompt in the clear. The noun is what makes it a secret.
  /\b(lock|door|gate|garage|safe|alarm|bike|locker|keypad|entry|wifi|router)\s*(code|combination|pin|password)\b/i,
  /\b(pin|passcode|combination|security\s+code|access\s+code)\b\s*(is|are|=|:)/i,
]

const SECRET_PATTERNS = [...SECRET_VALUE_PATTERNS, ...SECRET_LABEL_PATTERNS]

const PERSONAL_PATTERNS = [
  /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/,
  /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{13,19}\b/,
]

/**
 * Label a value so the prompt builder can decide whether to send it.
 *
 * This is metadata for redaction and prompt selection, not an access gate —
 * the owner reads every fact at full fidelity through the memory API. It exists
 * because most writers are automated and would otherwise ship a pasted API key
 * to a model provider without anyone deciding to.
 */
export function classifySensitivity(value) {
  const text = String(value ?? '')
  if (!text) return 'normal'
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return 'secret'
  if (PERSONAL_PATTERNS.some((pattern) => pattern.test(text))) return 'sensitive'
  return 'normal'
}

/** The one marker every sink in this project uses for a value it would not emit. */
export const SECRET_PLACEHOLDER = '[withheld]'

/* A label is a name for the value, not the value. Past this length it is prose
 * that happened to contain a colon. */
const MAX_LABEL_CHARS = 60

const globalCopy = (pattern) =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)

/** Escape a literal so it can be matched as itself rather than as a pattern. */
const escapeRegExp = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/*
 * Match a known secret where it stands on its own, not everywhere its bytes
 * appear. Without the guards, masking the secret "cat" turns "concatenate" into
 * "con[withheld]enate" — unrelated text destroyed, and a reader told a secret
 * was in a word that never held one. The guards are conditional on the secret's
 * own edges so a token like "sk-live-..." is still found inside "key=sk-live-...".
 */
function occurrencesOf(secret) {
  const leading = /^[A-Za-z0-9]/.test(secret) ? '(?<![A-Za-z0-9])' : ''
  const trailing = /[A-Za-z0-9]$/.test(secret) ? '(?![A-Za-z0-9])' : ''
  return new RegExp(`${leading}${escapeRegExp(secret)}${trailing}`, 'g')
}

/**
 * Remove a secret from a value, keeping whatever is safe to keep.
 *
 * Two forms, because callers know two different amounts:
 *
 *   maskSecretValue(text)         — "this value is secret", location unknown
 *   maskSecretValue(text, secret) — "this exact string is the secret"
 *
 * Both guarantee the same thing: the secret is not in what comes back. What is
 * kept beyond that is best-effort — the fact's name, the sentence around a
 * located credential — and is dropped whenever keeping it cannot be shown safe.
 * Withholding a value entirely is a correct outcome here. Emitting it with a
 * marker beside it is not, which is exactly what this function used to do: it
 * split on the first `:` or `=`, and a value with neither became its own
 * "label", so "the wifi password is hunter2" came back as
 * "the wifi password is hunter2: [withheld]" — the secret intact, and every
 * downstream reader believing it had been removed.
 */
export function maskSecretValue(value, secret) {
  const text = String(value ?? '')

  // `undefined` means "no needle was passed"; an explicitly empty or null one
  // means "there is no secret to remove", which is a different claim.
  if (secret !== undefined) return maskKnownSecret(text, String(secret ?? ''))

  if (!text) return SECRET_PLACEHOLDER

  // Cut out every credential whose shape says where it is. This is what keeps
  // "Deploy failed, the CI token xoxb-... expired" a useful sentence.
  let masked = text
  for (const pattern of SECRET_VALUE_PATTERNS) {
    masked = masked.replace(globalCopy(pattern), () => SECRET_PLACEHOLDER)
  }

  // Verified, not assumed: the spans were the whole story only if nothing in
  // what is left still reads as a secret.
  if (masked !== text && classifySensitivity(masked) !== 'secret') return masked

  return labelOnly(text)
}

/*
 * A secret is announced but not locatable — "the gate code is 4829", where the
 * value is four digits and nothing distinguishes it from a year. Keep the name
 * of the fact if there is a trustworthy one, and nothing else.
 */
function labelOnly(text) {
  const separator = text.search(/[:=]/)
  if (separator <= 0) return SECRET_PLACEHOLDER

  const label = text.slice(0, separator).trim()
  if (!label || label.length >= MAX_LABEL_CHARS) return SECRET_PLACEHOLDER

  // Splitting on the first separator does not know which side the value is on.
  // A name has letters in it, and a name is not itself a credential; a run of
  // digits before the colon is a code that was written down back-to-front
  // ("4829: my gate code"), not a label.
  if (!/[A-Za-z]/.test(label)) return SECRET_PLACEHOLDER
  if (/\d{4,}/.test(label)) return SECRET_PLACEHOLDER
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(label))) return SECRET_PLACEHOLDER

  return `${label}: ${SECRET_PLACEHOLDER}`
}

function maskKnownSecret(text, needle) {
  const masked = needle ? text.replace(occurrencesOf(needle), () => SECRET_PLACEHOLDER) : text

  // Checked rather than trusted, in both directions: the needle must be gone,
  // and the caller's needle is not evidence that it was the only secret here.
  if (needle && occurrencesOf(needle).test(masked)) return SECRET_PLACEHOLDER
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(masked))) return SECRET_PLACEHOLDER

  return masked
}
