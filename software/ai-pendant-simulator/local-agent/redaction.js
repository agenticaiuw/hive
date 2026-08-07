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
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(password|passcode|secret|api[\s_-]?key|token|private[\s_-]?key)\b\s*[:=]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Secrets the owner says out loud to a worn pendant. "Remember this: my bike
  // lock code is 4829" carries none of the machine-generated shapes above — it
  // is four digits and a noun — so without this the value reached a
  // third-party prompt in the clear. The noun is what makes it a secret.
  /\b(lock|door|gate|garage|safe|alarm|bike|locker|keypad|entry|wifi|router)\s*(code|combination|pin|password)\b/i,
  /\b(pin|passcode|combination|security\s+code|access\s+code)\b\s*(is|are|=|:)/i,
]

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

/** Keep the fact's existence (and its name) while withholding the value. */
export function maskSecretValue(value) {
  const text = String(value ?? '')
  const label = text.split(/[:=]/)[0].trim()
  return label && label.length < 60 ? `${label}: [withheld]` : '[withheld]'
}
