/*
 * The owner's REAL iPhone, driven through the Mac's iPhone Mirroring window.
 *
 * The transport is phone-harness (~/.phone-harness): `screencapture` of the
 * mirroring window plus Apple Vision OCR for eyes, Quartz CGEventPost HID
 * events for hands. It makes no network calls. Its CLI reads a Python program
 * from stdin with the helper namespace pre-imported.
 *
 * READS AND WRITES TAKE DIFFERENT PATHS, AND THAT IS THE SAFETY MODEL
 *
 * A read is a capture of one window by id. `screencapture -l <id>` works on a
 * window that is on ANOTHER macOS Space, so reads never activate anything,
 * never switch the owner's Space, and never steal their focus. Nothing in the
 * read path calls activate(). This also fixes a misdiagnosis: phone-harness's
 * own find_window() asks for kCGWindowListOptionOnScreenOnly, so the owner
 * running apps fullscreen makes a perfectly healthy mirroring session report
 * "no phone is connected". These programs enumerate with
 * kCGWindowListOptionAll instead and tell "off another Space" apart from
 * "actually not there".
 *
 * A write is the opposite, and the asymmetry is not fussiness. CGEventPost
 * aims at absolute SCREEN coordinates, and synthesized keystrokes go to
 * whatever application is frontmost. Post a tap while the mirroring window is
 * on another Space and it does not miss — it lands on the owner's real
 * desktop, clicking whatever app is actually in front of them. So every write
 * activates first and then PROVES the window arrived: present in the
 * on-screen list, app frontmost, bounds stable across two reads, and no
 * Connect / "iPhone in Use" interstitial on screen. If any of that fails the
 * program raises before a single event is posted. There is no "post it and
 * hope".
 *
 * WHY IT MUST BE A CHILD OF THE AGENT
 * macOS TCC grants are per-binary. The "AI Pendant Agent" app already holds
 * Accessibility and Screen Recording, so a phone-harness spawned by this
 * process inherits the grant and passes both checks; the same binary run from
 * a plain terminal fails them. Nothing here should ever be re-homed into a
 * detached helper or a LaunchAgent of its own without re-proving that.
 *
 * WHY PARAMS NEVER TOUCH THE PYTHON SOURCE
 * Every param on these actions — app name, text to tap, text to type — is
 * written by a language model from a sentence somebody said out loud. If any
 * of it were concatenated into the program text, `"); import os; os.system(` in
 * an app name would be code running as the agent, with the agent's own TCC
 * grants and the owner's phone attached. So the program is a CONSTANT: one
 * fixed string per action, containing no interpolation at all. The params
 * travel out-of-band as JSON in the PH_PARAMS environment variable and arrive
 * as a dict the program reads by key. A hostile string is then a Python str
 * and nothing else — the same way a bound SQL parameter is a value and not a
 * fragment of the query. iosControl.test.js proves it with the payload above.
 *
 * WHY NOTHING IS EVER RETRIED
 * A duplicated tap on a real phone is a real-world side effect: a second Send,
 * a second Buy, a second Delete. A call that times out or fails returns what it
 * knows and stops. Deciding to try again is the owner's, not ours.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { childEnv } from './childEnv.js'
import { workspacePath } from './config.js'
import { currentCancellationSignal, throwIfAborted } from './jobControl.js'
import { resolveUserPath } from './security.js'

const DEFAULT_HARNESS_BIN = path.join(
  os.homedir(),
  '.phone-harness',
  '.venv',
  'bin',
  'phone-harness',
)

/*
 * The venv binary by absolute path, not the ~/.local/bin symlink: the agent
 * process does not necessarily have ~/.local/bin on PATH, and a capability
 * that works from a developer's shell and not from the app is the failure mode
 * this whole module exists to avoid.
 */
export function harnessBinaryPath() {
  const configured = String(process.env.PHONE_HARNESS_BIN || '').trim()
  return configured || DEFAULT_HARNESS_BIN
}

/* One line of stdout, ours, so a helper that prints on its own does not have to
 * be parsed around. The first occurrence is the real one: nothing in these
 * programs writes to stdout before the terminating write. */
const RESULT_MARKER = '<<phone-harness-result>>'

/* Kill grace, matching computerControl's spawnShell: a process that ignores
 * SIGTERM still has to end. */
const KILL_GRACE_MS = 2_000

const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 300_000

/*
 * The programs. Each is a plain string literal with NO `${...}` in it — that is
 * the invariant, and it is checked mechanically by the test that reads this
 * file's own source. Every value a caller supplies is read off `p`, the dict
 * parsed from PH_PARAMS.
 *
 * Each body is written already indented by four spaces, because it is spliced
 * into the `try:` block at the end of PROGRAM_PROLOGUE.
 *
 * The prologue below carries the window locator, the read path and the write
 * gate. It imports what it needs by name rather than leaning on the helper
 * namespace the CLI pre-imports, so the same program is exactly as correct
 * under `python -` as under `phone-harness` — which is what lets the tests run
 * it against stub modules instead of a real phone.
 *
 * It deliberately does NOT use phone-harness's find_window() /
 * ensure_mirroring() / connection_state(): all three are built on
 * kCGWindowListOptionOnScreenOnly and therefore report a healthy session as
 * "no phone is connected" whenever the owner has the window on another Space.
 * The blocked-interstitial markers ARE taken from it verbatim — that check is
 * correct and worth keeping.
 */
const PROGRAM_PROLOGUE = `import json, os, subprocess, sys, tempfile, time

import Quartz
from AppKit import NSRunningApplication, NSWorkspace
from phone_harness import mirror as _mirror, ocr as _ocrmod

APP = "iPhone Mirroring"
BUNDLE_ID = "com.apple.ScreenContinuity"

# A phone is much taller than it is wide (354x781 on this Mac -> 0.45). The
# "Welcome to iPhone Mirroring" window is 640x662 -> 0.97, captures fine, and
# OCRs nothing at all, so shape is how the two are told apart. The window title
# is NOT usable for this: kCGWindowName comes back empty unless the reading
# process holds Screen Recording, so a name test would silently do nothing.
PHONE_ASPECT = 0.46

NO_WINDOW = ("iPhone Mirroring has no open window — open the iPhone Mirroring "
             "app and leave the window visible.")
NOT_RUNNING = ("iPhone Mirroring is not running — open it and connect your "
               "phone.")
NOT_FRONTMOST = ("iPhone Mirroring could not be brought to the front, so "
                 "NOTHING was sent to the phone. A tap or keystroke posted now "
                 "would have landed on whatever else is on screen.")
MOVED = ("The iPhone Mirroring window moved while it was being brought "
         "forward, so NOTHING was sent to the phone.")
BLOCKED = ("iPhone Mirroring is showing a Connect / 'iPhone in Use' screen, so "
           "NOTHING was sent. Connecting the phone is physical and only you can "
           "do it.")

# Verbatim from phone-harness helpers._BLOCKED_MARKERS.
BLOCKED_MARKERS = ("iphone in use", "lock your iphone", "mirroring ended",
                   "to connect")

CAPTURE_DIR = os.path.join(tempfile.gettempdir(), "phone-harness")
os.makedirs(CAPTURE_DIR, exist_ok=True)


def phone_windows(on_screen_only=False):
    """The mirroring app's phone-shaped windows, most phone-shaped first."""
    option = (Quartz.kCGWindowListOptionOnScreenOnly if on_screen_only
              else Quartz.kCGWindowListOptionAll)
    found = []
    for w in (Quartz.CGWindowListCopyWindowInfo(
            option, Quartz.kCGNullWindowID) or []):
        try:
            if w.get("kCGWindowOwnerName") != APP:
                continue
            if w.get("kCGWindowLayer", 1) != 0:
                continue
            b = w["kCGWindowBounds"]
            width, height = float(b["Width"]), float(b["Height"])
            if width < 200 or height <= width:
                continue
            name = str(w.get("kCGWindowName") or "")
            if name.strip().lower().startswith("welcome"):
                continue
            found.append({"x": float(b["X"]), "y": float(b["Y"]),
                          "w": width, "h": height,
                          "id": int(w["kCGWindowNumber"]), "name": name})
        except Exception:
            continue
    found.sort(key=lambda v: abs(v["w"] / v["h"] - PHONE_ASPECT))
    return found


def capture(win, path=None):
    """(path, None) or (None, why). Works with the window on another Space."""
    path = path or os.path.join(CAPTURE_DIR, "agent-window.png")
    r = subprocess.run(
        ["screencapture", "-x", "-o", "-l", str(win["id"]), path],
        capture_output=True)
    if (r.returncode != 0 or not os.path.exists(path)
            or os.path.getsize(path) < 20000):
        return None, (r.stderr.decode(errors="replace").strip()
                      or "capture was empty")
    return path, None


def read_phone(path=None):
    """(window, boxes, image) WITHOUT activating or focusing anything.

    Candidates are tried most-phone-shaped first and the first one that OCRs
    any text wins; a candidate that captures but reads blank is kept only as a
    last resort, because that is exactly what the Welcome window does.
    """
    candidates = phone_windows()
    if not candidates:
        raise RuntimeError(
            NOT_RUNNING if _mirror.running_app() is None else NO_WINDOW)
    fallback, why = None, "no capture was attempted"
    for win in candidates:
        image, err = capture(win, path)
        if image is None:
            why = err
            continue
        boxes = _ocrmod.recognize(image, win)
        if boxes:
            return win, boxes, image
        if fallback is None:
            fallback = (win, [], image)
        why = "captured, but no text was recognised on it"
    if fallback is not None:
        return fallback
    raise RuntimeError(
        "could not capture the iPhone Mirroring window: " + why)


def blocked_by(boxes):
    text = " ".join(o["text"] for o in boxes).lower()
    return any(marker in text for marker in BLOCKED_MARKERS)


def same_bounds(a, b):
    return all(round(a[k]) == round(b[k]) for k in ("x", "y", "w", "h"))


def frontmost_app():
    """Who has the screen right now — recorded so it can be given back."""
    app = NSWorkspace.sharedWorkspace().frontmostApplication()
    if app is None:
        return None
    return {"bundleId": str(app.bundleIdentifier() or ""),
            "name": str(app.localizedName() or "")}


def ready_to_send():
    """Bring the phone window forward and PROVE it before any event is posted.

    Returns (window, boxes, prior_app). Raises — having posted nothing — if the
    window is not demonstrably on screen, frontmost, still, and past the
    connect screen.

    Activation happens only when the window is not already frontmost, so a run
    of phone actions activates once and then keeps going rather than yanking
    the screen back and forth on every step. prior_app is whoever had the
    screen before, so the caller can hand it back when the run is over.
    """
    app = _mirror.running_app()
    if app is None:
        raise RuntimeError(NOT_RUNNING)
    if not phone_windows():
        raise RuntimeError(NO_WINDOW)
    prior = frontmost_app()
    if not _mirror.is_frontmost():
        app.activateWithOptions_(1 << 1)
    win = None
    deadline = time.time() + 6.0
    while time.time() < deadline:
        time.sleep(0.25)
        onscreen = phone_windows(on_screen_only=True)
        if onscreen and _mirror.is_frontmost():
            win = onscreen[0]
            break
    if win is None:
        raise RuntimeError(NOT_FRONTMOST)
    # Twice, a beat apart: a window still sliding onto the Space would move out
    # from under the coordinates we are about to aim at.
    time.sleep(0.4)
    settled = phone_windows(on_screen_only=True)
    if not settled or not _mirror.is_frontmost():
        raise RuntimeError(NOT_FRONTMOST)
    if not same_bounds(win, settled[0]):
        raise RuntimeError(MOVED)
    win = settled[0]
    image, err = capture(win)
    if image is None:
        raise RuntimeError(
            "could not see the phone screen before acting, so nothing was "
            "sent: " + err)
    boxes = _ocrmod.recognize(image, win)
    # A live phone screen always says something — a clock at the very least.
    # Nothing readable means the front window is not the phone: most likely the
    # "Welcome to iPhone Mirroring" window, which is the same shape family and
    # captures perfectly. Tapping into that is not a phone tap, so stop.
    if not boxes:
        raise RuntimeError(
            "could not see the phone screen before acting, so nothing was "
            "sent: the front iPhone Mirroring window shows no readable text, "
            "which is not what a live phone screen looks like.")
    if blocked_by(boxes):
        raise RuntimeError(BLOCKED)
    return win, boxes, prior


def still_there(win):
    """Re-check between steps. Focus can be stolen mid-sequence."""
    now = phone_windows(on_screen_only=True)
    if not now or not _mirror.is_frontmost():
        raise RuntimeError(NOT_FRONTMOST)
    if not same_bounds(win, now[0]):
        raise RuntimeError(MOVED)


def settle(win, timeout=6.0, interval=0.45):
    """Wait for the screen to stop changing, then return its final OCR."""
    previous, boxes = None, []
    deadline = time.time() + timeout
    while time.time() < deadline:
        image, err = capture(win)
        if image is None:
            time.sleep(interval)
            continue
        boxes = _ocrmod.recognize(image, win)
        current = tuple(sorted(o["text"] for o in boxes))
        if current == previous:
            break
        previous = current
        time.sleep(interval)
    return boxes


def visible(boxes, limit=25):
    return [o["text"] for o in boxes][:limit]


def diff_screens(before, after):
    """What the action actually did to the screen.

    A tap that changed nothing is the single most common failure on a phone —
    the label matched, the touch landed a few points off the control, and the
    agent carries on down a path that never opened. Reporting the difference
    turns that from a silent wrong turn into something the planner can see.
    """
    was = set(o["text"].strip() for o in before if o["text"].strip())
    now = set(o["text"].strip() for o in after if o["text"].strip())
    return {"changed": was != now,
            "appeared": sorted(now - was)[:12],
            "disappeared": sorted(was - now)[:12]}


p = json.loads(os.environ["PH_PARAMS"])
result = None
try:
`

const PROGRAM_EPILOGUE = `
except BaseException as exc:
    sys.stdout.write("\\n<<phone-harness-result>>" + json.dumps(
        {"error": {"type": type(exc).__name__, "message": str(exc)}}) + "\\n")
    sys.stdout.flush()
    raise SystemExit(3)

sys.stdout.write("\\n<<phone-harness-result>>" + json.dumps(
    {"result": result}, default=str) + "\\n")
sys.stdout.flush()
`

const OPERATIONS = {
  /*
   * The three reads. None of them activates, focuses, or switches a Space —
   * `screencapture -l <id>` reaches the window wherever it is.
   */
  ios_status: {
    readOnly: true,
    timeoutMs: 45_000,
    /* The preflight, and the one call that answers instead of raising when the
     * phone is unreachable: "the window is closed" IS the answer to "what is
     * the state of the phone". It distinguishes off-Space (readable now,
     * writes need the window brought forward) from genuinely absent, which is
     * the distinction phone-harness's own connection_state() collapses. */
    python: `    running = _mirror.running_app() is not None
    windows = phone_windows()
    on_screen = phone_windows(on_screen_only=True)
    result = {"appRunning": running, "windowFound": bool(windows),
              "onScreen": bool(on_screen),
              "frontmost": _mirror.is_frontmost(),
              "readable": False, "blocked": False}
    if not running:
        result["state"] = "not-running"
    elif not windows:
        result["state"] = "no-window"
    else:
        try:
            win, boxes, _image = read_phone()
            result["window"] = win
            result["readable"] = True
            result["textCount"] = len(boxes)
            result["blocked"] = blocked_by(boxes)
            if result["blocked"]:
                result["state"] = "blocked"
            elif result["onScreen"]:
                result["state"] = "ready"
            else:
                result["state"] = "off-space"
        except Exception as probe:
            result["state"] = "unreadable"
            result["detail"] = str(probe)
    result["ready"] = result["state"] == "ready"
    result["writesNeedActivation"] = result["state"] == "off-space"
`,
  },
  ios_ocr: {
    readOnly: true,
    timeoutMs: 45_000,
    python: `    win, boxes, _image = read_phone()
    items = [o for o in boxes if o["confidence"] >= p["minConfidence"]]
    result = {
        "count": len(items),
        "onScreen": bool(phone_windows(on_screen_only=True)),
        "blocked": blocked_by(boxes),
        "items": [
            {"text": o["text"], "x": round(o["x"]), "y": round(o["y"]),
             "w": round(o["w"]), "h": round(o["h"]),
             "confidence": o["confidence"]}
            for o in items[:p["limit"]]
        ],
    }
`,
  },
  ios_screenshot: {
    readOnly: true,
    timeoutMs: 45_000,
    python: `    win, boxes, image = read_phone(p["path"])
    result = {"path": image, "window": win, "textCount": len(boxes),
              "onScreen": bool(phone_windows(on_screen_only=True)),
              "blocked": blocked_by(boxes)}
`,
  },
  /*
   * The seven writes — the point of the whole module, not an optional extra.
   * An agent that can read a phone and not touch it is a screen reader.
   *
   * Every one opens with ready_to_send(), which posts nothing and raises
   * unless the window is provably on screen, frontmost and still, and
   * re-checks with still_there() immediately before EACH posted event. That
   * guard is not a capability limit, it is what makes the capability safe to
   * have: an unverified tap does not miss the phone, it clicks the owner's
   * real desktop. Every write also reports what changed on screen, so a tap
   * that matched a label but hit nothing is visible instead of silent.
   */
  ios_open_app: {
    timeoutMs: 60_000,
    python: `    win, before, prior = ready_to_send()
    still_there(win)
    _mirror.press("cmd+3")
    time.sleep(0.9)
    still_there(win)
    _mirror.type_text(p["name"])
    time.sleep(1.2)
    still_there(win)
    _mirror.press("return")
    after = settle(win)
    result = {"opened": p["name"], "priorApp": prior,
              "visible": visible(after)}
    result.update(diff_screens(before, after))
`,
  },
  ios_tap_text: {
    timeoutMs: 60_000,
    /* The OCR that chooses the point comes from ready_to_send()'s own verified
     * capture, so the coordinates and the bounds check describe the same
     * moment. still_there() runs once more between choosing and tapping. */
    python: `    win, before, prior = ready_to_send()
    query = p["query"].lower()
    hits = [o for o in before
            if (o["text"].lower() == query if p["exact"]
                else query in o["text"].lower())]
    if not hits:
        raise RuntimeError("nothing on the iPhone screen matches "
                           + repr(p["query"]) + "; visible: "
                           + repr(visible(before, 30)))
    if p["index"] >= len(hits):
        raise RuntimeError("only " + str(len(hits)) + " match(es) for "
                           + repr(p["query"]) + ", so index "
                           + str(p["index"]) + " is out of range")
    hit = hits[p["index"]]
    still_there(win)
    _mirror.tap(hit["x"], hit["y"])
    after = settle(win)
    result = {"tapped": {"text": hit["text"], "x": round(hit["x"]),
                         "y": round(hit["y"])},
              "matches": len(hits), "priorApp": prior,
              "visible": visible(after)}
    result.update(diff_screens(before, after))
`,
  },
  ios_type_text: {
    /* Typing is ~30ms a character through real keycodes, so a long string is a
     * genuinely long operation. */
    timeoutMs: 120_000,
    python: `    win, before, prior = ready_to_send()
    still_there(win)
    _mirror.type_text(p["text"])
    after = settle(win)
    result = {"typed": len(p["text"]), "priorApp": prior,
              "visible": visible(after)}
    result.update(diff_screens(before, after))
`,
  },
  ios_swipe: {
    timeoutMs: 45_000,
    python: `    win, before, prior = ready_to_send()
    cx = win["x"] + win["w"] / 2.0
    cy = win["y"] + win["h"] / 2.0
    dx = ({"left": -1.0, "right": 1.0}.get(p["direction"], 0.0)
          * win["w"] * p["distance"])
    dy = ({"up": -1.0, "down": 1.0}.get(p["direction"], 0.0)
          * win["h"] * p["distance"])
    still_there(win)
    _mirror.drag(cx - dx / 2, cy - dy / 2, cx + dx / 2, cy + dy / 2,
                 duration=0.12, steps=6)
    after = settle(win)
    result = {"direction": p["direction"], "distance": p["distance"],
              "priorApp": prior, "visible": visible(after)}
    result.update(diff_screens(before, after))
`,
  },
  ios_back: {
    timeoutMs: 45_000,
    /* iOS's interactive-pop gesture: a drag that STARTS at the left edge. It
     * is composed from mirror.drag rather than any invented helper, and the
     * `changed` field is how the planner finds out when an app does not
     * support it — a back that did nothing reports changed:false rather than
     * claiming success. ios_home is the guaranteed escape when it does. */
    python: `    win, before, prior = ready_to_send()
    y = win["y"] + win["h"] * 0.5
    still_there(win)
    _mirror.drag(win["x"] + 3.0, y, win["x"] + win["w"] * 0.65, y,
                 duration=0.25, steps=12)
    after = settle(win)
    result = {"gesture": "back", "priorApp": prior, "visible": visible(after)}
    result.update(diff_screens(before, after))
`,
  },
  ios_scroll: {
    timeoutMs: 45_000,
    python: `    win, before, prior = ready_to_send()
    still_there(win)
    _mirror.scroll_wheel(-p["amount"], win["x"] + win["w"] / 2.0,
                         win["y"] + win["h"] / 2.0)
    after = settle(win)
    result = {"amount": p["amount"], "priorApp": prior,
              "visible": visible(after)}
    result.update(diff_screens(before, after))
`,
  },
  ios_home: {
    timeoutMs: 45_000,
    python: `    win, before, prior = ready_to_send()
    still_there(win)
    _mirror.press("cmd+1")
    after = settle(win)
    result = {"priorApp": prior, "visible": visible(after)}
    result.update(diff_screens(before, after))
`,
  },
  /*
   * Not an action type: internal, never advertised to the planner and never
   * reachable from a plan. It hands the screen back to whoever had it before
   * the phone run started.
   */
  ios_restore_focus: {
    internal: true,
    timeoutMs: 20_000,
    python: `    apps = NSRunningApplication.runningApplicationsWithBundleIdentifier_(
        p["bundleId"])
    if apps:
        apps[0].activateWithOptions_(1 << 1)
        result = {"restored": p["bundleId"]}
    else:
        result = {"restored": None}
`,
  },
}

/**
 * The action types this module dispatches. Derived, never typed twice.
 * Internal operations are excluded: nothing advertises or plans them.
 */
export const IOS_ACTION_TYPES = Object.freeze(
  Object.entries(OPERATIONS)
    .filter(([, op]) => !op.internal)
    .map(([type]) => type)
    .sort(),
)

/** The exact program that would be sent for an action. Exported for the test. */
export function buildProgram(type) {
  const op = OPERATIONS[String(type ?? '')]
  if (!op) throw new Error(`Unsupported iPhone action type: ${type}`)
  return PROGRAM_PROLOGUE + op.python + PROGRAM_EPILOGUE
}

const finite = (value, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), high)

function requiredString(value, message) {
  const text = typeof value === 'string' ? value : ''
  if (!text.trim()) throw new Error(message)
  return text
}

/*
 * Params, normalised to the exact shapes the programs index by key.
 *
 * Numbers are coerced and clamped HERE rather than in Python so that a
 * nonsense value fails as a validation error the owner can read, instead of a
 * ValueError traceback from inside a helper. Strings are passed through
 * untouched — they are data, and sanitising them would only create the
 * illusion that the safety comes from the sanitising.
 */
function paramsFor(action) {
  const type = String(action?.type ?? '')
  const params = action?.params ?? {}

  switch (type) {
    case 'ios_status':
      return {}
    case 'ios_ocr':
      return {
        minConfidence: clamp(finite(params.minConfidence, 0.3), 0, 1),
        limit: Math.round(clamp(finite(params.limit, 120), 1, 500)),
      }
    case 'ios_screenshot':
      return { path: screenshotDestination(params.path) }
    case 'ios_open_app':
      return {
        name: requiredString(
          params.name ?? params.appName ?? params.app,
          'ios_open_app requires the app name to open on the iPhone.',
        ),
      }
    case 'ios_tap_text':
      return {
        query: requiredString(
          params.query ?? params.text ?? params.label,
          'ios_tap_text requires the on-screen text to tap.',
        ),
        index: Math.round(clamp(finite(params.index, 0), 0, 50)),
        exact: params.exact === true,
      }
    case 'ios_type_text':
      return {
        text: requiredString(
          params.text ?? params.value,
          'ios_type_text requires the text to type.',
        ),
      }
    case 'ios_swipe': {
      const direction = String(params.direction ?? '').toLowerCase()
      if (!['up', 'down', 'left', 'right'].includes(direction)) {
        throw new Error(
          'ios_swipe requires direction up, down, left, or right.',
        )
      }
      return {
        direction,
        distance: clamp(finite(params.distance, 0.4), 0.05, 0.9),
      }
    }
    case 'ios_scroll': {
      /* `direction` is the courtesy spelling; the helper takes a signed
       * amount, where positive scrolls content the way a two-finger swipe up
       * does. */
      const direction = String(params.direction ?? '').toLowerCase()
      const amount = Math.round(clamp(finite(params.amount, 300), -3000, 3000))
      if (direction === 'up') return { amount: -Math.abs(amount) }
      if (direction === 'down') return { amount: Math.abs(amount) }
      return { amount }
    }
    case 'ios_home':
    case 'ios_back':
      return {}
    case 'ios_restore_focus':
      return {
        bundleId: requiredString(
          params.bundleId,
          'ios_restore_focus needs the bundle id to hand the screen back to.',
        ),
      }
    default:
      throw new Error(`Unsupported iPhone action type: ${type}`)
  }
}

/* Screenshots land in the workspace, next to every other artefact the agent
 * produces, unless the caller named somewhere else. */
function screenshotDestination(requested) {
  const asked = String(requested ?? '').trim()
  const destination = asked
    ? resolveUserPath(asked)
    : path.join(
        workspacePath,
        'iphone-screenshots',
        `iphone-${Date.now()}.png`,
      )
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  return destination
}

function timeoutFor(action) {
  const op = OPERATIONS[String(action?.type ?? '')]
  const requested = Number(action?.params?.timeout)
  if (Number.isFinite(requested) && requested > 0) {
    return clamp(requested, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  }
  return op?.timeoutMs ?? 45_000
}

/*
 * The connection failures, told apart by what the program actually says.
 *
 * The first two patterns also match phone-harness's own wording, because a
 * helper called underneath can still raise its version of the same complaint.
 * An unmatched failure falls through and is reported verbatim rather than
 * being relabelled as a connection problem it may not be.
 */
const NO_WINDOW_MESSAGE =
  'iPhone Mirroring has no open window — open the iPhone Mirroring app and leave the window visible.'
const BLOCKED_MESSAGE =
  'iPhone Mirroring is showing a Connect / "iPhone in Use" screen. Open iPhone Mirroring and connect the phone — and if it says "iPhone in Use", lock the iPhone so mirroring can resume. I will not tap Connect for you.'
/*
 * The abort that matters most. A write asked for the window to be brought
 * forward, it did not demonstrably arrive, and so nothing at all was sent —
 * because a tap posted at that moment would have clicked the owner's real
 * desktop rather than their phone. The message leads with what did NOT happen.
 */
const NOT_FRONTMOST_MESSAGE =
  'Nothing was sent to the iPhone: iPhone Mirroring could not be brought to the front, and a tap or keystroke posted while it is on another Space lands on whatever else is on screen. Bring the iPhone Mirroring window to the current Space and try again.'

function connectionProblem(text) {
  const message = String(text ?? '')
  if (/iPhone in Use|showing a connect|connect \/ 'iPhone in Use'/i.test(message)) {
    return { reason: 'ios-mirroring-blocked', message: BLOCKED_MESSAGE }
  }
  if (
    /could not be brought to the front|moved while it was being brought forward|could not see the phone screen before acting/i.test(
      message,
    )
  ) {
    return { reason: 'ios-window-not-frontmost', message: NOT_FRONTMOST_MESSAGE }
  }
  if (
    /has no (phone|open) window|no phone is connected|isn'?t running|is not running/i.test(
      message,
    )
  ) {
    return { reason: 'ios-mirroring-window-missing', message: NO_WINDOW_MESSAGE }
  }
  return null
}

/** The same problem, from an ios_status state rather than an exception. */
function connectionProblemForState(state) {
  if (state === 'no-window' || state === 'not-running') {
    return { reason: 'ios-mirroring-window-missing', message: NO_WINDOW_MESSAGE }
  }
  if (state === 'blocked') {
    return { reason: 'ios-mirroring-blocked', message: BLOCKED_MESSAGE }
  }
  return null
}

/*
 * The result line, pulled out of stdout.
 *
 * indexOf, not lastIndexOf: the marker is written exactly once, at the very
 * end, and anything that looks like a second one can only be inside the JSON
 * payload — a param the program echoed back, which is data and must not be
 * allowed to redirect the parse.
 */
function parseHarnessOutput(stdout) {
  const text = String(stdout ?? '')
  const at = text.indexOf(RESULT_MARKER)
  if (at === -1) return null
  const start = at + RESULT_MARKER.length
  const end = text.indexOf('\n', start)
  const line = end === -1 ? text.slice(start) : text.slice(start, end)
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** stdout with our result line removed, so the message is only the program's. */
function stdoutWithoutResult(stdout) {
  const text = String(stdout ?? '')
  const at = text.indexOf(RESULT_MARKER)
  return (at === -1 ? text : text.slice(0, at)).trim()
}

function runHarness({ program, params, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const binary = harnessBinaryPath()
    let child

    try {
      child = spawn(binary, [], {
        /* Its own process group, so a timeout kills the python and anything it
         * started rather than orphaning them. */
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        /*
         * childEnv strips the agent's own credentials — the relay key, the
         * agent token, the session secret — from everything it spawns. PATH,
         * HOME and TMPDIR survive, and PH_PARAMS is merged in explicitly at
         * this one call site, which is the whole point of `extra`: passing a
         * value to a child is a decision someone can see, not an inheritance
         * nobody chose.
         */
        env: childEnv({ extra: { PH_PARAMS: JSON.stringify(params ?? {}) } }),
      })
    } catch (error) {
      reject(error)
      return
    }

    const chunks = { stdout: [], stderr: [] }
    let timedOut = false
    let cancelled = false
    let settled = false
    let escalation = null

    const collect = (stream, name) => {
      stream?.on('data', (chunk) => chunks[name].push(chunk))
      stream?.on('error', () => {})
    }
    collect(child.stdout, 'stdout')
    collect(child.stderr, 'stderr')

    const killGroup = (which) => {
      try {
        process.kill(-child.pid, which)
      } catch {
        try {
          child.kill(which)
        } catch {
          // Already gone.
        }
      }
    }

    const stop = () => {
      killGroup('SIGTERM')
      if (escalation) return
      escalation = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      escalation.unref?.()
    }

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            stop()
          }, timeoutMs)
        : null
    timer?.unref?.()

    const onAbort = () => {
      cancelled = true
      stop()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      signal?.removeEventListener?.('abort', onAbort)
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })

    child.on('close', (code, closeSignal) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        exitCode: code,
        signal: closeSignal ?? null,
        timedOut,
        cancelled,
        durationMs: Date.now() - startedAt,
      })
    })

    child.stdin?.on('error', () => {})
    child.stdin?.end(program)
  })
}

function describeSuccess(type, result) {
  switch (type) {
    case 'ios_status': {
      const state = result?.state
      const window = result?.window
      const where = window
        ? ` (window ${Math.round(window.w)}x${Math.round(window.h)} at ${Math.round(window.x)},${Math.round(window.y)})`
        : ''
      if (state === 'ready') {
        return `iPhone Mirroring is connected, on screen and ready${where}.`
      }
      /* Readable but on another Space. This is the common case for an owner who
       * runs apps fullscreen, and it is NOT a fault: reads work as they are,
       * and a write will bring the window forward first. */
      if (state === 'off-space') {
        return `The iPhone is connected and readable, but its window is on another Space${where}, so reads work while taps and typing will first bring iPhone Mirroring to the front.`
      }
      if (state === 'unreadable') {
        return `The iPhone Mirroring window is there but could not be read: ${result?.detail ?? 'no detail'}.`
      }
      return connectionProblemForState(state)?.message ?? `iPhone Mirroring state: ${state}.`
    }
    case 'ios_ocr':
      return `Read ${result?.count ?? 0} text items off the iPhone screen${result?.onScreen === false ? ' (window is on another Space; nothing was activated)' : ''}.`
    case 'ios_screenshot':
      return `Captured the iPhone screen to ${result?.path}.`
    case 'ios_open_app':
      return `Opened ${result?.opened} on the iPhone.${changeNote(result)}`
    case 'ios_tap_text':
      return `Tapped "${result?.tapped?.text}" on the iPhone at ${result?.tapped?.x},${result?.tapped?.y}.${changeNote(result)}`
    case 'ios_type_text':
      return `Typed ${result?.typed} characters into the focused iPhone field.${changeNote(result)}`
    case 'ios_swipe':
      return `Swiped ${result?.direction} on the iPhone.${changeNote(result)}`
    case 'ios_scroll':
      return `Scrolled the iPhone screen.${changeNote(result)}`
    case 'ios_back':
      return `Swiped back on the iPhone.${changeNote(result)}`
    case 'ios_home':
      return `Went to the iPhone Home Screen.${changeNote(result)}`
    default:
      return 'iPhone action completed.'
  }
}

/*
 * What the screen did about it.
 *
 * "changed: false" is the single most useful thing a phone action can say. The
 * label matched, the touch landed a few points off the control, and without
 * this the agent walks confidently down a path that never opened.
 */
function changeNote(result) {
  if (result?.changed === true) {
    const appeared = (result.appeared ?? []).slice(0, 4)
    return appeared.length
      ? ` The screen changed; now showing ${appeared.map((text) => `"${text}"`).join(', ')}.`
      : ' The screen changed.'
  }
  if (result?.changed === false) {
    return ' The screen did NOT change — the touch may have missed, so check before assuming it worked.'
  }
  return ''
}

const failed = (action, message, extra = {}) => ({
  action,
  ok: false,
  status: 'failed',
  message,
  ...extra,
})

/**
 * Run one ios_* action on the owner's real iPhone.
 *
 * Returns computerControl's handler shape: `{ action, ok, status, message }`
 * plus whatever the action produced. A malformed action THROWS (the caller
 * asked for something incoherent); a run that reached the phone and failed
 * RETURNS ok:false carrying the harness's own stderr, because the evidence is
 * the point — "the window is closed" and "the text was not on screen" are
 * different problems with different fixes and must not collapse into one
 * message.
 */
export async function runIosAction(action) {
  const type = String(action?.type ?? '')
  const op = OPERATIONS[type]
  if (!op || op.internal) {
    throw new Error(`Unsupported iPhone action type: ${type}`)
  }
  return runOperation(action)
}

async function runOperation(action) {
  const type = String(action?.type ?? '')
  const op = OPERATIONS[type]

  const params = paramsFor(action)
  const program = buildProgram(type)
  const timeoutMs = timeoutFor(action)
  const signal = currentCancellationSignal()
  throwIfAborted(signal, 'Cancelled before the iPhone action started.')

  const harness = { binary: harnessBinaryPath(), timeoutMs }

  let run
  /* Counted so the focus hand-back can tell "the run is over" from "we are
   * between two taps of the same run". Internal ops do not count: the restore
   * itself must not look like phone activity and re-arm its own timer. */
  const counted = !op.internal
  if (counted) focusLease.inFlight += 1
  try {
    run = await runHarness({ program, params, timeoutMs, signal })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return failed(
        action,
        `phone-harness is not installed at ${harness.binary}. Install it (or set PHONE_HARNESS_BIN) before driving the iPhone.`,
        { reason: 'ios-harness-missing', harness },
      )
    }
    return failed(action, `Could not start phone-harness: ${error?.message ?? error}`, {
      reason: 'ios-harness-spawn-failed',
      harness,
    })
  } finally {
    /* Everything below here is synchronous, so the count is released only once
     * this action is genuinely done with the phone. */
    if (counted) focusLease.inFlight = Math.max(0, focusLease.inFlight - 1)
  }

  const stderr = run.stderr.trim()
  const payload = parseHarnessOutput(run.stdout)
  const stdout = stdoutWithoutResult(run.stdout)
  const evidence = {
    stdout,
    stderr,
    harness: { ...harness, exitCode: run.exitCode, durationMs: run.durationMs },
  }

  if (run.cancelled) {
    return {
      action,
      ok: false,
      status: 'cancelled',
      message:
        'The iPhone action was cancelled. Whatever had already been sent to the phone has already happened — nothing was retried.',
      ...evidence,
      reason: 'ios-cancelled',
    }
  }

  if (run.timedOut) {
    return failed(
      action,
      `The iPhone action did not finish within ${timeoutMs}ms and was stopped. It was NOT retried — check the phone before running it again.`,
      { ...evidence, reason: 'ios-timeout' },
    )
  }

  /* The program's own reported exception, which is the good path for a failure:
   * it carries the harness's exact wording. */
  if (payload?.error) {
    const raw = String(payload.error.message ?? '').trim()
    const problem = connectionProblem(raw)
    if (problem) {
      return failed(action, problem.message, {
        ...evidence,
        reason: problem.reason,
        harnessError: payload.error,
      })
    }
    return failed(action, raw || `phone-harness raised ${payload.error.type}.`, {
      ...evidence,
      reason: 'ios-harness-error',
      harnessError: payload.error,
    })
  }

  if (run.exitCode !== 0 || !payload) {
    /* No structured payload: the interpreter died before our except block, the
     * CLI refused the input, or the binary printed usage. stderr verbatim is
     * the only honest thing to hand back. */
    const problem = connectionProblem(stderr || stdout)
    const detail = stderr || stdout || `exit code ${run.exitCode}`
    return failed(
      action,
      problem ? problem.message : `phone-harness failed: ${detail}`,
      {
        ...evidence,
        reason: problem ? problem.reason : 'ios-harness-failed',
      },
    )
  }

  const result = payload.result ?? {}
  rememberFocus(result.priorApp)

  /*
   * ios_status is a report, not an attempt: "the window is closed" is a
   * successful answer to "what is the state of the phone". It still says so in
   * plain words and flags `ready: false`, so a caller that treats ok as "the
   * phone is usable" is corrected by the very next field.
   */
  return {
    action,
    ok: true,
    status: 'success',
    message: describeSuccess(type, result),
    ...result,
    harness: evidence.harness,
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  }
}

/*
 * GIVING THE SCREEN BACK
 *
 * A write has to bring iPhone Mirroring to the front, and leaving it there
 * after a run means the owner looks up from their laptop to find their work
 * shoved aside. Restoring focus after every single action would be worse: a
 * twelve-tap task would flip the screen twenty-four times.
 *
 * So the restore is debounced. The first write of a run records who had the
 * screen; every later write pushes the timer out; when the phone has been
 * quiet for a few seconds the app that was in front gets it back. Mid-run the
 * mirroring window is already frontmost, so ready_to_send() does not activate
 * again and the run is uninterrupted.
 *
 * Best-effort by design: a failed restore is a cosmetic annoyance, never a
 * reason to fail an action that already happened. The timer is unref'd so it
 * can never hold the process open.
 */
const focusRestoreDelayMs = () =>
  Math.max(Number(process.env.PENDANT_IOS_FOCUS_RESTORE_MS) || 4_000, 100)
const MIRRORING_BUNDLE_ID = 'com.apple.ScreenContinuity'

const focusLease = { bundleId: null, timer: null, lastRestore: null, inFlight: 0 }

function rememberFocus(priorApp) {
  if (process.env.PENDANT_IOS_RESTORE_FOCUS === 'false') return
  const bundleId = String(priorApp?.bundleId ?? '').trim()
  /* Mid-run the "previous" app IS the mirroring window. Overwriting the lease
   * with it would hand the screen back to the phone, which is where it already
   * is, and lose the app the owner actually left. */
  if (bundleId && bundleId !== MIRRORING_BUNDLE_ID) {
    focusLease.bundleId = bundleId
  }
  if (!focusLease.bundleId) return
  armFocusRestore()
}

function armFocusRestore() {
  if (focusLease.timer) clearTimeout(focusLease.timer)
  focusLease.timer = setTimeout(() => {
    focusLease.timer = null
    /*
     * Never while the phone is still being driven. The debounce measures the
     * gap between actions, and a single tap can outlast it — a restore that
     * fired mid-run would pull the screen off the phone between two steps of
     * a sequence, which is both the disruption this is meant to prevent and,
     * worse, a focus change that the next step's own guard would then have to
     * refuse. Re-arm and wait for the run to be genuinely over.
     */
    if (focusLease.inFlight > 0) {
      armFocusRestore()
      return
    }
    const target = focusLease.bundleId
    focusLease.bundleId = null
    if (!target) return
    runOperation({ type: 'ios_restore_focus', params: { bundleId: target } })
      .then((outcome) => {
        focusLease.lastRestore = { bundleId: target, ok: outcome?.ok === true }
      })
      .catch(() => {
        focusLease.lastRestore = { bundleId: target, ok: false }
      })
  }, focusRestoreDelayMs())
  focusLease.timer.unref?.()
}

/** Test seam: what the focus lease is holding, and what it last did. */
export function focusLeaseState() {
  return {
    pending: focusLease.bundleId,
    armed: Boolean(focusLease.timer),
    lastRestore: focusLease.lastRestore,
  }
}
