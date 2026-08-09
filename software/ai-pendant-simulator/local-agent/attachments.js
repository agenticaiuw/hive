/*
 * Attachments, as first-class planner input.
 *
 * THE CONTRACT (mac-menubar, commit 06171f1). The floating HUD posts /plan
 * with the same files said two ways:
 *
 *   "attachments": ["/abs/path/a.png", ...]        — the array, for this module
 *   "command": "summarize this [attached: /abs/path/a.png, ...]"
 *                                                  — a plain-text suffix that
 *                                                    worked while the server
 *                                                    ignored the array
 *
 * When the array is present it is the truth and the suffix is redundancy:
 * stripAttachedSuffix() removes it so the model never sees the same paths
 * twice. When the array is absent the command is left byte-for-byte alone —
 * a bare "[attached: …]" typed by hand is just text.
 *
 * VALIDATION IS FAIL-CLOSED AND NAMES NAMES. Every path must exist and be a
 * regular file. A path that fails is never silently dropped: planning around
 * a missing file produces a plan that reads a file that is not there, and a
 * plan built from "the attachments that survived" is a plan the owner did not
 * ask for. One bad path fails the whole request, and the error names each bad
 * path and why.
 *
 * REFUSED EVEN FROM THE OWNER. Attachment paths are owner input from the HUD,
 * but ~/.ssh and ~/.aws are credential stores, and .env / .env.* /
 * secrets.conf are the repo's own secret-file patterns (the root .gitignore's
 * list, .env.example carved out there and here). Attaching one would put its
 * path — and, one read_file step later, its contents — into a model prompt.
 * The refusal is checked BEFORE stat so a refused path is never probed, and
 * again on the resolved real path so a symlink cannot launder one.
 *
 * NO UPLOADS. The agent is local; a path IS the file. Nothing here copies,
 * moves or serves bytes — the planner gets paths, and the executor's ordinary
 * read_file / open_path actions do the reading under their own rules.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* The HUD appends exactly one trailing "[attached: …]" block. Anchored to the
 * end so a command that quotes the phrase mid-sentence keeps it. */
const ATTACHED_SUFFIX = /\s*\[attached:[^\]]*\]\s*$/i

/* Directories under $HOME whose contents are credentials by construction. */
const FORBIDDEN_HOME_DIRS = ['.ssh', '.aws']

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.tiff', '.bmp',
])

export function stripAttachedSuffix(command) {
  return String(command ?? '').replace(ATTACHED_SUFFIX, '').trim()
}

/* The repo's secret-file patterns, mirrored from the root .gitignore:
 * `.env`, `.env.*` (with `.env.example` exempted there and here), and
 * `secrets.conf`. */
export function isSecretFileName(name) {
  const lower = String(name ?? '').toLowerCase()
  if (lower === 'secrets.conf') return true
  if (lower === '.env') return true
  return lower.startsWith('.env.') && lower !== '.env.example'
}

/*
 * ~/.ssh and ~/.aws in every spelling that reaches this machine's disk: the
 * home path as configured AND its realpath, because a home reached through a
 * symlinked prefix (macOS's /var → /private/var, a moved home) must not make
 * `startsWith` blind to the same directory.
 */
function forbiddenRootsFor(home, fsImpl) {
  const spellings = new Set([path.resolve(String(home))])
  try {
    spellings.add(fsImpl.realpathSync(String(home)))
  } catch {
    /* A home that cannot be resolved still guards its literal spelling. */
  }
  const roots = []
  for (const spelling of spellings) {
    for (const dir of FORBIDDEN_HOME_DIRS) {
      roots.push({ root: path.join(spelling, dir), dir })
    }
  }
  return roots
}

function refusalReason(resolved, roots) {
  for (const { root, dir } of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return `inside ~/${dir} — credential stores are never read or attached`
    }
  }
  if (isSecretFileName(path.basename(resolved))) {
    return 'matches the secret-file patterns (.env, secrets.conf) — never read or attached'
  }
  return null
}

function vetOne(rawPath, { home, roots, fsImpl }) {
  const given = String(rawPath ?? '').trim()
  if (!given) {
    return { problem: { path: String(rawPath ?? ''), reason: 'not a usable path', refused: false } }
  }

  const expanded =
    given === '~' || given.startsWith('~/')
      ? path.join(home, given.slice(1))
      : given
  if (!path.isAbsolute(expanded)) {
    return {
      problem: {
        path: given,
        reason: 'not an absolute path — the HUD sends full paths, and a relative one is ambiguous here',
        refused: false,
      },
    }
  }
  const resolved = path.resolve(expanded)

  /* Refusal precedes stat on purpose: a refused path is never probed, so this
   * cannot even confirm whether something exists under ~/.ssh. */
  const refusedAsGiven = refusalReason(resolved, roots)
  if (refusedAsGiven) {
    return { problem: { path: resolved, reason: refusedAsGiven, refused: true } }
  }

  let stat
  try {
    stat = fsImpl.statSync(resolved)
  } catch {
    return { problem: { path: resolved, reason: 'no such file on this Mac', refused: false } }
  }
  if (!stat.isFile()) {
    return {
      problem: {
        path: resolved,
        reason: 'not a regular file (folders and devices cannot be attached)',
        refused: false,
      },
    }
  }

  /* The same refusal, on where the path REALLY leads — a symlink into ~/.ssh
   * must not launder the location it points at. */
  let real = resolved
  try {
    real = fsImpl.realpathSync(resolved)
  } catch {
    /* statSync just succeeded; a realpath miss here is a race. The stat'd
     * path already passed the refusal, so keep it. */
  }
  const refusedAsReal = refusalReason(real, roots)
  if (refusedAsReal) {
    return { problem: { path: resolved, reason: refusedAsReal, refused: true } }
  }

  return {
    file: {
      path: resolved,
      bytes: stat.size,
      kind: IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase()) ? 'image' : 'file',
    },
  }
}

/**
 * Validate the HUD's attachments array and normalise the command around it.
 *
 * No array (or an empty one) means "this request has no attachments": the
 * command is returned untouched — including any literal "[attached: …]" text,
 * which is then just words the owner typed.
 *
 * With an array: every path is vetted, the redundant suffix is stripped, and
 * the caller gets both halves explicitly — `attachments` (usable files, with
 * size and kind) and `problems` (each bad path with its reason and whether it
 * was a security refusal rather than a miss). Callers must treat a non-empty
 * `problems` as fatal to the request; this module only reports.
 */
export function prepareAttachments({
  command,
  attachments = null,
  home = os.homedir(),
  fsImpl = fs,
} = {}) {
  const text = String(command ?? '')
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { command: text, attachments: [], problems: [] }
  }

  const files = []
  const problems = []
  const seen = new Set()
  const roots = forbiddenRootsFor(home, fsImpl)

  for (const entry of attachments) {
    const vetted = vetOne(entry, { home, roots, fsImpl })
    const key = vetted.file?.path ?? vetted.problem.path
    if (seen.has(key)) continue
    seen.add(key)
    if (vetted.file) files.push(vetted.file)
    else problems.push(vetted.problem)
  }

  /* A send with nothing typed arrives as the bare suffix; stripping it would
   * hand the planner an empty request. The fallback names the owner's actual
   * intent — "here are files, act on them" — without re-listing the paths the
   * attachments block already carries. */
  const stripped = stripAttachedSuffix(text)
  return {
    command:
      stripped ||
      `Use the attached file${attachments.length === 1 ? '' : 's'}.`,
    attachments: files,
    problems,
  }
}

/**
 * The prompt block the planner reads — mirrors how conversation context
 * travels (orchestrator appends it to context.promptBlock, llmPlanner sends
 * that block ahead of "Current request:"). Paths appear here and only here.
 */
export function attachmentsPromptBlock(files = []) {
  if (!files.length) return ''
  const lines = files.map(
    (file) =>
      `- ${file.path} (${file.kind === 'image' ? 'image, ' : ''}${describeBytes(file.bytes)})`,
  )
  return [
    'Attached files (absolute paths on this Mac; each verified to exist):',
    ...lines,
    'Plan steps may use these paths directly: read_file for text, open_path to open one in its app. Refer to them by these exact paths and never ask the owner to re-send them.',
  ].join('\n')
}

/** One sentence naming every bad path — the response the owner reads. */
export function describeAttachmentProblems(problems = []) {
  if (!problems.length) return ''
  const parts = problems.map((problem) => `${problem.path} (${problem.reason})`)
  const refusals = problems.filter((problem) => problem.refused).length
  const lead =
    refusals === problems.length
      ? `Refused ${problems.length === 1 ? 'an attachment' : `${problems.length} attachments`}`
      : `${problems.length === 1 ? 'An attachment' : `${problems.length} attachments`} cannot be used`
  return `${lead}: ${parts.join('; ')}. Nothing was planned.`
}

function describeBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return 'size unknown'
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let amount = value
  let unit = 0
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000
    unit += 1
  }
  const rounded = amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)
  return `${rounded} ${units[unit]}`
}
