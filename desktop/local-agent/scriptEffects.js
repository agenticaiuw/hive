/*
 * WHAT A SCRIPT DOES, NOT WHAT IT IS WRITTEN IN.
 *
 * THE INCIDENT THIS FILE EXISTS TO FIX (2026-08-09)
 *
 * The owner asked their pendant for the four newest items in Safari's Reading
 * List. Mic, LTE, transcription and planning all worked. The planner produced a
 * single `run_applescript` that reads the list and returns four lines. The gate
 * saw the action TYPE, said "Running AppleScript needs your approval", parked
 * the plan, and spoke the refusal to a pendant with no speaker attached. The
 * request died in silence, and the owner had never asked for that guardrail.
 *
 * The gate was classifying by MECHANISM. "Read my reading list" and "empty my
 * trash" are the same tier when the only question asked is "is this
 * AppleScript?". Same for the shell: `ls` and `rm -rf` are indistinguishable to
 * a rule that only knows the word `run_shell`.
 *
 * THE RULE
 *
 * Irreversible or outward-facing needs a human; reading does not. The owner
 * spoke the request — that IS the authorization for a read. Approval is for the
 * things a read can never be: destroying data, changing state, reaching another
 * person, spending money. So this file answers one question about a script's
 * body — does it only look? — and refuses to guess. An unparseable script, a
 * mixed one, or one this checker simply does not recognise is not a read.
 *
 * WHAT THIS IS NOT
 *
 * It is not a sandbox and it is not a secrecy boundary. A read that auto-runs
 * can still read a private file, exactly as the already-hands-free `read_file`
 * and `list_directory` always could; the tier is "cannot be taken back", not
 * "cannot be embarrassing". And it is not a parser — it is a recogniser with an
 * allowlist of statement shapes and a denylist of effects, which is why every
 * unknown answer is "confirm" rather than "probably fine".
 */

/* Long enough for a real reading-list script, short enough that nobody can hide
 * a mutation past the end of what a human would review. */
const MAX_SCRIPT_LENGTH = 4000
const MAX_COMMAND_LENGTH = 800

/**
 * AppleScript verbs whose whole purpose is to change something, with the effect
 * spelled out so a parked plan explains itself in terms of what it would DO.
 *
 * `appScoped` says whether naming the target application makes the sentence
 * truer ("closes a window in Safari") or just noisier ("runs a shell command in
 * Safari").
 */
const APPLESCRIPT_EFFECTS = [
  { token: 'do shell script', effect: 'runs an arbitrary shell command' },
  { token: 'do script', effect: 'runs script code inside another app' },
  { token: 'run script', effect: 'runs script text assembled at runtime' },
  { token: 'load script', effect: 'loads script code off disk' },
  { token: 'store script', effect: 'writes script code to disk' },
  { token: 'open location', effect: 'opens a URL' },
  { token: 'open for access', effect: 'opens a file for writing' },
  { token: 'mount volume', effect: 'mounts a volume' },
  { token: 'shut down', effect: 'shuts the Mac down' },
  { token: 'log out', effect: 'logs the owner out' },
  { token: 'key code', effect: 'sends keystrokes to whatever is in front' },
  { token: 'keystroke', effect: 'sends keystrokes to whatever is in front' },
  { token: 'perform action', effect: 'operates a UI control' },
  { token: 'set volume', effect: 'changes the system volume' },
  { token: 'display dialog', effect: 'puts a dialog on the owner’s screen' },
  { token: 'display notification', effect: 'posts a notification' },
  { token: 'delete', effect: 'deletes something', appScoped: true },
  { token: 'remove', effect: 'removes something', appScoped: true },
  { token: 'erase', effect: 'erases something', appScoped: true },
  { token: 'empty', effect: 'empties something (the trash)', appScoped: true },
  { token: 'make', effect: 'creates a new object', appScoped: true },
  { token: 'create', effect: 'creates something', appScoped: true },
  { token: 'duplicate', effect: 'duplicates something', appScoped: true },
  { token: 'move', effect: 'moves something', appScoped: true },
  { token: 'copy', effect: 'copies something onto something else', appScoped: true },
  { token: 'add', effect: 'adds something', appScoped: true },
  { token: 'save', effect: 'writes changes to disk', appScoped: true },
  { token: 'write', effect: 'writes to a file', appScoped: true },
  { token: 'close', effect: 'closes a window or document', appScoped: true },
  { token: 'quit', effect: 'quits the application', appScoped: true },
  { token: 'restart', effect: 'restarts the Mac' },
  { token: 'sleep', effect: 'puts the Mac to sleep' },
  { token: 'activate', effect: 'takes over the owner’s screen', appScoped: true },
  { token: 'launch', effect: 'launches an application' },
  { token: 'send', effect: 'sends something on the owner’s behalf', appScoped: true },
  { token: 'post', effect: 'posts something outward', appScoped: true },
  { token: 'reply', effect: 'replies to someone', appScoped: true },
  { token: 'forward', effect: 'forwards something to someone', appScoped: true },
  { token: 'share', effect: 'shares something outward', appScoped: true },
  { token: 'publish', effect: 'publishes something', appScoped: true },
  { token: 'subscribe', effect: 'subscribes to something', appScoped: true },
  { token: 'unsubscribe', effect: 'unsubscribes from something', appScoped: true },
  { token: 'import', effect: 'imports data', appScoped: true },
  { token: 'export', effect: 'exports data', appScoped: true },
  { token: 'print', effect: 'prints something', appScoped: true },
  { token: 'paste', effect: 'pastes over something', appScoped: true },
  { token: 'click', effect: 'clicks a UI control', appScoped: true },
  { token: 'select', effect: 'changes what is selected', appScoped: true },
  { token: 'reveal', effect: 'changes what is on screen', appScoped: true },
  { token: 'eject', effect: 'ejects a volume' },
  { token: 'install', effect: 'installs something' },
  { token: 'uninstall', effect: 'uninstalls something' },
  { token: 'say', effect: 'speaks out loud in the room' },
]

const APPLESCRIPT_EFFECT_PATTERNS = APPLESCRIPT_EFFECTS.map((entry) => ({
  ...entry,
  pattern: new RegExp(`\\b${entry.token.split(' ').join('\\s+')}\\b`, 'i'),
}))

/*
 * THE WRINKLE, AND THE HONEST LIMIT OF THE ANSWER.
 *
 * The incident's own script is full of `set … to`:
 *
 *     set itemsList to every reading list item
 *     set end of rows to {(date added of i), (name of i), (URL of i)}
 *     set n to n + 1
 *
 * Every one of those is a LOCAL VARIABLE assignment. A naive "set … to means
 * mutation" rule would park the exact read this file exists to let through, so
 * the target is what gets judged, not the keyword:
 *
 *   - a bare identifier (`itemsList`, `n`)                    → local
 *   - `end of <a local already assigned>` (a list append)     → local
 *   - anything with a possessive, a container, or an `of`
 *     chain (`name of front window`, `the clipboard`)         → the application
 *
 * Where this is NOT decidable: inside a `tell application …` block, AppleScript
 * resolves a bare identifier against the application's dictionary FIRST, so
 * `set rating to 100` inside `tell current track` mutates the track even though
 * it looks exactly like `set rows to {}`. Nothing short of the app's own
 * dictionary can tell those apart statically, and this checker does not have
 * one. So inside a tell block a bare identifier is treated as an application
 * property — confirm — when its name is one of the dictionary terms below, and
 * as a local otherwise.
 *
 * That is a heuristic, and it is the one genuinely soft edge in this file. The
 * residual hole is a bare set of an app property whose name is not on this
 * list, inside a tell block. It is deliberately biased toward confirming: the
 * list includes ordinary words a script might also use as locals, because a
 * needless approval prompt costs a tap and a missed mutation cannot be undone.
 */
const APP_PROPERTY_NAMES = new Set([
  'account', 'active', 'alarm', 'author', 'background', 'body', 'bounds',
  'brightness', 'category', 'class', 'collapsed', 'color', 'comment',
  'comments', 'completed', 'content', 'contents', 'current', 'date',
  'description', 'destination', 'document', 'due', 'duration', 'editable',
  'enabled', 'flagged', 'folder', 'font', 'frontmost', 'hidden', 'id', 'index',
  'kind', 'label', 'location', 'locked', 'message', 'miniaturized', 'mode',
  'mute', 'muted', 'name', 'note', 'notes', 'owner', 'password', 'path',
  'permissions', 'picture', 'playlist', 'position', 'priority', 'properties',
  'quality', 'rate', 'rating', 'recipient', 'recipients', 'selected',
  'selection', 'sender', 'shortcut', 'size', 'sound', 'source', 'speed',
  'starred', 'state', 'status', 'style', 'subject', 'tag', 'tags', 'target',
  'text', 'title', 'track', 'url', 'value', 'version', 'visible', 'volume',
  'wallpaper', 'window', 'zoomed',
])

/**
 * Does this AppleScript only look at things?
 *
 * @returns {{read: boolean, why: string, app: string|null}} `why` is a clause
 *   describing the EFFECT that held it, ready to drop into a sentence.
 */
export function analyzeAppleScript(script) {
  const raw = typeof script === 'string' ? script : ''
  if (!raw.trim()) {
    return notRead('has no script text to judge')
  }
  if (raw.length > MAX_SCRIPT_LENGTH) {
    return notRead(
      `is ${raw.length} characters long, past the ${MAX_SCRIPT_LENGTH} this checker will reason about`,
    )
  }

  /*
   * System Events is the UI-scripting back door: through it a script can click,
   * type and menu its way into anything on screen, and the dictionary terms it
   * uses to do so are ordinary nouns. Its read-only uses (listing processes)
   * are real but rare, and telling them apart from a click by pattern is
   * exactly the guessing this file refuses to do.
   */
  if (/\bsystem\s+events\b/i.test(raw)) {
    return notRead(
      'talks to System Events, which can click and type anywhere on the screen',
      appNameFrom(raw),
    )
  }

  const stripped = stripCommentsAndStrings(raw)
  if (!stripped.ok) {
    return notRead(stripped.why, appNameFrom(raw))
  }

  const context = {
    app: appNameFrom(raw),
    locals: new Set(),
    tellDepth: 0,
  }

  const statements = stripped.text
    .split(/[\n;]/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (!statements.length) {
    return notRead('is only comments, with nothing in it to judge', context.app)
  }

  for (const statement of statements) {
    const verdict = classifyStatement(statement, context)
    if (!verdict.read) return verdict
  }

  return { read: true, why: '', app: context.app }
}

/* ------------------------------------------------------------------ shell */

/**
 * Commands that only report. Each value is a guard for the flags that would
 * turn that command into a writer (`find -delete`, `plutil -convert` in place),
 * or null when the command has no such mode.
 */
const READ_ONLY_COMMANDS = new Map([
  ['ls', null],
  ['cat', null],
  ['head', null],
  ['tail', null],
  ['wc', null],
  ['stat', null],
  ['file', null],
  ['basename', null],
  ['dirname', null],
  ['grep', null],
  ['egrep', null],
  ['fgrep', null],
  ['df', null],
  ['du', null],
  ['ps', null],
  ['pgrep', null],
  ['ioreg', null],
  ['sw_vers', null],
  ['uname', null],
  ['uptime', null],
  ['whoami', null],
  ['hostname', null],
  ['pwd', null],
  ['id', null],
  ['groups', null],
  ['system_profiler', null],
  ['find', guardFind],
  ['date', guardDate],
  ['pmset', guardPmset],
  ['defaults', guardDefaults],
  ['plutil', guardPlutil],
  ['networksetup', guardNetworksetup],
  ['scutil', guardScutil],
  ['sysctl', guardSysctl],
  ['osascript', guardOsascript],
])

/**
 * Does this shell command only report?
 *
 * Chained commands are split and judged segment by segment, strictest verdict
 * wins — a pipeline is only a read when every stage of it is.
 *
 * @returns {{read: boolean, why: string}}
 */
export function analyzeShellCommand(command) {
  const raw = String(command ?? '').trim()
  if (!raw) return { read: false, why: 'has no command text to judge' }
  if (raw.length > MAX_COMMAND_LENGTH) {
    return {
      read: false,
      why: `is ${raw.length} characters long, past the ${MAX_COMMAND_LENGTH} this checker will reason about`,
    }
  }
  if (/`/.test(raw) || raw.includes('$(')) {
    return {
      read: false,
      why: 'substitutes the output of another command, which this checker cannot bound',
    }
  }
  if (raw.includes('$')) {
    return {
      read: false,
      why: 'expands a shell variable, hiding what would actually run',
    }
  }
  if (/[<>]/.test(raw)) {
    return {
      read: false,
      why: 'redirects input or output, which writes somewhere instead of only reporting',
    }
  }
  if (/[(){}]/.test(raw)) {
    return {
      read: false,
      why: 'uses a subshell or brace expansion this checker cannot bound',
    }
  }

  const segments = splitShellSegments(raw)
  if (!segments) {
    return {
      read: false,
      why: 'cannot be split into commands reliably (unbalanced quoting, or a background &)',
    }
  }

  for (const segment of segments) {
    const verdict = classifyShellSegment(segment)
    if (!verdict.read) return verdict
  }

  return { read: true, why: '' }
}

function classifyShellSegment(segment) {
  const tokens = tokenizeSegment(segment)
  if (!tokens || !tokens.length) {
    return { read: false, why: `has a command part this checker cannot read ("${clip(segment)}")` }
  }

  const [head, ...args] = tokens
  if (head.includes('=')) {
    return {
      read: false,
      why: `sets an environment variable before running something ("${clip(head)}")`,
    }
  }
  if (/^(sudo|doas)$/i.test(head)) {
    return { read: false, why: 'runs as another user, which is never just reading' }
  }

  const name = head.split('/').pop().toLowerCase()
  if (!READ_ONLY_COMMANDS.has(name)) {
    return {
      read: false,
      why: `runs "${clip(name)}", which is not on the read-only command list`,
    }
  }

  const guard = READ_ONLY_COMMANDS.get(name)
  const why = guard ? guard(args) : null
  return why ? { read: false, why } : { read: true, why: '' }
}

/* --------------------------------------------------------- shell guards */

const FIND_WRITERS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir',
  '-fls', '-fprint', '-fprint0', '-fprintf',
])

function guardFind(args) {
  const hit = args.find((arg) => FIND_WRITERS.has(arg.toLowerCase()))
  return hit
    ? `runs "find ${hit}", which acts on every file it matches instead of listing them`
    : null
}

function guardDate(args) {
  const bad = args.find((arg) => !/^\+/.test(arg) && !/^-[urjvfR]/.test(arg))
  return bad
    ? `passes "${clip(bad)}" to date, which can set the clock rather than report it`
    : null
}

function guardPmset(args) {
  return args[0] === '-g'
    ? null
    : 'uses pmset for something other than "-g", which changes power settings'
}

function guardDefaults(args) {
  return /^(read|read-type|domains)$/.test(String(args[0] ?? ''))
    ? null
    : 'uses defaults for something other than a read, which rewrites a preference'
}

function guardPlutil(args) {
  if (args.includes('-p')) return null
  const outIndex = args.indexOf('-o')
  if (outIndex >= 0 && args[outIndex + 1] === '-') return null
  return 'uses plutil without "-p" or "-o -", which rewrites the plist in place'
}

function guardNetworksetup(args) {
  return /^-get/i.test(String(args[0] ?? ''))
    ? null
    : 'uses networksetup for something other than a "-get", which reconfigures the network'
}

function guardScutil(args) {
  return /^--(nwi|dns|get|proxy)$/i.test(String(args[0] ?? ''))
    ? null
    : 'uses scutil for something other than a query, which changes system configuration'
}

function guardSysctl(args) {
  if (args.includes('-w')) return 'uses "sysctl -w", which writes a kernel setting'
  const assignment = args.find((arg) => !arg.startsWith('-') && arg.includes('='))
  return assignment
    ? `assigns "${clip(assignment)}" through sysctl, which writes a kernel setting`
    : null
}

/*
 * osascript is the shell's door back into AppleScript, so it is judged by the
 * same rule rather than by its own name — otherwise every verdict in this file
 * could be sidestepped by wrapping the script in `osascript -e`.
 */
function guardOsascript(args) {
  const language = args[args.indexOf('-l') + 1]
  if (args.includes('-l') && !/^applescript$/i.test(String(language ?? ''))) {
    return `runs osascript in ${clip(String(language ?? 'another language'))}, which this checker cannot read`
  }

  const scripts = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-e' && args[i + 1] !== undefined) {
      scripts.push(args[i + 1])
      i += 1
    }
  }
  if (!scripts.length) {
    return 'runs osascript from a file, whose contents this checker cannot see'
  }

  const verdict = analyzeAppleScript(scripts.join('\n'))
  return verdict.read ? null : `runs an AppleScript that ${verdict.why}`
}

/* ------------------------------------------------------ AppleScript parts */

function classifyStatement(statement, context) {
  const effect = APPLESCRIPT_EFFECT_PATTERNS.find((entry) =>
    entry.pattern.test(statement),
  )
  if (effect) {
    const where = effect.appScoped && context.app ? ` in ${context.app}` : ''
    return notRead(
      `calls "${effect.token}", which ${effect.effect}${where}`,
      context.app,
    )
  }

  if (/^end\b/i.test(statement)) {
    if (/^end\s+tell\b/i.test(statement)) {
      context.tellDepth = Math.max(0, context.tellDepth - 1)
    }
    return READ
  }

  if (/^tell\b/i.test(statement)) {
    const tail = tailAfterTo(statement)
    if (tail) return classifyStatement(tail, context)
    context.tellDepth += 1
    return READ
  }

  if (/^else\b/i.test(statement)) return READ

  if (/^if\b/i.test(statement)) {
    const then = statement.match(/\bthen\b(.*)$/i)
    const tail = then?.[1]?.trim()
    return tail ? classifyStatement(tail, context) : READ
  }

  if (/^repeat\b/i.test(statement)) {
    const loopVariable = statement.match(/^repeat\s+with\s+([A-Za-z_][A-Za-z0-9_]*)/i)
    if (loopVariable) context.locals.add(loopVariable[1].toLowerCase())
    return READ
  }

  if (/^exit\s+repeat$/i.test(statement)) return READ
  if (/^(try|end\s+try)$/i.test(statement)) return READ
  if (/^on\s+error\b/i.test(statement)) return READ

  const handler = statement.match(/^on\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:\(([^)]*)\))?$/i)
  if (handler) {
    for (const parameter of String(handler[1] ?? '').split(',')) {
      const name = parameter.trim().toLowerCase()
      if (/^[a-z_][a-z0-9_]*$/.test(name)) context.locals.add(name)
    }
    return READ
  }

  if (/^(return|get|count|exists)\b/i.test(statement)) return READ

  if (/^set\b/i.test(statement)) return classifySet(statement, context)

  return notRead(
    `has a line this checker cannot confirm is a read ("${clip(statement)}")`,
    context.app,
  )
}

function classifySet(statement, context) {
  const body = statement.replace(/^set\s+/i, '')
  const toIndex = findTopLevelTo(body)
  if (toIndex < 0) {
    return notRead(
      `has a "set" this checker cannot parse ("${clip(statement)}")`,
      context.app,
    )
  }

  const target = body.slice(0, toIndex).trim()
  if (!target) {
    return notRead(`has a "set" with no target ("${clip(statement)}")`, context.app)
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
    const name = target.toLowerCase()
    if (context.locals.has(name)) return READ
    if (context.tellDepth > 0 && APP_PROPERTY_NAMES.has(name)) {
      return notRead(
        `assigns to "${target}" inside a tell block, where that name is ${
          context.app ? `${context.app}'s own` : 'the application’s own'
        } property rather than a variable`,
        context.app,
      )
    }
    context.locals.add(name)
    return READ
  }

  const append = target.match(/^end\s+of\s+([A-Za-z_][A-Za-z0-9_]*)$/i)
  if (append && context.locals.has(append[1].toLowerCase())) return READ

  return notRead(
    `assigns to "${clip(target)}", which changes ${
      context.app ?? 'the application it is talking to'
    } rather than reading it`,
    context.app,
  )
}

/**
 * Remove comments and blank out string literals in one left-to-right pass.
 *
 * One pass rather than two regexes because `--` inside a string is not a
 * comment and a quote inside a comment does not open a string; running either
 * rule first gets the other one wrong. Unbalanced quoting is reported rather
 * than repaired — a script this cannot read is not a script it can clear.
 */
function stripCommentsAndStrings(raw) {
  let out = ''
  let index = 0
  let inString = false
  let blockDepth = 0

  while (index < raw.length) {
    const char = raw[index]

    if (blockDepth > 0) {
      if (char === '(' && raw[index + 1] === '*') {
        blockDepth += 1
        index += 2
        continue
      }
      if (char === '*' && raw[index + 1] === ')') {
        blockDepth -= 1
        index += 2
        continue
      }
      if (char === '\n') out += '\n'
      index += 1
      continue
    }

    if (inString) {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '"') {
        inString = false
        index += 1
        continue
      }
      if (char === '\n') {
        return { ok: false, why: 'has a string that is never closed, which this checker cannot read past' }
      }
      index += 1
      continue
    }

    if (char === '"') {
      /* An empty pair, not nothing: `set output to ""` has to keep a value on
       * the right of `to` or the statement stops looking like an assignment. */
      inString = true
      out += '""'
      index += 1
      continue
    }
    if (char === '(' && raw[index + 1] === '*') {
      blockDepth = 1
      index += 2
      continue
    }
    if (char === '-' && raw[index + 1] === '-') {
      while (index < raw.length && raw[index] !== '\n') index += 1
      continue
    }
    if (char === '#') {
      while (index < raw.length && raw[index] !== '\n') index += 1
      continue
    }

    out += char
    index += 1
  }

  if (inString || blockDepth > 0) {
    return {
      ok: false,
      why: 'has an unclosed string or comment, which this checker cannot read past',
    }
  }
  return { ok: true, text: out }
}

/** Index of the ` to ` that separates a `set` target from its value, ignoring
 * any inside parentheses, braces or brackets. */
function findTopLevelTo(text) {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '{' || char === '[') depth += 1
    else if (char === ')' || char === '}' || char === ']') depth -= 1
    else if (depth === 0 && /\s/.test(char) && /^\s+to\b/i.test(text.slice(index))) {
      return index
    }
  }
  return -1
}

/** The statement after a one-line `tell … to <statement>`, or null. */
function tailAfterTo(statement) {
  const index = findTopLevelTo(statement)
  if (index < 0) return null
  return statement.slice(index).replace(/^\s+to\s+/i, '').trim() || null
}

/** The first `tell application "X"` name, read from the ORIGINAL text — the
 * stripped copy has no string literals left to read it from. */
function appNameFrom(raw) {
  const match = raw.match(/\btell\s+(?:application|app)\s+"([^"]{1,60})"/i)
  return match ? match[1] : null
}

function splitShellSegments(raw) {
  const segments = []
  let current = ''
  let quote = null

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]

    if (quote) {
      if (char === quote) quote = null
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\\') {
      current += raw.slice(index, index + 2)
      index += 1
      continue
    }
    if (char === '&' || char === '|') {
      const doubled = raw[index + 1] === char
      /* A lone `&` backgrounds the command; nothing downstream can then say
       * what ran or when, so it is not something to wave through. */
      if (char === '&' && !doubled) return null
      segments.push(current)
      current = ''
      if (doubled) index += 1
      continue
    }
    if (char === ';' || char === '\n' || char === '\r') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }

  if (quote) return null
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter(Boolean)
}

function tokenizeSegment(segment) {
  const tokens = []
  let current = ''
  let started = false
  let quote = null

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]

    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }
      current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === '\\') {
      current += segment[index + 1] ?? ''
      started = true
      index += 1
      continue
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += char
    started = true
  }

  if (quote) return null
  if (started) tokens.push(current)
  return tokens
}

const READ = Object.freeze({ read: true, why: '', app: null })

function notRead(why, app = null) {
  return { read: false, why, app }
}

function clip(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > 60 ? `${value.slice(0, 59)}…` : value
}
