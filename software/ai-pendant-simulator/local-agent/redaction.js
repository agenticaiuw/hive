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
