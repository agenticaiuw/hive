/*
 * A shell command's stdout, said as a sentence.
 *
 * THE BUG THIS EXISTS TO FIX. "Tell me how much free disk space the Mac
 * currently has" ran `df -h` — correctly — and then the raw table walked all
 * the way to the owner: "Filesystem Size Used Avail Capacity iused ifree
 * %iused Mounted on /dev/disk3s1s1 460Gi 12Gi 125Gi 9% …" was the dashboard's
 * hero headline AND the pendant's queued spoken reply. runShell's result
 * `message` was truncateMessage(stdout, 280), and every answer surface —
 * orchestrator responseText, spokenConfirmation, spokenTextForResult — builds
 * the answer by joining result messages. Nothing between `df` and the owner's
 * ears ever turned columns into prose, so a wearable read a filesystem table
 * out loud.
 *
 * WHERE THIS SITS. At the writer, per spokenBudget.js's rule: the constraint
 * arrives at the thing that WRITES the text, not as a truncation downstream
 * (pendantSpeech's 180-character slice is a backstop that cuts mid-word; a
 * message that needs it has already failed). So runShell asks this module for
 * its success message, and everything that joins messages inherits a sentence.
 *
 * WHAT CHANGES AND WHAT DOES NOT. Only the answer text. The result object
 * keeps full `stdout` and `stderr` exactly as before — the job store, the
 * activity log, sideResults and the dashboard detail views all read those, so
 * the evidence is intact; this module only decides what gets SAID. Failure
 * messages are untouched too: shellFailureMessage's diagnostics ("exited 42",
 * "timed out after 250ms") are already prose and tests pin them.
 *
 * TWO LAYERS, LIKE THE ROUTER'S TIERS:
 *
 *   purpose-built — the handful of commands the no-model tiers actually emit
 *                   (get_battery/get_mac_status templates in computerControl,
 *                   the hands-free STATUS_SHELL_PATTERNS in actionRisk: df,
 *                   pmset, uptime, ls, du, sw_vers, scutil --nwi, the volume
 *                   readback). Each parses the real output and answers with
 *                   the numbers, never with hardcoded values.
 *   generic       — everything else. A short single line passes through
 *                   byte-for-byte (it was already an answer). Anything
 *                   multi-line, tab-tabular or over ~200 characters becomes
 *                   the first meaningful line plus "… and N more lines."
 *
 * A formatter that cannot parse what it sees returns null and the generic
 * layer answers instead — same shape as the deterministic matchers declining
 * to the planner. Formatters never throw an answer away.
 */

/*
 * Above this, even a single line is not a sentence anyone should hear. The
 * trigger is deliberately looser than the budget below: a 190-character line
 * passes through untouched (it fits under the speech cap), while condensed
 * output aims well under it.
 */
const GENERIC_TRIGGER_CHARS = 200

/*
 * What a condensed answer may spend. Sits under pendantSpeech.js's
 * MAX_SPOKEN_CHARACTERS (180) on purpose: if this module keeps its budget,
 * the downstream slice never engages and never gets the chance to cut a
 * word in half.
 */
const ANSWER_BUDGET_CHARS = 170

/* A line carrying this many tab-separated fields is a table row, not prose,
 * even when it is the only line. */
const TABULAR_TAB_FIELDS = 4

/**
 * The success message for a completed shell command. Never a table, never
 * multi-line, never empty.
 */
export function answerForShellOutput({ command, stdout, stderr } = {}) {
  const out = String(stdout ?? '').trim()
  const err = String(stderr ?? '').trim()
  const body = out || err

  /* Mirrors the previous `stdout || stderr || 'Command completed.'` exactly —
   * a silent success still says something. */
  if (!body) return 'Command completed.'

  if (out) {
    const formatted = formatShellAnswer(command, out)
    if (formatted) return formatted
  }

  return condenseToAnswer(body)
}

/**
 * Purpose-built answers for the commands the cheap paths emit. Null means
 * "not mine" — the caller falls back to condenseToAnswer, never to raw.
 */
export function formatShellAnswer(command, stdout) {
  const cmd = String(command ?? '').trim()
  const text = String(stdout ?? '').trim()
  if (!cmd || !text) return null

  for (const { claims, format } of FORMATTERS) {
    if (!claims(cmd)) continue
    try {
      const answer = format(text, cmd)
      if (answer) return answer
    } catch {
      /* A parse surprise must cost the purpose-built phrasing, not the
       * answer: fall through to the generic layer. */
    }
    return null
  }

  return null
}

/**
 * The generic layer: one informative sentence out of arbitrary output.
 *
 * A short single non-tabular line is returned byte-for-byte — it was already
 * the answer, and rewriting it would break the commands whose output is prose
 * (date, whoami, hostname). Everything else keeps its first meaningful line,
 * clipped at a word boundary, and says how much it is not saying.
 */
export function condenseToAnswer(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return ''

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (
    lines.length <= 1 &&
    trimmed.length <= GENERIC_TRIGGER_CHARS &&
    !isTabularLine(trimmed)
  ) {
    return trimmed
  }

  const first = collapse(lines[0] ?? '')
  const rest = lines.length - 1
  const suffix =
    rest > 0 ? ` … and ${rest} more line${rest === 1 ? '' : 's'}.` : ''

  return `${clipAtWordBoundary(first, ANSWER_BUDGET_CHARS - suffix.length)}${suffix}`
}

/* ========================================================================
 * The formatter table. `claims` decides on the COMMAND (cheap, anchored),
 * `format` answers from the OUTPUT or returns null to decline.
 * ======================================================================== */

const FORMATTERS = [
  {
    /* df / df -h / df -H / df -h /some/path */
    claims: (cmd) => /^df(\s|$)/i.test(cmd),
    format: formatDiskFree,
  },
  {
    /* pmset -g batt — the get_battery / get_mac_status battery template. */
    claims: (cmd) => /^pmset\s+-g\s+batt/i.test(cmd),
    format: formatBattery,
  },
  {
    claims: (cmd) => /^uptime(\s|$)/i.test(cmd),
    format: formatUptime,
  },
  {
    /* Plain listings only. `ls -l` rows carry eight columns of permissions
     * and dates this module would have to guess at; the generic layer's
     * "first line + N more" is the honest answer there. */
    claims: (cmd) => /^ls(\s|$)/i.test(cmd) && !/(^|\s)-\w*l/.test(cmd),
    format: formatListing,
  },
  {
    claims: (cmd) => /^du(\s|$)/i.test(cmd),
    format: formatDiskUsage,
  },
  {
    claims: (cmd) => /^sw_vers(\s|$)/i.test(cmd),
    format: formatMacosVersion,
  },
  {
    /* scutil --nwi — the get_mac_status network template. */
    claims: (cmd) => /^scutil\s+--nwi\b/i.test(cmd),
    format: formatNetworkInfo,
  },
  {
    /* The volume readbacks get_mac_status and the planner both use. The
     * command string is an osascript invocation, so the claim is on the
     * embedded phrase, not the binary. */
    claims: (cmd) =>
      cmd.includes('output volume of (get volume settings)') ||
      cmd.includes('get volume settings'),
    format: formatVolume,
  },
]

/*
 * df. Header names the columns; "Mounted on" is one column that splits into
 * two tokens, and Filesystem is the only column that may contain spaces —
 * so columns are counted from a collapsed header and any extra row tokens
 * are folded back into the filesystem name.
 */
function formatDiskFree(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2) return null

  const columns = lines[0].replace(/Mounted on/i, 'Mounted_on').split(/\s+/)
  const sizeIdx = columns.findIndex((c) => /^(Size|[\dKk]+-blocks|Blocks)$/i.test(c))
  const availIdx = columns.findIndex((c) => /^Avail(able)?$/i.test(c))
  const capIdx = columns.findIndex((c) => /^(Capacity|Use%)$/i.test(c))
  if (sizeIdx < 0 || availIdx < 0) return null

  /* Plain `df` reports block counts; the unit is in the header itself. */
  const blockMatch = /^([\dKk]+)-blocks$/i.exec(columns[sizeIdx])
  const blockBytes = blockMatch
    ? /k$/i.test(blockMatch[1])
      ? Number.parseInt(blockMatch[1], 10) * 1024
      : Number.parseInt(blockMatch[1], 10)
    : null

  const rows = []
  for (const line of lines.slice(1)) {
    let fields = line.split(/\s+/)
    if (fields.length < columns.length) continue
    if (fields.length > columns.length) {
      const extra = fields.length - columns.length
      fields = [fields.slice(0, extra + 1).join(' '), ...fields.slice(extra + 1)]
    }
    rows.push({ fields, mount: fields[fields.length - 1] })
  }
  if (!rows.length) return null

  /* The question is about the Mac, so the root filesystem answers it. The
   * writable half of a split APFS system volume is the next best truth, and
   * a df pointed at one path returns one row, which speaks for itself. */
  const row =
    rows.find((r) => r.mount === '/') ??
    rows.find((r) => r.mount === '/System/Volumes/Data') ??
    (rows.length === 1 ? rows[0] : null)
  if (!row) return null

  const avail = speakDfValue(row.fields[availIdx], blockBytes)
  const size = speakDfValue(row.fields[sizeIdx], blockBytes)
  if (!avail || !size) return null

  const capacity = capIdx >= 0 ? /^(\d{1,3})%$/.exec(row.fields[capIdx]) : null
  const used = capacity ? ` (${capacity[1]}% used)` : ''
  const where = row.mount === '/' ? '' : ` on ${row.mount}`

  return `${avail} free of ${size}${used}${where}.`
}

/*
 * "460Gi" → "460 GB". The suffix is spoken as the decimal unit on purpose:
 * the owner asked how much space is left, not for a lesson in binary
 * prefixes, and 460 "gigs" is what every other surface calls it.
 */
function speakDfValue(token, blockBytes) {
  const match = /^([\d.,]+)([KMGTPE])?(i|iB|B)?$/i.exec(String(token ?? ''))
  if (!match) return null
  if (!match[2]) {
    if (!blockBytes) return match[3] ? `${match[1]} bytes` : null
    const blocks = Number.parseFloat(match[1].replace(/,/g, ''))
    if (!Number.isFinite(blocks)) return null
    return speakBytes(blocks * blockBytes)
  }
  return `${match[1]} ${match[2].toUpperCase()}B`
}

function speakBytes(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)
  return `${rounded} ${units[unit]}`
}

/*
 * pmset -g batt:
 *   Now drawing from 'Battery Power'
 *    -InternalBattery-0 (id=6094947)	85%; discharging; 3:42 remaining present: true
 */
function formatBattery(text) {
  const percent = /(\d{1,3})%/.exec(text)
  if (!percent) {
    /* Desktops have the power line and no battery row. */
    return /AC Power/i.test(text) ? 'On AC power.' : null
  }

  const state = /\d{1,3}%;\s*([A-Za-z][A-Za-z ]*)/.exec(text)
  const remaining = /(\d+:\d{2})\s+remaining/.exec(text)
  const stateWord = state ? state[1].trim().toLowerCase() : ''

  let phrase = ''
  if (stateWord === 'charged') phrase = ', fully charged'
  else if (stateWord === 'ac attached') phrase = ', on AC power'
  else if (stateWord) phrase = `, ${stateWord}`

  let eta = ''
  if (
    remaining &&
    remaining[1] !== '0:00' &&
    (stateWord === 'charging' || stateWord === 'discharging' || stateWord === 'finishing charge')
  ) {
    eta = `, about ${remaining[1]} ${stateWord === 'discharging' ? 'remaining' : 'until full'}`
  }

  return `Battery at ${percent[1]}%${phrase}${eta}.`
}

/* " 10:14  up 3 days, 2:11, 2 users, load averages: 1.72 1.90 2.02" */
function formatUptime(text) {
  const line = collapse(text.split('\n')[0] ?? '')
  const up = /\bup\s+(.+?),\s*\d+\s+users?/.exec(line)
  if (!up) return null
  const load = /load averages?:\s*([\d.]+)/.exec(line)
  return `Up for ${up[1]}${load ? ` — load ${load[1]}` : ''}.`
}

/* Plain ls prints one name per line when stdout is a pipe, which it is here. */
function formatListing(text) {
  const names = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!names.length) return 'Empty directory.'

  const count = `${names.length} item${names.length === 1 ? '' : 's'}`
  const shown = names.slice(0, 3).map((name) => clipAtWordBoundary(name, 40))
  const more = names.length - shown.length
  const sentence = `${count} — ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`

  /* Three pathological filenames can still blow the budget; the count alone
   * is a worse answer but always a speakable one. */
  return sentence.length <= ANSWER_BUDGET_CHARS ? sentence : `${count}.`
}

/*
 * du prints its total last (`du -sh x` is only that line). Sizes come out of
 * -h as "1.5G"; without -h they are 512-byte blocks.
 */
function formatDiskUsage(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) return null

  const parsed = /^([\d.,]+)([KMGTPE])?i?B?\s+(.+)$/.exec(last)
  if (!parsed) return null

  const size = parsed[2]
    ? `${parsed[1]} ${parsed[2].toUpperCase()}B`
    : speakBytes(Number.parseFloat(parsed[1].replace(/,/g, '')) * 512)
  const target = parsed[3].trim()

  return target === 'total' ? `${size} in total.` : `${size} in ${target}.`
}

function formatMacosVersion(text) {
  const version = /ProductVersion:\s*(\S+)/.exec(text)
  if (!version) return null
  const name = /ProductName:\s*(.+)/.exec(text)
  const build = /BuildVersion:\s*(\S+)/.exec(text)
  return `${name ? name[1].trim() : 'macOS'} ${version[1]}${build ? ` (build ${build[1]})` : ''}.`
}

function formatNetworkInfo(text) {
  const interfaces = /Network interfaces:\s*(.+)/.exec(text)
  if (interfaces) {
    const names = interfaces[1].trim().split(/[,\s]+/).filter(Boolean)
    if (names.length) {
      const address = /address\s*:\s*([0-9a-f.:]+)/i.exec(text)
      const via = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
      return `Online via ${via}${address ? ` (${address[1]})` : ''}.`
    }
  }
  /* Only call it offline on output this parser recognisably owns — anything
   * else declines to the generic layer rather than inventing a verdict. */
  if (/Network information/i.test(text) || /No network/i.test(text)) {
    return 'No active network connection.'
  }
  return null
}

function formatVolume(text) {
  const bare = /^(\d{1,3})$/.exec(text)
  if (bare) return `Volume at ${bare[1]}%.`
  const settings = /output volume:\s*(\d{1,3})/.exec(text)
  if (!settings) return null
  const muted = /output muted:\s*true/.test(text)
  return `Volume at ${settings[1]}%${muted ? ', muted' : ''}.`
}

/* ======================================================================== */

function isTabularLine(line) {
  return line.split('\t').filter((field) => field.trim()).length >= TABULAR_TAB_FIELDS
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/*
 * Never cuts inside a word — same contract clampSpokenToBudget keeps for
 * scripts. When the only space is unhelpfully early, a hard clip with the
 * ellipsis is still better than shipping the whole line.
 */
function clipAtWordBoundary(text, maxChars) {
  const budget = Math.max(12, maxChars)
  if (text.length <= budget) return text
  const slice = text.slice(0, budget - 1)
  const lastSpace = slice.lastIndexOf(' ')
  const kept = lastSpace > budget * 0.5 ? slice.slice(0, lastSpace) : slice
  return `${kept.trimEnd()}…`
}
