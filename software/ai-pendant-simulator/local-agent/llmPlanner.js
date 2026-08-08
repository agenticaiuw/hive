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
 * apps-only machine block instead of the full 26,000-character brief. Point it
 * anywhere with LLM_BACKGROUND_MODEL; the default is the multimodal small model
 * this repo already talks to, so the cheap tier needs no new credentials.
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
   * Prefer the Mac or the web when the task can be done there — this is for
   * what genuinely needs the phone: iOS-only apps, things tied to the owner's
   * phone number, checking how something looks on the device.
   */
  ios_status: {
    description:
      "Check whether the owner's real iPhone is reachable through iPhone Mirroring. Reads only. Returns state ready | off-space | blocked | no-window | not-running. 'off-space' means the mirroring window is on another macOS Space: reading works as-is, and taps or typing will bring the window forward first. Call this first when unsure; only the owner can open or reconnect iPhone Mirroring.",
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
      "Open an app on the owner's REAL iPhone via Spotlight. The normal way to start a phone task.",
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
      "Go to the Home Screen on the owner's REAL iPhone. Always works, and is the way out of an app without tapping anything inside it.",
    params: {},
  },
}

const SAFE_ACTION_SCHEMA = {
  open_url: { description: 'Open a whitelisted URL.', params: { url: 'string' } },
  open_app: { description: 'Open a whitelisted app.', params: { appName: 'string' } },
  open_folder: { description: 'Open a whitelisted folder.', params: { path: 'string' } },
  create_note: { description: 'Create a markdown note.', params: { filename: 'string', content: 'string' } },
  copy_to_clipboard: { description: 'Copy text to clipboard.', params: { text: 'string' } },
  run_project: { description: 'Run npm dev in a whitelisted project.', params: { path: 'string' } },
  search_file: { description: 'Search whitelisted folders.', params: { root: 'string', query: 'string' } },
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
  const full = FULL_CONTROL_MODE ? FULL_CONTROL_ACTION_SCHEMA : SAFE_ACTION_SCHEMA

  if (tier !== 'background') return full

  const subset = {}
  for (const type of BACKGROUND_ACTION_TYPES) {
    if (full[type]) subset[type] = full[type]
  }
  return subset
}

/**
 * What this file says one action type DOES, regardless of tier or mode.
 *
 * These descriptions were written for the planner and read by nobody else, so
 * GET /capabilities published 95 action types with an empty description and a
 * caller matching against the manifest could only match on how the type is
 * spelled. Both schemas are consulted, not the mode-selected one: what
 * `delete_path` does is not a function of FULL_CONTROL_MODE, and a manifest
 * whose prose changed with an env var would be worse than none.
 */
export function actionDescription(type) {
  const name = String(type ?? '')
  const spec = FULL_CONTROL_ACTION_SCHEMA[name] ?? SAFE_ACTION_SCHEMA[name]
  const description = String(spec?.description ?? '').trim()
  return description || null
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

  if (FULL_CONTROL_MODE && LLM_ENABLED) {
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
      : !FULL_CONTROL_MODE
        ? 'Full-control LLM planner is disabled (FULL_CONTROL_MODE=false). No hardcoded command matching.'
        : 'LLM could not plan this command. Rephrase the request or check LLM_API_KEY.',
    planner: 'llm',
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
  const actionSchema = actionSchemaForTier(tier)
  const model = background ? LLM_BACKGROUND_MODEL : LLM_MODEL
  const maxTokens = background
    ? Math.min(LLM_MAX_TOKENS, 768)
    : LLM_MAX_TOKENS

  /*
   * The small tier gets a short brief, not a shortened version of the long one.
   * Its job is narrow — one obvious action, or admit it cannot — and every rule
   * about browsers, native UI trees and shell is not just wasted tokens there
   * but an invitation to attempt something outside its schema.
   */
  const systemPrompt = background
    ? `You are the fast planning layer for a Mac agent. The request is expected to be simple and single-step.

Return ONLY valid JSON:
{
  "status": "ready" | "instant" | "unsupported",
  "response": "optional short spoken answer when status is instant",
  "actions": [ { "type": "...", "label": "human readable step", "params": { ... } } ],
  "error": "only when unsupported"
}

Available action types (this is the complete list you may use):
${JSON.stringify(actionSchema, null, 2)}

${machinePrompt}

Rules:
- Prefer exactly one action. Two is the maximum.
- Weather → get_weather. Time/date → get_time. Translation → translate_text.
- Battery / wifi / system status → get_mac_status.
- If the request needs the web, a browser, native UI clicking, a shell command, email, or more than two steps, return status "unsupported" with error "needs full planner". Do not improvise around a missing action type.
- Use absolute paths under ${home}.`
    : FULL_CONTROL_MODE
    ? `You are the planning layer for a Mac computer-control agent with FULL access to the user's machine.
Decide the intent yourself. Do not rely on keyword short-circuits from the client.

Return ONLY valid JSON:
{
  "status": "ready" | "instant" | "unsupported",
  "response": "optional short spoken answer when status is instant",
  "actions": [
    { "type": "...", "label": "human readable step", "params": { ... } }
  ],
  "error": "only when unsupported"
}

When to use each status:
- "instant": you already know the answer (or only need get_weather / get_time / translate_text). Put the spoken answer in "response". For weather/time/translate, prefer those action types and leave response empty — the runtime will fill it.
- "ready": Mac control / apps / files / media / settings that need confirmation before running.
- "unsupported": truly impossible on this device.

Available action types:
${JSON.stringify(actionSchema, null, 2)}

${machinePrompt}

Planning rules:
- Choose dedicated action types yourself. Never invent keyword parsers.
- Weather / rain / forecast → get_weather.
- Time / date / clock → get_time.
- Translation → translate_text.
- Reminders → create_reminder. Brightness/volume → set_brightness / set_volume / set_mute.
- Brief me / prepare my workday / what did I miss in email / read my schedule / summarize today's notes into next actions → compose_briefing (one action, nothing else). It reads the sources and writes the note itself; do not add create_note or run_applescript alongside it. It never sends, which is what the owner asked for.
- Web / browser / "this page" / site / tab / form on the web:
  1) Prefer browser_* tools (extension uses the real logged-in profile).
  2) For anything past a single step, name a session: browser_open_session with session:"work", then pass session:"work" on every later browser_* action so they all hit the same tab.
  3) Start with browser_list_tabs or browser_snapshot, then click/type by ref or selector.
  4) Use browser_wait_for after navigations or SPA updates.
  5) Prefer browser_read_page (main_text/forms) over dumping html.
  6) Only use browser_capture or desktop computer_use_task when the page is canvas/visual-only or the extension is offline.
- Native Mac apps (Finder, Settings, non-browser UI): ui_menu / ui_find / ui_click; computer_use_task for multi-step unpredictable UI.
- Prefer dedicated types over long shell/AppleScript.
- Keep plans short (usually 1-3 steps). Use absolute paths under ${home} when possible.
- Destructive actions only when the user explicitly asks.
- If truly impossible, return status "unsupported" with a short reason.`
    : `You are the planning layer for a safe Mac local agent.
Return ONLY valid JSON with status, actions, optional response, and optional error.
Allowed action types: ${JSON.stringify(actionSchema, null, 2)}
Never invent shell commands or paths outside the whitelist.`

  const userContent = [context?.promptBlock, `Current request:\n${command}`]
    .filter(Boolean)
    .join('\n\n')

  const headers = llmRequestHeaders()

  onProgress?.({
    phase: 'llm_start',
    message: `Asking ${model} for a plan`,
  })

  const content = await requestLlmPlanContent({
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

  onProgress?.({
    phase: 'llm_parse',
    message: 'Parsing the plan',
    partial: content,
  })

  /*
   * What this call cost. The streaming completions API returns no usage block,
   * so the character counts are the ground truth and the token numbers derived
   * from them are labelled estimates wherever they surface. Every return below
   * carries it: a plan the owner cannot price is a plan they cannot route.
   */
  const inheritedChars = (resumed?.resumed ? resumed.messages : []).reduce(
    (total, message) => total + String(message.content || '').length,
    0,
  )
  const usage = {
    tier,
    model,
    promptChars: systemPrompt.length + userContent.length + inheritedChars,
    completionChars: content.length,
    /* Broken out so the cost of inheriting a thread can be compared against
     * the cost of rediscovering it, which is the only number that decides
     * whether this mechanism is worth keeping. */
    inheritedChars,
    resumed: Boolean(resumed?.resumed),
  }

  const parsed = JSON.parse(extractJsonObject(content))
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
      usage,
    }
  }

  if (
    parsed.status === 'instant' ||
    (!actions.length && responseText) ||
    (actions.length &&
      actions.every((action) =>
        ['get_weather', 'get_time', 'translate_text'].includes(action.type),
      ))
  ) {
    return {
      status: actions.length && !responseText ? 'ready' : 'instant',
      command,
      response: responseText || undefined,
      summary: responseText || undefined,
      actions,
      requiresConfirmation: false,
      planner: 'llm',
      fullControl: FULL_CONTROL_MODE,
      usage,
    }
  }

  return {
    status: 'ready',
    command,
    response: responseText || undefined,
    actions,
    requiresConfirmation: true,
    safety: FULL_CONTROL_MODE
      ? 'Full computer control is enabled. Review the plan carefully before confirming.'
      : 'Actions are prepared first. Nothing is executed on the Mac until you confirm.',
    planner: 'llm',
    fullControl: FULL_CONTROL_MODE,
    usage,
  }
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
    Object.hasOwn(SAFE_ACTION_SCHEMA, name) ||
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
