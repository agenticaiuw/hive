import fs from 'node:fs'
import path from 'node:path'
import { exec, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  enqueueBrowserCommand,
  waitForBrowserResult,
} from './browserBridge.js'
import { workspacePath } from './config.js'
import { resolveUserPath } from './security.js'
import {
  getDisplayBrightness,
  getOutputVolume,
  setDisplayBrightness,
  setOutputMuted,
  setOutputVolume,
} from './systemControls.js'
import { createReminder } from './reminders.js'
import {
  getCurrentInputSource,
  selectInputSource,
} from './macos/inputSource.js'
import {
  inferOverlayFraction,
  inferOverlayRegion,
  showScreenOverlay,
} from './screenOverlay.js'
import * as computerUse from './computerUse.js'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
const DEFAULT_SHELL_TIMEOUT_MS = 120_000
const runningProjects = new Map()

export async function executeComputerAction(action) {
  // Never let raw tkinter/python overlay hacks claim success — use the native helper.
  if (
    (action?.type === 'run_shell' || action?.type === 'run_project') &&
    /tkinter|overrideredirect|mainloop|aipendant-screen-overlay|screenwidth/i.test(
      String(action.params?.command ?? ''),
    )
  ) {
    return showOverlay({
      type: 'show_screen_overlay',
      label: action.label || 'Show screen overlay',
      params: {
        region: inferOverlayRegion(
          `${action.label || ''} ${action.params?.command || ''}`,
        ),
        fraction: inferOverlayFraction(
          `${action.label || ''} ${action.params?.command || ''}`,
        ),
        color: 'black',
      },
    })
  }

  switch (action.type) {
    case 'run_shell':
      return runShell(action)
    case 'run_applescript':
      return runAppleScript(action)
    case 'open_url':
      return openUrl(action)
    case 'open_app':
      return openApp(action)
    case 'open_path':
    case 'open_folder':
      return openPath(action)
    case 'write_file':
      return writeFile(action)
    case 'read_file':
      return readFile(action)
    case 'list_directory':
      return listDirectory(action)
    case 'delete_path':
      return deletePath(action)
    case 'copy_path':
      return copyPath(action)
    case 'move_path':
      return movePath(action)
    case 'type_text':
      return typeText(action)
    case 'press_keys':
      return pressKeys(action)
    case 'send_email':
      return sendEmail(action)
    case 'screenshot':
      return computerUse.takeScreenshot(action)
    case 'zoom':
      return computerUse.zoomRegion(action)
    // Accessibility tier — preferred over the pixel tier below.
    case 'ui_snapshot':
      return computerUse.uiSnapshot(action)
    case 'ui_find':
      return computerUse.uiFind(action)
    case 'ui_click':
      return computerUse.uiClick(action)
    case 'ui_menu':
      return computerUse.uiMenu(action)
    case 'ui_wait_for':
      return computerUse.uiWaitFor(action)
    case 'ui_hit_test':
      return computerUse.uiHitTest(action)
    // Pixel tier.
    case 'mouse_move':
      return computerUse.mouseMove(action)
    case 'mouse_click':
      return computerUse.mouseClick(action)
    case 'mouse_double_click':
      return computerUse.mouseClick(action, { defaultClicks: 2 })
    case 'mouse_right_click':
      return computerUse.mouseClick(action, { defaultButton: 'right' })
    case 'mouse_down':
      return computerUse.mouseButton(action, 'down')
    case 'mouse_up':
      return computerUse.mouseButton(action, 'up')
    case 'mouse_drag':
      return computerUse.mouseDrag(action)
    case 'scroll':
    case 'mouse_scroll':
      return computerUse.mouseScroll(action)
    case 'cursor_position':
      return computerUse.readCursorPosition(action)
    case 'list_displays':
      return computerUse.readDisplays(action)
    case 'check_input_permissions':
      return computerUse.readInputPermissions(action)
    case 'computer_use_task':
      return runComputerUseTaskAction(action)
    case 'get_clipboard':
      return getClipboard(action)
    case 'copy_to_clipboard':
    case 'set_clipboard':
      return setClipboard(action)
    case 'create_note':
      return createNote(action)
    case 'run_project':
      return runProject(action)
    case 'search_file':
      return searchFile(action)
    case 'play_youtube':
      return playYoutube(action)
    case 'get_weather':
      return getWeather(action)
    case 'get_time':
      return getTime(action)
    case 'translate_text':
      return translateText(action)
    case 'set_brightness':
      return setBrightness(action)
    case 'get_brightness':
      return readBrightness(action)
    case 'set_volume':
      return setVolume(action)
    case 'get_volume':
      return readVolume(action)
    case 'set_mute':
      return setMute(action)
    case 'create_reminder':
      return addReminder(action)
    case 'set_input_source':
    case 'set_keyboard_language':
      return setInputSource(action)
    case 'get_input_source':
      return readInputSource(action)
    case 'show_screen_overlay':
      return showOverlay(action)
    case 'browser_navigate':
      return runBrowserAction(action, 'navigate')
    case 'browser_click':
      return runBrowserAction(action, 'click')
    case 'browser_type':
      return runBrowserAction(action, 'type')
    case 'browser_read_page':
      return runBrowserAction(action, 'read_page')
    case 'browser_snapshot':
      return runBrowserAction(action, 'snapshot')
    case 'browser_wait_for':
      return runBrowserAction(action, 'wait_for')
    case 'browser_scroll':
      return runBrowserAction(action, 'scroll')
    case 'browser_select':
      return runBrowserAction(action, 'select')
    case 'browser_list_tabs':
      return runBrowserAction(action, 'list_tabs')
    case 'browser_capture':
      return runBrowserAction(action, 'capture')
    case 'browser_press_key':
      return runBrowserAction(action, 'press_key')
    default:
      throw new Error(`Unsupported action type: ${action.type}`)
  }
}

async function addReminder(action) {
  const result = await createReminder({
    title: action.params?.title || action.params?.name,
    due: action.params?.due || action.params?.when || action.params?.date,
    notes: action.params?.notes || action.params?.body || '',
    listName: action.params?.list || action.params?.listName || null,
  })
  return success(
    action,
    `Created reminder “${result.title}”${result.due ? ` due ${result.due}` : ''}`,
    result,
  )
}

async function getWeather(action) {
  const { runWeatherBuiltin } = await import('./builtins/weather.js')
  const location = String(action.params?.location || '').trim()
  const result = await runWeatherBuiltin({
    slots: location ? { location } : {},
    command: location || String(action.label || 'weather'),
  })
  return success(action, result.response, result.metadata)
}

async function getTime(action) {
  const { runTimeBuiltin } = await import('./builtins/time.js')
  const result = await runTimeBuiltin()
  return success(action, result.response, result.metadata)
}

async function translateText(action) {
  const { runTranslateBuiltin } = await import('./builtins/translate.js')
  const text = String(action.params?.text || '').trim()
  const targetLang = String(
    action.params?.targetLang || action.params?.to || '',
  ).trim()
  const result = await runTranslateBuiltin({
    slots: {
      ...(text ? { text } : {}),
      ...(targetLang ? { targetLang } : {}),
    },
    command: text || String(action.label || 'translate'),
  })
  return success(action, result.response, result.metadata)
}

async function setInputSource(action) {
  const query = String(
    action.params?.language ||
      action.params?.source ||
      action.params?.name ||
      action.params?.query ||
      '',
  ).trim()

  if (!query) {
    throw new Error('set_input_source requires a language/source name.')
  }

  const selected = await selectInputSource(query)
  return success(
    action,
    selected.enabledNow
      ? `Enabled and switched typing language to ${selected.name}`
      : `Switched typing language to ${selected.name}`,
    selected,
  )
}

async function readInputSource(action) {
  const current = await getCurrentInputSource()
  if (!current) {
    throw new Error('Could not read the current input source.')
  }
  return success(action, `Current typing language is ${current.name}`, current)
}

async function showOverlay(action) {
  const hint = `${action.label || ''} ${action.params?.command || ''} ${JSON.stringify(action.params || {})}`
  const region =
    action.params?.region ||
    inferOverlayRegion(hint)
  const fraction =
    action.params?.fraction ??
    action.params?.coverage ??
    inferOverlayFraction(hint)
  const percent = action.params?.percent ?? null

  const result = await showScreenOverlay({
    region,
    color: action.params?.color || 'black',
    opacity: action.params?.opacity ?? 1,
    fraction,
    percent,
  })
  return success(
    action,
    `Covered ${result.percent}% of the ${result.region} of the screen (${result.dismiss})`,
    result,
  )
}

async function setBrightness(action) {
  const level = action.params?.level ?? action.params?.brightness ?? action.params?.percent
  const result = await setDisplayBrightness(level)
  return success(
    action,
    `Set display brightness to ${result.percent}%`,
    result,
  )
}

async function readBrightness(action) {
  const result = await getDisplayBrightness()
  return success(action, `Display brightness is ${result.percent}%`, result)
}

async function setVolume(action) {
  const level = action.params?.level ?? action.params?.volume ?? action.params?.percent
  const result = await setOutputVolume(level)
  return success(action, `Set volume to ${result.percent}%`, result)
}

async function readVolume(action) {
  const result = await getOutputVolume()
  return success(
    action,
    result.muted
      ? `Volume is muted (level ${result.percent}%)`
      : `Volume is ${result.percent}%`,
    result,
  )
}

async function setMute(action) {
  const muted = Boolean(
    action.params?.muted ?? action.params?.mute ?? true,
  )
  const result = await setOutputMuted(muted)
  return success(
    action,
    result.muted ? 'Muted output volume' : 'Unmuted output volume',
    result,
  )
}

async function runShell(action) {
  const command = String(action.params?.command ?? '').trim()
  const cwd = action.params?.cwd
    ? resolveUserPath(action.params.cwd)
    : undefined
  const timeout = Number(action.params?.timeout ?? DEFAULT_SHELL_TIMEOUT_MS)

  if (!command) {
    throw new Error('run_shell requires a command.')
  }

  const { stdout, stderr } = await execAsync(command, {
    cwd,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  })

  const output = trimOutput(stdout || stderr || 'Command completed.')

  return success(action, truncateMessage(output, 280), {
    stdout: trimOutput(stdout),
    stderr: trimOutput(stderr),
  })
}

async function runAppleScript(action) {
  const script = String(action.params?.script ?? '').trim()

  if (!script) {
    throw new Error('run_applescript requires a script.')
  }

  const { stdout, stderr } = await execFileAsync('osascript', ['-e', script], {
    timeout: DEFAULT_SHELL_TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
  })

  return success(action, trimOutput(stdout || stderr || 'AppleScript completed.'), {
    stdout: trimOutput(stdout),
    stderr: trimOutput(stderr),
  })
}

async function openUrl(action) {
  const url = String(action.params?.url ?? '').trim()
  await execFileAsync('open', [url])
  return success(action, `Opened ${url}`)
}

async function openApp(action) {
  // Schema seatbelt only: models sometimes emit name/app instead of appName.
  // Exact string from the planner — no hard-coded alias table.
  const appName = String(
    action.params?.appName ??
      action.params?.name ??
      action.params?.app ??
      action.params?.application ??
      '',
  )
    .trim()
    .replace(/\.app$/i, '')

  if (!appName) {
    throw new Error('open_app requires appName.')
  }

  await execFileAsync('open', ['-a', appName])
  return success(action, `Opened ${appName} on Mac`)
}

async function openPath(action) {
  const targetPath = resolveUserPath(action.params?.path)
  await execFileAsync('open', [targetPath])
  return success(action, `Opened ${targetPath}`)
}

async function writeFile(action) {
  const targetPath = resolveUserPath(action.params?.path)
  const content = String(action.params?.content ?? '')
  const append = Boolean(action.params?.append)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  if (append && fs.existsSync(targetPath)) {
    fs.appendFileSync(targetPath, content)
  } else {
    fs.writeFileSync(targetPath, content)
  }

  return success(action, `${append ? 'Appended to' : 'Wrote'} ${targetPath}`, {
    path: targetPath,
  })
}

async function readFile(action) {
  const targetPath = resolveUserPath(action.params?.path)
  const maxBytes = Number(action.params?.maxBytes ?? 100_000)
  const buffer = fs.readFileSync(targetPath)
  const content = buffer.slice(0, maxBytes).toString('utf8')

  return success(action, `Read ${targetPath}`, {
    path: targetPath,
    content,
    truncated: buffer.length > maxBytes,
  })
}

async function listDirectory(action) {
  const targetPath = resolveUserPath(action.params?.path ?? '~')
  const recursive = Boolean(action.params?.recursive)
  const entries = listEntries(targetPath, recursive, 200)

  return success(action, `Listed ${entries.length} entries in ${targetPath}`, {
    path: targetPath,
    entries,
  })
}

async function deletePath(action) {
  const targetPath = resolveUserPath(action.params?.path)
  const stats = fs.statSync(targetPath)

  if (stats.isDirectory()) {
    fs.rmSync(targetPath, { recursive: true, force: true })
  } else {
    fs.unlinkSync(targetPath)
  }

  return success(action, `Deleted ${targetPath}`)
}

async function copyPath(action) {
  const fromPath = resolveUserPath(action.params?.from)
  const toPath = resolveUserPath(action.params?.to)
  fs.mkdirSync(path.dirname(toPath), { recursive: true })
  fs.cpSync(fromPath, toPath, { recursive: true })
  return success(action, `Copied ${fromPath} to ${toPath}`)
}

async function movePath(action) {
  const fromPath = resolveUserPath(action.params?.from)
  const toPath = resolveUserPath(action.params?.to)
  fs.mkdirSync(path.dirname(toPath), { recursive: true })
  fs.renameSync(fromPath, toPath)
  return success(action, `Moved ${fromPath} to ${toPath}`)
}

async function typeText(action) {
  const text = String(action.params?.text ?? '')

  if (!text) {
    throw new Error('type_text requires a non-empty text value.')
  }

  try {
    await computerUse.typeTextViaHelper(text, {
      perCharDelayMs: action.params?.perCharDelayMs,
    })
    return success(action, `Typed ${text.length} characters into the frontmost app`, {
      characters: text.length,
      method: 'cgevent',
    })
  } catch (error) {
    // The secure-input interlock is a refusal, not a transport failure — never
    // retry it through AppleScript.
    if (error.code === 'SECURE_INPUT') {
      throw error
    }

    // Degrade rather than break on a machine where the helper cannot build.
    // AppleScript `keystroke` mangles newlines and unicode, hence the caveat.
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    await execFileAsync('osascript', [
      '-e',
      `tell application "System Events" to keystroke "${escaped}"`,
    ])
    return success(
      action,
      `Typed ${text.length} characters into the frontmost app (AppleScript fallback; unicode and newlines may be unreliable)`,
      { characters: text.length, method: 'applescript', fallbackReason: error.message },
    )
  }
}

async function pressKeys(action) {
  const keys = String(action.params?.keys ?? '').trim().toLowerCase()

  if (!keys) {
    throw new Error('press_keys requires a keys value like cmd+c or enter.')
  }

  try {
    await computerUse.pressKeysViaHelper(keys, { repeat: action.params?.repeat })
    return success(action, `Pressed ${keys}`, { keys, method: 'cgevent' })
  } catch (error) {
    if (error.code === 'SECURE_INPUT') {
      throw error
    }

    // buildKeyScript only knows cmd/ctrl/alt/shift and seven special keys, so
    // this fallback is genuinely narrower — it throws on arrows and F-keys.
    const script = buildKeyScript(keys)
    await execFileAsync('osascript', ['-e', script])
    return success(action, `Pressed ${keys}`, {
      keys,
      method: 'applescript',
      fallbackReason: error.message,
    })
  }
}

async function sendEmail(action) {
  const to = String(action.params?.to ?? '').trim()
  const subject = String(action.params?.subject ?? '').trim()
  const body = String(action.params?.body ?? '')
  const shouldSend = action.params?.send !== false

  if (!to) {
    throw new Error('send_email requires a recipient.')
  }

  const escapedSubject = escapeAppleScript(subject)
  const escapedBody = escapeAppleScript(body)
  const escapedTo = escapeAppleScript(to)
  const sendLine = shouldSend ? 'send newMessage' : '-- left open for review'

  const script = `tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:"${escapedSubject}", content:"${escapedBody}", visible:true}
  tell newMessage
    make new to recipient at end of to recipients with properties {address:"${escapedTo}"}
  end tell
  ${sendLine}
end tell`

  await execFileAsync('osascript', ['-e', script])

  return success(
    action,
    shouldSend
      ? `Sent email to ${to}`
      : `Created draft email to ${to} in Mail.app`,
  )
}

// Entry point for the bounded perceive-act loop. This is the one action the
// user confirms; the loop itself runs entirely server-side, so screenshot bytes
// never cross the agent's own HTTP surface or its 2mb JSON body limit.
async function runComputerUseTaskAction(action) {
  const { runComputerUseTask, computerUseEnabled, visionUploadConsented } = await import(
    './computerUseLoop.js'
  )
  const { isVisionConfigured, requestLlmMessages, visionModelName } = await import(
    './llmPlanner.js'
  )

  if (!computerUseEnabled()) {
    throw new Error(
      'The computer-use loop is disabled. Set PENDANT_COMPUTER_USE_ENABLED=1 to allow the agent to drive the screen.',
    )
  }

  if (!isVisionConfigured()) {
    throw new Error(
      'No vision model is configured. Set LLM_VISION_MODEL to a multimodal model on your LLM_API_BASE_URL.',
    )
  }

  // Screenshots of the desktop are uploaded to a third-party inference
  // provider. That is a materially different privacy posture from the
  // text-only agent, so it is opt-in and never implied by FULL_CONTROL_MODE.
  if (!visionUploadConsented()) {
    throw new Error(
      `Screenshots would be uploaded to api.openai.com (model ${visionModelName()}). Set PENDANT_VISION_UPLOAD_CONSENT=1 to allow that.`,
    )
  }

  const { executeActions } = await import('./executor.js')
  const result = await runComputerUseTask(action.params ?? {}, {
    requestMessages: ({ messages, hasImages }) =>
      requestLlmMessages({ messages, hasImages }),
    execute: executeActions,
  })

  return {
    action,
    ok: result.ok,
    status: result.ok ? 'success' : result.status,
    message: result.message,
    ...result,
  }
}

async function getClipboard(action) {
  const { stdout } = await execAsync('pbpaste')
  return success(action, 'Read clipboard contents', { text: stdout })
}

async function setClipboard(action) {
  await writeClipboard(String(action.params?.text ?? ''))
  return success(action, 'Copied text to clipboard')
}

async function createNote(action) {
  const noteDir = resolveUserPath(action.params?.directory ?? workspacePath)
  const filename = path.basename(String(action.params?.filename ?? 'note.md'))
  const notePath = path.join(noteDir, filename)
  fs.mkdirSync(noteDir, { recursive: true })
  fs.writeFileSync(notePath, String(action.params?.content ?? ''))
  await execFileAsync('open', [notePath])
  return success(action, `Created note ${notePath}`, { path: notePath })
}

async function runProject(action) {
  const projectPath = resolveUserPath(action.params?.path)

  if (runningProjects.has(projectPath)) {
    return success(action, `Project is already running at ${projectPath}`)
  }

  const command = String(action.params?.command ?? 'npm run dev')
  const child = spawn(command, {
    cwd: projectPath,
    detached: true,
    stdio: 'ignore',
    shell: true,
  })
  child.unref()
  runningProjects.set(projectPath, child.pid)

  return success(action, `Started "${command}" in ${projectPath}`)
}

async function runBrowserAction(action, type) {
  const command = enqueueBrowserCommand({
    type,
    params: action.params ?? {},
    label: action.label ?? type,
  })
  const result = await waitForBrowserResult(command.commandId)

  if (result.status === 'failed') {
    throw new Error(result.error ?? 'Browser extension action failed.')
  }

  return success(action, result.result?.message ?? 'Browser action completed.', {
    browser: result.result,
  })
}

async function searchFile(action) {
  const home = resolveUserPath('~')
  const requestedRoot = resolveUserPath(action.params?.root ?? '~/Desktop')
  // Never scan the entire home folder — it hangs and feels like "no response".
  const root =
    requestedRoot === home || requestedRoot === '/'
      ? resolveUserPath('~/Desktop')
      : requestedRoot
  const query = String(action.params?.query ?? '')
  const matches = searchFiles(root, query, {
    maxMatches: 20,
    maxVisited: 800,
  })

  return success(
    action,
    matches.length
      ? `Found ${matches.length} match(es) under ${root}`
      : `No matches for "${query}" under ${root}`,
    { matches, root },
  )
}

async function playYoutube(action) {
  const query = String(action.params?.query ?? action.params?.q ?? '').trim()
  if (!query) {
    throw new Error('play_youtube requires a query.')
  }

  const video = await resolveYoutubeVideo(query)
  const watchUrl = `https://www.youtube.com/watch?v=${video.videoId}&autoplay=1`

  await execFileAsync('open', [watchUrl])

  // Give Chrome a moment, then nudge playback if a results page was somehow focused.
  try {
    await execFileAsync('osascript', [
      '-e',
      `tell application "Google Chrome"
  activate
  delay 1.2
  if (count of windows) > 0 then
    set URL of active tab of front window to "${watchUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
  end if
end tell`,
    ])
  } catch {
    // open() already launched the watch URL; Chrome automation is best-effort.
  }

  return success(
    action,
    `Playing “${video.title || query}” on YouTube`,
    {
      query,
      videoId: video.videoId,
      title: video.title || null,
      url: watchUrl,
    },
  )
}

async function resolveYoutubeVideo(query) {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`
  const response = await fetch(searchUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })

  if (!response.ok) {
    throw new Error(`YouTube search failed (${response.status}).`)
  }

  const html = await response.text()
  const videoIdMatches = [
    ...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g),
  ].map((match) => match[1])

  const uniqueIds = [...new Set(videoIdMatches)]
  if (!uniqueIds.length) {
    throw new Error(`No YouTube video found for “${query}”.`)
  }

  const videoId = uniqueIds[0]
  const titleMatch = html.match(
    new RegExp(
      `"videoId":"${videoId}".{0,400}?"title":\\{"runs":\\[\\{"text":"([^"]+)"\\}\\]`,
      's',
    ),
  )

  return {
    videoId,
    title: titleMatch?.[1]?.replace(/\\u0026/g, '&') || query,
  }
}

function listEntries(targetPath, recursive, limit) {
  const entries = []
  const queue = [targetPath]

  while (queue.length && entries.length < limit) {
    const currentPath = queue.shift()
    const children = fs.readdirSync(currentPath, { withFileTypes: true })

    for (const child of children) {
      const childPath = path.join(currentPath, child.name)
      entries.push({
        path: childPath,
        name: child.name,
        type: child.isDirectory() ? 'directory' : 'file',
      })

      if (recursive && child.isDirectory()) {
        queue.push(childPath)
      }

      if (entries.length >= limit) {
        break
      }
    }
  }

  return entries
}

function searchFiles(root, query, { maxMatches = 20, maxVisited = 800 } = {}) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = []
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  const skipNames = new Set([
    'node_modules',
    'Library',
    '.git',
    'Caches',
    'Cache',
    'DerivedData',
  ])

  while (queue.length && matches.length < maxMatches && visited < maxVisited) {
    const { dir: currentPath, depth } = queue.shift()
    let children

    try {
      children = fs.readdirSync(currentPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const child of children) {
      if (child.name.startsWith('.') || skipNames.has(child.name)) {
        continue
      }

      visited += 1
      const childPath = path.join(currentPath, child.name)

      if (child.isDirectory()) {
        if (depth < 4) {
          queue.push({ dir: childPath, depth: depth + 1 })
        }
      } else if (
        !tokens.length ||
        tokens.every((token) => child.name.toLowerCase().includes(token))
      ) {
        matches.push(childPath)
      }

      if (matches.length >= maxMatches || visited >= maxVisited) {
        break
      }
    }
  }

  return matches
}

function buildKeyScript(keys) {
  const parts = keys.split('+').map((part) => part.trim())
  const key = parts.pop()
  const modifiers = parts.map((modifier) => {
    if (modifier === 'cmd' || modifier === 'command') {
      return 'command down'
    }

    if (modifier === 'ctrl' || modifier === 'control') {
      return 'control down'
    }

    if (modifier === 'alt' || modifier === 'option') {
      return 'option down'
    }

    if (modifier === 'shift') {
      return 'shift down'
    }

    throw new Error(`Unsupported modifier: ${modifier}`)
  })

  const keyLiteral = specialKeyLiteral(key)
  const usingClause = modifiers.length
    ? ` using {${modifiers.join(', ')}}`
    : ''

  return `tell application "System Events" to keystroke ${keyLiteral}${usingClause}`
}

function specialKeyLiteral(key) {
  const specialKeys = {
    enter: 'return',
    return: 'return',
    tab: 'tab',
    escape: 'escape',
    esc: 'escape',
    space: 'space',
    delete: 'delete',
    backspace: 'delete',
  }

  if (specialKeys[key]) {
    return specialKeys[key]
  }

  return `"${key.replace(/"/g, '\\"')}"`
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function writeClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error('pbcopy failed.'))
      }
    })
    child.stdin.end(text)
  })
}

function trimOutput(value) {
  return String(value ?? '').trim()
}

function truncateMessage(value, maxLength) {
  const text = trimOutput(value)

  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength - 3)}...`
}

function success(action, message, extra = {}) {
  return {
    action,
    ok: true,
    status: 'success',
    message,
    ...extra,
  }
}
