import os from 'node:os'
import { FULL_CONTROL_MODE } from './config.js'
import {
  formatMachineContextForPrompt,
  getMachineContext,
} from './machineContext.js'
import { planCommand as planWithRules } from './planner.js'

const LLM_API_KEY = process.env.LLM_API_KEY || ''
const LLM_API_BASE_URL =
  process.env.LLM_API_BASE_URL || 'https://api.openai.com/v1'
// Pinned: the bare `deepseek-v4-flash` slug still resolves to the April preview
// checkpoint, which is far weaker at agentic work (Terminal-Bench 61.8 vs 82.7)
// and costs more.
const LLM_MODEL =
  process.env.LLM_MODEL || 'deepseek/deepseek-v4-flash-0731'
// DeepSeek is text-only; a request carrying an image 404s. Screenshots go to a
// vision model that returns normalized 0-999 coordinates, so no provider-side
// image resize can throw off a click.
const LLM_VISION_MODEL =
  process.env.LLM_VISION_MODEL || 'google/gemini-3.6-flash'
// 'auto' picks per request; 'low'/'medium'/'high' pin it; 'off' omits the field.
const LLM_REASONING_EFFORT = process.env.LLM_REASONING_EFFORT || 'auto'
const LLM_MAX_TOKENS = Math.min(
  Math.max(Number(process.env.LLM_MAX_TOKENS || 1024), 128),
  4096,
)
const LLM_ENABLED = process.env.LLM_ENABLED !== 'false' && Boolean(LLM_API_KEY)

const FULL_CONTROL_ACTION_SCHEMA = {
  run_shell: {
    description: 'Run any shell command on the Mac (zsh). Use for installs, git, npm, curl, etc.',
    params: { command: 'string', cwd: 'optional absolute path', timeout: 'optional ms' },
  },
  run_applescript: {
    description: 'Run AppleScript for deep macOS automation.',
    params: { script: 'string' },
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
  browser_navigate: {
    description: 'Open a URL in the home Mac Chrome extension using existing logged-in browser cookies.',
    params: { url: 'string' },
  },
  browser_click: {
    description: 'Click an element in the active browser tab.',
    params: { selector: 'CSS selector' },
  },
  browser_type: {
    description: 'Type into an input in the active browser tab.',
    params: { selector: 'CSS selector', text: 'string', submit: 'optional boolean' },
  },
  browser_read_page: {
    description: 'Read visible text or HTML from the active browser tab.',
    params: { mode: 'text|html', selector: 'optional CSS selector' },
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
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${LLM_API_KEY}`,
  }

  if (LLM_API_BASE_URL.includes('openrouter.ai')) {
    headers['HTTP-Referer'] =
      process.env.OPENROUTER_HTTP_REFERER ||
      'https://github.com/geunwoo-dev/ai-pendant-simulator'
    headers['X-Title'] = process.env.OPENROUTER_APP_TITLE || 'AI Pendant Simulator'
  }

  return headers
}

/**
 * Multi-turn, optionally multimodal chat request.
 *
 * This is the transport the perceive-act loop runs on. It differs from the
 * single-shot planner path in three ways that matter:
 *  - it takes a full `messages` array, so assistant turns accumulate;
 *  - `content` may be an OpenAI content-part array carrying `image_url` with a
 *    base64 data URL;
 *  - `response_format: json_object` is applied ONLY when there is no image.
 *    Several vision-capable models on OpenRouter reject json_object alongside
 *    image parts, and the failure surfaces as an opaque provider 400.
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
      temperature: 0.1,
      max_tokens: maxTokens,
      ...(hasImages ? {} : { response_format: { type: 'json_object' } }),
      messages,
    }),
  })

  const payload = await response.json()

  if (!response.ok) {
    const message = payload?.error?.message ?? `LLM API request failed (${response.status}).`
    const error = new Error(`${message} (model ${model})`)
    error.status = response.status
    // Lets the caller drop to a text-only step rather than aborting the task.
    error.rejectedImages = hasImages
    throw error
  }

  return payload.choices?.[0]?.message?.content ?? ''
}

export function isFullControlPlanner() {
  return FULL_CONTROL_MODE
}

export async function planCommand(command, options = {}) {
  const { context = null, onProgress = null } = options

  if (FULL_CONTROL_MODE && LLM_ENABLED) {
    try {
      const llmPlan = await planWithLlm(command, {
        context,
        onProgress,
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

  if (!FULL_CONTROL_MODE || !LLM_ENABLED) {
    return planWithRules(command)
  }

  return {
    status: 'unsupported',
    command,
    actions: [],
    requiresConfirmation: true,
    error:
      'LLM could not plan this command. Rephrase the request or check LLM_API_KEY.',
    planner: 'llm',
  }
}

async function planWithLlm(
  command,
  { context = null, onProgress = null } = {},
) {
  const home = os.homedir()
  const machine = await getMachineContext()
  const machinePrompt = formatMachineContextForPrompt(machine)
  const actionSchema = FULL_CONTROL_MODE
    ? FULL_CONTROL_ACTION_SCHEMA
    : SAFE_ACTION_SCHEMA

  const systemPrompt = FULL_CONTROL_MODE
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
- Weather / rain / forecast → get_weather (never play_youtube, never open YouTube).
- Time / date / clock → get_time.
- Translation → translate_text.
- Music / play a song or video → play_youtube (or open_app Spotify when appropriate).
- Open apps with open_app using the installed-app list for THIS device.
- Brightness → set_brightness. Volume/mute → set_volume / set_mute. Reminders → create_reminder.
- Screen darken/cover → show_screen_overlay.
- Prefer dedicated types over long shell/AppleScript.
- Driving an app's interface: prefer ui_menu, then ui_find + ui_click. Fall back to screenshot + mouse_click only when the accessibility tree does not expose the control.
- When the task needs several dependent UI steps whose outcome you cannot predict (fill this form, find that setting, work through this dialog), emit a SINGLE computer_use_task with a clear goal instead of guessing a fixed click sequence.
- Keep plans short (usually 1-3 steps). Use absolute paths under ${home} when possible.
- Destructive actions are allowed when the user explicitly asks.
- If truly impossible, return status "unsupported" with a short reason.`
    : `You are the planning layer for a safe Mac local agent.
Return ONLY valid JSON with status, actions, optional response, and optional error.
Allowed action types: ${JSON.stringify(actionSchema, null, 2)}
Never invent shell commands or paths outside the whitelist.`

  const userContent = [context?.promptBlock, `Current request:\n${command}`]
    .filter(Boolean)
    .join('\n\n')

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${LLM_API_KEY}`,
  }

  // OpenRouter recommends these attribution headers.
  if (LLM_API_BASE_URL.includes('openrouter.ai')) {
    headers['HTTP-Referer'] =
      process.env.OPENROUTER_HTTP_REFERER || 'https://github.com/geunwoo-dev/ai-pendant-simulator'
    headers['X-Title'] = process.env.OPENROUTER_APP_TITLE || 'AI Pendant Simulator'
  }

  onProgress?.({
    phase: 'llm_start',
    message: `Asking ${LLM_MODEL} for a plan`,
  })

  const content = await requestLlmPlanContent({
    headers,
    systemPrompt,
    userContent,
    onProgress,
    command,
  })

  if (!content) {
    throw new Error('LLM returned an empty planning response.')
  }

  onProgress?.({
    phase: 'llm_parse',
    message: 'Parsing the plan',
    partial: content,
  })

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
  if (LLM_REASONING_EFFORT !== 'auto') return LLM_REASONING_EFFORT
  if (attempt > 0) return 'high'
  const text = String(command || '')
  if (DELIBERATION_HINTS.test(text)) return 'high'
  if (text.length > 160) return 'high'
  // Reading a screen is perception, not deliberation.
  if (hasScreenshot) return 'low'
  return 'low'
}

async function requestLlmPlanContent({
  headers,
  systemPrompt,
  userContent,
  onProgress,
  screenshot = null,
  command = '',
  attempt = 0,
}) {
  const useStream = typeof onProgress === 'function'
  const hasScreenshot = Boolean(screenshot?.dataUrl)
  const effort = chooseReasoningEffort(command, { attempt, hasScreenshot })
  // OpenRouter parses multipart content best with the text first.
  const userMessage = hasScreenshot
    ? {
        role: 'user',
        content: [
          { type: 'text', text: userContent },
          { type: 'image_url', image_url: { url: screenshot.dataUrl } },
        ],
      }
    : { role: 'user', content: userContent }

  const response = await fetch(`${LLM_API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: hasScreenshot ? LLM_VISION_MODEL : LLM_MODEL,
      temperature: 0.1,
      max_tokens: LLM_MAX_TOKENS,
      stream: useStream,
      response_format: { type: 'json_object' },
      ...(effort === 'off' ? {} : { reasoning: { effort } }),
      messages: [{ role: 'system', content: systemPrompt }, userMessage],
    }),
  })

  if (!useStream) {
    const payload = await response.json()
    if (!response.ok) {
      throw new Error(
        payload.error?.message ?? `LLM API request failed (${response.status}).`,
      )
    }
    return payload.choices?.[0]?.message?.content ?? ''
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(
      payload.error?.message ?? `LLM API request failed (${response.status}).`,
    )
  }

  if (!response.body) {
    throw new Error('LLM stream body missing.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let lastEmit = 0
  let lastEmittedLen = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n')
    buffer = chunks.pop() ?? ''

    for (const rawLine of chunks) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue

      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }

      const delta =
        payload.choices?.[0]?.delta?.content ??
        payload.choices?.[0]?.message?.content ??
        ''
      if (!delta) continue

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
  }

  onProgress?.({
    phase: 'llm_stream',
    message: 'Model finished drafting',
    partial: content,
    chars: content.length,
  })

  return content
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
])

export function isKnownActionType(type) {
  const name = String(type ?? '')
  return (
    Object.hasOwn(FULL_CONTROL_ACTION_SCHEMA, name) ||
    Object.hasOwn(SAFE_ACTION_SCHEMA, name) ||
    DISPATCH_ALIASES.has(name)
  )
}

function sanitizeActions(actions) {
  // Light per-action cleanup only — never rewrite the whole plan from command text.
  return actions
    .map((action) => {
      if (!action || typeof action !== 'object') {
        return null
      }

      if (
        action?.type === 'run_shell' &&
        /brightness/i.test(String(action.params?.command ?? ''))
      ) {
        return {
          type: 'set_brightness',
          label: action.label || 'Set display brightness',
          params: { level: 0.5 },
        }
      }

      if (
        (action?.type === 'run_shell' || action?.type === 'run_project') &&
        /tkinter|mainloop|overrideredirect|screenwidth|overlay/i.test(
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
