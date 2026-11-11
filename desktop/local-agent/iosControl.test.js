import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import './testWorkspace.js'
import {
  IOS_ACTION_TYPES,
  buildProgram,
  focusLeaseState,
  harnessBinaryPath,
  runIosAction,
} from './iosControl.js'
import { SUPPORTED_ACTION_TYPES, executeComputerAction } from './computerControl.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/* Handing focus back is a debounced timer that spawns another child. It has
 * its own test; everywhere else it would just fire into a torn-down stub. */
process.env.PENDANT_IOS_RESTORE_FOCUS = 'false'

/*
 * NOTHING IN THIS FILE TOUCHES THE REAL PHONE.
 *
 * Two kinds of double are used, and the difference matters:
 *
 *   fakeHarness  — a shell script standing in for the phone-harness binary.
 *                  Exercises the JS half: timeouts, exit codes, stderr,
 *                  classification of the harness's wording.
 *   stubPhone    — real Python running the REAL generated program against stub
 *                  Quartz / phone_harness modules and a stub `screencapture`.
 *                  Exercises the half that actually matters for safety: which
 *                  window is chosen, whether anything is activated, and above
 *                  all whether a single HID event is ever posted when the
 *                  mirroring window is not verifiably in front.
 */

/*
 * The payload this design exists to defeat: quotes, a newline, and a
 * closing-paren-then-statement break-out, arriving as an app name or a label to
 * tap. If it ever reached the Python source it would run with the agent's TCC
 * grants and the owner's phone attached.
 */
const HOSTILE = '"); import os; os.system("touch /tmp/ph-injection-probe"); ("\n\'\'\'\n#'

/* Real geometry, measured on this Mac: the phone window and the decoy. The
 * "Welcome to iPhone Mirroring" window captures perfectly and OCRs nothing. */
const PHONE_WINDOW = {
  kCGWindowOwnerName: 'iPhone Mirroring',
  kCGWindowLayer: 0,
  kCGWindowNumber: 21250,
  kCGWindowName: '',
  kCGWindowBounds: { X: 888, Y: 38, Width: 354, Height: 781 },
}
const WELCOME_WINDOW = {
  kCGWindowOwnerName: 'iPhone Mirroring',
  kCGWindowLayer: 0,
  kCGWindowNumber: 21251,
  kCGWindowName: '',
  kCGWindowBounds: { X: 400, Y: 110, Width: 640, Height: 662 },
}
const MENU_BAR = {
  kCGWindowOwnerName: 'iPhone Mirroring',
  kCGWindowLayer: 0,
  kCGWindowNumber: 21249,
  kCGWindowName: '',
  kCGWindowBounds: { X: 0, Y: 0, Width: 1440, Height: 30 },
}

const SAMPLE_PARAMS = {
  ios_status: {},
  ios_ocr: { limit: 5 },
  ios_screenshot: {},
  ios_open_app: { name: 'Notes' },
  ios_tap_text: { query: 'Settings' },
  ios_type_text: { text: 'hello' },
  ios_swipe: { direction: 'up' },
  ios_scroll: { direction: 'down' },
  ios_back: {},
  ios_home: {},
}

/* Params wide enough for any write, so one loop can exercise them all. */
const EVERY_WRITE_PARAM = {
  query: 'Settings',
  index: 0,
  exact: false,
  text: 'hello',
  name: 'Notes',
  direction: 'up',
  distance: 0.4,
  amount: 300,
}

function findPython() {
  const candidates = [
    process.env.PH_TEST_PYTHON,
    path.join(os.homedir(), '.phone-harness', '.venv', 'bin', 'python'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  try {
    return execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

const PYTHON = findPython()

/* A stand-in for the phone-harness binary. No Python, no phone. */
function fakeHarness(t, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-harness-'))
  const file = path.join(dir, 'phone-harness')
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  const previous = process.env.PHONE_HARNESS_BIN
  process.env.PHONE_HARNESS_BIN = file
  t.after(() => {
    if (previous === undefined) delete process.env.PHONE_HARNESS_BIN
    else process.env.PHONE_HARNESS_BIN = previous
    fs.rmSync(dir, { force: true, recursive: true })
  })
  return file
}

const RESULT_OK = String.raw`printf '\n<<phone-harness-result>>{"result":{"state":"ready","ready":true}}\n'`

/*
 * A fake macOS. Quartz reports whatever windows the scenario says are on each
 * list, `screencapture` writes a file big enough to pass the size check, and
 * every input primitive records itself instead of posting an event — so "did
 * this program touch the owner's machine" is a question the test can answer
 * exactly.
 */
function stubPhone(t, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-stub-'))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))

  const lib = path.join(root, 'lib')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(path.join(lib, 'phone_harness'), { recursive: true })
  fs.mkdirSync(bin, { recursive: true })

  const statePath = path.join(root, 'state.json')
  const eventsPath = path.join(root, 'events.jsonl')
  const capturesPath = path.join(root, 'captures.txt')

  fs.writeFileSync(
    statePath,
    JSON.stringify({
      appRunning: true,
      frontmost: false,
      activationWorks: false,
      all: [MENU_BAR, PHONE_WINDOW, WELCOME_WINDOW],
      onscreen: [],
      ocr: { 21250: ['19:16', 'App Library', 'Settings'], 21251: [] },
      frontApp: { bundleId: 'com.apple.Safari', name: 'Safari' },
      runningBundles: ['com.apple.Safari'],
      ...scenario,
    }),
  )
  fs.writeFileSync(eventsPath, '')
  fs.writeFileSync(capturesPath, '')

  fs.writeFileSync(
    path.join(lib, 'Quartz.py'),
    [
      'import json, os',
      'kCGWindowListOptionAll = 0',
      'kCGWindowListOptionOnScreenOnly = 1',
      'kCGNullWindowID = 0',
      'def _state():',
      '    with open(os.environ["PH_STUB_STATE"]) as f:',
      '        return json.load(f)',
      'def CGWindowListCopyWindowInfo(option, _ignored):',
      '    state = _state()',
      '    return state["onscreen"] if option == kCGWindowListOptionOnScreenOnly else state["all"]',
      'def CGSessionCopyCurrentDictionary():',
      '    return {"CGSSessionScreenIsLocked": 1 if _state().get("macLocked") else 0}',
      // Event constants and constructors. CGEventPostToPid records what was
      // addressed to which process; CGEventPost records a GLOBAL post, so a
      // test can tell the two apart — which is the whole safety distinction.
      'kCGEventFlagMaskCommand = 1048576',
      'kCGEventFlagMaskShift = 131072',
      'kCGEventMouseMoved = 5',
      'kCGEventLeftMouseDown = 1',
      'kCGEventLeftMouseUp = 2',
      'kCGEventLeftMouseDragged = 6',
      'kCGMouseButtonLeft = 0',
      'kCGHIDEventTap = 0',
      'def _log(entry):',
      '    with open(os.environ["PH_STUB_EVENTS"], "a") as f:',
      '        f.write(json.dumps(entry) + "\\n")',
      'def CGPointMake(x, y):',
      '    return (x, y)',
      'def CGEventCreateKeyboardEvent(source, keycode, down):',
      '    return {"kind": "key", "keycode": keycode, "down": down, "flags": 0}',
      'def CGEventCreateMouseEvent(source, kind, point, button):',
      '    return {"kind": "mouse", "type": kind, "point": point}',
      'def CGEventSetFlags(ev, flags):',
      '    ev["flags"] = flags',
      'kCGScrollEventUnitPixel = 0',
      'def CGEventCreateScrollWheelEvent(source, unit, count, dy):',
      '    return {"kind": "scroll", "dy": dy, "point": None}',
      'def CGEventSetLocation(ev, point):',
      '    ev["point"] = point',
      // The keycodes iPhone Mirroring actually forwards, reversed. Typing has
      // to become VISIBLE on the fake screen: ios_open_app now refuses to press
      // Return until it has SEEN the query on the phone, and a stub whose
      // keystrokes go nowhere would make that guard untestable — and, worse,
      // would make it look like a bug.
      '_TYPED = {0:"a",1:"s",2:"d",3:"f",4:"h",5:"g",6:"z",7:"x",8:"c",9:"v",',
      '          11:"b",12:"q",13:"w",14:"e",15:"r",16:"y",17:"t",31:"o",',
      '          32:"u",34:"i",35:"p",37:"l",38:"j",40:"k",45:"n",46:"m",49:" "}',
      'def _append_typed(text):',
      '    state = _state()',
      '    state["typed"] = state.get("typed", "") + text',
      '    with open(os.environ["PH_STUB_STATE"], "w") as f:',
      '        json.dump(state, f)',
      'def _typed_from_key(code, flags):',
      '    if flags not in (0, kCGEventFlagMaskShift):',
      '        return',
      '    ch = _TYPED.get(code)',
      '    if ch is None:',
      '        return',
      '    _append_typed(ch.upper() if flags == kCGEventFlagMaskShift else ch)',
      'def CGEventPostToPid(pid, ev):',
      '    if ev.get("down") is False:',
      '        return',
      '    _log({"event": "targeted_" + ev["kind"], "pid": pid,',
      '          "keycode": ev.get("keycode"), "flags": ev.get("flags"),',
      '          "type": ev.get("type"), "point": ev.get("point"),',
      '          "dy": ev.get("dy")})',
      '    if ev["kind"] == "key":',
      '        _typed_from_key(ev.get("keycode"), ev.get("flags") or 0)',
      'def CGEventPost(tap, ev):',
      '    _log({"event": "global_" + ev["kind"]})',
      '',
    ].join('\n'),
  )

  fs.writeFileSync(
    path.join(lib, 'AppKit.py'),
    [
      'import json, os',
      'def _state():',
      '    with open(os.environ["PH_STUB_STATE"]) as f:',
      '        return json.load(f)',
      'class _Front:',
      '    def __init__(self, info):',
      '        self._info = info',
      '    def bundleIdentifier(self):',
      '        return self._info.get("bundleId")',
      '    def localizedName(self):',
      '        return self._info.get("name")',
      '    def processIdentifier(self):',
      '        return self._info.get("pid", 4242)',
      '    def activateWithOptions_(self, options):',
      '        with open(os.environ["PH_STUB_EVENTS"], "a") as f:',
      '            f.write(json.dumps({"event": "restore",',
      '                                "bundleId": self._info.get("bundleId")}) + "\\n")',
      'class _Workspace:',
      '    def frontmostApplication(self):',
      '        info = _state().get("frontApp")',
      '        return _Front(info) if info else None',
      'class NSWorkspace:',
      '    @staticmethod',
      '    def sharedWorkspace():',
      '        return _Workspace()',
      'class NSRunningApplication:',
      '    @staticmethod',
      '    def runningApplicationsWithBundleIdentifier_(bundle_id):',
      '        state = _state()',
      '        if bundle_id == "com.apple.ScreenContinuity":',
      '            if not state.get("appRunning", True):',
      '                return []',
      '            return [_Front({"bundleId": bundle_id, "pid": 68343})]',
      '        known = state.get("runningBundles", [])',
      '        return [_Front({"bundleId": bundle_id})] if bundle_id in known else []',
      '',
    ].join('\n'),
  )

  fs.writeFileSync(path.join(lib, 'phone_harness', '__init__.py'), '')
  fs.writeFileSync(
    path.join(lib, 'phone_harness', 'mirror.py'),
    [
      'import json, os',
      'def _state():',
      '    with open(os.environ["PH_STUB_STATE"]) as f:',
      '        return json.load(f)',
      'def _record(event, **fields):',
      '    fields["event"] = event',
      '    with open(os.environ["PH_STUB_EVENTS"], "a") as f:',
      '        f.write(json.dumps(fields) + "\\n")',
      'class _App:',
      '    def activateWithOptions_(self, options):',
      '        _record("activate")',
      '        state = _state()',
      '        if state.get("activationWorks"):',
      '            state["onscreen"] = state["all"]',
      '            state["frontmost"] = True',
      // Faithful to the real thing: once mirroring is in front, IT is the
      // frontmost app, so a later step in the same run sees itself as the
      // "previous" app. The lease must not be overwritten with that.
      '            state["frontApp"] = {"bundleId": "com.apple.ScreenContinuity",',
      '                                 "name": "iPhone Mirroring"}',
      '            with open(os.environ["PH_STUB_STATE"], "w") as f:',
      '                json.dump(state, f)',
      'def running_app():',
      '    return _App() if _state().get("appRunning", True) else None',
      'def is_frontmost():',
      '    return bool(_state().get("frontmost", False))',
      'def activate():',
      '    _record("activate_fn")',
      'def tap(x, y):',
      '    _record("tap", x=x, y=y)',
      'def long_press(x, y, duration=0.8):',
      '    _record("long_press", x=x, y=y)',
      'def drag(x1, y1, x2, y2, duration=0.35, steps=14):',
      '    _record("drag", x1=x1, y1=y1, x2=x2, y2=y2)',
      'def scroll_wheel(dy, x, y, steps=6):',
      '    _record("scroll_wheel", dy=dy, x=x, y=y)',
      'def press(combo):',
      '    _record("press", combo=combo)',
      'def type_text(text, delay=0.03):',
      '    _record("type_text", length=len(text))',
      '    state = _state()',
      '    state["typed"] = state.get("typed", "") + text',
      '    with open(os.environ["PH_STUB_STATE"], "w") as f:',
      '        json.dump(state, f)',
      // The real one is load-bearing (iPhone Mirroring forwards raw keycodes
      // and ignores the unicode payload), so the targeted typing path asks
      // phone_harness for it rather than keeping a second copy.
      '_KEYCODES = {"a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,',
      '             "v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,',
      '             "o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,',
      '             "m":46," ":49}',
      'def _keycode_for(ch):',
      '    shifted = ch.isupper()',
      '    return _KEYCODES.get(ch.lower()), shifted',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(lib, 'phone_harness', 'ocr.py'),
    [
      'import json, os',
      'def image_size(path):',
      '    return (390, 844)',
      'def recognize(path, window):',
      '    with open(os.environ["PH_STUB_STATE"]) as f:',
      '        state = json.load(f)',
      '    texts = list(state.get("ocr", {}).get(str(window["id"]), []))',
      // Whatever has been typed shows up on the phone's screen, the way a real
      // search field would. A scenario can set typingIsSwallowed to model the
      // failure ios_open_app now guards against: Spotlight opened, the
      // characters never arrived, and Return would launch the wrong app.
      '    if texts and state.get("typed") and not state.get("typingIsSwallowed"):',
      '        texts = texts + [state["typed"]]',
      '    return [{"text": t, "confidence": 0.9,',
      '             "x": window["x"] + window["w"] / 2,',
      '             "y": window["y"] + 40 + i * 30,',
      '             "w": 80, "h": 20}',
      '            for i, t in enumerate(texts)]',
      '',
    ].join('\n'),
  )

  fs.writeFileSync(
    path.join(bin, 'screencapture'),
    [
      '#!/bin/sh',
      'id=""',
      'target=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -l) id="$2"; shift 2 ;;',
      '    -*) shift ;;',
      '    *) target="$1"; shift ;;',
      '  esac',
      'done',
      'echo "$id" >> "$PH_STUB_CAPTURES"',
      'dd if=/dev/zero of="$target" bs=1024 count=40 2>/dev/null',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  /* `defaults` too, so the Space-switch diagnosis is scenario-controlled
   * rather than a reading of whatever this Mac happens to be set to. */
  fs.writeFileSync(
    path.join(bin, 'defaults'),
    [
      '#!/bin/sh',
      'case "$PH_STUB_SPACE_SWITCH" in',
      '  on) echo 1 ;;',
      '  off) echo 0 ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    PYTHONPATH: lib,
    PH_STUB_STATE: statePath,
    PH_STUB_EVENTS: eventsPath,
    PH_STUB_CAPTURES: capturesPath,
    PH_STUB_SPACE_SWITCH: scenario?.spaceSwitch ?? 'unset',
    /* The Spaces work reaches the REAL CoreGraphics through ctypes, which no
     * Python stub can intercept — and these scenarios carry the ids of the
     * owner's actual windows. Without this a test run would shuffle real
     * windows around someone's desk. */
    PH_SPACE_MOVE: '0',
    /* Activation reaches SkyLight through ctypes, which no Python stub can
     * intercept — the same problem as the Spaces work above, and the same
     * answer. Without pinning it, whether the targeted pointer route is
     * "available" would depend on the machine running the suite rather than on
     * the scenario, and every assertion below would be describing this laptop. */
    PH_STUB_ACTIVATION: scenario?.activation === 'unavailable' ? '0' : '1',
    ...(scenario?.spaceType ? { PH_STUB_SPACE_TYPE: scenario.spaceType } : {}),
  }

  const readEvents = () =>
    fs
      .readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

  const readCaptures = () =>
    fs.readFileSync(capturesPath, 'utf8').split('\n').filter(Boolean)

  /* Run the REAL generated program for `type` against the fake macOS. */
  const run = (type, params) => {
    const programPath = path.join(root, `${type}.py`)
    fs.writeFileSync(programPath, buildProgram(type))
    let stdout
    let status = 0
    try {
      stdout = execFileSync(PYTHON, [programPath], {
        encoding: 'utf8',
        env: { ...env, PH_PARAMS: JSON.stringify(params ?? {}) },
      })
    } catch (error) {
      stdout = String(error.stdout ?? '')
      status = error.status ?? -1
    }
    const at = stdout.indexOf('<<phone-harness-result>>')
    const payload =
      at === -1
        ? null
        : JSON.parse(stdout.slice(at + '<<phone-harness-result>>'.length).split('\n')[0])
    return { status, stdout, payload, events: readEvents(), captures: readCaptures() }
  }

  /* The same fake macOS, reached the way production reaches it: through
   * runIosAction spawning what it believes is phone-harness. */
  const harness = fakeHarness(
    t,
    'PYTHONPATH="$PH_STUB_LIB" PATH="$PH_STUB_BIN:$PATH" exec "$PH_STUB_PYTHON" -',
  )
  const exported = {
    PH_STUB_LIB: lib,
    PH_STUB_BIN: bin,
    PH_STUB_PYTHON: PYTHON,
    PH_STUB_STATE: statePath,
    PH_STUB_EVENTS: eventsPath,
    PH_STUB_CAPTURES: capturesPath,
    PH_STUB_SPACE_SWITCH: scenario?.spaceSwitch ?? 'unset',
    /* The Spaces work reaches the REAL CoreGraphics through ctypes, which no
     * Python stub can intercept — and these scenarios carry the ids of the
     * owner's actual windows. Without this a test run would shuffle real
     * windows around someone's desk. */
    PH_SPACE_MOVE: '0',
    /* Activation reaches SkyLight through ctypes, which no Python stub can
     * intercept — the same problem as the Spaces work above, and the same
     * answer. Without pinning it, whether the targeted pointer route is
     * "available" would depend on the machine running the suite rather than on
     * the scenario, and every assertion below would be describing this laptop. */
    PH_STUB_ACTIVATION: scenario?.activation === 'unavailable' ? '0' : '1',
    ...(scenario?.spaceType ? { PH_STUB_SPACE_TYPE: scenario.spaceType } : {}),
  }
  for (const [key, value] of Object.entries(exported)) process.env[key] = value
  t.after(() => {
    for (const key of Object.keys(exported)) delete process.env[key]
  })

  /* Everything that reached the machine as a synthesized HID event. Activation
   * and focus restoration are window management, not input. */
  const inputEvents = (events) =>
    events.filter(
      (event) => !['activate', 'activate_fn', 'restore'].includes(event.event),
    )

  return { run, readEvents, readCaptures, inputEvents, harness, statePath }
}

const needsPython = (t) => {
  if (PYTHON) return false
  t.skip('no python available to run the generated programs')
  return true
}

// --- the injection boundary -------------------------------------------------

test('a hostile param never becomes part of the Python source', () => {
  for (const type of IOS_ACTION_TYPES) {
    const program = buildProgram(type)
    assert.ok(!program.includes(HOSTILE), `${type} must not carry the payload`)
    assert.ok(!program.includes('os.system'), `${type} must not contain os.system`)
    // The program is the same string whatever the caller says. There is no
    // per-call source to poison.
    assert.equal(program, buildProgram(type))
    assert.match(program, /p = json\.loads\(os\.environ\["PH_PARAMS"\]\)/)
  }
})

test('the Python programs are literals with no interpolation at all', () => {
  /*
   * Source-level, because this is the invariant a future edit would break
   * silently: the day someone writes an interpolated program string the
   * payload-of-the-day tests still pass and the hole is open.
   */
  const source = fs.readFileSync(path.join(HERE, 'iosControl.js'), 'utf8')
  const start = source.indexOf('const PROGRAM_PROLOGUE')
  const end = source.indexOf('export const IOS_ACTION_TYPES')
  assert.ok(start > 0 && end > start, 'failed to locate the Python program table')
  const table = source.slice(start, end)
  assert.ok(table.length > 500, 'the Python program table looks empty')
  assert.ok(
    !table.includes('${'),
    'a Python program string interpolates a value — params must only travel in PH_PARAMS',
  )
})

test('a hostile param runs as inert data, not code', async (t) => {
  if (needsPython(t)) return
  const probe = path.join(os.tmpdir(), 'ph-injection-probe')
  fs.rmSync(probe, { force: true })
  t.after(() => fs.rmSync(probe, { force: true }))

  const phone = stubPhone(t, { activationWorks: true })
  const run = phone.run('ios_tap_text', { query: HOSTILE, index: 0, exact: false })

  // It reached the real matching logic and found nothing — the payload was a
  // string being compared, never a statement being run.
  assert.equal(run.status, 3)
  assert.match(run.payload.error.message, /nothing on the iPhone screen matches/)
  assert.equal(fs.existsSync(probe), false, 'the injected os.system ran')
  assert.deepEqual(phone.inputEvents(run.events), [], 'a failed match must post nothing')
})

test('params reach the child only through PH_PARAMS, without agent credentials', async (t) => {
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ios-capture-')),
    'capture',
  )
  process.env.PH_TEST_OUT = out
  process.env.PH_TEST_FAKE_API_KEY = 'never-give-this-to-a-child'
  t.after(() => {
    delete process.env.PH_TEST_OUT
    delete process.env.PH_TEST_FAKE_API_KEY
    fs.rmSync(path.dirname(out), { force: true, recursive: true })
  })

  fakeHarness(
    t,
    [
      'cat > "$PH_TEST_OUT.program"',
      'env > "$PH_TEST_OUT.env"',
      'printf %s "$PH_PARAMS" > "$PH_TEST_OUT.params"',
      RESULT_OK,
    ].join('\n'),
  )

  const result = await runIosAction({
    type: 'ios_open_app',
    params: { name: HOSTILE },
  })
  assert.equal(result.ok, true)

  const program = fs.readFileSync(`${out}.program`, 'utf8')
  const params = JSON.parse(fs.readFileSync(`${out}.params`, 'utf8'))
  const env = fs.readFileSync(`${out}.env`, 'utf8')

  assert.ok(!program.includes(HOSTILE), 'the payload reached the program text')
  assert.equal(params.name, HOSTILE, 'the value must arrive intact, as data')
  assert.match(env, /^PH_PARAMS=/m)
  assert.match(env, /^PATH=/m, 'PATH must survive or nothing runs')
  assert.ok(
    !/^PH_TEST_FAKE_API_KEY=/m.test(env),
    'childEnv must keep credential-shaped variables out of the child',
  )
})

// --- the read path: off-Space, and never disturbing the owner ---------------

test('a read works with the window on another Space and activates nothing', async (t) => {
  if (needsPython(t)) return
  // The owner is in a fullscreen app: the mirroring window exists but is on no
  // on-screen list at all. This is the case phone-harness misreports as "no
  // phone is connected".
  const phone = stubPhone(t, { onscreen: [], frontmost: false, activationWorks: false })

  const run = phone.run('ios_ocr', { minConfidence: 0.3, limit: 50 })

  assert.equal(run.status, 0)
  assert.equal(run.payload.result.count, 3)
  assert.equal(run.payload.result.onScreen, false)
  assert.deepEqual(
    run.payload.result.items.map((item) => item.text),
    ['19:16', 'App Library', 'Settings'],
  )
  // The whole point: no activation, no Space switch, no focus theft, no events.
  assert.deepEqual(run.events, [], 'a read must not touch the owner\'s machine')
})

test('the phone window is chosen by shape, not by list order', async (t) => {
  if (needsPython(t)) return
  // The Welcome window listed FIRST, and nothing but it would be found by a
  // naive "first tall-ish window" rule. It captures fine and OCRs nothing.
  const phone = stubPhone(t, {
    all: [WELCOME_WINDOW, MENU_BAR, PHONE_WINDOW],
    onscreen: [],
  })

  const run = phone.run('ios_screenshot', { path: path.join(os.tmpdir(), 'ios-stub-shot.png') })

  assert.equal(run.status, 0)
  assert.equal(run.payload.result.window.id, 21250, 'picked the Welcome window')
  assert.equal(run.payload.result.textCount, 3)
  // The 1440x30 menu-bar windows are never even captured: wider than tall.
  assert.deepEqual(run.captures, ['21250'])
})

test('a window that captures but reads blank does not masquerade as the phone', async (t) => {
  if (needsPython(t)) return
  // Only the decoy is present. It captures, OCRs nothing, and is returned as a
  // last resort with an honest empty reading rather than a confident wrong one.
  const phone = stubPhone(t, { all: [WELCOME_WINDOW], onscreen: [], ocr: { 21251: [] } })

  const run = phone.run('ios_ocr', { minConfidence: 0.3, limit: 50 })
  assert.equal(run.status, 0)
  assert.equal(run.payload.result.count, 0)
  assert.deepEqual(run.events, [])
})

test('ios_status tells off-Space apart from unreachable', async (t) => {
  if (needsPython(t)) return

  const offSpace = stubPhone(t, { onscreen: [], frontmost: false })
  const off = offSpace.run('ios_status', {})
  assert.equal(off.status, 0)
  assert.equal(off.payload.result.state, 'off-space')
  assert.equal(off.payload.result.readable, true)
  assert.equal(off.payload.result.ready, false)
  assert.equal(off.payload.result.pointerWritesNeedActivation, true)
  assert.deepEqual(off.events, [], 'even the status probe must not activate')

  const onScreen = stubPhone(t, {
    onscreen: [MENU_BAR, PHONE_WINDOW, WELCOME_WINDOW],
    frontmost: true,
  })
  const ready = onScreen.run('ios_status', {})
  assert.equal(ready.payload.result.state, 'ready')
  assert.equal(ready.payload.result.ready, true)
  assert.equal(ready.payload.result.pointerWritesNeedActivation, false)

  const gone = stubPhone(t, { all: [], onscreen: [] })
  assert.equal(gone.run('ios_status', {}).payload.result.state, 'no-window')

  const shut = stubPhone(t, { all: [], onscreen: [], appRunning: false })
  assert.equal(shut.run('ios_status', {}).payload.result.state, 'not-running')
})

// --- the write path: prove the window is there, or post nothing -------------

test('a write posts NOTHING when the window cannot be brought to the front', async (t) => {
  if (needsPython(t)) return
  /*
   * The most important test in this module.
   *
   * CGEventPost aims at absolute screen coordinates and keystrokes go to the
   * frontmost app. If the mirroring window is on another Space and the program
   * posts anyway, the tap lands on the owner's real desktop — clicking whatever
   * app is actually in front of them. So: activation is attempted, it does not
   * take, and not one input event may be posted.
   */
  const phone = stubPhone(t, {
    onscreen: [],
    frontmost: false,
    activationWorks: false,
  })

  const run = phone.run('ios_tap_text', { query: 'Settings', index: 0, exact: false })

  assert.equal(run.status, 3)
  assert.match(run.payload.error.message, /could not be brought to the front/)
  assert.match(run.payload.error.message, /Nothing was sent to the iPhone/i)
  assert.equal(run.payload.error.code, 'not-frontmost')
  assert.deepEqual(
    phone.inputEvents(run.events),
    [],
    'an input event was posted with the phone window not in front',
  )
  // It did try to activate — refusing is the fallback, not the first move.
  assert.ok(run.events.some((event) => event.event === 'activate'))
})

test('the refusal names the macOS setting that is actually responsible', async (t) => {
  if (needsPython(t)) return
  /*
   * "Could not be brought to the front" is true and useless on its own. When
   * Desktop & Dock's "switch to a Space with open windows" is off, activating
   * the app genuinely cannot follow it to its Space — so the fix is one
   * setting, and the message should say which.
   */
  const off = stubPhone(t, {
    onscreen: [],
    frontmost: false,
    activationWorks: false,
    spaceSwitch: 'off',
  })
  const blocked = off.run('ios_swipe', { direction: 'up', distance: 0.4 })
  assert.equal(blocked.payload.error.code, 'not-frontmost')
  assert.match(blocked.payload.error.message, /Desktop & Dock/)
  assert.match(blocked.payload.error.message, /switch to a Space/)

  // With the setting on, the window simply is not reachable — no setting to
  // blame, so we must not blame one.
  const on = stubPhone(t, {
    onscreen: [],
    frontmost: false,
    activationWorks: false,
    spaceSwitch: 'on',
  })
  const other = on.run('ios_swipe', { direction: 'up', distance: 0.4 })
  assert.equal(other.payload.error.code, 'not-frontmost')
  assert.ok(!/Desktop & Dock/.test(other.payload.error.message))
  assert.match(other.payload.error.message, /Space you are working in/)
})

test('a locked Mac is reported as the Mac, not as a phone problem', async (t) => {
  if (needsPython(t)) return
  /*
   * While the Mac is locked the window server composites nothing, so every
   * capture fails with "could not create image from window" — which reads
   * exactly like a dead phone connection and sends the owner to look at the
   * wrong device. Observed live: the agent saw this the moment the Mac locked.
   */
  const phone = stubPhone(t, { macLocked: true, onscreen: [], frontmost: false })

  const status = phone.run('ios_status', {})
  assert.equal(status.payload.result.state, 'mac-locked')
  assert.equal(status.payload.result.macLocked, true)
  assert.equal(status.payload.result.windowFound, true)

  const write = phone.run('ios_home', {})
  assert.equal(write.payload.error.code, 'mac-locked')
  assert.match(write.payload.error.message, /Nothing was sent to the iPhone/i)
  assert.match(write.payload.error.message, /Mac's screen is locked/)
  assert.deepEqual(phone.inputEvents(write.events), [])

  const result = await runIosAction({ type: 'ios_status', params: {} })
  assert.equal(result.ok, true)
  assert.match(result.message, /Mac's screen is locked/)
  assert.match(result.message, /this is the Mac, not the phone/)
  // Measured on this Mac while genuinely locked: the window stays enumerable
  // and every capture returns "could not create image from window". Reading is
  // the foundation of every guard, so neither reads nor writes are possible —
  // the phone is not drivable overnight, and this is where that is stated.
  assert.equal(result.readsPossible, false)
  assert.equal(result.writesPossible, false)
  assert.match(result.message, /neither read nor driven/)
})

test('a fullscreen Space is named as the hard blocker it is', async (t) => {
  if (needsPython(t)) return
  /*
   * The one no setting fixes. macOS gives a fullscreen app a Space that hosts
   * only that app: measured on the owner's Mac, CGSMoveWindowsToManagedSpace
   * and CGSAddWindowsToSpaces both resolved, both were called against the
   * active Space, and the mirroring window stayed off-screen either way. So a
   * touch has nothing to land on, and telling the owner to flip a preference
   * would send them to fix the wrong thing.
   */
  const phone = stubPhone(t, {
    onscreen: [],
    frontmost: false,
    spaceType: 'fullscreen',
    spaceSwitch: 'on', // even with the preference ON, fullscreen still blocks
  })

  const status = phone.run('ios_status', {})
  assert.equal(status.payload.result.activeSpaceIsFullscreen, true)
  assert.equal(status.payload.result.pointerWritesPossible, false)
  assert.equal(status.payload.result.pointerBlockedBy, 'fullscreen-space')
  // Reading and ios_home are untouched by any of this.
  assert.equal(status.payload.result.readsPossible, true)
  assert.equal(status.payload.result.navigationWritesPossible, true)

  const result = await runIosAction({ type: 'ios_status', params: {} })
  assert.match(result.message, /FULLSCREEN/)
  assert.match(result.message, /no other window may join/)
  assert.ok(!/Desktop & Dock/.test(result.message), 'must not blame the preference')
})

test('ios_status says up front whether a write could land at all', async (t) => {
  if (needsPython(t)) return
  const stuck = stubPhone(t, { onscreen: [], frontmost: false, spaceSwitch: 'off' })
  const status = stuck.run('ios_status', {})
  assert.equal(status.payload.result.state, 'off-space')
  assert.equal(status.payload.result.readable, true)
  assert.equal(status.payload.result.spaceSwitchOnActivate, false)
  // Pointer actions cannot land, but the two menu-equivalent actions still
  // can — so "writes" as a single yes/no would be a lie in both directions.
  assert.equal(status.payload.result.pointerWritesPossible, false)
  assert.equal(status.payload.result.navigationWritesPossible, true)
  assert.equal(status.payload.result.writesPossible, true)
  assert.equal(status.payload.result.writeMechanism, 'targeted')
  assert.deepEqual(status.payload.result.targetedActions, [
    'ios_home',
    'ios_app_switcher',
  ])

  const fine = stubPhone(t, { onscreen: [], frontmost: false, spaceSwitch: 'on' })
  const ok = fine.run('ios_status', {})
  assert.equal(ok.payload.result.pointerWritesPossible, true)
  assert.equal(ok.payload.result.writeMechanism, 'activate-fallback')

  // And the owner-facing message names the fix rather than only the symptom.
  const stuckAgain = stubPhone(t, { onscreen: [], frontmost: false, spaceSwitch: 'off' })
  const result = await runIosAction({ type: 'ios_status', params: {} })
  assert.equal(result.ok, true)
  assert.equal(result.pointerWritesPossible, false)
  assert.match(result.message, /Desktop & Dock/)
  assert.deepEqual(stuckAgain.readEvents(), [])
})

test('ios_home reaches the phone without activating or taking focus', async (t) => {
  if (needsPython(t)) return
  /*
   * The one action with a targeted route, measured on the real phone: cmd+1 is
   * a menu key equivalent, so CGEventPostToPid delivers it while the window is
   * on another Space. Nothing may be activated, and the event must be
   * ADDRESSED (targeted_key), never broadcast (global_key) — a global post is
   * what would land on the owner's desktop.
   */
  const phone = stubPhone(t, {
    onscreen: [],
    frontmost: false,
    activationWorks: false, // would make the guarded path fail outright
  })

  const run = phone.run('ios_home', {})
  assert.equal(run.status, 0, `ios_home should not need the window in front: ${JSON.stringify(run.payload)}`)
  assert.equal(run.payload.result.mechanism, 'targeted')

  const events = run.events
  const targeted = events.filter((e) => e.event === 'targeted_key')
  assert.equal(targeted.length, 1, 'exactly one addressed key event')
  assert.equal(targeted[0].keycode, 18, 'cmd+1')
  assert.equal(targeted[0].flags, 1048576, 'the command flag')
  assert.ok(
    !events.some((e) => e.event.startsWith('global_')),
    'nothing may be posted globally on the targeted path',
  )
  assert.ok(
    !events.some((e) => e.event === 'activate'),
    'the targeted path must never activate the app',
  )
  assert.equal(run.payload.result.priorApp, undefined, 'no focus was taken, so none is owed back')
})

test('the targeted path leaves the frontmost app exactly where it found it', async (t) => {
  if (needsPython(t)) return
  /*
   * The stronger form of the assertion above. "No activate call was recorded"
   * is a statement about which functions ran; this checks the END STATE, which
   * is what the owner actually experiences — the stub's activateWithOptions_
   * rewrites frontApp, so an app that took the screen by any route would show
   * up here.
   *
   * This is the invariant the whole targeted route exists for, and it is the
   * one measured on the real phone on 2026-08-08: with the owner in a
   * fullscreen Safari on another Space, cmd+1 reached the phone and
   * NSWorkspace.frontmostApplication read com.apple.Safari before and after.
   */
  const phone = stubPhone(t, {
    onscreen: [],
    frontmost: false,
    activationWorks: false,
    frontApp: { bundleId: 'com.apple.Safari', name: 'Safari' },
  })

  const before = JSON.parse(fs.readFileSync(phone.statePath, 'utf8')).frontApp
  const run = phone.run('ios_home', {})
  assert.equal(run.status, 0)
  const after = JSON.parse(fs.readFileSync(phone.statePath, 'utf8')).frontApp

  assert.deepEqual(after, before, 'the owner kept their screen')
  assert.equal(after.bundleId, 'com.apple.Safari')
  assert.ok(
    !run.events.some((e) => e.event === 'activate' || e.event === 'activate_fn'),
    'nothing may be activated on the targeted route',
  )
  // And the Space was never touched either: moving the window is part of the
  // guarded path, and the targeted path must not reach for it.
  assert.ok(
    !run.events.some((e) => String(e.event).includes('move')),
    'the targeted route must not move the window between Spaces',
  )
})

test('ios_status reports pointer reach as measured, in both directions', async (t) => {
  if (needsPython(t)) return
  /*
   * REWRITTEN 2026-08-09, and the previous version of this test was asserting
   * something false. It pinned pointerTargetedPossible to a constant false on
   * the reasoning that iPhone Mirroring "declines to forward pointer input
   * while it is not the active application" — which is true, and which was
   * then taken to mean the app cannot be made active without taking the
   * owner's screen. It can:
   * _SLPSSetFrontProcessWithOptions(psn, 0, kCPSNoWindows) makes it ACTIVE
   * while fronting nothing.
   *
   * Measured on the owner's phone, owner working in another window, with a
   * cmd+3 control passing in the same run: identical keys posted with
   * CGEventPostToPid did NOTHING with the app inactive and LANDED with it
   * active — Spotlight went from its suggestion list to a live search for the
   * typed string. Frontmost app and active Space were sampled before, during
   * and after and never changed.
   *
   * So this now pins a route that exists, and pins its LIMIT just as hard.
   */
  const visibleNotFront = stubPhone(t, { onscreen: [PHONE_WINDOW], frontmost: false })
  const seen = visibleNotFront.run('ios_status', {}).payload.result
  assert.equal(seen.state, 'ready')
  assert.equal(seen.pointerTargetedPossible, true)
  assert.equal(seen.pointerTargetedBlockedBy, null)
  assert.equal(seen.pointerWritesPossible, true)
  assert.equal(seen.writeMechanism, 'targeted-active')
  assert.equal(
    seen.pointerWritesNeedActivation,
    false,
    'the targeted route makes the app active without fronting it, so it costs the owner nothing',
  )
  // The whole pointer family joins the free actions on this route.
  assert.deepEqual(seen.targetedActions, [
    'ios_home',
    'ios_app_switcher',
    'ios_open_app',
    'ios_tap_text',
    'ios_type_text',
    'ios_swipe',
    'ios_scroll',
    'ios_back',
  ])

  /*
   * THE LIMIT, and it is deliberately conservative. The measurement above was
   * taken with the window on the Space the owner is looking at. Whether a
   * pointer event can be hit-tested against a window macOS is not compositing
   * has NOT been measured, so off-Space it does not claim the route. Set
   * PH_TARGETED_POINTER_OFFSPACE=1 after measuring it, not before.
   */
  const offSpace = stubPhone(t, { onscreen: [], frontmost: false, spaceSwitch: 'on' })
  const off = offSpace.run('ios_status', {}).payload.result
  assert.equal(off.state, 'off-space')
  assert.equal(off.pointerTargetedPossible, false)
  assert.equal(off.pointerTargetedBlockedBy, 'off-space-unproven')
  assert.deepEqual(off.targetedActions, ['ios_home', 'ios_app_switcher'])

  /*
   * THE ORIGINAL REGRESSION, which must stay fixed on the fallback route.
   * pointerWritesNeedActivation used to be `state == "off-space"`, so a window
   * in plain sight while the owner worked in another app reported FALSE and
   * the write then took their screen anyway. With activation unavailable there
   * is no targeted route, the guarded path is all there is, and the field has
   * to admit that it will cost them their focus. Visible is not active.
   */
  const noSkylight = stubPhone(t, {
    onscreen: [PHONE_WINDOW],
    frontmost: false,
    activation: 'unavailable',
  })
  const fallback = noSkylight.run('ios_status', {}).payload.result
  assert.equal(fallback.state, 'ready')
  assert.equal(fallback.activationAvailable, false)
  assert.equal(fallback.pointerTargetedPossible, false)
  assert.equal(fallback.pointerTargetedBlockedBy, 'activation-unavailable')
  assert.equal(fallback.pointerWritesPossible, true)
  assert.equal(fallback.writeMechanism, 'activate-fallback')
  assert.equal(
    fallback.pointerWritesNeedActivation,
    true,
    'without the targeted route a visible but inactive window still costs the owner their focus',
  )

  const front = stubPhone(t, {
    onscreen: [PHONE_WINDOW],
    frontmost: true,
    activation: 'unavailable',
  })
  const ready = front.run('ios_status', {}).payload.result
  assert.equal(ready.pointerWritesNeedActivation, false, 'already active, nothing to take')

  // Unreachable phones claim nothing at all.
  const shut = stubPhone(t, { appRunning: false, all: [], onscreen: [] })
  const dead = shut.run('ios_status', {}).payload.result
  assert.equal(dead.pointerWritesPossible, false)
  assert.equal(dead.pointerTargetedPossible, false)
  assert.deepEqual(dead.targetedActions, [])

  /*
   * AND THE WORLD STILL OVERRULES THE MECHANISM. Caught by running the real
   * generated program against the owner's Mac while its screen was locked: the
   * activation route is entirely available there — the symbols resolve, the
   * window is enumerable, the app is running — and status therefore claimed
   * pointerWritesPossible true with writeMechanism "targeted-active" for a
   * machine that composites nothing, cannot be read, and cannot verify a
   * single thing it did. Having a route is not the same as being able to use
   * it.
   */
  const macLocked = stubPhone(t, {
    onscreen: [PHONE_WINDOW],
    frontmost: false,
    macLocked: true,
  })
  const asleep = macLocked.run('ios_status', {}).payload.result
  assert.equal(asleep.state, 'mac-locked')
  assert.equal(asleep.readsPossible, false)
  assert.equal(asleep.activationAvailable, true, 'the mechanism is fine; the world is not')
  assert.equal(asleep.pointerTargetedPossible, false)
  assert.equal(asleep.pointerTargetedBlockedBy, 'unreachable')
  assert.equal(asleep.pointerWritesPossible, false)
  assert.equal(asleep.writeMechanism, 'none')

  // Same rule for a phone the owner is holding, and for a password prompt.
  for (const [label, scenario] of [
    ['paused', { ocr: { 21250: ['iPhone in Use', 'Lock your iPhone to connect.'], 21251: [] } }],
    ['mac-login', { ocr: { 21250: ['iPhone Mirroring Is Locked', 'Enter password'], 21251: [] } }],
  ]) {
    const phone = stubPhone(t, { onscreen: [PHONE_WINDOW], frontmost: false, ...scenario })
    const state = phone.run('ios_status', {}).payload.result
    assert.equal(state.pointerTargetedPossible, false, label)
    assert.equal(state.pointerWritesPossible, false, label)
    assert.equal(state.writeMechanism, 'none', label)
  }
})

test('the targeted pointer route posts addressed events and takes no focus', async (t) => {
  if (needsPython(t)) return
  /*
   * The invariant the whole change exists for. With the window visible but the
   * app inactive, a tap must:
   *   - make the app ACTIVE and hand activation straight back,
   *   - never call activateWithOptions_ (that is what fronts a window),
   *   - post its mouse events ADDRESSED to the process, never globally,
   *   - and owe nobody their focus back afterwards.
   */
  const phone = stubPhone(t, {
    onscreen: [PHONE_WINDOW],
    frontmost: false,
    activationWorks: false, // the guarded path would fail outright
  })

  const before = JSON.parse(fs.readFileSync(phone.statePath, 'utf8')).frontApp
  const run = phone.run('ios_tap_text', { query: 'Settings', index: 0, exact: false })
  assert.equal(run.status, 0, `tap should not need fronting: ${JSON.stringify(run.payload)}`)
  assert.equal(run.payload.result.mechanism, 'targeted-active')

  const events = run.events
  assert.ok(
    events.some((e) => e.event === 'activate_targeted'),
    'the app must be made active',
  )
  assert.ok(
    events.some((e) => e.event === 'restore_targeted'),
    'activation must be handed straight back',
  )
  assert.ok(
    !events.some((e) => e.event === 'activate' || e.event === 'activate_fn'),
    'nothing may be fronted',
  )
  assert.ok(
    !events.some((e) => String(e.event).startsWith('global_')),
    'a pointer event must never be broadcast at the screen',
  )
  assert.ok(
    events.some((e) => e.event === 'targeted_mouse'),
    'the tap must be addressed to the process',
  )
  assert.equal(run.payload.result.priorApp, null, 'no focus was taken, so none is owed back')

  const after = JSON.parse(fs.readFileSync(phone.statePath, 'utf8')).frontApp
  assert.deepEqual(after, before, 'the owner kept their screen')
})

test('ios_open_app will not press Return until it has seen what it typed', async (t) => {
  if (needsPython(t)) return
  /*
   * The Airbnb guard. Spotlight opened, the app name never arrived, and Return
   * launched whatever Siri had already suggested — asking for Calculator
   * opened Airbnb on the owner's real phone. Typing works now, but "it works
   * now" is not a safety property: the check is that the query was SEEN on the
   * phone's own screen before anything was committed.
   */
  const swallowed = stubPhone(t, {
    onscreen: [PHONE_WINDOW],
    frontmost: false,
    typingIsSwallowed: true,
  })
  const refused = swallowed.run('ios_open_app', { name: 'Calculator' })
  assert.notEqual(refused.status, 0, 'it must refuse rather than launch something else')
  assert.equal(refused.payload.error.code, 'not-typed')
  assert.ok(
    !swallowed
      .readEvents()
      .some((e) => e.event === 'targeted_key' && e.keycode === 36),
    'Return must never be pressed when the query did not arrive',
  )

  // And when the text does arrive, it commits.
  const working = stubPhone(t, { onscreen: [PHONE_WINDOW], frontmost: false })
  const opened = working.run('ios_open_app', { name: 'Notes' })
  assert.equal(opened.status, 0, JSON.stringify(opened.payload))
  assert.ok(
    working.readEvents().some((e) => e.event === 'targeted_key' && e.keycode === 36),
    'Return is pressed once the query is on screen',
  )
})

test('a Mac login prompt is recognised and never typed into', async (t) => {
  if (needsPython(t)) return
  /*
   * Resuming a paused session puts up the MAC's password prompt. It is a text
   * field on a screen that otherwise reads like any other, so an action that
   * does not know about it types its payload into a password box. This is not
   * hypothetical — an experiment run against this module while proving the
   * activation route was polling to fire, and its marker list did not include
   * this screen.
   */
  const locked = stubPhone(t, {
    onscreen: [PHONE_WINDOW],
    frontmost: false,
    ocr: {
      21250: ['iPhone Mirroring Is Locked', 'Enter the Mac login for "Evan Liu" to continue.', 'Enter password'],
      21251: [],
    },
  })

  const status = locked.run('ios_status', {}).payload.result
  assert.equal(status.state, 'mac-login')
  assert.equal(status.needsMacLogin, true)

  for (const [type, params] of [
    ['ios_type_text', { text: 'hunter2' }],
    ['ios_tap_text', { query: 'Enter password', index: 0, exact: false }],
    ['ios_open_app', { name: 'Notes' }],
    ['ios_home', {}],
  ]) {
    const phone = stubPhone(t, {
      onscreen: [PHONE_WINDOW],
      frontmost: false,
      ocr: {
        21250: ['iPhone Mirroring Is Locked', 'Enter the Mac login for "Evan Liu" to continue.', 'Enter password'],
        21251: [],
      },
    })
    const run = phone.run(type, params)
    assert.notEqual(run.status, 0, `${type} must refuse at a password prompt`)
    assert.equal(run.payload.error.code, 'mac-login', type)
    assert.deepEqual(
      phone.inputEvents(phone.readEvents()).filter((e) => String(e.event).includes('key')),
      [],
      `${type} must not send a single keystroke at a password field`,
    )
  }
})

test('the targeted path still refuses when the world says no', async (t) => {
  if (needsPython(t)) return
  // Not activating is a mechanism change, not a licence. Paused, blocked and
  // locked still stop it, because those are facts about the world.
  const paused = stubPhone(t, {
    onscreen: [], frontmost: false,
    ocr: { 21250: ['iPhone in Use', 'Lock your iPhone to connect.'], 21251: [] },
  })
  const p = paused.run('ios_home', {})
  assert.equal(p.payload.error.code, 'paused')
  assert.deepEqual(paused.inputEvents(p.events), [])

  const locked = stubPhone(t, { macLocked: true, onscreen: [], frontmost: false })
  const l = locked.run('ios_home', {})
  assert.equal(l.payload.error.code, 'mac-locked')
  assert.deepEqual(locked.inputEvents(l.events), [])
})

test('every write action aborts without posting when the window stays away', async (t) => {
  if (needsPython(t)) return
  // ios_home is absent: it has a targeted route and does not need the window.
  const writes = [
    'ios_tap_text',
    'ios_type_text',
    'ios_swipe',
    'ios_scroll',
    'ios_back',
    'ios_open_app',
  ]
  for (const type of writes) {
    const phone = stubPhone(t, { onscreen: [], frontmost: false, activationWorks: false })
    const run = phone.run(type, EVERY_WRITE_PARAM)
    assert.equal(run.status, 3, `${type} should have refused`)
    assert.match(run.payload.error.message, /Nothing was sent to the iPhone/i, type)
    assert.deepEqual(phone.inputEvents(run.events), [], `${type} posted an event anyway`)
  }
})

test('a write proceeds once the window is verifiably in front', async (t) => {
  if (needsPython(t)) return
  const phone = stubPhone(t, { onscreen: [], frontmost: false, activationWorks: true })

  const run = phone.run('ios_tap_text', { query: 'Settings', index: 0, exact: false })

  assert.equal(run.status, 0)
  assert.equal(run.payload.result.tapped.text, 'Settings')
  const taps = run.events.filter((event) => event.event === 'tap')
  assert.equal(taps.length, 1, 'exactly one tap, never a retry')
  // Aimed inside the phone window, at the matched row.
  assert.equal(taps[0].x, 888 + 354 / 2)
  assert.equal(taps[0].y, 38 + 40 + 2 * 30)
  // Whoever had the screen is recorded, so it can be handed back later.
  assert.equal(run.payload.result.priorApp.bundleId, 'com.apple.Safari')
})

test('every write action posts its own event once the window is in front', async (t) => {
  if (needsPython(t)) return
  const expected = {
    ios_tap_text: 'tap',
    ios_type_text: 'type_text',
    ios_swipe: 'drag',
    ios_back: 'drag',
    ios_scroll: 'scroll_wheel',
    ios_home: 'targeted_key',
    ios_open_app: 'press',
  }
  for (const [type, event] of Object.entries(expected)) {
    const phone = stubPhone(t, { onscreen: [], frontmost: false, activationWorks: true })
    const run = phone.run(type, EVERY_WRITE_PARAM)
    assert.equal(run.status, 0, `${type} failed: ${JSON.stringify(run.payload)}`)
    const posted = phone.inputEvents(run.events)
    assert.ok(posted.length > 0, `${type} posted nothing`)
    assert.ok(
      posted.some((entry) => entry.event === event),
      `${type} should post a ${event}, got ${posted.map((e) => e.event).join(',')}`,
    )
  }
})

test('ios_back drags from the left edge, which is what makes it a back gesture', async (t) => {
  if (needsPython(t)) return
  const phone = stubPhone(t, { onscreen: [], frontmost: false, activationWorks: true })

  const run = phone.run('ios_back', {})
  assert.equal(run.status, 0)
  const drags = run.events.filter((event) => event.event === 'drag')
  assert.equal(drags.length, 1)
  // Starts within a few points of the window's left edge and travels right.
  assert.ok(drags[0].x1 - PHONE_WINDOW.kCGWindowBounds.X <= 6, 'not an edge swipe')
  assert.ok(drags[0].x2 > drags[0].x1)
})

test('a write reports whether the screen actually changed', async (t) => {
  if (needsPython(t)) return
  // The stub screen never changes, so a tap that "worked" still reports that
  // nothing happened — which is exactly the signal a planner needs to stop
  // walking down a path that never opened.
  const phone = stubPhone(t, { onscreen: [], frontmost: false, activationWorks: true })
  const run = phone.run('ios_tap_text', { query: 'Settings', index: 0, exact: false })

  assert.equal(run.payload.result.changed, false)
  assert.deepEqual(run.payload.result.appeared, [])

  const result = await runIosAction({
    type: 'ios_tap_text',
    params: { query: 'Settings' },
  })
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.match(result.message, /did NOT change/)
  assert.match(result.message, /Tapped "Settings"/)
})

test('the screen is handed back to whoever had it, once the run goes quiet', async (t) => {
  if (needsPython(t)) return
  process.env.PENDANT_IOS_FOCUS_RESTORE_MS = '300'
  process.env.PENDANT_IOS_RESTORE_FOCUS = 'true'
  t.after(() => {
    delete process.env.PENDANT_IOS_FOCUS_RESTORE_MS
    process.env.PENDANT_IOS_RESTORE_FOCUS = 'false'
  })

  const phone = stubPhone(t, { onscreen: [], frontmost: false, activationWorks: true })

  // Two writes in a row: the second must NOT clear the lease, because by then
  // the "previous" app is iPhone Mirroring itself.
  await runIosAction({ type: 'ios_home', params: {} })
  await runIosAction({ type: 'ios_scroll', params: { direction: 'down' } })

  const armed = focusLeaseState()
  assert.equal(armed.pending, 'com.apple.Safari')

  await new Promise((resolve) => setTimeout(resolve, 2500))

  const restores = phone.readEvents().filter((event) => event.event === 'restore')
  assert.equal(restores.length, 1, 'focus should be handed back exactly once')
  assert.equal(restores[0].bundleId, 'com.apple.Safari')
})

test('a write refuses when the window in front is not the phone', async (t) => {
  if (needsPython(t)) return
  // Only the decoy is on screen. It is the same shape family, it captures
  // perfectly, and it reads blank — so a bounds check alone would happily tap
  // into iPhone Mirroring's own onboarding window.
  const phone = stubPhone(t, {
    all: [WELCOME_WINDOW],
    onscreen: [],
    activationWorks: true,
    ocr: { 21251: [] },
  })

  const run = phone.run('ios_tap_text', { query: 'Settings', index: 0, exact: false })
  assert.equal(run.status, 3)
  assert.match(run.payload.error.message, /no readable text/)
  assert.deepEqual(phone.inputEvents(run.events), [])
})

test('a Connect screen stops a write before any event, and is not a pause', async (t) => {
  if (needsPython(t)) return
  // A session that was never connected, as opposed to one the owner paused by
  // picking up the phone. Different cause, different fix, different code — and
  // in neither case may anything be tapped, least of all Connect itself.
  const phone = stubPhone(t, {
    onscreen: [],
    frontmost: false,
    activationWorks: true,
    ocr: { 21250: ['To connect, open iPhone Mirroring', 'Connect'], 21251: [] },
  })

  const run = phone.run('ios_home', {})
  assert.equal(run.status, 3)
  assert.equal(run.payload.error.code, 'blocked')
  assert.deepEqual(phone.inputEvents(run.events), [], 'tapped through the connect screen')

  const result = await runIosAction({ type: 'ios_home', params: {} })
  assert.equal(result.reason, 'ios-mirroring-blocked')
  assert.match(result.message, /will not tap Connect/i)
})

test('the owner picking up their phone is a pause, not a failure', async (t) => {
  if (needsPython(t)) return
  /*
   * Mirroring pauses whenever the owner unlocks their iPhone. That is the
   * ordinary cost of a shared device and it fixes itself; reporting it in the
   * same words as a broken setup taught the planner to treat the most common
   * interruption there is as an error worth escalating.
   */
  const phone = stubPhone(t, {
    onscreen: [],
    frontmost: false,
    activationWorks: true,
    ocr: {
      21250: ['iPhone in Use', 'iPhone Mirroring ended due to iPhone use.',
              'Lock your iPhone to connect.', 'Connect'],
      21251: [],
    },
  })

  const status = phone.run('ios_status', {})
  assert.equal(status.payload.result.state, 'paused')
  assert.equal(status.payload.result.pausedByPhoneUse, true)
  assert.equal(status.payload.result.readable, true, 'the screen is still readable')
  assert.equal(status.payload.result.writesPossible, false)

  const write = phone.run('ios_home', {})
  assert.equal(write.payload.error.code, 'paused')
  assert.deepEqual(phone.inputEvents(write.events), [])

  const result = await runIosAction({ type: 'ios_home', params: {} })
  assert.equal(result.reason, 'ios-mirroring-paused')
  assert.match(result.message, /paused because the iPhone is in use/)
  assert.match(result.message, /Nothing is broken/)
  assert.match(result.message, /resumes on its own/)

  const reported = await runIosAction({ type: 'ios_status', params: {} })
  assert.equal(reported.ok, true)
  assert.equal(reported.state, 'paused')
  assert.match(reported.message, /paused because the iPhone is in use/)
})

test('the refusal reaches the caller as a structured, actionable failure', async (t) => {
  if (needsPython(t)) return
  const phone = stubPhone(t, { onscreen: [], frontmost: false, activationWorks: false })

  const result = await runIosAction({
    type: 'ios_tap_text',
    params: { query: 'Settings' },
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ios-window-not-frontmost')
  assert.match(result.message, /Nothing was sent to the iPhone/)
  assert.match(result.message, /another Space/)
  assert.deepEqual(phone.inputEvents(phone.readEvents()), [])
})

test('an off-Space read reaches the caller as a plain success', async (t) => {
  if (needsPython(t)) return
  const phone = stubPhone(t, { onscreen: [], frontmost: false })

  const result = await runIosAction({ type: 'ios_status', params: {} })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'off-space')
  assert.equal(result.ready, false)
  assert.match(result.message, /another Space/)
  assert.deepEqual(phone.readEvents(), [])
})

// --- failure modes at the process boundary ----------------------------------

test('a closed mirroring window is reported as something the owner can act on', async (t) => {
  fakeHarness(
    t,
    [
      'cat > /dev/null',
      String.raw`printf '\n<<phone-harness-result>>{"error":{"type":"RuntimeError","message":"iPhone Mirroring has no open window — open the iPhone Mirroring app and leave the window visible."}}\n'`,
      'exit 3',
    ].join('\n'),
  )

  const result = await runIosAction({ type: 'ios_ocr', params: {} })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'ios-mirroring-window-missing')
  assert.equal(
    result.message,
    'iPhone Mirroring has no open window — open the iPhone Mirroring app and leave the window visible.',
  )
})

test("phone-harness's own no-window wording is classified the same way", async (t) => {
  // A helper called underneath can still raise the stock message.
  fakeHarness(
    t,
    [
      'cat > /dev/null',
      String.raw`printf '\n<<phone-harness-result>>{"error":{"type":"RuntimeError","message":"iPhone Mirroring is open but no phone is connected. Please connect your phone in the app, then retry."}}\n'`,
      'exit 3',
    ].join('\n'),
  )

  const result = await runIosAction({ type: 'ios_ocr', params: {} })
  assert.equal(result.reason, 'ios-mirroring-window-missing')
  assert.match(result.harnessError.message, /no phone is connected/)
})

test('a non-zero exit hands back stderr verbatim', async (t) => {
  fakeHarness(
    t,
    [
      'cat > /dev/null',
      'echo "Traceback (most recent call last):" >&2',
      `echo "ImportError: No module named 'Quartz'" >&2`,
      'exit 1',
    ].join('\n'),
  )

  const result = await runIosAction({ type: 'ios_status', params: {} })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ios-harness-failed')
  assert.equal(result.harness.exitCode, 1)
  assert.match(result.stderr, /Traceback \(most recent call last\):/)
  assert.match(result.stderr, /ImportError: No module named 'Quartz'/)
  assert.match(result.message, /ImportError: No module named 'Quartz'/)
})

test('a hung harness is stopped at the timeout and never retried', async (t) => {
  fakeHarness(t, ['cat > /dev/null', 'sleep 30'].join('\n'))

  const startedAt = Date.now()
  const result = await runIosAction({ type: 'ios_ocr', params: { timeout: 1000 } })
  const elapsed = Date.now() - startedAt

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ios-timeout')
  assert.match(result.message, /NOT retried/)
  assert.ok(elapsed < 15_000, `timeout did not bound the call (${elapsed}ms)`)
})

test('a missing phone-harness says where it looked instead of hanging', async (t) => {
  const previous = process.env.PHONE_HARNESS_BIN
  process.env.PHONE_HARNESS_BIN = path.join(os.tmpdir(), 'no-such-phone-harness')
  t.after(() => {
    if (previous === undefined) delete process.env.PHONE_HARNESS_BIN
    else process.env.PHONE_HARNESS_BIN = previous
  })

  const result = await runIosAction({ type: 'ios_status', params: {} })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ios-harness-missing')
  assert.match(result.message, /no-such-phone-harness/)
})

test('the default binary is the venv path, not a PATH lookup', () => {
  const previous = process.env.PHONE_HARNESS_BIN
  delete process.env.PHONE_HARNESS_BIN
  try {
    assert.equal(
      harnessBinaryPath(),
      path.join(os.homedir(), '.phone-harness', '.venv', 'bin', 'phone-harness'),
    )
  } finally {
    if (previous !== undefined) process.env.PHONE_HARNESS_BIN = previous
  }
})

// --- parameter validation ---------------------------------------------------

test('an incoherent action fails closed before anything is spawned', async () => {
  const cases = [
    [{ type: 'ios_open_app', params: {} }, /requires the app name/],
    [{ type: 'ios_tap_text', params: {} }, /requires the on-screen text/],
    [{ type: 'ios_type_text', params: { text: '   ' } }, /requires the text to type/],
    [{ type: 'ios_swipe', params: { direction: 'sideways' } }, /up, down, left, or right/],
    [{ type: 'ios_fly_home', params: {} }, /Unsupported iPhone action type/],
  ]
  for (const [action, pattern] of cases) {
    await assert.rejects(() => runIosAction(action), pattern, action.type)
  }
})

// --- wiring -----------------------------------------------------------------

test('every advertised iPhone action is dispatchable and described', async () => {
  const plannerSource = fs.readFileSync(path.join(HERE, 'llmPlanner.js'), 'utf8')

  assert.deepEqual(IOS_ACTION_TYPES, [
    'ios_app_switcher',
    'ios_back',
    'ios_home',
    'ios_ocr',
    'ios_open_app',
    'ios_screenshot',
    'ios_scroll',
    'ios_status',
    'ios_swipe',
    'ios_tap_text',
    'ios_type_text',
  ])
  // The internal focus hand-back is never advertised or dispatchable.
  assert.ok(!IOS_ACTION_TYPES.includes('ios_restore_focus'))
  assert.ok(!SUPPORTED_ACTION_TYPES.includes('ios_restore_focus'))
  await assert.rejects(
    () => runIosAction({ type: 'ios_restore_focus', params: { bundleId: 'x' } }),
    /Unsupported iPhone action type/,
  )

  for (const type of IOS_ACTION_TYPES) {
    assert.ok(
      SUPPORTED_ACTION_TYPES.includes(type),
      `${type} has no dispatch case in computerControl.js`,
    )
    assert.ok(
      plannerSource.includes(`  ${type}: {`),
      `${type} must be advertised to the planner`,
    )
  }
})

test('the executor actually routes every iPhone type into this module', async (t) => {
  fakeHarness(t, ['cat > /dev/null', RESULT_OK].join('\n'))

  for (const type of IOS_ACTION_TYPES) {
    const result = await executeComputerAction({
      type,
      label: `probe ${type}`,
      params: SAMPLE_PARAMS[type],
    })
    assert.equal(result.ok, true, `${type} did not reach iosControl`)
    assert.equal(result.status, 'success')
    assert.equal(result.action.type, type)
    assert.ok(String(result.message).length > 0, `${type} produced no message`)
  }
})
