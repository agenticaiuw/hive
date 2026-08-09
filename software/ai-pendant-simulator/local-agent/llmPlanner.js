import './loadEnv.js'
import os from 'node:os'
import { FULL_CONTROL_MODE } from './config.js'
import {
  formatMachineContextForPrompt,
  getMachineContext,
} from './machineContext.js'
import { stripProtocolTerminators } from '../shared/protocolText.js'
/* The executor's dispatch table is the authority on what can actually run;
 * see isKnownActionType. computerControl does not import this file, so there
 * is no cycle. */
import { SUPPORTED_ACTION_TYPES } from './computerControl.js'
import { CAPABILITY_GAP_ACTIONS } from './capabilityGapsActions.js'
import { assessPlanCoverage } from './goalVerdict.js'

// Mac / browser planning uses OpenAI only (cheap text tier). Pendant voice on
// Cloudflare uses Realtime separately — this process never opens Realtime.
function resolveOpenAiApiKey() {
  const openai = String(process.env.OPENAI_API_KEY || '').trim()
  const llm = String(process.env.LLM_API_KEY || '').trim()
  // Never send OpenRouter keys to api.openai.com.
  if (openai && !openai.startsWith('sk-or-')) return openai
  if (llm && !llm.startsWith('sk-or-')) return llm
  if (openai.startsWith('sk-or-') || llm.startsWith('sk-or-')) {
    console.error(
      '[planner] Ignoring OpenRouter sk-or-v1 key — set OPENAI_API_KEY (sk-proj-…)',
    )
  }
  return ''
}
const LLM_API_KEY = resolveOpenAiApiKey()
const LLM_API_BASE_URL = String(
  process.env.LLM_API_BASE_URL || 'https://api.openai.com/v1',
)
  .trim()
  .replace(/\/$/, '')
const LLM_MODEL = String(process.env.LLM_MODEL || 'gpt-5.6-luna').trim()
// Vision for computer-use screenshots (OpenAI multimodal).
const LLM_VISION_MODEL =
  process.env.LLM_VISION_MODEL || 'gpt-4.1-mini'
/*
 * The cheap tier. Same API, smaller model, and — the part that actually moves
 * the bill — a system prompt built from a trimmed action schema and an
 * apps-only machine block instead of the full brief. Point it anywhere with
 * LLM_BACKGROUND_MODEL; the default is the multimodal small model this repo
 * already talks to, so the cheap tier needs no new credentials.
 *
 * It is also the model that picks tool domains for the full tier — see
 * discoverDomains. Same reasoning: a small judgement on a small prompt.
 *
 * The "26,000-character brief" this used to name is gone. The flat schema is
 * 28,120 characters and no longer ships whole: FULL_CONTROL_ACTION_SCHEMA is
 * now delivered a domain at a time through toolDiscovery.js, and a measured
 * everyday command carries ~1,900 of it. The 42,012-character planner prompt
 * those numbers came from is in llmPlannerDiscovery.test.js, which fails if
 * the drilled-down one stops being a fraction of it.
 */
const LLM_BACKGROUND_MODEL = String(
  process.env.LLM_BACKGROUND_MODEL || 'gpt-4.1-mini',
).trim()
// gpt-5.6-luna (and most OpenAI chat/completions models) reject unknown
// `reasoning`. Never send that field to api.openai.com.
const LLM_REASONING_EFFORT = process.env.LLM_REASONING_EFFORT || 'off'
const LLM_SEND_REASONING =
  !LLM_API_BASE_URL.includes('api.openai.com') &&
  (process.env.LLM_SEND_REASONING === '1' ||
    Boolean(String(process.env.LLM_API_BASE_URL || '').trim()))
const LLM_MAX_TOKENS = Math.min(
  Math.max(Number(process.env.LLM_MAX_TOKENS || 1024), 128),
  4096,
)
const LLM_ENABLED = process.env.LLM_ENABLED !== 'false' && Boolean(LLM_API_KEY)

const FULL_CONTROL_ACTION_SCHEMA = {
  /* The four verbs whose modules were finished but had no way in. This is also
   * what makes isKnownActionType accept them — without it sanitizeActions
   * strips the action out of every plan that names one. */
  ...CAPABILITY_GAP_ACTIONS,
  run_shell: {
    description: 'Run any shell command on the Mac (zsh). Use for installs, git, npm, curl, etc.',
    params: { command: 'string', cwd: 'optional absolute path', timeout: 'optional ms' },
  },
  run_applescript: {
    description: 'Run AppleScript for deep macOS automation.',
    params: { script: 'string' },
  },
  /*
   * Deferred work. These were dispatchable but absent from every schema, so
   * sanitizeActions dropped them from any plan that named one — and the owner
   * heard a confident summary for a briefing that was never made. The
   * capability manifest caught the drift by diffing the two registries.
   */
  research_brief: {
    description:
      'Research a topic on the web and leave a written brief plus an audio version the owner can play later from the pendant. Use when nobody is waiting for the answer now.',
    params: {
      topic: 'string',
      mode: "optional 'brief' (default) or 'deep'",
      maxSources: 'optional number',
    },
  },
  play_briefing: {
    description:
      'Play a briefing that is already waiting. Defaults to the most recent one.',
    params: {
      id: "optional briefing id, or 'latest'",
      onMac: 'optional boolean — play through the Mac speakers instead',
    },
  },
  list_briefings: {
    description: 'List the briefings waiting to be played, newest first.',
    params: { limit: 'optional number, default 20' },
  },
  open_url: {
    description: 'Open any URL in the default browser (shopping, Gmail, docs, etc.).',
    params: { url: 'string' },
  },
  open_app: {
    description: 'Open any installed macOS application by name.',
    params: { appName: 'string' },
  },
  open_path: {
    description: 'Open any file or folder with the default app.',
    params: { path: 'absolute path' },
  },
  write_file: {
    description: 'Create or overwrite a file anywhere the user can write.',
    params: { path: 'absolute path', content: 'string', append: 'optional boolean' },
  },
  read_file: {
    description: 'Read a text file from disk.',
    params: { path: 'absolute path', maxBytes: 'optional number' },
  },
  list_directory: {
    description: 'List files in a folder.',
    params: { path: 'absolute path', recursive: 'optional boolean' },
  },
  delete_path: {
    description: 'Delete a file or folder.',
    params: { path: 'absolute path' },
  },
  copy_path: {
    description: 'Copy a file or folder.',
    params: { from: 'absolute path', to: 'absolute path' },
  },
  move_path: {
    description: 'Move or rename a file or folder.',
    params: { from: 'absolute path', to: 'absolute path' },
  },
  type_text: {
    description:
      'Type text into the frontmost application. Layout independent and unicode safe (emoji, CJK, newlines).',
    params: { text: 'string', perCharDelayMs: 'optional pacing in ms' },
  },
  press_keys: {
    description:
      'Press a keyboard shortcut in the frontmost app. Supports cmd/ctrl/alt/shift/fn plus arrows, function keys, page up/down, home/end and forward delete.',
    params: {
      keys: 'string like cmd+c, cmd+shift+p, enter, pageup, ctrl+alt+left, f5',
      repeat: 'optional number of repeats',
    },
  },
  set_brightness: {
    description:
      'Set Mac display brightness. Use this for ANY brightness request. Level can be 0-1 or 0-100.',
    params: { level: 'number (0-1 or 0-100)' },
  },
  get_brightness: {
    description: 'Read the current Mac display brightness.',
    params: {},
  },
  set_volume: {
    description:
      'Set Mac output volume. Use this for ANY volume request. Level can be 0-100.',
    params: { level: 'number 0-100' },
  },
  get_volume: {
    description: 'Read the current Mac output volume and mute state.',
    params: {},
  },
  set_mute: {
    description: 'Mute or unmute Mac output volume.',
    params: { muted: 'boolean' },
  },
  /*
   * The executor and the pendant's hands-free allowlist have supported these
   * since status tools existed, but the schema never mentioned them — so the
   * planner answered "what's my battery" with run_shell pmset instead. Naming
   * them here is what makes the structured tool reachable, and it lets an
   * escalated request produce the same action the deterministic tier would.
   */
  get_mac_status: {
    description:
      'Read Mac status through structured tools instead of shell. Prefer this for battery, wifi/network or volume questions.',
    params: {
      fields: 'optional array of battery | wifi | volume | all (default all)',
    },
  },
  get_battery: {
    description: 'Read battery charge and whether the Mac is on power.',
    params: {},
  },
  create_reminder: {
    description:
      'Create an item in Apple Reminders. Use this for ANY reminder request. Never use run_shell or raw AppleScript for reminders.',
    params: {
      title: 'string',
      due: 'optional natural date/time like "tonight at 9pm" or ISO string',
      notes: 'optional string',
      list: 'optional Reminders list name',
    },
  },
  show_screen_overlay: {
    description:
      'Cover part of the screen with a black always-on-top overlay (Esc/click to dismiss). Use for ANY darken/cover screen request. Never use run_shell/python/tkinter. For "top 80%" set region=top and percent=80 (or fraction=0.8).',
    params: {
      region: 'left | right | top | bottom | full',
      percent: 'optional 1-100 coverage of that region (e.g. 80 for top 80%)',
      fraction: 'optional 0-1 coverage (alternative to percent)',
      color: 'optional color name, default black',
      opacity: 'optional 0.2-1',
    },
  },
  send_email: {
    description: 'Send or draft an email through Mail.app.',
    params: {
      to: 'email address',
      subject: 'string',
      body: 'string',
      send: 'boolean, default true',
    },
  },
  screenshot: {
    description:
      'Capture the screen. Returns a downscaled image plus the display size in points, the image size in pixels, and the points-per-image-pixel ratio needed to turn image coordinates back into clickable screen coordinates.',
    params: {
      scope: 'optional display|window|region',
      display: 'optional 1-based display number',
      region: 'optional {x, y, w, h} in screen points',
      maxWidth: 'optional downscale width, default 1456',
      path: 'optional absolute path to also save a durable copy',
    },
  },
  zoom: {
    description:
      'Capture one region of the screen at native resolution to read small text without paying for a full frame.',
    params: { region: '{x, y, w, h} in screen points', maxWidth: 'optional, default 1024' },
  },
  // --- Accessibility tier: prefer these over pixel clicking. They resolve a
  // control by NAME, so they are layout independent, cost no image tokens, and
  // record what was actually clicked.
  ui_snapshot: {
    description:
      'List the actionable accessibility elements of an app, with on-screen frames in points. Try this before any screenshot.',
    params: { app: 'optional app name, default frontmost', maxElements: 'optional number' },
  },
  ui_find: {
    description: 'Find one named control in an app without acting on it.',
    params: { app: 'optional', title: 'exact title', titleContains: 'substring', nth: 'optional index' },
  },
  ui_click: {
    description:
      'Press a named control via the accessibility API, falling back to a click at its centre. Preferred over mouse_click.',
    params: { app: 'optional', ref: 'ref from ui_snapshot', title: 'or exact title', titleContains: 'or substring' },
  },
  ui_menu: {
    description:
      'Choose an app menu item by path, e.g. ["File","Export As","PDF…"]. Never click menus by coordinate.',
    params: { app: 'app name', path: 'array of menu titles' },
  },
  ui_wait_for: {
    description: 'Poll until a named control appears. Use instead of sleeping.',
    params: { app: 'optional', title: 'or titleContains', timeoutMs: 'optional, default 5000' },
  },
  ui_hit_test: {
    description: 'Report which named control is under a screen point.',
    params: { x: 'number in points', y: 'number in points' },
  },
  // --- Pixel tier: only when the accessibility tree does not expose the control.
  mouse_move: {
    description: 'Move the pointer to a screen point (points, top-left origin).',
    params: { x: 'number', y: 'number' },
  },
  mouse_click: {
    description: 'Click at a screen point.',
    params: {
      x: 'number',
      y: 'number',
      button: 'optional left|right|middle',
      clicks: 'optional 1-3',
      modifiers: 'optional array like ["cmd","shift"]',
    },
  },
  mouse_double_click: {
    description: 'Double-click at a screen point.',
    params: { x: 'number', y: 'number' },
  },
  mouse_right_click: {
    description: 'Right-click at a screen point to open a context menu.',
    params: { x: 'number', y: 'number' },
  },
  mouse_drag: {
    description: 'Press, drag along an interpolated path, and release.',
    params: { fromX: 'number', fromY: 'number', toX: 'number', toY: 'number', button: 'optional', steps: 'optional' },
  },
  mouse_down: {
    description: 'Press and hold a mouse button at a point.',
    params: { x: 'number', y: 'number', button: 'optional' },
  },
  mouse_up: {
    description: 'Release a held mouse button at a point.',
    params: { x: 'number', y: 'number', button: 'optional' },
  },
  scroll: {
    description: 'Scroll the view under the pointer. Positive dy scrolls up.',
    params: { x: 'optional number', y: 'optional number', dx: 'optional number', dy: 'optional number' },
  },
  cursor_position: {
    description: 'Report where the pointer currently is.',
    params: {},
  },
  list_displays: {
    description: 'List displays with their point origins, sizes and backing scale factors.',
    params: {},
  },
  computer_use_task: {
    description:
      'Hand a goal to the bounded perceive-act loop: the agent looks at the screen, acts, looks again, and repeats until done or until its step/time budget runs out. Use this when the task needs several dependent UI steps whose outcome cannot be predicted in advance. Shell, file and mail actions are NOT available inside the loop.',
    params: {
      goal: 'what to accomplish, in one sentence',
      app: 'optional app to focus on',
      maxSteps: 'optional, default 25',
      budgetMs: 'optional wall-clock budget',
    },
  },
  get_clipboard: {
    description: 'Read the current clipboard text.',
    params: {},
  },
  copy_to_clipboard: {
    description: 'Copy text to the clipboard.',
    params: { text: 'string' },
  },
  create_note: {
    description: 'Create a note file and open it.',
    params: { filename: 'string', content: 'string', directory: 'optional path' },
  },
  compose_briefing: {
    description:
      "Read the owner's calendar, unread mail, recent files or notes and leave a short spoken brief plus a note on the Mac. Use for any 'brief me' / 'prepare my workday' / 'what did I miss in email' / 'read my schedule' / 'summarize today's notes into next actions' request. It composes and stores only — it never sends anything.",
    params: {
      kind: 'one of: morning, workday, wrapup, mail, schedule',
    },
  },
  triage_inbox: {
    description:
      "Classify the owner's unread mail into urgent / reply soon / reference / noise, draft replies for the first two categories, and leave a reviewable list plus the draft files on the Mac. Use for 'triage my inbox', 'turn my unread mail into a priority list', 'classify my unread mail', 'draft replies for the top three'. It NEVER sends: the drafts are files the owner sends themselves. Do not add a send_email action alongside it.",
    params: {
      sinceHours: 'optional lookback in hours, default 72',
      maxDrafts:
        'optional cap on drafted replies; pass 3 when the owner said "the top three"',
    },
  },
  meeting_followup: {
    description:
      "After a meeting ends: open the meeting notes, write a DRAFT summary file with the attendees and the action items quoted out of those notes, and list the unread mail that belongs to that meeting. Use for 'after my meeting', 'meeting follow-up', 'write up that meeting'. For work BEFORE a meeting starts use prepare_for_meeting instead. It never sends the summary to anyone.",
    params: {
      lookbackHours: 'optional, how far back to look for the meeting, default 6',
      open: 'optional false to write the workspace without bringing files forward',
    },
  },
  run_project: {
    description: 'Start a long-running command in a project folder.',
    params: { path: 'absolute path', command: 'optional shell command' },
  },
  search_file: {
    description: 'Search for files by name under a folder.',
    params: { root: 'absolute path', query: 'string' },
  },
  play_youtube: {
    description:
      'Play a song or video on YouTube when the user wants music/video playback. Prefer this over opening a YouTube search URL.',
    params: { query: 'string song or video search query' },
  },
  get_weather: {
    description:
      'Fetch current weather for a location. Use for ANY weather/rain/forecast question. Do not open YouTube or a browser for weather.',
    params: { location: 'optional city/region string' },
  },
  get_time: {
    description:
      'Return the current local date and time. Use for clock/time/date questions.',
    params: {},
  },
  translate_text: {
    description: 'Translate text to a target language.',
    params: {
      text: 'string to translate',
      targetLang: 'optional language code or name like ko, en, korean',
    },
  },
  set_input_source: {
    description:
      'Switch the Mac typing/keyboard language (Arabic, Korean, English/U.S., Japanese, etc.). Enables the layout if needed. Never use raw System Events keycodes for this.',
    params: { language: 'string like Arabic, Korean, English, Japanese' },
  },
  get_input_source: {
    description: 'Read the current Mac typing/keyboard language.',
    params: {},
  },
  browser_list_tabs: {
    description:
      'List open web tabs (title, url, tabId) in the user browser profile. Prefer before guessing which tab is active.',
    params: { limit: 'optional number' },
  },
  browser_snapshot: {
    description:
      'Structured interactive-element snapshot of a tab (refs, roles, names, selectors). Prefer this over desktop screenshots for web work. Then click/type using ref or selector.',
    params: {
      tabId: 'optional',
      urlContains: 'optional',
      maxElements: 'optional number',
    },
  },
  browser_navigate: {
    description:
      'Open a URL in the user browser via the extension (real cookies/session). Prefer over open_url when the extension is online.',
    params: {
      url: 'string',
      newTab: 'optional boolean',
      tabId: 'optional',
      session: 'optional session name to stay on the same tab',
    },
  },
  browser_click: {
    description:
      'Click an element in a browser tab. Prefer ref from browser_snapshot; selector also works.',
    params: {
      ref: 'optional snapshot ref e.g. e3',
      selector: 'optional CSS selector',
      tabId: 'optional',
      session: 'optional session name to stay on the same tab',
    },
  },
  browser_type: {
    description: 'Type into an input in a browser tab (ref or selector).',
    params: {
      ref: 'optional',
      selector: 'optional',
      text: 'string',
      submit: 'optional boolean',
      tabId: 'optional',
      session: 'optional session name to stay on the same tab',
    },
  },
  browser_select: {
    description: 'Choose an option in a <select> (ref or selector).',
    params: {
      ref: 'optional',
      selector: 'optional',
      value: 'optional',
      label: 'optional',
      tabId: 'optional',
      session: 'optional session name to stay on the same tab',
    },
  },
  browser_read_page: {
    description:
      'Read page content. Modes: text, main_text, forms, landmarks, html. Prefer main_text or forms over html.',
    params: {
      mode: 'text|main_text|forms|landmarks|html',
      selector: 'optional',
      ref: 'optional',
      maxChars: 'optional',
      tabId: 'optional',
      session: 'optional session name to stay on the same tab',
    },
  },
  browser_wait_for: {
    description: 'Wait until a selector is visible or text appears on the page.',
    params: {
      selector: 'optional',
      textContains: 'optional',
      timeoutMs: 'optional',
      tabId: 'optional',
      session: 'optional session name to stay on the same tab',
    },
  },
  browser_scroll: {
    description: 'Scroll to an element (ref/selector) or by dy/dx pixels.',
    params: {
      ref: 'optional',
      selector: 'optional',
      dy: 'optional',
      dx: 'optional',
      tabId: 'optional',
      session: 'optional session name to stay on the same tab',
    },
  },
  browser_press_key: {
    description: 'Dispatch a key (e.g. Enter, Escape) on the focused element or a target.',
    params: {
      key: 'string',
      ref: 'optional',
      selector: 'optional',
      tabId: 'optional',
      session: 'optional session name to stay on the same tab',
    },
  },
  browser_capture: {
    description:
      'PNG of the visible browser tab only. Use only when structured snapshot is insufficient (canvas/charts). Do not send to cloud by default.',
    params: {
      tabId: 'optional',
      urlContains: 'optional',
      session: 'optional session name to stay on the same tab',
    },
  },
  browser_open_session: {
    description:
      'Claim a browser tab under a name you choose, opening one if nothing is open. Pass that same session on every later browser_* action to keep acting on the same page.',
    params: {
      session: 'name you pick, e.g. checkout',
      url: 'optional URL to open',
      urlContains: 'optional substring of an already-open tab to adopt',
      tabId: 'optional, unreliable in Safari — prefer urlContains',
    },
  },
  browser_list_sessions: {
    description: 'List named browser sessions and the tab each one points at.',
    params: {},
  },
  browser_close_session: {
    description:
      'Forget a named browser session. The tab stays open; only the name is released.',
    params: { session: 'session name' },
  },
  /*
   * The two-phase pair, described here so the model can reach them when the
   * owner asks for a look first. Neither replaces the direct actions: when the
   * ask is "click the download link", browser_click is still the right answer
   * and still runs immediately.
   */
  browser_inspect: {
    description:
      'Read a page and report what it says with quotes and citations, plus ONE proposed next step — without clicking or typing anything. Use when the owner wants to know what is on a page, or asked to see what you would do before you do it.',
    params: {
      url: 'string',
      goal: 'what the owner is trying to do, in their words — drives the proposed step',
      look: 'optional array of exact strings to find and quote',
      maxChars: 'optional',
    },
  },
  browser_inspect_act: {
    description:
      'Run the step a browser_inspect proposed, on the element it described. Only usable with an inspectionId from browser_inspect.',
    params: {
      inspectionId: 'from browser_inspect',
      text: 'required only when the proposal types into a field',
    },
  },
  sweep_folder_preview: {
    description:
      'Look at a folder (Downloads, Desktop) and report what a clean-up would do: half-finished downloads, byte-identical duplicates, stale installers, old files, screenshots. Moves and deletes nothing; returns a plan id. Use for "clean up my Downloads/Desktop", "what can I get rid of", "show me what you would move".',
    params: {
      directory: 'optional absolute path, defaults to ~/Downloads',
      staleDays: 'optional, default 90',
      installerStaleDays: 'optional, default 30',
    },
  },
  sweep_folder_apply: {
    description:
      'Carry out a sweep_folder_preview plan exactly as previewed. Needs the planId from the preview; pass `only` with item ids to do just some of them.',
    params: {
      planId: 'from sweep_folder_preview',
      only: 'optional array of item ids from the preview',
    },
  },
  sweep_folder_undo: {
    description: 'Put back the files a sweep_folder_apply moved or deleted.',
    params: { planId: 'from sweep_folder_preview' },
  },
  /*
   * The iPhone family.
   *
   * These do not simulate a phone and they are not a sandbox: they drive the
   * owner's REAL iPhone through the Mac's iPhone Mirroring window, with
   * screenshots plus OCR for eyes and synthesized touches for hands. Whatever
   * happens on that screen happens on the phone in their pocket.
   *
   * Tapping, typing and swiping are ordinary steps here, exactly like the
   * Mac's own ui_click and type_text: a real phone task is a dozen touches and
   * stopping to ask before each one would not be an agent. What the model owes
   * in exchange is the loop the descriptions keep repeating — READ the screen,
   * act on text you have just seen, then CHECK the `changed` field to find out
   * whether anything actually happened. OCR reads text, not meaning; a label
   * can match while the touch lands on nothing.
   *
   * Anything irreversible or outward-facing (paying, ordering, sending,
   * deleting, passwords, card numbers) is held for the owner's approval
   * automatically — plan it anyway, and it will be surfaced rather than
   * silently dropped.
   *
   * READING THE PHONE IS FREE, and so is ios_home: both reach the mirroring
   * window wherever it is, without switching the owner's Space or taking their
   * focus, so checking something on the phone while the owner works costs them
   * nothing. Tapping, typing, swiping and opening an app are different — they
   * briefly bring the mirroring window to the front and then hand the screen
   * back. Prefer reading, and prefer ios_home over a tap when either will do.
   *
   * THE PHONE IS SHARED, so any step can be interrupted at any moment. The
   * owner picking up their iPhone pauses mirroring, and their Mac locking
   * takes the screen away entirely. Neither is a fault and neither means the
   * task was wrong: they are reported as `ios-mirroring-paused` and
   * `ios-mac-locked`, they resolve by themselves, and the right response is to
   * say so and offer to continue later — never to retry in a loop, and never
   * to report the task as failed.
   *
   * Prefer the Mac or the web when the task can be done there — this is for
   * what genuinely needs the phone: iOS-only apps, things tied to the owner's
   * phone number, checking how something looks on the device.
   */
  ios_status: {
    description:
      "Check whether the owner's real iPhone is reachable through iPhone Mirroring. Reads only, and the honest preflight: it answers `readsPossible`, `pointerWritesPossible`, `writeMechanism` and `pointerWritesNeedActivation` before anything is attempted. States: ready (with the window visible, tapping and typing now run WITHOUT taking the owner's screen — writeMechanism 'targeted-active') | off-space (window is on another macOS Space — reading, ios_home and ios_app_switcher work as-is, everything else must bring the window forward) | paused (the owner is holding their phone; resumes by itself when they lock it) | mac-login (iPhone Mirroring is asking for the owner's MAC password before it will reconnect — only they can answer it, so stop and say so; never send keystrokes at it) | mac-locked (the Mac's screen is locked, so the phone can be neither read nor driven) | blocked | no-window | not-running. Call this first when unsure, and when a phone step reports paused, mac-login or mac-locked — those are normal, not failures.",
    params: {},
  },
  ios_ocr: {
    description:
      "Read every piece of text currently visible on the owner's real iPhone screen, each with a tap-ready x/y centre. Reads only, changes nothing, and never steals the owner's focus or switches their Space. This is the element tree for the phone — call it before tapping so you tap text you have actually seen.",
    params: {
      limit: 'optional max items, default 120',
      minConfidence: 'optional 0-1, default 0.3',
    },
  },
  ios_screenshot: {
    description:
      "Capture a PNG of the owner's real iPhone screen to a file and return the path. Reads only. Use for unlabelled icons and layout questions; prefer ios_ocr when the thing you need has a text label.",
    params: { path: 'optional absolute path; defaults into the workspace' },
  },
  ios_open_app: {
    description:
      "Open an app on the owner's REAL iPhone via Spotlight. The normal way to start a phone task. It types the name, so it briefly brings the mirroring window to the front and then hands the screen back. Check `changed` and the visible text afterwards: Spotlight opens on whatever Siri suggests, so confirm the app you asked for is the one that opened.",
    params: { name: 'app name as it appears on the iPhone, e.g. Notes' },
  },
  ios_tap_text: {
    description:
      "Tap on-screen text on the owner's REAL iPhone — the main way to drive it. Tap only text you have just read with ios_ocr; the result tells you what was tapped, where, and whether the screen `changed`. If changed is false the touch missed, so re-read and try a different label rather than repeating the same tap. Never repeat a tap just because it seemed not to work: on a real phone the second one may be a second order.",
    params: {
      query: 'the visible text to tap (substring match unless exact)',
      index: 'optional 0-based match to use when several match',
      exact: 'optional boolean for exact-text match',
    },
  },
  ios_type_text: {
    description:
      "Type into whatever text field is already focused on the owner's REAL iPhone. Tap the field first and confirm the keyboard is up. A newline presses return, which in a search or message field submits — leave it out unless you mean to submit. Only US-keyboard characters can be typed; emoji cannot. Say which field you are typing into so a password or payment field can be recognised.",
    params: {
      text: 'the literal text to type',
      field: "optional: the field's on-screen label, e.g. Search, Password",
    },
  },
  ios_swipe: {
    description:
      "Flick the owner's REAL iPhone screen — page a Home Screen, dismiss a card, move a carousel. Use ios_scroll for long lists instead.",
    params: {
      direction: 'up | down | left | right (finger motion)',
      distance: 'optional 0.05-0.9 fraction of the screen, default 0.4',
    },
  },
  ios_scroll: {
    description:
      "Scroll a list on the owner's REAL iPhone. Reports whether the screen changed, so a list already at its end is visible rather than looping.",
    params: {
      direction: 'optional up | down',
      amount: 'optional pixels, default 300; negative scrolls the other way',
    },
  },
  ios_back: {
    description:
      "Go back one screen on the owner's REAL iPhone with the left-edge swipe gesture. Most apps support it; the result reports whether the screen `changed`, and ios_home is the guaranteed way out when it did not.",
    params: {},
  },
  ios_home: {
    description:
      "Go to the Home Screen on the owner's REAL iPhone. The cheapest action there is: it reaches the phone without bringing the mirroring window forward or taking the owner's focus, so it works while they are using their Mac. Always works, and is the way out of an app without tapping anything inside it.",
    params: {},
  },
  ios_app_switcher: {
    description:
      "Open the App Switcher on the owner's REAL iPhone to see what is currently running. Costs the owner nothing: like ios_home it reaches the phone without bringing the mirroring window forward or taking their focus, so it works while they are using their Mac. This is the only way to learn what is open BEHIND the current app — a screenshot only ever shows the app in front. Follow it with a screen read to see the result.",
    params: {},
  },
}

/*
 * What the small tier is allowed to plan with.
 *
 * Derived from the full schema rather than duplicated, so an action can never
 * drift out of sync with its description. The cut is: direct, single-step,
 * well-understood actions stay; the browser_*, ui_*, mouse_* families and the
 * open-ended escape hatches (run_shell, run_applescript, computer_use_task,
 * send_email) go. Those are exactly the ones that need judgement — and they are
 * also most of the prompt, because their descriptions are the longest.
 *
 * A request that turns out to need something from the excluded set does not
 * lose the capability: the orchestrator escalates it to the full planner.
 */
const BACKGROUND_ACTION_TYPES = [
  'open_app',
  'open_url',
  'open_path',
  'open_folder',
  'list_directory',
  'read_file',
  'write_file',
  'create_note',
  'copy_to_clipboard',
  'get_clipboard',
  'create_reminder',
  'set_volume',
  'get_volume',
  'set_mute',
  'set_brightness',
  'get_brightness',
  'get_mac_status',
  'get_battery',
  'get_weather',
  'get_time',
  'translate_text',
  'play_youtube',
  'screenshot',
  'search_file',
]

export function backgroundModelName() {
  return LLM_BACKGROUND_MODEL
}

export function plannerModelName() {
  return LLM_MODEL
}

/**
 * The action schema a tier plans against. `background` gets the subset above;
 * everything else gets the same schema it always got.
 */
export function actionSchemaForTier(tier = 'planner') {
  if (tier !== 'background') return FULL_CONTROL_ACTION_SCHEMA

  const subset = {}
  for (const type of BACKGROUND_ACTION_TYPES) {
    if (FULL_CONTROL_ACTION_SCHEMA[type]) subset[type] = FULL_CONTROL_ACTION_SCHEMA[type]
  }
  return subset
}

/**
 * What this file says one action type DOES, regardless of tier or mode.
 *
 * These descriptions were written for the planner and read by nobody else, so
 * GET /capabilities published 95 action types with an empty description and a
 * caller matching against the manifest could only match on how the type is
 * spelled. What `delete_path` does is not a function of any env var, and a
 * manifest whose prose changed with one would be worse than none.
 */
export function actionDescription(type) {
  const description = String(actionSpec(type)?.description ?? '').trim()
  return description || null
}

/**
 * The raw schema entry — description AND parameters — for one action type, or
 * null for a type no schema describes.
 *
 * BY REFERENCE, deliberately. toolDiscovery.js hands these to the model as the
 * level-3 answer, and a copy would be a second registry: the moment one is
 * edited and the other is not, the model is planning against a schema the
 * planner no longer believes. Same reason actionSchemaForTier returns the
 * shared objects rather than clones. Do not mutate what comes back.
 */
export function actionSpec(type) {
  const name = String(type ?? '')
  return FULL_CONTROL_ACTION_SCHEMA[name] ?? null
}

export function isLlmPlannerEnabled() {
  return LLM_ENABLED
}

export function visionModelName() {
  return LLM_VISION_MODEL
}

// The text model is text-only: a request carrying an image part 404s or, worse,
// silently drops it and the agent confidently guesses. So vision is gated on an
// explicitly configured multimodal model, and callers degrade to text-only
// planning when it is absent rather than pretending to see.
export function isVisionConfigured() {
  return LLM_ENABLED && Boolean(LLM_VISION_MODEL) && LLM_VISION_MODEL !== 'off'
}

export function llmRequestHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${LLM_API_KEY}`,
  }
}

/**
 * Multi-turn, optionally multimodal chat request.
 *
 * This is the transport the perceive-act loop runs on. It differs from the
 * single-shot planner path in three ways that matter:
 *  - it takes a full `messages` array, so assistant turns accumulate;
 *  - `content` may be an OpenAI content-part array carrying `image_url` with a
 *    base64 data URL;
 *  - `response_format: json_object` is applied ONLY when there is no image
 *    (some multimodal endpoints reject json_object with image parts).
 */
export async function requestLlmMessages({
  messages,
  hasImages = false,
  maxTokens = LLM_MAX_TOKENS,
  fetchImpl = fetch,
} = {}) {
  if (!LLM_ENABLED) {
    throw new Error('LLM is not configured (set LLM_API_KEY).')
  }

  if (hasImages && !isVisionConfigured()) {
    throw new Error(
      'No vision model is configured. Set LLM_VISION_MODEL to a multimodal model on your LLM_API_BASE_URL, or run the task without screenshots.',
    )
  }

  const model = hasImages ? LLM_VISION_MODEL : LLM_MODEL
  const response = await fetchImpl(`${LLM_API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: llmRequestHeaders(),
    body: JSON.stringify({
      model,
      // gpt-5.x only allows default temperature (omit field).
      max_completion_tokens: maxTokens,
      ...(hasImages ? {} : { response_format: { type: 'json_object' } }),
      messages,
    }),
  })

  const payload = await response.json()
  const providerError = providerErrorMessage(payload)

  if (!response.ok || providerError) {
    const message =
      providerError || `LLM API request failed (${response.status}).`
    const error = new Error(`${message} (model ${model})`)
    error.status = response.status
    // Lets the caller drop to a text-only step rather than aborting the task.
    error.rejectedImages = hasImages
    throw error
  }

  return stripProtocolTerminators(
    payload.choices?.[0]?.message?.content ?? '',
  )
}

export function isFullControlPlanner() {
  return FULL_CONTROL_MODE
}

export async function planCommand(command, options = {}) {
  // `tier` picks the model and how much prompt it is given. Default is the
  // behaviour every existing caller already had.
  const {
    context = null,
    onProgress = null,
    tier = 'planner',
    // A thread another body already built (local-agent/contextResume.js).
    // Null means plan from a cold start, as every caller did before.
    resumed = null,
  } = options

  if (LLM_ENABLED) {
    try {
      const llmPlan = await planWithLlm(command, {
        context,
        onProgress,
        tier,
        resumed,
      })

      if (llmPlan.status === 'instant') {
        return llmPlan
      }

      if (llmPlan.status === 'ready' && llmPlan.actions.length) {
        return llmPlan
      }

      if (llmPlan.status === 'ready' && llmPlan.response) {
        return {
          ...llmPlan,
          status: 'instant',
          requiresConfirmation: false,
        }
      }

      if (llmPlan.status === 'unsupported') {
        return llmPlan
      }
    } catch (error) {
      console.warn(`[planner] LLM planning failed: ${error.message}`)
      onProgress?.({
        phase: 'error',
        message: error.message,
      })
    }
  }

  // Never fall back to keyword / string-match tables. Planning is model-only.
  return {
    status: 'unsupported',
    command,
    actions: [],
    requiresConfirmation: true,
    error: !LLM_ENABLED
      ? 'LLM planner is not configured (set LLM_API_KEY). No hardcoded command matching.'
      : 'LLM could not plan this command. Rephrase the request or check LLM_API_KEY.',
    planner: 'llm',
  }
}

/*
 * TOOL DISCOVERY — the planner is handed a catalogue, not the library.
 *
 * Every planner turn used to carry FULL_CONTROL_ACTION_SCHEMA in full: 92
 * action types with their parameter hints, ~28,000 characters, on "set the
 * volume to 30" as much as on a five-step browser job. toolDiscovery.js groups
 * the executor's live dispatch table into 14 domains; the first-level prompt
 * carries only the ~820-character domain catalogue, and the tools themselves
 * arrive at level 3 for the two or three domains this request actually needs.
 *
 * The wiring is a BOUNDED PRE-PASS, not an open tool loop: one cheap call to
 * pick domains, one planning call with just those schemas, and at most one
 * widening. Two things make it safe to lose no capability:
 *   - the planning prompt names the domains it did NOT receive and tells the
 *     model to ask for them ("need_tools") instead of refusing;
 *   - an "unsupported" from a scoped prompt is never believed on the spot —
 *     it is re-planned once against the whole schema, which is exactly the
 *     prompt this file sent before discovery existed.
 * So the worst case is today's cost plus a small pre-pass, and the common case
 * is a fraction of it.
 *
 * PENDANT_TOOL_DISCOVERY=off restores the flat schema, which is the only way
 * to A/B this without a code change.
 */
const TOOL_DISCOVERY_ENABLED = process.env.PENDANT_TOOL_DISCOVERY !== 'off'
/* Picking a shelf is a small judgement, so it runs on the small model. Getting
 * it wrong costs a widening, never a capability. */
const LLM_DISCOVERY_MODEL = String(
  process.env.LLM_DISCOVERY_MODEL || LLM_BACKGROUND_MODEL,
).trim()
const DISCOVERY_DOMAIN_LIMIT = 4
/* Enough of the thread for "do that on the other tab" to land in `browser`,
 * far too little to put the projection's cost back into the prompt. */
const DISCOVERY_CONTEXT_CHARS = 800

/*
 * The planning rules, as entries rather than one block, so a rule travels with
 * the tools it talks about. A prompt scoped to `files` should not spend six
 * lines on browser sessions — and, worse, should not advertise browser_* to a
 * model that was given no browser schema. `needs` is the list of action types
 * a rule names; the rule ships when any of them did. A rule with no `needs` is
 * about planning itself and always ships.
 *
 * With no scoping the filter is a no-op and the block is byte-for-byte the one
 * this file has always sent. llmPlannerDiscovery.test.js asserts that.
 */
const FULL_CONTROL_RULES = [
  { text: '- Choose dedicated action types yourself. Never invent keyword parsers.' },
  { text: '- Weather / rain / forecast → get_weather.', needs: ['get_weather'] },
  { text: '- Time / date / clock → get_time.', needs: ['get_time'] },
  { text: '- Translation → translate_text.', needs: ['translate_text'] },
  {
    text: '- Reminders → create_reminder. Brightness/volume → set_brightness / set_volume / set_mute.',
    needs: ['create_reminder', 'set_brightness', 'set_volume', 'set_mute'],
  },
  {
    text: "- Brief me / prepare my workday / what did I miss in email / read my schedule / summarize today's notes into next actions → compose_briefing (one action, nothing else). It reads the sources and writes the note itself; do not add create_note or run_applescript alongside it. It never sends, which is what the owner asked for.",
    needs: ['compose_briefing'],
  },
  {
    text: `- Web / browser / "this page" / site / tab / form on the web:
  1) Prefer browser_* tools (extension uses the real logged-in profile).
  2) For anything past a single step, name a session: browser_open_session with session:"work", then pass session:"work" on every later browser_* action so they all hit the same tab.
  3) Start with browser_list_tabs or browser_snapshot, then click/type by ref or selector.
  4) Use browser_wait_for after navigations or SPA updates.
  5) Prefer browser_read_page (main_text/forms) over dumping html.
  6) Only use browser_capture or desktop computer_use_task when the page is canvas/visual-only or the extension is offline.`,
    needs: [
      'browser_open_session',
      'browser_list_tabs',
      'browser_snapshot',
      'browser_read_page',
      'browser_wait_for',
      'browser_capture',
    ],
  },
  {
    text: '- Native Mac apps (Finder, Settings, non-browser UI): ui_menu / ui_find / ui_click; computer_use_task for multi-step unpredictable UI.',
    needs: ['ui_menu', 'ui_find', 'ui_click', 'computer_use_task'],
  },
  {
    text: '- Prefer dedicated types over long shell/AppleScript.',
    needs: ['run_shell', 'run_applescript'],
  },
  { text: '- Keep plans short (usually 1-3 steps). Use absolute paths under {{home}} when possible.' },
  { text: '- Destructive actions only when the user explicitly asks.' },
  {
    text: '- A request to change something (cancel / send / delete / buy / unsubscribe / …) is not completed by a plan that only opens and reads. Include the acting step when you can already see it; when you genuinely must look first, plan the look — the run is then reported as reconnaissance with the change still to do, never as done.',
  },
  { text: '- If truly impossible, return status "unsupported" with a short reason.' },
]

/**
 * The system prompt for one planning call.
 *
 * Exported because the size of this string is the whole result, and a test
 * that measures a reconstruction of it measures nothing. Pass `schemaText` to
 * hand the model a drilled-down subset; omit it and the prompt is identical to
 * the one this file sent before discovery existed.
 *
 * @param toolNames    action types actually in `schemaText`, for rule filtering
 * @param otherDomains domain names deliberately withheld — naming them is what
 *                     turns a missing tool into a request instead of a refusal
 */
export function buildPlannerSystemPrompt({
  tier = 'planner',
  machinePrompt = '',
  home = os.homedir(),
  schemaText = null,
  toolNames = null,
  otherDomains = [],
} = {}) {
  const background = tier === 'background'
  const schema = schemaText ?? JSON.stringify(actionSchemaForTier(tier), null, 2)
  const withheld = Array.isArray(otherDomains) ? otherDomains.filter(Boolean) : []
  const drillDown = withheld.length
    ? `\n\nTool domains NOT loaded for this request: ${withheld.join(', ')}.
If nothing above can do the job, do NOT answer "unsupported" — answer {"status":"need_tools","domains":["<domain>"]} and those tools will be given to you.`
    : ''

  if (background) {
    return `You are the fast planning layer for a Mac agent. The request is expected to be simple and single-step.

Return ONLY valid JSON:
{
  "status": "ready" | "instant" | "unsupported",
  "response": "optional short spoken answer when status is instant",
  "actions": [ { "type": "...", "label": "human readable step", "params": { ... } } ],
  "requiresConfirmation": true only if you are asking permission for a step the owner did not request,
  "confirmReason": "when asking: what the extra step is, and why you want it",
  "error": "only when unsupported"
}

Available action types (this is the complete list you may use):
${schema}${drillDown}

${machinePrompt}

Rules:
- The owner's request is your authorization. Do what they asked and do not ask again.
- Prefer exactly one action. Two is the maximum.
- Weather → get_weather. Time/date → get_time. Translation → translate_text.
- Battery / wifi / system status → get_mac_status.
- If the request needs the web, a browser, native UI clicking, a shell command, email, or more than two steps, return status "unsupported" with error "needs full planner". Do not improvise around a missing action type.
- Use absolute paths under ${home}.`
  }

  if (!FULL_CONTROL_MODE) {
    return `You are the planning layer for a safe Mac local agent.
Return ONLY valid JSON with status, actions, optional response, and optional error.
Allowed action types: ${schema}
Never invent shell commands or paths outside the whitelist.`
  }

  const loaded = Array.isArray(toolNames) ? new Set(toolNames) : null
  const rules = FULL_CONTROL_RULES.filter(
    (rule) => !rule.needs || !loaded || rule.needs.some((type) => loaded.has(type)),
  )
    .map((rule) => rule.text.split('{{home}}').join(home))
    .join('\n')

  return `You are the planning layer for a Mac computer-control agent with FULL access to the user's machine.
Decide the intent yourself. Do not rely on keyword short-circuits from the client.

Return ONLY valid JSON:
{
  "status": "ready" | "instant" | "unsupported",
  "response": "optional short spoken answer when status is instant",
  "actions": [
    { "type": "...", "label": "human readable step", "params": { ... } }
  ],
  "requiresConfirmation": true only if you are asking permission — omit it otherwise,
  "confirmReason": "when asking: what you want to do beyond the request, and why",
  "error": "only when unsupported"
}

When to use each status:
- "instant": you already know the answer (or only need get_weather / get_time / translate_text). Put the spoken answer in "response". For weather/time/translate, prefer those action types and leave response empty — the runtime will fill it.
- "ready": Mac control / apps / files / media / settings to carry out now.
- "unsupported": truly impossible on this device.

Permission — you decide, not a rule table:
- The owner's request IS your authorization. Plan it and let it run. Asking them to confirm what they just asked for is friction they pay on every turn for a decision they already made.
- Ask ONLY when a step goes beyond what they asked for: something you believe would help but they did not request, or something hard to undo that the literal request does not cover. Then set "requiresConfirmation": true and say in "confirmReason" what the extra step is and why you want it, in one sentence, addressed to them.
- Asking is per-plan, so keep the extra step in "actions" and explain it — do not silently drop it and do not smuggle it in.
- Everything you run is recorded and can be undone afterwards. That is what buys you the benefit of the doubt; do not spend it on steps nobody asked for.

Available action types:
${schema}${drillDown}

${machinePrompt}

Planning rules:
${rules}`
}

/**
 * LEVEL 1: which shelves does this request need?
 *
 * The only capability text in this prompt is the domain catalogue — 14 lines,
 * ~820 characters, no action type named anywhere. Returns the domains the
 * model asked for, filtered to ones that exist, or an empty list if the model
 * or the network let us down; an empty list means the caller falls back to the
 * whole schema, which is what it sent before this existed.
 */
async function discoverDomains(command, { headers, context = null, onProgress = null }) {
  const { normalizeDomains, renderDomainCatalog } = await import('./toolDiscovery.js')

  const systemPrompt = `You are the tool-discovery layer for a Mac agent. You do not plan yet: you choose which shelves of the tool library this request needs, and the tools on them are fetched for you.

Tool domains:
${renderDomainCatalog()}

Return ONLY valid JSON: {"domains": ["<domain>", ...]}

Rules:
- Name every domain the request might touch, likeliest first. Two or three is normal; ${DISCOVERY_DOMAIN_LIMIT} is the maximum.
- Naming one domain too many costs a few tokens. Naming one too few costs a whole round trip, or a worse plan built out of the wrong shelf — so when two could apply, name both.
- A request to be summarised, caught up, prepared for or told what it missed almost always spans more than one shelf.
- "shell" and "input" are the general ways into anything this Mac can do that no other shelf covers — a script, or driving an app window. Add them whenever the obvious shelf might not reach the whole job. Choosing between a direct tool and a script happens later; you are only deciding what to put on the table.`

  const thread = String(context?.promptBlock ?? '')
  const userContent = [
    thread ? `Recent context:\n${thread.slice(-DISCOVERY_CONTEXT_CHARS)}` : '',
    `Request:\n${command}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const content = await requestLlmPlanContent({
    headers,
    systemPrompt,
    userContent,
    // No onProgress: this call is not streamed, so it cannot interleave with
    // the plan draft the orchestrator is rendering token by token.
    command,
    model: LLM_DISCOVERY_MODEL,
    maxTokens: 120,
  })

  const parsed = JSON.parse(extractJsonObject(content))
  const domains = normalizeDomains(parsed.domains, { limit: DISCOVERY_DOMAIN_LIMIT })

  onProgress?.({
    phase: 'discover_tools',
    message: domains.length
      ? `Opened tool domains: ${domains.join(', ')}`
      : 'No domain matched — loading every tool',
  })

  return {
    domains,
    usage: {
      tier: 'discovery',
      model: LLM_DISCOVERY_MODEL,
      promptChars: systemPrompt.length + userContent.length,
      completionChars: content.length,
    },
  }
}

async function planWithLlm(
  command,
  { context = null, onProgress = null, tier = 'planner', resumed = null } = {},
) {
  const background = tier === 'background'
  const home = os.homedir()
  const machine = await getMachineContext()
  const machinePrompt = formatMachineContextForPrompt(machine, {
    compact: background,
  })
  const model = background ? LLM_BACKGROUND_MODEL : LLM_MODEL
  const maxTokens = background
    ? Math.min(LLM_MAX_TOKENS, 768)
    : LLM_MAX_TOKENS

  const discovery = await import('./toolDiscovery.js')

  /*
   * Which tools this call gets.
   *
   * The small tier does not drill down: its schema is already 24 types, and a
   * second model call to save a few hundred characters would cost more latency
   * than it saves tokens. It still benefits — the same renderer packs its
   * schema one tool per line instead of pretty-printed JSON.
   */
  let scoped = null
  let discoveredDomains = null
  const usage = []

  if (background) {
    // Its own subset, read back off actionSchemaForTier rather than off
    // BACKGROUND_ACTION_TYPES, so the cheap tier is handed exactly the types it
    // was handed before — not one more that happens to be dispatchable.
    scoped = { toolNames: Object.keys(actionSchemaForTier(tier)), otherDomains: [] }
  } else if (TOOL_DISCOVERY_ENABLED && FULL_CONTROL_MODE) {
    try {
      const picked = await discoverDomains(command, {
        headers: llmRequestHeaders(),
        context,
        onProgress,
      })
      usage.push(picked.usage)
      discoveredDomains = picked.domains
      if (picked.domains.length) {
        scoped = {
          domains: picked.domains,
          toolNames: discovery.toolsForDomains(picked.domains),
          otherDomains: discovery.domainsExcept(picked.domains),
        }
      }
    } catch (error) {
      // Discovery is an optimisation. A failed one costs the pre-pass and
      // falls through to the prompt this file has always sent.
      console.warn(`[planner] tool discovery failed: ${error.message}`)
    }
  }

  const userContent = [context?.promptBlock, `Current request:\n${command}`]
    .filter(Boolean)
    .join('\n\n')

  const headers = llmRequestHeaders()
  const inheritedChars = (resumed?.resumed ? resumed.messages : []).reduce(
    (total, message) => total + String(message.content || '').length,
    0,
  )

  let systemPrompt = ''
  let content = ''
  let parsed = null
  let widened = false

  /*
   * At most two planning calls. The second only happens when the first said it
   * was missing tools, or refused while holding a subset — the two ways a
   * drilled-down prompt can be less capable than the flat one. Widening goes
   * straight to the whole schema rather than adding one domain at a time: a
   * second wrong guess would cost another round trip, and by this point the
   * request has already proved it does not fit the catalogue.
   */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const schemaText = scoped
      ? discovery.renderToolSchemas(scoped.toolNames)
      : JSON.stringify(actionSchemaForTier(tier), null, 2)

    systemPrompt = buildPlannerSystemPrompt({
      tier,
      machinePrompt,
      home,
      schemaText,
      toolNames: scoped?.toolNames ?? null,
      otherDomains: scoped?.otherDomains ?? [],
    })

    onProgress?.({
      phase: 'llm_start',
      message: `Asking ${model} for a plan`,
    })

    content = await requestLlmPlanContent({
      headers,
      systemPrompt,
      userContent,
      onProgress,
      command,
      model,
      maxTokens,
      priorMessages: resumed?.resumed ? resumed.messages : [],
      cacheKey: resumed?.cacheKey ?? null,
    })

    if (!content) {
      throw new Error('LLM returned an empty planning response.')
    }

    /* What this call cost. The streaming completions API returns no usage
     * block, so the character counts are the ground truth and the token
     * numbers derived from them are labelled estimates wherever they surface.
     * Every return below carries it: a plan the owner cannot price is a plan
     * they cannot route. */
    usage.push({
      tier,
      model,
      promptChars: systemPrompt.length + userContent.length + inheritedChars,
      completionChars: content.length,
      inheritedChars,
      resumed: Boolean(resumed?.resumed),
      /* The number this change exists to move, kept next to the number it is
       * part of: a prompt total that shrank because the machine inventory
       * shrank would look identical from the outside. */
      schemaChars: schemaText.length,
      toolCount: scoped
        ? scoped.toolNames.length
        : Object.keys(actionSchemaForTier(tier)).length,
      domains: scoped?.domains ?? null,
    })

    onProgress?.({
      phase: 'llm_parse',
      message: 'Parsing the plan',
      partial: content,
    })

    parsed = JSON.parse(extractJsonObject(content))

    const shortOfTools =
      Boolean(scoped) &&
      !widened &&
      (parsed.status === 'need_tools' || parsed.status === 'unsupported')
    if (!shortOfTools) break

    widened = true
    scoped = null
    onProgress?.({
      phase: 'discover_widen',
      message:
        parsed.status === 'need_tools'
          ? 'Plan needs more tools — loading the whole library'
          : 'Refused with a partial library — re-planning against all of it',
    })
  }

  if (parsed.status === 'need_tools') {
    // Only reachable with discovery disabled mid-flight or a model that keeps
    // asking after being handed everything. Treat it as the refusal it is,
    // rather than returning a "ready" plan with no steps in it.
    parsed = {
      status: 'unsupported',
      error: 'The planner asked for tools that do not exist.',
    }
  }

  const totals = usage.reduce(
    (sum, call) => ({
      promptChars: sum.promptChars + call.promptChars,
      completionChars: sum.completionChars + call.completionChars,
    }),
    { promptChars: 0, completionChars: 0 },
  )
  const planningUsage = usage[usage.length - 1]
  const summarisedUsage = {
    ...planningUsage,
    // The total across the pre-pass and every planning call: routingStats
    // prices a turn off this field, and pricing only the last call would hide
    // exactly the cost discovery adds.
    promptChars: totals.promptChars,
    completionChars: totals.completionChars,
    calls: usage.length,
    discovery: usage.some((call) => call.tier === 'discovery'),
    widened,
    /* What the pre-pass picked, kept even when the plan widened past it. This
     * is the only signal that says WHICH domain guess was wrong, and the
     * taxonomy is tuned by reading it — after widening, `domains` above is
     * null, which is accurate about the last call and useless as a diagnosis. */
    discoveryDomains: discoveredDomains,
  }

  const actions = sanitizeActions(
    Array.isArray(parsed.actions) ? parsed.actions : [],
  )
  const responseText = String(parsed.response || '').trim()

  if (parsed.status === 'unsupported') {
    return {
      status: 'unsupported',
      command,
      actions: [],
      requiresConfirmation: true,
      error: parsed.error ?? 'LLM could not produce an action plan.',
      planner: 'llm',
      usage: summarisedUsage,
    }
  }

  /*
   * WHO DECIDES WHETHER TO ASK.
   *
   * This used to be a constant: every plan confirmed except one made entirely
   * of three action types named right here — get_weather, get_time,
   * translate_text. That trio was the planner's whole theory of risk, and it
   * was wrong in both directions. Too strict, because "what are the four
   * latest items on my Safari reading list" plans one read-only AppleScript
   * and still parked for an approval nobody needed. Too loose, because a plan
   * the model labelled "instant" skipped confirmation whatever was in it.
   *
   * The owner's rule replaces it, and it is about SCOPE, not mechanism: their
   * request is the authorization. A reminder they asked for is a reminder they
   * approved; asking again is friction they pay on every turn for a decision
   * they already made. What genuinely needs asking is a step they did NOT ask
   * for — something the model thinks would help, or something hard to undo
   * that goes past the literal request. Only the model can tell those apart,
   * because the difference is between the plan and the sentence, and no table
   * of action types can see a sentence.
   *
   * So the default is false and the model raises it, with a reason. A code
   * floor here would quietly rebuild the thing being removed, so there is
   * none; see the accountability note below for what carries the weight
   * instead.
   *
   * NOTHING THAT RECORDS IS RELAXED. This changes only whether the owner is
   * asked BEFORE. actionLedger, actionReceipts and the pipeline events still
   * see every step, and undo still works, which is the half of the trade that
   * makes the other half affordable.
   */
  const requiresConfirmation = parsed.requiresConfirmation === true
  const confirmReason = requiresConfirmation
    ? String(parsed.confirmReason || '').trim() ||
      'The planner asked for approval without saying why.'
    : ''

  if (parsed.status === 'instant' || (!actions.length && responseText)) {
    return {
      status: actions.length && !responseText ? 'ready' : 'instant',
      command,
      response: responseText || undefined,
      summary: responseText || undefined,
      actions,
      requiresConfirmation,
      ...(requiresConfirmation
        ? { confirmReason, safety: safetyLine(confirmReason) }
        : {}),
      planner: 'llm',
      fullControl: FULL_CONTROL_MODE,
      usage: summarisedUsage,
    }
  }

  /*
   * The upstream half of the false-done incident: a read-only plan for an
   * irreversible goal ("cancel my recurring investments" planned as open +
   * snapshot) used to present itself as the whole task. The plan still runs
   * exactly as before — reconnaissance is legitimate first work — but it is
   * MARKED as partial, so every surface that shows it says "looking first",
   * and the execute-side verdict (goalVerdict.applyGoalVerdict) will report
   * the run as incomplete rather than done. Validation only; the model's
   * plan is not rewritten.
   */
  const coverage = assessPlanCoverage(command, actions)

  return {
    status: 'ready',
    command,
    response: responseText || undefined,
    actions,
    requiresConfirmation,
    ...(requiresConfirmation ? { confirmReason } : {}),
    ...(coverage.reconnaissance
      ? {
          partial: {
            reconnaissance: true,
            note: coverage.note,
            remainder: coverage.goal.gerundPhrase,
          },
        }
      : {}),
    safety:
      coverage.reconnaissance && !requiresConfirmation
        ? coverage.note
        : safetyLine(confirmReason),
    planner: 'llm',
    fullControl: FULL_CONTROL_MODE,
    usage: summarisedUsage,
  }
}

/*
 * What the plan says about itself. A plan that is about to run must not carry
 * a sentence telling the owner to review it before confirming — they will be
 * reading it afterwards. And a plan that IS waiting should lead with the
 * model's own reason for waiting, not with a generic notice: "I also wanted to
 * empty the folder, which cannot be undone" is the thing worth reading, and it
 * is the reason the ask was worth making at all.
 */
function safetyLine(confirmReason) {
  if (!confirmReason) {
    return 'Running what you asked for. Every step is recorded and can be undone from the ledger.'
  }
  return `Waiting on you: ${confirmReason}`
}

// Deliberating costs seconds of voice latency, so spend it only where it pays:
// a retry (the fast pass already failed) or a command whose wording implies
// several dependent steps, comparison, or open-ended searching.
const DELIBERATION_HINTS =
  /\b(then|after that|figure out|research|compare|summari[sz]e|debug|troubleshoot|refactor|migrat|organi[sz]e|clean up|plan|decide|why|how come|instead of|each of|all of my|every)\b/i

export function chooseReasoningEffort(
  command,
  { attempt = 0, hasScreenshot = false } = {},
) {
  if (LLM_REASONING_EFFORT === 'off' || !LLM_REASONING_EFFORT) return 'off'
  if (LLM_REASONING_EFFORT !== 'auto') return LLM_REASONING_EFFORT
  // Auto only when explicitly enabled — still keep simple voice commands cheap.
  if (attempt > 0) return 'high'
  const text = String(command || '')
  if (DELIBERATION_HINTS.test(text)) return 'high'
  if (text.length > 160) return 'high'
  if (hasScreenshot) return 'low'
  return 'off'
}

export async function requestLlmPlanContent({
  headers,
  systemPrompt,
  userContent,
  onProgress,
  screenshot = null,
  command = '',
  attempt = 0,
  fetchImpl = fetch,
  // Tier overrides. Omitted means the planner tier, i.e. what every caller
  // before the policy router got.
  model = null,
  maxTokens = null,
  /*
   * A reasoning thread migrated from another body, already shaped for this
   * model by shared/contextHandoff.js. Empty is the normal case.
   */
  priorMessages = [],
  cacheKey = null,
}) {
  const useStream = typeof onProgress === 'function'
  const hasScreenshot = Boolean(screenshot?.dataUrl)
  const effort = chooseReasoningEffort(command, { attempt, hasScreenshot })
  // OpenAI (and OpenAI-compatible gateways) parse multipart content best with text first.
  const userMessage = hasScreenshot
    ? {
        role: 'user',
        content: [
          { type: 'text', text: userContent },
          { type: 'image_url', image_url: { url: screenshot.dataUrl } },
        ],
      }
    : { role: 'user', content: userContent }

  const response = await fetchImpl(`${LLM_API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: hasScreenshot ? LLM_VISION_MODEL : model || LLM_MODEL,
      // gpt-5.x: max_completion_tokens only; no temperature override; no reasoning.
      max_completion_tokens: maxTokens || LLM_MAX_TOKENS,
      stream: useStream,
      response_format: { type: 'json_object' },
      ...(LLM_SEND_REASONING && effort !== 'off'
        ? { reasoning: { effort } }
        : {}),
      /*
       * Steers repeated calls carrying the same migrated context at the same
       * server-side cache. The key is the handle ID, never the handle secret —
       * this field goes to the provider on every request.
       */
      ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
      /*
       * Order is load-bearing, not cosmetic. Provider prompt caches key on an
       * exact prefix, so the stable material goes first — this body's system
       * prompt, then the migrated thread, which is byte-identical for the life
       * of the handle — and the volatile part, the new request, goes last.
       * Put the request in the middle and every resume is a fresh prefix and
       * every resume misses.
       *
       * The cache is per-model, so a relay(gpt-realtime-2.1)→Mac(gpt-5.6-luna)
       * hop cannot hit it however the messages are ordered; a second call on
       * this body with the same handle can, and does.
       */
      messages: [
        { role: 'system', content: systemPrompt },
        ...(Array.isArray(priorMessages) ? priorMessages : []),
        userMessage,
      ],
    }),
  })

  if (!useStream) {
    const payload = await response.json()
    const providerError = providerErrorMessage(payload)
    if (!response.ok || providerError) {
      throw new Error(
        providerError || `LLM API request failed (${response.status}).`,
      )
    }
    return stripProtocolTerminators(
      payload.choices?.[0]?.message?.content ?? '',
    )
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(
      providerErrorMessage(payload) ||
        `LLM API request failed (${response.status}).`,
    )
  }

  const responseContentType =
    response.headers?.get?.('content-type')?.toLowerCase() || ''
  if (
    responseContentType.includes('application/json') &&
    !responseContentType.includes('text/event-stream')
  ) {
    const payload = await response.json()
    const providerError = providerErrorMessage(payload)
    if (providerError) throw new Error(providerError)
    return stripProtocolTerminators(
      payload.choices?.[0]?.message?.content ?? '',
    )
  }

  if (!response.body) {
    throw new Error('LLM stream body missing.')
  }

  return readLlmSseContent(response.body, { onProgress })
}

export async function readLlmSseContent(body, { onProgress } = {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let lastEmit = 0
  let lastEmittedLen = 0

  const consumeLine = (rawLine) => {
    const line = rawLine.trim()
    if (!line) return

    const isDataFrame = line.startsWith('data:')
    const data = isDataFrame ? line.slice(5).trim() : line
    // Provider transport control stays inside this parser. It is never a
    // model delta, progress message, session turn, or speech input.
    if (!data || data === '[DONE]') return
    if (!isDataFrame && !data.startsWith('{')) return

    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      return
    }

    const providerError = providerErrorMessage(payload)
    if (providerError) throw new Error(providerError)

    const delta =
      payload.choices?.[0]?.delta?.content ??
      payload.choices?.[0]?.message?.content ??
      ''
    if (!delta) return

    content += delta
    const now = Date.now()
    // Emit often enough for the ops dashboard to show real token chunks.
    if (now - lastEmit >= 70 || content.length - lastEmittedLen >= 24) {
      lastEmit = now
      lastEmittedLen = content.length
      onProgress?.({
        phase: 'llm_stream',
        message: 'Model is drafting the plan',
        partial: content,
        chars: content.length,
        delta,
      })
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      buffer += decoder.decode()
      if (buffer) consumeLine(buffer)
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split(/\r?\n/)
    buffer = chunks.pop() ?? ''

    for (const rawLine of chunks) {
      consumeLine(rawLine)
    }
  }

  return stripProtocolTerminators(content)
}

function providerErrorMessage(payload) {
  if (!payload || typeof payload !== 'object') return ''
  if (typeof payload.error === 'string') return payload.error.trim()
  if (payload.error && typeof payload.error === 'object') {
    return String(
      payload.error.message || payload.error.code || 'LLM provider error.',
    ).trim()
  }
  if (payload.type === 'error') {
    return String(payload.message || 'LLM provider error.').trim()
  }
  return ''
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) {
    throw new Error('LLM returned empty JSON.')
  }

  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return trimmed.slice(start, end + 1)
    }
    throw new Error('LLM did not return valid JSON.')
  }
}

// Dispatchable types that are deliberately not advertised to the model, kept
// here so a plan replayed from history is not dropped.
const DISPATCH_ALIASES = new Set([
  'set_clipboard',
  'open_folder',
  'open_path',
  'set_keyboard_language',
  'mouse_scroll',
  'show_screen_overlay',
  /*
   * Diagnostic, not something to plan: the owner never asks for it, but a
   * replayed history must not have the step silently dropped.
   */
  'check_input_permissions',
  /* research_brief is the advertised spelling; this is its dispatch alias. */
  'research_topic',
])

/*
 * Anything the executor can dispatch is a legal action, whether or not this
 * file describes it.
 *
 * These two registries kept drifting apart, and the failure is silent and
 * bad: sanitizeActions drops the step, the run reports success, and the owner
 * hears a confident summary for work that never happened. It has now happened
 * three times — briefings, research, and ten capture/focus/tidy actions — each
 * time because a new capability was wired into computerControl.js and nobody
 * remembered this list. Deriving the fallback from the dispatch table makes
 * that class of bug impossible rather than merely detectable.
 *
 * The schemas above still matter: they carry the descriptions and parameter
 * hints that let the model USE an action well. This only stops an undescribed
 * one from being thrown away.
 */
export function isKnownActionType(type) {
  const name = String(type ?? '')
  return (
    Object.hasOwn(FULL_CONTROL_ACTION_SCHEMA, name) ||
    DISPATCH_ALIASES.has(name) ||
    SUPPORTED_ACTION_TYPES.includes(name)
  )
}

/*
 * The brightness a shell command is trying to set, or null if it is not setting
 * one. Null is the common answer and the safe one: it leaves the command alone.
 *
 * Returns 0-1, the range set_brightness takes. A bare integer 0-100 is read as a
 * percentage because that is how people say it, but a bare 0-1 decimal is taken
 * literally — "brightness 0.3" and "brightness 30%" mean the same thing and
 * neither means 30 times full scale.
 */
export function brightnessLevelFromText(text) {
  const command = String(text ?? '')
  if (!/\bbrightness\b/i.test(command)) return null

  /* A read is not a write. `brightness -l`, `get brightness`, `brightness
   * --list` all used to be rewritten into a command that changed the display. */
  if (/\b(?:get|read|show|list|current|status|-l|--list)\b/i.test(command)) return null

  const percent = command.match(/(\d{1,3}(?:\.\d+)?)\s*%/)
  if (percent) return clampLevel(Number(percent[1]) / 100)

  /* Otherwise the last number in the command — `brightness set 0.4` and
   * `set-brightness 70` both put the value last, and taking the last one avoids
   * matching a display index or a flag's own digits earlier in the line. */
  const numbers = command.match(/\d+(?:\.\d+)?/g)
  if (!numbers?.length) return null
  const raw = Number(numbers[numbers.length - 1])
  if (!Number.isFinite(raw)) return null

  if (raw > 1) return clampLevel(raw / 100)
  return clampLevel(raw)
}

const clampLevel = (level) => Math.min(1, Math.max(0, level))

function sanitizeActions(actions) {
  // Light per-action cleanup only — never rewrite the whole plan from command text.
  return actions
    .map((action) => {
      if (!action || typeof action !== 'object') {
        return null
      }

      /*
       * A shell command about brightness becomes the structured action — but
       * only when it is actually setting one, and only at the level the owner
       * asked for.
       *
       * Both halves were wrong. `/brightness/i` matched the whole command, so a
       * READ like `brightness -l` was rewritten into a write. And the level was
       * the literal 0.5, so "set brightness to 100%" dimmed the screen to half
       * and reported success. A rewrite that silently substitutes a different
       * value is worse than no rewrite: the owner asked for something specific
       * and got a confident answer to a different question.
       */
      if (action?.type === 'run_shell') {
        const command = String(action.params?.command ?? '')
        const level = brightnessLevelFromText(command)
        if (level !== null) {
          return {
            type: 'set_brightness',
            label: action.label || 'Set display brightness',
            params: { level },
          }
        }
      }

      if (
        (action?.type === 'run_shell' || action?.type === 'run_project') &&
        /*
         * Kept in step with computerControl.js's own predicate, which is the
         * one that actually intercepts. This copy carried a bare `overlay`
         * alternative the executor's did not, so `run_shell echo overlay`
         * planned as a full-screen black rectangle — a word in passing became a
         * screen takeover. The executor's `aipendant-screen-overlay` is here
         * for the reverse reason: it only ever matched on that side, so the two
         * disagreed in both directions.
         */
        /tkinter|mainloop|overrideredirect|screenwidth|aipendant-screen-overlay/i.test(
          String(action.params?.command ?? ''),
        )
      ) {
        return {
          type: 'show_screen_overlay',
          label: action.label || 'Show screen overlay',
          params: {
            region: inferOverlayRegionFromText(
              `${action.label || ''} ${action.params?.command || ''}`,
            ),
            fraction: inferOverlayFractionFromText(
              `${action.label || ''} ${action.params?.command || ''}`,
            ),
            color: 'black',
          },
        }
      }

      // Prefer play_youtube when the model opened a YouTube search results URL.
      if (
        action?.type === 'open_url' &&
        /youtube\.com\/results/i.test(String(action.params?.url ?? ''))
      ) {
        try {
          const url = new URL(action.params.url)
          const query = url.searchParams.get('search_query') || 'music'
          return {
            type: 'play_youtube',
            label: action.label || `Play on YouTube: ${query}`,
            params: { query },
          }
        } catch {
          return action
        }
      }

      // A hallucinated type used to pass straight through, get shown to the
      // user for confirmation, and only fail at execution with "Unsupported
      // action type". Drop it here instead.
      if (!isKnownActionType(action.type)) {
        console.warn(`[planner] dropping unknown action type: ${String(action.type)}`)
        return null
      }

      return {
        type: action.type,
        label: action.label || action.type,
        params: action.params && typeof action.params === 'object' ? action.params : {},
      }
    })
    .filter(Boolean)
}

function inferOverlayRegionFromText(text = '') {
  const value = String(text).toLowerCase()
  if (/right half|오른쪽/.test(value)) return 'right'
  if (/top half|upper half|위쪽|상단|top\s+\d/.test(value)) return 'top'
  if (/bottom half|lower half|아래|하단/.test(value)) return 'bottom'
  if (/full screen|entire screen|whole screen|전체/.test(value)) return 'full'
  return 'left'
}

function inferOverlayFractionFromText(text = '') {
  const match =
    String(text).match(/(\d{1,3})\s*%/) ||
    String(text).match(/\b(0?\.\d+)\b/)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  return Math.min(1, Math.max(0.05, value > 1 ? value / 100 : value))
}
