import fs from 'node:fs'
import path from 'node:path'
import { exec, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  forgetBrowserSession,
  listBrowserSessions,
  openBrowserSession,
  resolveSessionRef,
  runBrowserSessionAction,
} from './browserSessions.js'
import { SHELL_TIMEOUT_MS, workspacePath } from './config.js'
import { mintCapsule } from './evidenceCapsules.js'
import { currentCancellationSignal, throwIfAborted } from './jobControl.js'
import { classifySensitivity, maskSecretValue } from './redaction.js'
import { resolveUserPath } from './security.js'
import {
  getDisplayBrightness,
  getOutputVolume,
  setDisplayBrightness,
  setOutputMuted,
  setOutputVolume,
} from './systemControls.js'
import { createReminder } from './reminders.js'
import { childEnv } from './childEnv.js'
import { runCapabilityGapAction } from './capabilityGapsActions.js'
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
import {
  briefingHeadline,
  deliverBriefing,
  getBriefing,
  listBriefings,
  markBriefingPlayed,
  pendantSpeechForBriefing,
  playBriefingOnMac,
} from './audioBrief.js'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
const runningProjects = new Map()

const SHELL_MAX_OUTPUT_BYTES = 10 * 1024 * 1024
/* Grace between "please stop" and "stop": a process that ignores SIGTERM still
 * has to end, or a cancel that reported success would again be a cancel that
 * did nothing. */
const SHELL_KILL_GRACE_MS = 2_000

/*
 * The interpreter is named rather than left to the platform default, because
 * the argv on the record has to BE the argv. node's `shell: true` picks
 * /bin/sh on POSIX and %ComSpec% on Windows; writing down a guess at what it
 * picked is how a record starts drifting from the thing it describes.
 */
const SHELL_BINARY =
  process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'

const shellArgvFor = (command) =>
  process.platform === 'win32'
    ? [SHELL_BINARY, '/d', '/s', '/c', command]
    : [SHELL_BINARY, '-c', command]

export async function executeComputerAction(action) {
  // Never let raw tkinter/python overlay hacks claim success — use the native helper.
  if (
    (action?.type === 'run_shell' || action?.type === 'run_project') &&
    /tkinter|overrideredirect|mainloop|aipendant-screen-overlay|screenwidth/i.test(
      String(action.params?.command ?? ''),
    )
  ) {
    const executed = {
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
    }
    return recordRewrite(await showOverlay(executed), {
      submitted: action,
      executed,
      reason: 'overlay-interception',
      note: 'A tkinter/overrideredirect overlay script was replaced by the native overlay helper. The submitted script was never run.',
    })
  }

  /*
   * The planner can only emit action types llmPlanner.js knows about, and it
   * reaches research through `run_shell scripts/research-brief.mjs …` (see the
   * research block in machineContext.js). Running that as a real subprocess
   * would work right up to the point that matters: a subprocess can only hand
   * back stdout, and a briefing's deliverable is a megabyte of rendered audio
   * that has to ride on the result object for the pendant to play it. So the
   * CLI's own arguments are honoured in-process instead. The script still runs
   * standalone from a terminal — this only short-circuits the agent's copy.
   */
  const researchCall = researchCliCall(action)
  if (researchCall) {
    /* The executed form is named for what it actually is. It used to keep
     * `type: 'run_shell'` with the command swapped out for the parsed flags,
     * so the record claimed a shell run that never happened and did not carry
     * the command line it claimed to have run. */
    const executed = {
      type: researchCall.play ? 'play_briefing' : 'research_brief',
      label: action.label || (researchCall.play ? 'Play briefing' : 'Research brief'),
      params: researchCall.params,
    }
    return recordRewrite(
      await (researchCall.play ? playBriefing(executed) : researchBrief(executed)),
      {
        submitted: action,
        executed,
        reason: 'research-cli-in-process',
        note: "scripts/research-brief.mjs was honoured in-process because a subprocess can only return stdout and a briefing's deliverable is rendered audio. No shell command was run.",
      },
    )
  }

  switch (action.type) {
    /* Real case labels, not a guard above the switch: readDispatchableActionTypes
     * parses this file's own source for `case '...':`, so an early return would
     * work and still leave GET /capabilities reporting these as advertised but
     * undispatchable — the exact drift it exists to catch. */
    case 'briefing_triage':
    case 'review_queue':
    case 'watch_page':
    case 'schedule_routine':
      return runCapabilityGapAction(action)
    case 'run_shell':
      return runShell(action)
    case 'get_battery': {
      // A fixed shell read behind a named action. The result used to come back
      // labelled `run_shell` with no sign of what had been asked for.
      const executed = {
        type: 'run_shell',
        label: action.label || 'Read battery',
        params: { command: 'pmset -g batt' },
      }
      return recordRewrite(await runShell(executed), {
        submitted: action,
        executed,
        reason: 'builtin-shell',
        note: 'get_battery is implemented as a fixed shell read.',
      })
    }
    case 'get_mac_status': {
      const fields = Array.isArray(action.params?.fields)
        ? action.params.fields.map((f) => String(f).toLowerCase())
        : ['all']
      const wantAll = fields.includes('all') || fields.length === 0
      const parts = []
      if (wantAll || fields.includes('battery')) {
        parts.push(
          await runShell({
            type: 'run_shell',
            label: 'battery',
            params: { command: 'pmset -g batt' },
          }),
        )
      }
      if (wantAll || fields.includes('wifi') || fields.includes('network')) {
        parts.push(
          await runShell({
            type: 'run_shell',
            label: 'network',
            params: { command: 'scutil --nwi' },
          }),
        )
      }
      if (wantAll || fields.includes('volume')) {
        parts.push(
          await runShell({
            type: 'run_shell',
            label: 'volume',
            params: {
              command:
                "osascript -e 'output volume of (get volume settings)'",
            },
          }),
        )
      }
      const ok = parts.every((p) => p.ok !== false)
      const message = parts
        .map((p) => p.message || p.stdout || '')
        .filter(Boolean)
        .join('\n')
      return {
        action,
        ok,
        status: ok ? 'success' : 'failed',
        message: message || 'Status collected.',
        stdout: message,
        results: parts,
      }
    }
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
    case 'research_brief':
    case 'research_topic':
      return researchBrief(action)
    case 'play_briefing':
      return playBriefing(action)
    case 'list_briefings':
      return listBriefingsAction(action)
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
    case 'remind_me':
      return scheduleReminderAction(action)
    case 'quick_capture':
      return quickCaptureAction(action)
    case 'recall_capture':
      return recallCaptureAction(action)
    case 'tidy_downloads_preview':
      return tidyPreviewAction(action)
    case 'tidy_downloads_apply':
      return tidyApplyAction(action)
    case 'sweep_folder_preview':
      return sweepPreviewAction(action)
    case 'sweep_folder_apply':
      return sweepApplyAction(action)
    case 'sweep_folder_undo':
      return sweepUndoAction(action)
    case 'preview_plan':
      return previewPlanAction(action)
    case 'start_focus_session':
      return startFocusAction(action)
    case 'end_focus_session':
      return endFocusAction(action)
    case 'plan_my_day':
      return dayPlanAction(action)
    case 'prepare_for_meeting':
      return meetingPrepAction(action)
    case 'meeting_followup':
      return meetingFollowupAction(action)
    case 'triage_inbox':
      return mailTriageAction(action)
    case 'triage_notifications':
      return triageAction(action)
    case 'compose_briefing':
      return composeBriefingAction(action)
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
    case 'browser_open_session':
      return openBrowserTabSession(action)
    case 'browser_list_sessions':
      return listBrowserTabSessions(action)
    case 'browser_close_session':
      return closeBrowserTabSession(action)
    case 'browser_inspect':
      return browserInspectAction(action)
    case 'browser_inspect_act':
      return browserInspectActAction(action)
    default:
      throw new Error(`Unsupported action type: ${action.type}`)
  }
}

/*
 * The quick-capture / reminders / focus family.
 *
 * Each of these is a whole capability behind one action, rather than a plan of
 * five primitive steps, because the owner said it in one breath and every extra
 * step is another chance for the plan to come back half-done. The modules are
 * imported lazily for the same reason the builtins are: an action nobody in
 * this session used should not cost a Calendar or Mail import at boot.
 */
async function quickCaptureAction(action) {
  const { captureNote } = await import('./quickCapture.js')
  const result = captureNote({
    text: action.params?.text || action.params?.note || action.label,
    title: action.params?.title || null,
    mode: action.params?.mode || null,
  })
  return success(action, result.spoken, result)
}

async function recallCaptureAction(action) {
  const { recallCaptures } = await import('./quickCapture.js')
  const captures = recallCaptures({
    query: action.params?.query || action.params?.text || '',
    limit: Number(action.params?.limit) || 10,
  })
  return success(
    action,
    captures.length
      ? captures.map((capture) => capture.value).join('; ')
      : 'Nothing saved that matches that.',
    { captures },
  )
}

async function scheduleReminderAction(action) {
  const { scheduleReminder } = await import('./remindMe.js')
  const result = await scheduleReminder({
    text: action.params?.text || action.params?.title || action.label,
    notes: action.params?.notes || '',
    listName: action.params?.list || action.params?.listName || null,
  })
  return success(action, result.spoken, result)
}

async function tidyPreviewAction(action) {
  const { formatPreview, planTidy } = await import('./downloadsTidy.js')
  const plan = planTidy({
    directory: action.params?.directory || action.params?.path || undefined,
    groupBy: action.params?.groupBy || 'type',
  })
  /* The preview IS the result. Nothing has moved, and the plan id is the only
   * way anything ever will. */
  return success(action, formatPreview(plan), { plan })
}

async function tidyApplyAction(action) {
  const { applyTidy } = await import('./downloadsTidy.js')
  const planId = String(action.params?.planId || action.params?.id || '')
  if (!planId) throw new Error('tidy_downloads_apply needs the planId from a preview.')
  const result = applyTidy(planId)
  return success(action, result.spoken, result)
}

/*
 * Preview / apply / inspect: the two-phase family.
 *
 * The preview actions are ordinary actions. They run the moment they are asked,
 * they return a description, and they change nothing. The apply actions are
 * also ordinary actions — they take a plan id because that is how "do what you
 * showed me" is expressed, not because anything is being withheld. Every other
 * action type in this file still executes immediately and none of them gained a
 * precondition today.
 */
async function sweepPreviewAction(action) {
  const { formatSweep, planSweep } = await import('./folderSweep.js')
  const plan = planSweep({
    directory: action.params?.directory || action.params?.path || undefined,
    staleDays: Number(action.params?.staleDays) || undefined,
    installerStaleDays: Number(action.params?.installerStaleDays) || undefined,
  })
  /* The preview IS the result: nothing has moved and nothing is pending. */
  return success(action, formatSweep(plan), { plan })
}

async function sweepApplyAction(action) {
  const { applySweep } = await import('./folderSweep.js')
  const planId = String(action.params?.planId || action.params?.id || '')
  if (!planId) throw new Error('sweep_folder_apply needs the planId from a preview.')
  const only = action.params?.only ?? action.params?.items ?? null
  const result = await applySweep(planId, { only })
  return success(action, result.spoken, result)
}

async function sweepUndoAction(action) {
  const { undoSweep } = await import('./folderSweep.js')
  const planId = String(action.params?.planId || action.params?.id || '')
  if (!planId) throw new Error('sweep_folder_undo needs the planId of an applied sweep.')
  const result = await undoSweep(planId, { runId: action.params?.runId || null })
  return success(action, result.summary, result)
}

async function previewPlanAction(action) {
  const { foreseePlan, formatPlanPreview } = await import('./planPreview.js')
  const actions = Array.isArray(action.params?.actions) ? action.params.actions : []
  const preview = foreseePlan(actions, { title: action.params?.title || action.label || '' })
  return success(action, formatPlanPreview(preview), { preview })
}

async function browserInspectAction(action) {
  const { formatInspection, inspectPage } = await import('./browserInspect.js')
  const inspection = await inspectPage({
    url: action.params?.url,
    goal: action.params?.goal || action.params?.question || action.label || '',
    look: action.params?.look ?? [],
    maxChars: Number(action.params?.maxChars) || undefined,
    reload: action.params?.reload !== false,
  })
  return success(action, formatInspection(inspection), { inspection })
}

async function browserInspectActAction(action) {
  const { actOnInspection } = await import('./browserInspect.js')
  const inspectionId = String(action.params?.inspectionId || action.params?.id || '')
  if (!inspectionId) {
    throw new Error('browser_inspect_act needs the inspectionId from an inspect.')
  }
  const result = await actOnInspection(inspectionId, {
    text: action.params?.text ?? null,
  })
  return success(action, result.spoken, result)
}

async function startFocusAction(action) {
  const { startFocusSession } = await import('./focusSession.js')
  const session = await startFocusSession({
    minutes: Number(action.params?.minutes) || 25,
    label: action.params?.label || 'Focus',
    mute: action.params?.mute !== false,
  })
  return success(action, session.spoken, session)
}

async function endFocusAction(action) {
  const { endFocusSession } = await import('./focusSession.js')
  const session = await endFocusSession({ reason: action.params?.reason || 'cancelled' })
  return success(action, session.spoken, session)
}

async function dayPlanAction(action) {
  const { buildDayPlan, formatBriefing } = await import('./dayPlan.js')
  const plan = await buildDayPlan({})
  const briefing = formatBriefing(plan, { seconds: Number(action.params?.seconds) || 30 })
  return success(action, briefing.text, { briefing, plan })
}

async function meetingPrepAction(action) {
  const { prepareForNextMeeting } = await import('./meetingPrep.js')
  const result = await prepareForNextMeeting({
    withinHours: Number(action.params?.withinHours) || 24,
  })
  return success(action, result.spoken, result)
}

async function meetingFollowupAction(action) {
  const { prepareMeetingFollowup } = await import('./meetingFollowup.js')
  const result = await prepareMeetingFollowup({
    lookbackHours: Number(action.params?.lookbackHours) || undefined,
    open: action.params?.open !== false,
  })
  return success(action, result.spoken, result)
}

/*
 * The full run is deliberately not returned to the caller. Every action result
 * is written to pendant-jobs.json, and a triage run carries the sender, subject
 * and drafted reply for every unread message — the review list belongs in the
 * owner's folder, not in a job log that other surfaces read.
 */
async function mailTriageAction(action) {
  const { triageInbox } = await import('./mailTriage.js')
  const result = await triageInbox({
    sinceHours: Number(action.params?.sinceHours) || undefined,
    maxDrafts:
      action.params?.maxDrafts === undefined
        ? undefined
        : Number(action.params.maxDrafts),
  })
  return success(action, result.spoken, {
    triage: {
      id: result.id,
      scanned: result.scanned,
      counts: result.counts,
      drafts: result.drafts.length,
      reviewPath: result.reviewPath,
      folder: result.folder,
      sent: result.sent,
    },
  })
}

async function triageAction(action) {
  const { triageNotifications } = await import('./notificationTriage.js')
  const result = await triageNotifications({
    threshold: Number(action.params?.threshold) || undefined,
  })
  return success(action, result.spoken, result)
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

async function composeBriefingAction(action) {
  const { BRIEFING_KINDS, matchBriefingCommand, runBriefing } = await import(
    './briefing.js'
  )
  // The planner sometimes names the brief rather than the kind ("prepare my
  // workday"); recover the kind from the phrasing instead of failing on it.
  const requested = String(action.params?.kind || '').trim()
  const kind =
    requested in BRIEFING_KINDS
      ? requested
      : matchBriefingCommand(requested || action.label || '') || 'morning'

  const result = await runBriefing({
    kind,
    sinks: action.params?.sinks || null,
    play: Boolean(action.params?.play),
  })

  // Audio and the full note stay out of the action result: it is written to
  // pendant-jobs.json on every run, and the brief already lives on disk.
  return success(action, result.spoken, {
    briefing: {
      kind: result.kind,
      title: result.title,
      spoken: result.spoken,
      nextActions: result.nextActions,
      path: result.path ?? null,
      noteId: result.noteId ?? null,
      audioPath: result.audio?.wavPath ?? null,
      seconds: result.audio?.seconds ?? null,
      skipped: result.skipped,
      problems: result.problems,
      sent: result.sent,
    },
  })
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
  const timeoutMs = shellTimeoutFor(action.params?.timeout)

  if (!command) {
    throw new Error('run_shell requires a command.')
  }

  /* The signal for the job this action belongs to, if it has one. Null on the
   * paths that never had a controller (relay jobs, the deterministic fast
   * path) — recorded as such rather than assumed. */
  const signal = currentCancellationSignal()
  throwIfAborted(signal, 'Cancelled before the command started.')

  const run = await spawnShell({ command, cwd, timeoutMs, signal })
  const shell = describeShellRun({ command, cwd, timeoutMs, signal, run })
  const stdout = trimOutput(run.stdout)
  const stderr = trimOutput(run.stderr)

  if (shell.ok) {
    return success(
      action,
      truncateMessage(stdout || stderr || 'Command completed.', 280),
      { stdout, stderr, shell },
    )
  }

  /*
   * A failed command returns rather than throws.
   *
   * promisify(exec) rejected on a non-zero exit, and the only thing that
   * survived was `error.message`: executor.js catches, keeps the message and
   * builds `{ ok: false, status: 'failed' }` by hand. The exit code, the
   * signal, the killed flag and the command's own stdout and stderr — all of
   * which the rejection carried — went on the floor, so "exited 1 with a
   * useful diagnostic on stderr" and "killed by the timeout" were the same
   * record. Returning the same shape executor.js would have built keeps the
   * status identical and keeps the evidence.
   */
  return {
    action,
    ok: false,
    status: run.cancelled ? 'cancelled' : 'failed',
    message: shellFailureMessage(shell, stderr || stdout),
    reason: shell.outcome,
    stdout,
    stderr,
    shell,
  }
}

/**
 * Run a shell command and report what happened to it, whatever that was.
 *
 * Resolves for every outcome a process can have — clean exit, non-zero exit,
 * timeout kill, cancel kill — and rejects only when the child could not be
 * started at all. Callers read the outcome off the record instead of
 * inferring it from whether a promise threw.
 *
 * spawn rather than exec, for two things exec cannot do:
 *
 *   1. `detached` makes the shell a process-group leader, so a cancel can kill
 *      `-pid` and take the whole pipeline with it. exec forwards neither
 *      `detached` nor a group kill, and its own AbortSignal support kills the
 *      /bin/sh only — `sleep 60 | cat` outlives it and the cancel is a lie.
 *   2. the timeout has to be ours, because a record has to distinguish "the
 *      timeout killed it" from "it died of something else", and exec reports
 *      both as `killed: true`.
 */
function spawnShell({ command, cwd, timeoutMs, signal, maxBytes = SHELL_MAX_OUTPUT_BYTES }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let child

    try {
      child = spawn(command, {
        cwd,
        shell: SHELL_BINARY,
        /* Its own process group. See killGroup below. */
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        /* Was `process.env`, which handed the relay key, the agent token and
         * the session secret to every command the planner produced. One
         * `printenv` put them in stdout, and stdout is stored on the job and
         * read back into later prompts. */
        env: childEnv(),
      })
    } catch (error) {
      reject(error)
      return
    }

    const chunks = { stdout: [], stderr: [] }
    const bytes = { stdout: 0, stderr: 0 }
    let truncated = false
    let timedOut = false
    let cancelled = false
    let settled = false
    let escalation = null

    const collect = (stream, name) => {
      stream?.on('data', (chunk) => {
        const room = maxBytes - bytes[name]
        if (room <= 0) {
          truncated = true
          return
        }
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
        if (slice.length < chunk.length) truncated = true
        chunks[name].push(slice)
        bytes[name] += slice.length
      })
      /* A broken pipe on a stream we are draining is not the command's error. */
      stream?.on('error', () => {})
    }
    collect(child.stdout, 'stdout')
    collect(child.stderr, 'stderr')

    /*
     * The group, not the child. `sh -c 'sleep 60 | cat'` runs the sleep and
     * the cat as the shell's children; killing the shell alone orphans them
     * and they keep going, which is exactly the shape of cancel that reports
     * success and changes nothing.
     */
    const killGroup = (which) => {
      try {
        process.kill(-child.pid, which)
      } catch {
        try {
          child.kill(which)
        } catch {
          // Already gone. Nothing to stop.
        }
      }
    }

    const stop = () => {
      killGroup('SIGTERM')
      if (escalation) return
      escalation = setTimeout(() => killGroup('SIGKILL'), SHELL_KILL_GRACE_MS)
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
    /* addEventListener on an already-aborted signal never fires. The window is
     * one synchronous statement wide, and a cancel that lands inside it is
     * exactly the cancel most likely to be tested. */
    if (signal?.aborted) onAbort()

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
        truncated,
        durationMs: Date.now() - startedAt,
      })
    })

    function cleanup() {
      if (timer) clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      signal?.removeEventListener?.('abort', onAbort)
    }
  })
}

/**
 * What ran, and what became of it.
 *
 * The environment is deliberately absent and must stay absent: childEnv.js
 * strips the agent's credentials out of what a command can see, and recording
 * the environment here would put them back on the job record — the same leak,
 * one layer along. The command line itself goes through the project's own
 * redaction for the same reason, since a planner is perfectly capable of
 * writing a token into an argument.
 */
function describeShellRun({ command, cwd, timeoutMs, signal, run }) {
  const recorded = redactCommandLine(command)

  return {
    command: recorded,
    argv: shellArgvFor(recorded),
    cwd: cwd ?? null,
    ok: run.exitCode === 0,
    outcome: run.cancelled
      ? 'cancelled'
      : run.timedOut
        ? 'timed_out'
        : run.signal
          ? 'signalled'
          : run.exitCode === 0
            ? 'exited'
            : 'failed',
    exitCode: run.exitCode,
    signal: run.signal,
    /* `killed` means the process did not choose its own ending. A null exit
     * code with a signal is the only thing that says so. */
    killed: run.exitCode === null,
    timedOut: run.timedOut,
    cancelled: run.cancelled,
    timeoutMs,
    durationMs: run.durationMs,
    outputTruncated: run.truncated,
    /*
     * Whether a cancel could have reached this command at all. False means the
     * caller ran outside a cancellation scope, so /jobs/:id/cancel would have
     * stopped the plan between steps and left this command running — worth
     * saying out loud rather than leaving a reader to assume the stronger
     * guarantee.
     */
    interruptible: Boolean(signal),
  }
}

function shellFailureMessage(shell, output) {
  const tail = output ? `: ${truncateMessage(output, 240)}` : ''

  if (shell.cancelled) {
    return `Command cancelled; its process group was killed${shell.signal ? ` (${shell.signal})` : ''}${tail}`
  }

  if (shell.timedOut) {
    return `Command timed out after ${shell.timeoutMs}ms and was killed${shell.signal ? ` (${shell.signal})` : ''}${tail}`
  }

  if (shell.exitCode === null) {
    return `Command was killed by ${shell.signal ?? 'a signal'}${tail}`
  }

  return `Command exited ${shell.exitCode}${tail}`
}

/*
 * Per-action override, bounded by the configured ceiling.
 *
 * The ceiling is SHELL_TIMEOUT_MS from config.js — the one definition — so the
 * documented environment knob is what an operator thinks it is. A shorter
 * per-action timeout is honoured; a longer one is not, because an action
 * parameter comes from a model and a model must not be able to talk its way
 * past an operator's limit.
 */
function shellTimeoutFor(requested) {
  const value = Number(requested)
  if (!Number.isFinite(value) || value <= 0) return SHELL_TIMEOUT_MS
  return Math.min(value, SHELL_TIMEOUT_MS)
}

/*
 * A command line is stored on the job record and job records are composed into
 * later prompts, so a credential written into an argument would ride along.
 * redaction.js already knows what a credential looks like; this only decides
 * when to call it, because maskSecretValue on ordinary text returns
 * "[withheld]" for the whole string and an audit record of "[withheld]" tells
 * nobody anything.
 */
function redactCommandLine(command) {
  const text = String(command ?? '')
  if (!text) return text
  return classifySensitivity(text) === 'secret' ? maskSecretValue(text) : text
}

/**
 * Attach both forms of a rewritten action to its result.
 *
 * Some actions do not run as submitted, on purpose: an overlay script is
 * replaced by the native helper, and the research CLI is honoured in-process
 * because a subprocess cannot hand back rendered audio. Both rewrites are
 * load-bearing and stay. What was missing is that the result carried only the
 * rewritten form, so the job record — which the ops dashboard renders and
 * later prompts are composed from — described work nobody had asked for and
 * lost every trace of what was asked.
 *
 * `action` stays the EXECUTED form, because a result describes what happened
 * and undo.js reads that field to decide what it can reverse. `rewrite` names
 * both sides and says which is which.
 */
function recordRewrite(result, { submitted, executed, reason, note }) {
  return {
    ...result,
    action: executed,
    rewrite: {
      reason,
      note,
      submitted: describeActionForm(submitted),
      executed: describeActionForm(executed),
    },
  }
}

function describeActionForm(action) {
  return {
    type: String(action?.type ?? ''),
    label: action?.label ? String(action.label) : null,
    params: redactActionParams(action?.params),
  }
}

/* Same reasoning as redactCommandLine, applied to every string in the params:
 * the submitted form of a rewritten action is a new capture, and the thing
 * being captured is usually a shell command. Bounded as well as redacted —
 * this is a record of intent, not a copy of the payload. */
function redactActionParams(params) {
  if (!params || typeof params !== 'object') return {}

  const out = {}
  for (const [key, value] of Object.entries(params)) {
    out[key] =
      typeof value === 'string'
        ? truncateMessage(redactCommandLine(value), 2_000)
        : value
  }
  return out
}

async function runAppleScript(action) {
  const script = String(action.params?.script ?? '').trim()

  if (!script) {
    throw new Error('run_applescript requires a script.')
  }

  const { stdout, stderr } = await execFileAsync('osascript', ['-e', script], {
    timeout: SHELL_TIMEOUT_MS,
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

/*
 * Research → audio brief.
 *
 * Deliberately slow and deliberately cheap: it runs the production web search
 * and the cheap text tier, never Realtime, because by construction nobody is
 * waiting on the other end. The result carries the rendered speech so the
 * pendant can play the actual briefing instead of a sentence about it.
 */
async function researchBrief(action) {
  const { researchTopic } = await import('./research.js')
  const params = action.params ?? {}
  const topic = String(params.topic ?? params.query ?? params.subject ?? '').trim()
  if (!topic) throw new Error('research_brief requires a topic.')

  const research = await researchTopic({
    topic,
    mode: String(params.mode ?? 'brief'),
    match: String(params.match ?? ''),
    maxSources: Number(params.maxSources) || undefined,
  })
  const { briefing, notePath } = deliverBriefing({
    research,
    openNote: params.openNote === true,
  })

  if (params.playOnMac === true) playBriefingOnMac(briefing)

  /*
   * `deliver: "now"` attaches the whole briefing to this result, so a pendant
   * that asked and waited hears it immediately. The default is "later": the
   * spoken confirmation says it is ready, and the audio waits in the store
   * until "play my briefing" comes back for it. That is the whole point of
   * work nobody is waiting on — the owner picks the moment, not the agent.
   */
  const deliverNow = params.deliver === 'now' || params.attachAudio === true
  return success(action, briefingHeadline(briefing), {
    briefingId: briefing.id,
    notePath,
    audioPath: briefing.wavPath,
    opusPath: briefing.opusPath,
    seconds: briefing.seconds,
    sourcesRead: briefing.sourcesRead,
    sourcesSeen: briefing.sourcesSeen,
    sources: briefing.sources,
    headline: briefing.headline,
    ...(deliverNow ? { pendantSpeech: pendantSpeechForBriefing(briefing) } : {}),
  })
}

async function playBriefing(action) {
  const params = action.params ?? {}
  const briefing = getBriefing(String(params.id ?? params.briefingId ?? 'latest'))
  if (!briefing) {
    throw new Error('There are no briefings waiting.')
  }

  if (params.onMac === true) playBriefingOnMac(briefing)
  const pendantSpeech = pendantSpeechForBriefing(briefing)
  markBriefingPlayed(briefing.id)

  return success(action, briefing.spoken || briefingHeadline(briefing), {
    briefingId: briefing.id,
    notePath: briefing.notePath,
    audioPath: briefing.wavPath,
    seconds: briefing.seconds,
    sources: briefing.sources,
    ...(pendantSpeech ? { pendantSpeech } : {}),
  })
}

async function listBriefingsAction(action) {
  const briefings = listBriefings({
    limit: Number(action.params?.limit) || 20,
  }).map(({ spoken, sources, ...rest }) => ({
    ...rest,
    sourceCount: sources?.length ?? 0,
  }))
  const pending = briefings.filter((briefing) => !briefing.played).length
  return success(
    action,
    briefings.length
      ? `${briefings.length} briefing${briefings.length === 1 ? '' : 's'} saved, ${pending} not played yet.`
      : 'No briefings yet.',
    { briefings },
  )
}

/*
 * Recognise the research CLI inside a run_shell command and read its flags.
 * Matching on the script name (not on the owner's words) keeps this a routing
 * detail: anything else the planner shells out to is still a plain shell run.
 */
export function researchCliCall(action) {
  if (action?.type !== 'run_shell' && action?.type !== 'run_project') return null
  const command = String(action.params?.command ?? '')
  if (!/research-brief\.mjs/.test(command)) return null

  const value = (name) => {
    const match = command.match(
      new RegExp(`--${name}[= ]+(?:"([^"]*)"|'([^']*)'|([^\\s]+))`),
    )
    return match ? (match[1] ?? match[2] ?? match[3] ?? '').trim() : ''
  }

  if (/--play\b/.test(command)) {
    return { play: true, params: { id: value('play') || 'latest' } }
  }

  const topic = value('topic')
  if (!topic) return null
  return {
    play: false,
    params: {
      topic,
      mode: value('mode') || 'brief',
      match: value('match'),
      maxSources: Number(value('max-sources')) || undefined,
      openNote: /--open\b/.test(command),
      playOnMac: /--play-on-mac\b/.test(command),
      deliver: /--now\b/.test(command) ? 'now' : 'later',
    },
  }
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

/*
 * The browser readings that carry page content out of the extension, and how to
 * turn each one into the body of an evidence capsule.
 *
 * This is the single chokepoint: every browser_* action in the dispatch table
 * above, and therefore every /execute batch, every relay browser_run_actions
 * job, and everything browserPage.js sends over loopback, arrives here. A read
 * that is not in this table mints nothing, which is why the table is data —
 * adding a new reading action and forgetting its provenance should be one
 * missing line you can see, not a silent gap.
 */
const BROWSER_READINGS = {
  read_page: (params, result) => ({
    kind: String(params?.mode || 'main_text'),
    selector: params?.selector ?? null,
    content: String(result?.content ?? ''),
    truncated:
      Number.isFinite(Number(params?.maxChars)) &&
      String(result?.content ?? '').length >= Number(params.maxChars),
  }),
  snapshot: (_params, result) => ({
    kind: 'snapshot',
    selector: null,
    /* The elements, not the markup: a snapshot's evidentiary content is which
     * controls were on the page and what they were called. */
    content: (Array.isArray(result?.elements) ? result.elements : [])
      .map(
        (element) =>
          `${element?.role ?? '?'} "${element?.name ?? ''}" @ ${element?.selector ?? ''}`,
      )
      .join('\n'),
    truncated: false,
  }),
  capture: () => ({
    kind: 'screenshot',
    selector: null,
    /* Deliberately empty. The capsule records that a screenshot of this page
     * was taken and when; the pixels are not provenance we can safely keep,
     * and redaction.js strips image bytes at every other sink for the same
     * reason. */
    content: '',
    truncated: false,
  }),
}

async function runBrowserAction(action, type) {
  const result = await runBrowserSessionAction({
    type,
    params: action.params ?? {},
    label: action.label ?? type,
  })

  /* Say when a tab had to be opened: otherwise a planner reading the trace
   * cannot tell a page it navigated to from one it merely found. */
  const recovered = result.session?.recovery?.length
    ? ` (opened a tab first: ${result.session.recovery.join(' → ')})`
    : ''

  return success(
    action,
    `${result.message ?? 'Browser action completed.'}${recovered}`,
    { browser: { ...result, evidence: captureBrowserEvidence(action, type, result) } },
  )
}

/**
 * Mint the capsule for a reading that already happened.
 *
 * After the extension has answered, never before, and every failure is
 * swallowed: a store that cannot be written must not turn a page the owner
 * asked for into an error. Provenance is a camera here, exactly as
 * actionReceipts.observeBeforeAction is.
 *
 * Exported for the same reason SUPPORTED_ACTION_TYPES is: which readings carry
 * provenance is a contract worth checking without a live browser on the other
 * end of the bridge.
 */
export function captureBrowserEvidence(action, type, result) {
  const describe = BROWSER_READINGS[type]
  if (!describe) return null

  try {
    const params = action.params ?? {}
    const reading = describe(params, result)
    const minted = mintCapsule({
      url: result?.url || result?.session?.url || params.url || '',
      title: result?.title ?? '',
      region: { kind: reading.kind, selector: reading.selector },
      content: reading.content,
      context: 'browser-extension',
      /* The durable session name, not the numeric tab id: Safari renumbers
       * tabs between commands, so hashing the number would make every poll a
       * different observer and defeat the content addressing. */
      session: result?.session?.id ?? null,
      tabId: Number.isInteger(result?.tabId) ? result.tabId : null,
      requestedUrl: params.url || null,
      recovery: result?.session?.recovery ?? [],
      truncated: reading.truncated,
    })

    return {
      capsuleId: minted.capsuleId,
      state: minted.state,
      collapsed: minted.collapsed,
      contentHash: minted.capsule.contentHash,
      confidence: minted.capsule.confidence,
      redaction: minted.capsule.redaction.counts,
    }
  } catch (error) {
    return { capsuleId: null, error: String(error?.message ?? error) }
  }
}

async function openBrowserTabSession(action) {
  const result = await openBrowserSession(action.params ?? {})
  return success(action, result.message, { browser: result })
}

async function listBrowserTabSessions(action) {
  const sessions = listBrowserSessions()
  return success(
    action,
    sessions.length
      ? `${sessions.length} browser session(s): ${sessions.map((s) => `${s.id}→tab ${s.tabId}`).join(', ')}`
      : 'No browser sessions yet.',
    { browser: { sessions } },
  )
}

async function closeBrowserTabSession(action) {
  const { id } = resolveSessionRef(action.params ?? {})
  const forgotten = forgetBrowserSession(id)
  return success(
    action,
    forgotten
      ? `Released browser session "${id}".`
      : `No browser session named "${id}".`,
    { browser: { sessionId: id, released: forgotten } },
  )
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

/*
 * The dispatch table above, as data, for GET /capabilities.
 *
 * Read out of the switch rather than typed a second time. A hand-kept copy of
 * a 70-entry list is a list that is wrong: `compose_briefing` was added to the
 * dispatcher while this very export was first being written. Whatever the
 * switch can dispatch is what the manifest advertises, always.
 *
 * The floor check is the seatbelt — if a refactor ever changes the dispatcher's
 * shape this fails loudly at startup instead of quietly advertising nothing.
 */
function readDispatchableActionTypes() {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const start = source.indexOf('switch (action.type)')
  const end = source.indexOf('Unsupported action type', start)
  const dispatcher = source.slice(start, end)
  const types = [
    ...new Set([...dispatcher.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1])),
  ].sort()

  if (types.length < 40) {
    throw new Error(
      `computerControl: could not read the action dispatch table (found ${types.length} types).`,
    )
  }

  return Object.freeze(types)
}

export const SUPPORTED_ACTION_TYPES = readDispatchableActionTypes()
