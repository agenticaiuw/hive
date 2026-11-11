import fs from 'node:fs'
import path from 'node:path'
import { AGENT_TOKEN, FULL_CONTROL_MODE, PORT } from './config.js'
import { classifyAction } from './actionRisk.js'
import { SUPPORTED_ACTION_TYPES } from './computerControl.js'
import { staticReversibility } from './actionReceipts.js'
import {
  actionDescription as plannerActionDescription,
  isFullControlPlanner,
  isKnownActionType,
  isLlmPlannerEnabled,
  isVisionConfigured,
  visionModelName,
} from './llmPlanner.js'
import { isPublicPath } from './httpPolicy.js'

/*
 * One authoritative answer to "what can this agent do, and where does it live".
 *
 * Nothing published it before. /health returns four fields, so every remote
 * caller — the relay, the Realtime planner, a reconnaissance agent — had to
 * guess route names and action types, and a wrong guess came back as 401
 * (token middleware runs before routing), which reads as "exists but
 * forbidden". Whole rounds were spent probing a surface that could simply
 * describe itself.
 *
 * Everything here is DERIVED, not typed out: routes come from the live Express
 * router, action types from the executor's dispatch table, planner coverage
 * from llmPlanner's own registry, hands-free status from actionRisk. A
 * hand-maintained list would be wrong within a week — the drift it is meant to
 * expose is exactly the drift it would develop.
 *
 * WHAT CANNOT BE DERIVED IS THE PROSE, and the prose turned out to be the
 * whole product. This manifest is read by machines, not people:
 * shared/capabilityRegistry.js scores IDF-weighted token overlap between what
 * a caller asked for and what each capability SAYS about itself. A capability
 * that says nothing can only be found by spelling its path or its action type,
 * so a caller asking to "withdraw a source" never found POST /evidence/revoke
 * (0.379 against a 0.45 bar) and one asking to "record that the pendant
 * downloaded the audio" never found POST /pipeline/events (0.259). Nine
 * well-specified grants produced three matches and no live calls, entirely on
 * spelling.
 *
 * So there are three prose tables, in order of precedence per capability:
 *   ROUTE_NOTES   one line per `METHOD /path`
 *   GROUP_NOTES   fallback for a whole URL family, keyed by first path segment
 *   ACTION_NOTES  executor action types llmPlanner.js does not already describe
 * and llmPlanner's own action schema underneath ACTION_NOTES, because 82 of
 * the executor's types were already described there and the manifest simply
 * never published it.
 *
 * Three rules for anything written into them. Use the words a caller would ASK
 * with — revoke/withdraw/retract/invalidate — not the words the implementer
 * used to name the function; that is vocabulary, not keyword stuffing, and its
 * absence is the measured bug. Never claim more than the thing does: an empty
 * description loses a match, but an inflated one wins the wrong match and the
 * caller never finds out.
 *
 * And the one that is not obvious until you measure it: A NEGATION IS READ AS
 * A MENTION. The matcher is a bag of words and cannot see "not". "Deliberately
 * says almost nothing — no relay state, no permissions" made GET /health the
 * rival of the permissions probe and of every question about the relay, purely
 * on the words it used to disclaim them. So negate the EFFECT ("it sends
 * nothing", "it runs nothing", "the drafts stay drafts") and do not name a
 * neighbouring capability's subject to say you are not it. For the same
 * reason, spend a discriminating word only where it identifies the thing:
 * "Mac" written into thirty descriptions is worth nothing in any of them, and
 * it was worth something in `machine-context` before that happened.
 *
 * The manifest reports `undocumentedGroups`, `undocumentedRoutes` and
 * `actions.undocumented`, so its own rot stays visible in its own output.
 */

/* Where each URL family is implemented, so a caller can read one file next.
 * The `what` here is the fallback for any route with no ROUTE_NOTES line. */
const GROUP_NOTES = {
  '': {
    what: 'Root: static dashboard bundle.',
    module: 'local-agent/server.js',
  },
  health: {
    what: 'Unauthenticated liveness. Deliberately says almost nothing.',
    module: 'local-agent/httpPolicy.js',
  },
  capabilities: {
    what: 'This manifest.',
    module: 'local-agent/capabilityManifest.js',
  },
  plan: {
    /* This said "Does not run them" until someone read the router: a command
     * the deterministic tier recognises is executed inside /plan and comes
     * back with an empty action list. An overselling description costs a
     * match; an underselling one about side effects costs more than that. */
    what:
      'Turn a command into a plan of executor actions — except on the deterministic fast path, where it runs the command outright and returns the result.',
    module: 'local-agent/orchestrator.js + llmPlanner.js',
  },
  execute: {
    what: 'Run an approved action list. Returns a receipt per action.',
    module: 'local-agent/orchestrator.js + executor.js',
  },
  sessions: {
    what: 'Conversation transcripts kept per session.',
    module: 'local-agent/sessionStore.js',
  },
  jobs: {
    what: 'Every plan/execute run, its receipts, cancel and undo.',
    module: 'local-agent/jobTracker.js + undo.js',
  },
  logs: {
    what: 'Flat activity log of executed commands.',
    module: 'local-agent/logger.js',
  },
  thinking: {
    what: 'Live planner reasoning traces (SSE on /thinking/stream).',
    module: 'local-agent/thinkingTrace.js',
  },
  pipeline: {
    what: 'Pendant audio pipeline runs and their recordings.',
    module: 'local-agent/pipelineTrace.js + pipelineAudio.js',
  },
  'context-graph': {
    what: 'Entities and relations the agent remembers.',
    module: 'local-agent/contextGraph.js',
  },
  projects: {
    what: 'Working project the agent is currently oriented around.',
    module: 'local-agent/projectMemory.js',
  },
  'machine-context': {
    what: 'Discovered host inventory: apps, CLIs, macOS version, timezone.',
    module: 'local-agent/machineContext.js',
  },
  ops: {
    what: 'Aggregate status and one-shot snapshot for dashboards and relay.',
    module: 'local-agent/server.js',
  },
  browser: {
    what: 'Chrome extension bridge: heartbeat, command queue, tab sessions.',
    module: 'local-agent/browserBridge.js + browserSessions.js',
  },
  evidence: {
    what: 'Provenance for every browser reading: capsules, TTL, revocation with an audit tombstone.',
    module: 'local-agent/evidenceCapsules.js',
  },
  routines: {
    what: 'Scheduled work the owner is not waiting on.',
    module: 'local-agent/routines.js',
  },
  briefing: {
    what: 'Spoken briefings assembled for the pendant.',
    module: 'local-agent/briefing.js + audioBrief.js',
  },
  research: {
    what: 'Multi-source research runs and their rendered answers.',
    module: 'local-agent/research.js',
  },
  mail: {
    what:
      'Inbox triage: four buckets, drafted replies, reviewable on disk. Composes and stores only — never sends.',
    module: 'local-agent/mailTriage.js',
  },
  'meeting-followup': {
    what: 'Post-meeting workspace: notes opened, draft summary, related unread mail.',
    module: 'local-agent/meetingFollowup.js',
  },
  watches: {
    what: 'Standing page watches and the reports they have raised.',
    module: 'local-agent/pageWatch.js',
  },
  forms: {
    what: 'Web form fills, staged and reviewable before submission.',
    module: 'local-agent/formFill.js',
  },
  origins: {
    what:
      'One question read across several authenticated origins at once, routed between the owner\'s Safari and the relay browser. Per-origin provenance and fetch age; reads only.',
    module: 'local-agent/originFanOut.js',
  },
  memory: {
    what: 'Durable facts, separate from the per-session transcript.',
    module: 'local-agent/memoryService.js',
  },
  routing: {
    what: 'Which planner tier handled which request, and what it cost.',
    module: 'local-agent/routingStats.js',
  },
  journal: {
    what:
      'Execution journal, derived on read: what ran, in what order, what it touched, which tier planned it, whether it can be undone. Observes only.',
    module: 'local-agent/executionJournal.js',
  },
  observe: {
    what:
      'Host state a journal entry happened in: foreground app, running apps, whether synthesized input reaches the screen, browser sessions, path roots.',
    module: 'local-agent/executionJournal.js',
  },
  dashboard: {
    what: 'Ops dashboard HTML. Issues a loopback session cookie.',
    module: 'local-agent/dashboardSession.js',
  },
  permissions: {
    what:
      'Asking macOS for the grants this agent needs, at a moment the owner chose. One route, and it interrupts on purpose.',
    module: 'local-agent/macos/permissions.js',
  },
  focus: {
    what:
      'A focus / deep-work / pomodoro session: hides the distracting apps and mutes output volume for a set number of minutes, then restores them. Software only — it turns on no Do Not Disturb mode and blocks no website.',
    module: 'local-agent/focusSession.js',
  },
  sweep: {
    what:
      'Clean-up triage for one folder of loose files: keep, archive, file away, or delete, staged as a plan the owner applies by id. This is the family that can delete; every deletion is snapshotted first so undo can put it back.',
    module: 'local-agent/folderSweep.js',
  },
  tidy: {
    what:
      'Filing only: sorts the loose files in one folder into subfolders by type or by month. It moves and never deletes; sweep is the one that deletes.',
    module: 'local-agent/downloadsTidy.js',
  },
  capture: {
    what:
      'Quick captures: short things the owner said to save for later, and the search back over them.',
    module: 'local-agent/quickCapture.js',
  },
  'day-plan': {
    what:
      "Today's calendar events and open reminders, merged into one short spoken plan for the day.",
    module: 'local-agent/dayPlan.js',
  },
  'meeting-prep': {
    what: 'Preparation assembled BEFORE a meeting starts: who, what, and which documents.',
    module: 'local-agent/meetingPrep.js + meetingPrepQueue.js',
  },
  notifications: {
    what:
      'Interruption triage: what is actually worth surfacing right now, scored rather than listed.',
    module: 'local-agent/notificationTriage.js',
  },
  preview: {
    what:
      'Foresee what a list of executor actions would touch, before anyone approves it. Runs nothing.',
    module: 'local-agent/planPreview.js',
  },
  reminders: {
    what: 'Reminders parsed out of ordinary speech and written into Apple Reminders.',
    module: 'local-agent/remindMe.js',
  },
  ledger: {
    what: 'The append-only record of actions taken, and the verification over it.',
    module: 'local-agent/actionLedger.js + actionLedgerRoutes.js',
  },
  prepare: {
    what: 'Work staged for a human decision, with everything the decision needs attached.',
    module: 'local-agent/prepareApprove.js',
  },
  approve: {
    what: 'The decision itself on something previously staged: approve or reject.',
    module: 'local-agent/prepareApprove.js',
  },
  workbench: {
    what: 'Multi-step edits grouped into one transaction that commits or rolls back together.',
    module: 'local-agent/workbenchRoutes.js + workbenchTransaction.js',
  },
  catchup: {
    what: 'What changed while the owner was away, per source.',
    module: 'local-agent/catchupDigest.js + catchupSources.js',
  },
  'vision-loop': {
    what: 'Screenshot-and-decide loops: the agent looks at the screen, acts, and looks again.',
    module: 'local-agent/visionLoop.js + visionLoopRoutes.js',
  },
  'browser-jobs': {
    what:
      "Browser work queued to run later against the owner's logged-in browser, and the drain that works through it.",
    module: 'local-agent/browserJobRunner.js',
  },
  'form-previews': {
    what:
      'A filled form payload held for the owner to hear and approve before anything is submitted. Nothing in this family submits.',
    module: 'local-agent/formPreview.js',
  },
  'audio-retention': {
    what: 'How long captured and spoken audio is kept, and the sweep that deletes it.',
    module: 'local-agent/audioRetention.js',
  },
  'goal-router': {
    what:
      "One goal in, a body named for each part of it: which surface can actually do each clause right now with the credential in hand, rather than binding the whole goal to whichever body its name came from.",
    module: 'local-agent/goalRouter.js + goalRouterSurfaces.js',
  },
  'handle-this': {
    what:
      "\"Handle this\": read one question off several of the owner's open logged-in tabs at once through different lenses, and report what those readings agree and disagree on.",
    module: 'local-agent/handleThis.js + handleThisRoutes.js + handleThisPanel.js',
  },
  crosscheck: {
    what:
      "Ask one question of a page behind the owner's login several different ways and surface the DISAGREEMENT between the readings rather than resolving it. It does not make an answer right; it makes a wrong one visible.",
    module: 'local-agent/crossCheck.js',
  },
  'voice-notes': {
    what:
      'What happens to a pendant voice note after the transcript exists: where it was filed, what it was attached to, what it is still waiting on. It captures nothing itself.',
    module: 'local-agent/voiceNotes.js',
  },
}

/*
 * One line per route, keyed `METHOD /path`, overriding its family's note.
 *
 * This table is the fix for the measured failure described at the top of the
 * file: a family blurb is shared by every sibling, so /evidence/revoke and
 * /evidence/sweep were indistinguishable to a matcher and neither carried the
 * verb a caller would actually use. Absent from here, a route still falls back
 * to GROUP_NOTES and nothing gets worse; present, it says what IT does and
 * what it is not for.
 */
const ROUTE_NOTES = {
  /* ---- permissions ---- */
  'POST /permissions/request':
    'Ask macOS for the grants this agent is missing — Accessibility, Screen Recording, Automation — by really raising the system dialog on the owner\'s screen now. Grant it, allow it, "give it permission", "let it control my Mac". It interrupts on purpose and only when asked; a grant applies to this binary alone, and Accessibility does not take effect until the agent is restarted. To find out what is granted WITHOUT a dialog, read GET /observe or the permissions block of this manifest instead.',

  /* ---- focus ---- */
  'POST /focus':
    'Start a focus / deep-work / pomodoro session for N minutes: hides the distracting apps (Messages, Mail, Slack, Discord, Telegram, WhatsApp, Signal, Music, Spotify, TV, News, Photos by default) and mutes system output volume, then announces the end out loud. Hides rather than quits, so nothing is lost. It turns on no Do Not Disturb mode, suppresses no alert, and blocks no website. 409 if one is already under way.',
  'GET /focus':
    'Read the current focus session: whether one is under way, how many minutes remain, which apps were hidden and whether volume was muted. Read-only.',
  'DELETE /focus':
    'End the focus session early and put things back: unhides only the apps this session hid, unmutes only if this session muted. Stop, cancel, quit, "I am done". 404 when none is under way.',

  /* ---- sweep ---- */
  'GET /sweep/survey':
    'Look at a folder and report what is in it — how old each loose file is, which look like partial downloads or installers or screenshots, which are byte-identical duplicates. Purely a read: it writes no plan and moves nothing. Default folder is Downloads.',
  'POST /sweep/preview':
    'Propose a clean-up of one folder and stage it as a plan: which loose files to keep, archive, file into a dated folder, or delete, with a collision-free destination for each. Nothing moves and nothing is deleted — this returns a plan id, and applying it is a separate call. Use for "what would you get rid of", "show me before you touch anything".',
  'GET /sweep':
    'List the clean-up plans proposed so far, newest first, with their ids and counts. Read-only history; it does not propose a new one.',
  'GET /sweep/:planId':
    'Read one staged clean-up plan back item by item, plus any runs already applied to it. Read-only: this is what was proposed and what happened, not a re-proposal.',
  'POST /sweep/:planId/apply':
    'Carry out a staged clean-up plan: move the archives, file the screenshots, delete the debris. Pass `only` with item ids to do a subset. Files that changed or vanished since the preview are skipped as drift rather than guessed at. This is the destructive half; deletes are real unlinks, snapshotted first so undo can restore them.',
  'POST /sweep/:planId/undo':
    'Reverse a clean-up run: put the moved files back where they were and restore the deleted ones from the snapshot taken before the delete. Undo, revert, "put it back", "I changed my mind". A file too large to have been snapshotted cannot come back, and the plan says so up front.',

  /* ---- tidy ---- */
  'POST /tidy/preview':
    'Propose filing the loose files in one folder into subfolders — by type (Images, Screenshots, Documents, Installers, Archives, Audio, Video, Code) or by month — and stage it as a plan. Lists every from → to move plus name collisions and duplicate content. Moves nothing yet, and nothing here deletes: for getting rid of things use the sweep family.',
  'GET /tidy':
    'List the filing plans proposed so far with their move counts. Read-only history.',
  'POST /tidy/:planId/apply':
    'Carry out a staged filing plan: rename each loose file into its subfolder. Never overwrites — a name clash gets a suffix — and files that changed or vanished since the preview are reported as drift and skipped. Deletes nothing.',
  'POST /tidy/:planId/undo':
    'Move every file a filing run relocated back to where it came from. Nothing was deleted, so nothing has to be restored.',

  /* ---- memory ---- */
  'GET /memory/facts':
    'Read back the durable facts the agent has been told to remember, with their provenance, confidence and expiry. Filterable by kind and surface. Read-only, and it does not count as using a fact.',
  'POST /memory/facts':
    'Remember one fact: store a value under a key, keeping the displaced value as its previous version. Use for "remember that", "note that", "keep in mind". It stores what it is given — it does not read free text and extract facts out of it.',
  'DELETE /memory/facts/:idOrKey':
    'Forget one remembered fact by id or key — delete it, drop it, "that is wrong". Removes the row outright; it does not redact or tombstone, and it deletes no file on disk.',
  'GET /memory/domains':
    'Read the remembered facts of one capability domain (email, calendar, files, music, system, browser) — accounts, defaults, contacts, sites, places — best match first with secrets masked; without a domain, list every domain fact. Look up, recall, consult, "which account". Read-only, and it decides nothing.',
  'POST /memory/prune':
    'Garbage-collect the memory store: drop expired facts, facts untouched for about a month, and per-kind overflow. Clean up, trim, shrink. Preferences and permissions are exempt and revocation tombstones are kept. It touches no file and no other store.',
  'POST /memory/sync-graph':
    'Import durable entities out of the context graph into memory facts, one way and idempotently. Backfill, pull in, sync. It never writes back into the graph and deletes nothing on either side.',
  'POST /memory/browser-findings':
    'Save the specific claims a browser job read off a page as short-lived facts keyed by host, with the evidence capsule and URL that back them. It stores the findings, not the page: no HTML, no page text, no screenshot.',

  /* ---- context graph ---- */
  'GET /context-graph':
    'Read the whole entity-and-relation graph — people, projects, files, tasks and how they connect — plus pointers to the most recent of each and the active project. Read-only, and separate from the /memory fact store.',
  'POST /context-graph/entities':
    'Add or update one entity in the graph: a person, project, file, resource or task. Creates no relations.',
  'PATCH /context-graph/entities/:entityId':
    'Edit one existing entity: rename it, change its type, correct its attributes. An attributes body replaces the object rather than merging into it. 404 if there is no such entity.',
  'DELETE /context-graph/entities/:entityId':
    'Remove one entity from the graph. Facts previously imported from it into memory are left alone.',
  'POST /context-graph/relations':
    'Connect two entities that already exist — works with, belongs to, relates to. Link, associate, join.',
  'DELETE /context-graph/relations/:relationId':
    'Remove one connection between two entities. Unlink, disconnect. Both entities stay.',
  'POST /context-graph/reset':
    'Wipe the context graph: every entity and relation, tombstoned. Start over, clear, erase. It does not clear remembered facts, projects, routines, or anything on disk.',
  'POST /context-graph/demo':
    'Overwrite the graph with canned demo data for a walkthrough. Destructive and not a merge — real content is replaced, not added to.',

  /* ---- projects ---- */
  'GET /projects':
    'List every project the agent knows about plus which one is currently active. Read-only.',
  'GET /projects/active':
    'Read the project the agent is currently oriented around: its name, path, summary, goals, people and open threads. Read-only.',
  'POST /projects/active':
    'Switch to a different project the agent already knows about. It selects an existing one; there is no route here that creates or deletes a project.',
  'PATCH /projects/active':
    'Edit the currently active project in place — rename it, set its summary, add a goal, note the people or the open threads. It cannot switch projects and cannot edit any other one.',

  /* ---- routines ---- */
  'GET /routines':
    'List the standing scheduled work: each routine, when it next runs, when it last ran and how that went. Read-only. Use for "what is scheduled", "what runs automatically".',
  'POST /routines':
    'Schedule a command to run on its own, daily or weekly at a time, or on an interval. Use for "every morning", "each weekday", "every fifteen minutes". It registers the schedule and does not run it now; it only fires while this agent is up.',
  'PATCH /routines/:routineId':
    'Change a scheduled routine: rename it, edit its command, move its time, or pause it by disabling it. A new schedule recomputes when it next runs.',
  'DELETE /routines/:routineId':
    'Delete a scheduled routine permanently. Stop it, cancel it, remove it. To keep it but stop it firing, disable it instead.',
  'POST /routines/:routineId/run':
    'Run a scheduled routine right now, ahead of its schedule and even when disabled. This really executes it, side effects included — it is not a dry run and not a preview.',

  /* ---- evidence ---- */
  'GET /evidence':
    'Read the provenance ledger for everything the agent has read off a web page: which capsules are live, expired, revoked or retired, which hosts they came from, and which jobs cited which capsule. It also names the paths that mint no capsule at all, so an absence is legible. Read-only, and it can block no browser action.',
  'GET /evidence/:capsuleId':
    'Open one evidence capsule: the exact reading a claim rests on, its source URL and when it expires. An expired or revoked capsule comes back with its body withheld rather than missing, so the record of the reading survives the content.',
  'POST /evidence/revoke':
    'Revoke a source: withdraw, retract or invalidate a page reading the agent has already taken, so nothing may go on citing it. Selected by capsule id, exact url, or a whole host — "forget what you read on that site", "that page was wrong", "delete what you took from there". Deletes the stored content and cascades to the facts derived from it, and leaves a permanent tombstone naming what was revoked; the row itself is never removed. It does not block future reads of the same page and it does not undo any action already taken on that reading.',
  'POST /evidence/sweep':
    'Housekeeping over the evidence store: null out the bodies of capsules that expired a while ago. Purge stale text, drop old readings, reclaim space. It never touches a live capsule, is not how you revoke one, and is not required for correctness — an expired body is already withheld on read.',

  /* ---- browser bridge ---- */
  'POST /browser/heartbeat':
    "Extension-facing: a browser extension checks in and says it is alive, naming its device, current tab, window, URL and version. Register, connect, announce. It carries no work back and reads no page.",
  'GET /browser/poll':
    'Extension-facing: claim at most one queued browser command to go and do. Pull work, take the next task, drain the queue. Returns empty immediately when there is nothing — it does not hold the request open, and it creates no work. This is the only way a command leaves the queue.',
  'POST /browser/result/:commandId':
    'Extension-facing: hand back the outcome of a browser command the extension has finished — the result or the error — and release whoever was waiting on it. Report back, submit, answer. It runs nothing.',
  'GET /browser/status':
    'Is the browser reachable? Which extension devices are online, how stale each one is, how many commands are pending, which sessions are bound. Read-only: it does not ping the browser, it reports what the browser last said.',
  'DELETE /browser/commands/:commandId?':
    'Cancel a queued browser command, or all of them when no id is given, failing each waiter with a cancellation. Abort, drop, call it off. It cannot stop a command the browser has already started, and it does not clear the spool. NOTE: this is a cancel route, not the enqueue route — nothing enqueues browser commands over HTTP; commands are created in-process by browser_* actions run through POST /execute.',
  'GET /browser/spool':
    'Read the durable log of browser work that was asked for and never done, plus how much was dropped. What got lost, what is backed up. It does not retry any of it.',
  'DELETE /browser/spool/:commandId?':
    'Forget one spooled entry, or the whole backlog and its drop counters. Clear, purge. It cancels nothing live.',
  'POST /browser/sweep':
    'Run one housekeeping tick over the browser bridge: release expired command leases, expire stale commands, drop dead heartbeats. Reap, tidy up. It contacts no browser and deletes no stored reading.',
  'POST /browser/inspect':
    'Go to a URL and read it: the text and an element snapshot, stored with citations and ONE proposed next step. Look at this page, read it, what does it say. Reading only — it does not click, type, or carry out the step it proposes.',
  'GET /browser/inspections':
    'List the page readings taken so far, with their counts. Read-only; it re-reads nothing.',
  'GET /browser/inspections/:inspectionId':
    'Read one stored page inspection back in full, narrative and all. It does not refresh the page.',
  'POST /browser/inspections/:inspectionId/act':
    'Do the one thing the inspection proposed: re-snapshot the page, find the element again, and really click or type it. Go ahead, do it, confirm. Only the text to type may be supplied — an arbitrary action cannot be smuggled in here.',
  'GET /browser/sessions':
    'List the named browser sessions and which tab and URL each one currently points at. Read-only.',
  'POST /browser/sessions':
    'Open or adopt a browser tab and bind it to a session name, by tab id, by a fragment of its URL, or by opening a new one. This really drives the browser, and needs the extension online.',
  'DELETE /browser/sessions/:id':
    'Release a session name: forget which tab it pointed at. Unbind, detach, stop tracking. It does not close the tab and does not sign anything out.',
  'GET /browser/provenance':
    'Where the claims and filled fields came from: filterable by kind, host, url, and whether a fill is still undoable. Sources, citations, audit trail.',
  'POST /browser/provenance/trace':
    'Trace one claim back to the pages it came from. Prove it, back it up, "where did you get that". POST only because the claim text travels in the body; it writes nothing.',
  'GET /browser/provenance/:recordId':
    'One provenance record: what was extracted or filled, from where, and whether it can still be reversed. Read-only.',
  'POST /browser/provenance/:recordId/check':
    'Check whether a recorded claim still matches the page: you supply the fresh page text and this compares it to what was stored. Is it still true, has it changed, re-verify. It does not fetch the page itself and it executes nothing.',
  'GET /browser/provenance/:recordId/undo':
    'Describe how a recorded browser change WOULD be reversed. Read-only — it plans the undo and performs none of it.',
  'POST /browser/provenance/:recordId/undone':
    'Bookkeeping: mark that a recorded browser change has been reversed somewhere else. It performs no reversal itself.',

  /* ---- browser jobs ---- */
  'POST /browser-jobs':
    'Queue a browser job to run later against the owner\'s logged-in browser, or run it inline when asked to. Queued is the default: the answer comes back from a later drain, not from this call.',
  'GET /browser-jobs':
    'List queued and finished browser jobs and how each one ended. Read-only.',
  'GET /browser-jobs/:jobId':
    'Read one browser job: its steps, its outcome and what it read. Read-only.',
  'POST /browser-jobs/:jobId/run':
    'Run one queued browser job now rather than waiting for the drain. Really drives the browser.',
  'POST /browser-jobs/:jobId/cancel':
    'Cancel a queued browser job before it runs. It cannot recall one already in flight in the browser.',
  'POST /browser-jobs/drain':
    'Work through the queued browser jobs now. Really drives the browser; it is not a status read.',
  'POST /browser-jobs/sweep':
    'Housekeeping over browser jobs: expire the stale ones and release their claims.',
  'GET /browser-jobs/signals':
    'Read the signals that decide when browser jobs are worth draining. Read-only.',
  'POST /browser-jobs/signals':
    'Record a signal that browser work is worth draining now.',

  /* ---- forms ---- */
  'POST /forms/fill':
    "Fill in a real web form in the owner's logged-in browser: match the values to the fields and type, select or tick them. Populate, enter my details, prefill. It stops one click short — it never presses submit, leaves password fields blank and refuses file inputs. It is not a dry run: the typing really happens on the page.",
  'GET /forms/fills':
    'List the form fills carried out so far. Read-only; it re-fills nothing.',
  'GET /forms/fills/:fillId':
    'Read one form fill back: which fields were given which values, and where they came from.',
  'GET /form-previews':
    'List the prepared form payloads waiting on the owner. Every one is prepared and not sent.',
  'POST /form-previews':
    'Prepare a form for the owner to approve: read the page, fill the reversible fields and return exactly what would be sent, as text they can be read. Draft, stage, get it ready. Nothing is submitted.',
  'GET /form-previews/:id':
    'Read one prepared form payload back — what would be sent, verbatim.',
  'POST /form-previews/:id/approve':
    'Record the owner saying yes to a prepared form, against the digest of the bytes they were actually read and a spoken code. Approving is not sending: submitting is a separate call.',
  'POST /form-previews/:id/recheck':
    'Re-read the page behind a prepared form and revoke the approval if the content has moved since the owner heard it. Is it still valid, has it changed.',
  'GET /form-previews/:id/handoff':
    'Hand back the arguments a submit would take, once the form is approved. A GET because reading what would be sent is not sending it — the actual submit goes through POST /execute.',
  'POST /form-previews/:id/submitted':
    'Bookkeeping: record that a prepared form was submitted elsewhere. It submits nothing.',
  'DELETE /form-previews/:id':
    'Discard a prepared form payload unsent. Throw it away, cancel the draft.',

  /* ---- origins ---- */
  'POST /origins/read':
    "Ask one question across several of the owner's logged-in sites at once, each read through their own session, and come back with a per-origin answer, its provenance and how old the fetch was. Check all my accounts, look across my sites, gather from everywhere. Partial success is normal and named as such. It reads only: no click, no fill, no write.",
  'GET /origins/budget':
    'How much cross-origin reading is left today: whether the extension is up, and the remaining relay browser time. Read-only; it changes no quota.',

  /* ---- watches ---- */
  'GET /watches':
    'List the standing page watches. What am I monitoring, what am I tracking. Read-only.',
  'POST /watches':
    'Put a standing watch on one web page and be told when it changes — "tell me when my order ships", "let me know if the price moves", "keep an eye on this". Registers the watch; the first check is a silent baseline, so this does not report anything now.',
  'GET /watches/reports':
    'What the watches have seen change and nobody has acknowledged yet, spoken as a summary that distinguishes "nothing changed" from "nothing could be checked". Read-only; it polls nothing.',
  'GET /watches/health':
    'Can the watchers actually check right now, or is the browser tier down? Read-only.',
  'GET /watches/drafts':
    'The follow-up drafts the watches wrote. Prepared, not sent.',
  'GET /watches/drafts/:draftId':
    'Read one watch follow-up draft.',
  'DELETE /watches/drafts/:draftId':
    'Discard a watch follow-up draft unsent.',
  'POST /watches/drafts/:draftId/approve':
    'Record the owner approving a watch follow-up draft and return what a fill would be handed. It sends nothing, and the fill it describes stops before the submit control anyway.',
  'GET /watches/:watchId':
    'Read one watch: the page, the values tracked, the schedule and the threshold.',
  'PATCH /watches/:watchId':
    'Change a watch: what it tracks, how often, how big a change has to be, or pause it. It does not trigger a check.',
  'DELETE /watches/:watchId':
    'Stop watching a page for good and drop its reports. Cancel, remove, unsubscribe.',
  'POST /watches/:watchId/check':
    'Check a watched page right now through the browser, diff it against the baseline, and report only what moved and only if it cleared the threshold. Check now, refresh, look again.',
  'POST /watches/:watchId/ack':
    "Mark a watch's pending reports as heard. Got it, acknowledged, dismiss. It neither deletes the watch nor re-checks the page.",
  'GET /watches/:watchId/suppressed':
    'What a watch saw and decided was not worth saying, with its scores. This is how a quiet watch is told apart from a broken one.',

  /* ---- vision loop ---- */
  'GET /vision-loop/status':
    'Whether screen-driven UI automation can be dispatched here right now, split into what works today without the grant and what stays blocked until it is given. Read-only.',
  'POST /vision-loop/plan':
    'Check that a UI automation plan is well formed and reachable. It validates and returns; it checks no permission and runs nothing. A plan with one unreachable step is rejected whole rather than shortened.',
  'POST /vision-loop/run':
    'The route a UI automation plan WOULD be dispatched through. It is wired with no executor, so today the best case is that it reports it has no executor and lists what it would have run; without the accessibility grant it reports being blocked on that. It does not drive the UI.',
  'GET /vision-loop/history':
    'Past screen-driven runs, narrated, out of the action ledger. Read-only; undoing one is POST /jobs/:jobId/undo, not anything here.',
  'GET /vision-loop/preflight':
    'The permission gate alone, as one line for a dashboard tile. Runs nothing.',
  'GET /vision-loop/offload':
    'What an upload to the relay would contain and what is stopping it — consent, and the accessibility grant. Computed locally and sent nowhere; this is the privacy answer to "what would leave my machine", not an upload.',

  /* ---- plan, execute, jobs ---- */
  'POST /plan':
    'Turn a spoken or typed command into a list of executor actions, with a preview of what they would touch and how they could be undone. Careful: this is not uniformly a dry run — a command the deterministic router recognises outright (volume, brightness, mute, open an app, url or path, screenshot) is CARRIED OUT here and comes back with an empty action list and its results already in hand. Anything it cannot route comes back as a proposal for POST /execute.',
  'POST /execute':
    'Run an approved list of executor actions, one step at a time, and return a receipt per action: what it touched, whether it wrote, whether it can be undone. This is the route that actually does things. It writes an intent manifest before each step, but returns no ledger id, so its receipts and the ledger cannot be joined afterwards. A receipt carries no exit code, no command line and no environment — a failed shell step is a message, not a status code.',
  'GET /jobs':
    'The record of everything that has been planned or run, newest first, with trimmed results. What have you done, recent activity, history, what is in flight. Read-only; the full result for one job is at GET /jobs/:jobId.',
  'DELETE /jobs':
    'Erase the whole job history. Clear the log, forget what you did. It cancels nothing in flight and undoes nothing that was done.',
  'GET /jobs/:jobId':
    'Everything stored about one run: its command, its actions, its results, whether it can be undone. Read-only.',
  'GET /jobs/:jobId/receipts':
    'The per-action receipts for one run: what it touched, which files it wrote, which steps are reversible and where the snapshots live. Proof, evidence, "what did it actually change". It shows whether an undo is possible; it does not perform one.',
  'POST /jobs/:jobId/cancel':
    'Stop a run that is still going: the current step finishes and no further step starts. Abort, halt, never mind. Cancel is not undo — nothing already done is rolled back.',
  'POST /jobs/:jobId/undo':
    'Reverse what a finished run did, in reverse order: restore the snapshot, move the file back, delete the copy it made, put the volume and brightness back. Undo, revert, roll back, take it back. Shell, keyboard, email and browser steps cannot be reversed and are refused.',
  'POST /jobs/undo-last':
    'Undo the most recent run that can be undone. "Undo that", "take back the last thing", "oops". It picks the newest qualifying run itself — you cannot choose which.',

  /* ---- journal, observe ---- */
  'GET /journal':
    'The narrated timeline of what the agent has actually done to this machine: each step in order, what it touched, how long it took, how risky it was, which planner tier chose it, and whether it can still be undone. What changed today, audit, walk me through it. Derived on read and completely inert — it gates nothing and it does not read the action ledger.',
  'GET /journal/:jobId':
    'The same narrated timeline for one run, with nothing trimmed away for a list view.',
  'GET /observe':
    'The state of the host itself: the foreground app, which apps are running, whether Accessibility and Screen Recording are granted, whether synthesized input has actually been landing, which browser sessions are open and which path roots are configured. What is on screen, what is running, "can you type". This is host state, not history. Permission granted and events actually posting are two different claims and it reports both; ?probeInput=1 posts one real no-op event to re-measure the second.',

  /* ---- ledger ---- */
  'POST /ledger':
    'Write down what a plan intends to do before anyone runs it: the steps, how many of them change something, how many could not be undone, and how many would be unanswerable if the run were interrupted. It records intent and executes nothing.',
  'GET /ledger':
    'List the recorded intent manifests, newest first. Read-only, and the runnable parameters are stripped out.',
  'GET /ledger/interrupted':
    'Which recorded runs stopped part-way through — what got cut off, what died halfway. Read-only; it restarts and repairs nothing.',
  'GET /ledger/:ledgerId':
    'Read one recorded intent manifest. Parameters stripped.',
  'GET /ledger/:ledgerId/resume':
    'Decide what would be safe to continue after an interrupted run: which steps provably finished, which should be skipped, which should be re-run, and the question to put to the owner about the first step whose outcome cannot be established. It continues nothing itself — it hands back a list the caller must POST to /execute. Nothing on this process resumes a run.',

  /* ---- preview, prepare, approve ---- */
  'POST /preview':
    'Describe what a list of actions would do before anyone approves it: the apps, files and URLs it would touch, how much of it writes, and what could not be undone. What would this do, show me first, before you act. It runs nothing, and /execute never consults what it produced.',
  'POST /prepare':
    'Stage work for the owner to decide on: record the intent, capture the state of the world it assumed, and return a pending approval with the exact wording to read back and a deadline. Get it ready, ask me first, hold it for my OK. It runs nothing, and it deliberately keeps no copy — the caller holds the pending record.',
  'GET /prepare/:ledgerId/world':
    'Is a staged plan still committable, or has the world moved under it? Re-fingerprints what was captured at prepare time and reports the parts it cannot see. It commits nothing and expires nothing, and a match means the observable part is unchanged, not that nothing changed.',
  'POST /approve':
    "Settle a staged decision: check the owner's yes or no against the pending record, the world fingerprint and the plan digest, and hand back either the actions to run or a refusal with the reason to say out loud. A refusal is a normal answer, not an error. Approving is not doing: the actions still go to POST /execute.",
  'GET /approvals/pending':
    'What is waiting for the owner right now, from the relay that holds every parked decision: one row per pending approval with its summary, full readback, origin node, risk phrase and deadline. Read-only, fleet-wide — it lists prompts however they were delivered, spoken on the pendant or pushed to a phone. It decides nothing.',
  'POST /approvals/:approvalId/decision':
    'Answer one parked approval as the owner at this Mac: approve or deny, forwarded to the relay under this agent’s own credential. Any owner surface may decide any approval — origin only chose where the prompt was pushed. Deciding is not doing: a granted plan still runs nowhere until the body holding its manifest commits it.',

  /* ---- workbench ---- */
  'POST /workbench/plan':
    'Ask whether this piece of work has already been done before doing it again: fresh, a retry, already complete, in need of repair, or a deliberate re-run. Read-only despite the verb — it stages nothing and writes nothing, and the contents of any proposed output are stripped so a write cannot be smuggled through.',
  'POST /workbench/contexts':
    'Claim a piece of work durably before producing it, so a restart can tell a retry from a second attempt. Re-opening the same job and intent returns the same context rather than a duplicate. It runs and commits nothing.',
  'GET /workbench/contexts':
    'List the open pieces of work being tracked, filterable by job. Read-only.',
  'GET /workbench/contexts/:contextId':
    'Read one tracked piece of work and, once it claims to be committed, what is actually on disk versus what it claims. Did the output really land, verify the claim. It reports the gap; it does not repair it.',
  'GET /workbench/jobs/:jobId/handoff':
    'What a run that was interrupted and restarted had already finished, packaged so another machine can pick it up. It reports; it does not continue the run.',
  'POST /workbench/handoff':
    'Adopt a piece of tracked work that another machine produced. It never lowers a status that is further along locally, and it executes nothing the envelope describes.',

  /* ---- sessions, logs, thinking, routing, ops, machine ---- */
  'GET /sessions':
    'List the conversation threads and their turns. Chats, threads, transcripts. Read-only.',
  'POST /sessions':
    'Start a new empty conversation thread. It plans and runs nothing.',
  'GET /sessions/:sessionId':
    'Read one conversation thread and everything said in it.',
  'PATCH /sessions/:sessionId':
    'Rename a conversation thread. Title only; the turns are untouched.',
  'DELETE /sessions/:sessionId':
    'Delete a conversation thread and everything said in it.',
  'POST /sessions/:sessionId/clear':
    'Empty a conversation thread but keep the thread: forget what was said, start over in this one. The session and its id survive.',
  'GET /logs':
    'The flat activity log: one line per past command with its status and summary. The plainest history there is; GET /journal is the detailed one.',
  'GET /thinking':
    'Every stored reasoning trace: how the planner got from the command to the actions. Why did you do that, show your work.',
  'GET /thinking/latest':
    'The single newest reasoning trace, or nothing.',
  'GET /thinking/stream':
    'Subscribe to reasoning traces as they happen, over Server-Sent Events, with a heartbeat. Watch it think, follow along, tail. It accepts no input and ends only when the client leaves.',
  'GET /routing':
    'Which planner tier answered which requests and what it cost: calls, latency, estimated tokens, estimated spend and escalations. How much did that cost, which model, how fast. The token and cost figures are estimates from character counts, not the provider\'s own accounting, and the whole rollup is in memory and resets when the agent restarts.',
  'GET /ops/status':
    'Is everything up? Agent health, whether the relay answers, whether the browser extension is connected, a summary of the machine, and counts of what is stored. Reaches out to the relay to find out, so it is not purely local. Counts only — the underlying records live behind their own routes.',
  'GET /ops/snapshot':
    'One heavy export of everything at once — sessions, context graph, memory, jobs with receipts, traces, pipeline runs, routing and logs — capped at each edge for the relay to swallow. It is a truncated export for syncing and dashboards, not a backup and not the full stores.',
  'GET /health':
    'Unauthenticated liveness ping: are you alive, is the agent up, is anything answering on this port. Deliberately says almost nothing else — four fields and a pointer to this manifest.',
  'GET /capabilities':
    'This manifest: what this agent can do and where it lives. Every route with its description and auth, every executor action type with what it does, the planner and vision models, the surfaces that live elsewhere, and the status contract that stops a 401 being read as "this route exists". Derived from the live router and the executor dispatch table, so it cannot advertise a route that is not mounted. It runs nothing.',
  'GET /machine-context':
    'What this Mac is, as the planner sees it: macOS version, hostname, installed applications, the automation tooling that is present, the timezone. What apps do I have, is X installed, what version am I on. Cached, so it can be behind reality.',
  'POST /machine-context/refresh':
    'Re-scan this Mac and drop the cached description. "I just installed something", look again, rescan. It installs and configures nothing.',

  /* ---- pipeline ---- */
  'GET /pipeline':
    'The stored trace of voice-command runs: each run stage by stage. What happened to my request, where did it get stuck. Read-only; it replays nothing.',
  'DELETE /pipeline':
    'Erase the stored voice-command traces. It cancels nothing in flight and leaves the saved audio files on disk.',
  'GET /pipeline/stream':
    'Subscribe to voice-command traces as they happen, over Server-Sent Events. Watch it live, follow along, tail. No audio rides on this, and it accepts no input.',
  'POST /pipeline/events':
    'Record one step of a voice-command run against its id, creating the run if the id is new, and recompute whether that run is active, waiting, done or failed. This is where the pendant reports back what happened to a reply on the device — the stage named `device_playback` with a done or failed status is how a played or unplayable reply is logged, and how a run gets closed out. The stage name is whatever the caller calls it: the route validates it against no list of event types, so nothing here defines a delivery vocabulary. It triggers no playback and delivers nothing itself; it is the record, not the act.',
  'POST /pipeline/audio':
    'Store the raw captured or spoken audio for one run — mono 16-bit PCM, one megabyte at most — as a WAV beside the trace. Upload, attach, save the clip. It does not play it, transcribe it, or send it to the pendant.',
  'GET /pipeline/:pipelineId/audio/:direction':
    'Fetch the stored WAV for one run, input or output, to listen to what was actually captured or spoken. Download it, hear it, play it back. Serves the bytes as they were stored: no transcoding, no live stream, and nothing comes out of the speakers here.',

  /* ---- briefing ---- */
  'POST /briefing':
    "Compose the owner's own day into a written brief and, when asked, speak it: read their calendar, unread mail, recent files or notes for one of the fixed kinds (morning, workday, wrapup, mail, schedule) and leave a markdown note behind. Brief me, catch me up, wrap up my day. It composes and stores; it sends nothing to anyone. For a brief that also reads logged-in web accounts and leaves a review queue, POST /briefing/triage is the one.",
  'GET /briefing/kinds':
    'The fixed kinds of briefing that can be composed, and which sources and sinks each one uses. Read-only; it composes nothing.',
  'GET /briefing/latest':
    'Read back the most recently composed briefing. It does not compose a new one and it returns no audio.',
  'POST /briefing/triage':
    "Read across the owner's mail and their logged-in web accounts under their interruption policy, say only what actually needs them, and leave everything else as findings in a review queue. It composes, stores and speaks; it never replies, sends, archives or changes anything.",
  'GET /briefing/triage/runs':
    'List the past triage runs and point at the queue. Read-only; it runs no triage.',
  'GET /briefing/review':
    'The review queue: what the last cross-account triage found and nobody has acted on yet, drafts included. Nothing in it has been sent, replied to or changed.',
  'POST /briefing/review/:id':
    'Mark one item in the review queue as handled or dismissed. It does not carry out whatever the item suggested.',
  'GET /briefing/policy':
    "The rules for when the agent may interrupt the owner. Currently a placeholder until the owner states one, and it says so.",
  'POST /briefing/policy':
    'Set the rules for when the agent may interrupt: "only bother me if", thresholds, quiet subjects.',

  /* ---- research ---- */
  'POST /research':
    'Research a topic out on the web (or across the open tabs) and leave a cited written brief plus rendered audio on disk to hear later. Look it up, find out about, read up on. It returns file paths and metadata, not the audio bytes, and it delivers nothing to the pendant. This reads the web; a briefing reads the owner\'s own Mac.',
  'GET /research/briefings':
    'List the research briefs written so far, without their spoken text. Read-only.',
  'GET /research/briefings/:id':
    'Read one research brief in full, spoken text included.',
  'POST /research/briefings/:id/speech':
    'Render one research brief into the audio payload the pendant plays and mark it played. It hands the bytes back for the relay to carry — it does not push anything to the device itself; pass onMac to play it on the Mac speakers instead.',

  /* ---- catchup ---- */
  'GET /catchup':
    'What happened while the owner was away, gathered from every local store and put in order: what ran, what failed, what was announced, what is still waiting. What did I miss, catch me up, since this morning. Nothing in it was retried, replayed, resumed, played or acknowledged by asking.',
  'GET /catchup/needs-me':
    'Only the part of the catch-up that still needs the owner, shaped for a device with no screen, with counts of what was deliberately left out. It acts on nothing.',
  'GET /catchup/refusals':
    'The blind spots in the catch-up: which sources could not be read and which claims it declined to make. It does not retry them, and this is the honest half of "what did I miss".',

  /* ---- notifications, reminders, capture, day plan ---- */
  'GET /notifications':
    "What actually needs the owner right now, scored rather than listed: unread mail, meetings about to start, and open reminders, with everything below the bar counted but not read out. Anything urgent, what needs my attention, is anything on fire. It dismisses, snoozes and replies to nothing. When all three sources come back empty at once it says the read failed rather than that nothing needs them.",
  'POST /reminders':
    'Set a reminder from ordinary speech — "remind me to call Sam at four", "every weekday at nine", "do not let me forget" — parsing the time and any repetition out of the sentence. It really creates it: one-off items in Apple Reminders, repeating ones as a recurring calendar event. It does not stage or draft one for confirmation first.',
  'POST /capture':
    'Save one thing the owner just said so it is not lost — an idea, a fact, a name, a number. Remember this, note that, jot it down. Stored durably with no expiry; the confirmation deliberately does not repeat a value that looks like a secret. It creates no reminder, no file and no Apple note.',
  'GET /capture':
    'Search back over what was captured and read the matches out. What did I say about, what is my, recall. Searches only the captures — not files, not mail, not the web.',
  'DELETE /capture/:key':
    'Forget one capture by its exact key. Delete, remove, scrub. It does not match by title or approximately.',
  'GET /day-plan':
    "Today shaped into a plan: the events ahead, what is next, the transitions that are too tight, the double-bookings, the tasks ranked, and a spoken briefing sized to the seconds available. What does my day look like, what is next, am I double booked. It reads and speaks; it creates, moves and cancels nothing. When the calendar and the task list come back empty together it says the read failed rather than that the day is clear.",

  /* ---- meetings, mail ---- */
  'GET /meeting-prep':
    'Get ready for the NEXT meeting: the calendar entry, the documents worth having open, the mail threads that belong to it, and the decisions and questions pulled out of them, with a spoken summary. Prep me, what is this meeting about, before my call. It copies the matched documents into a prep folder unless told not to. It invites no one, reschedules nothing and emails nobody.',
  'POST /meeting-prep/brief':
    'Prepare for a meeting named by the owner rather than whichever is next — "get me ready for the board review" — searching a two-week window. Same assembly as the next-meeting prep, and it sends nothing.',
  'POST /meeting-prep/overnight':
    "Prepare every meeting on tomorrow's calendar in one batch, for a scheduled routine to call overnight. It owns no timer and does not schedule itself.",
  'GET /meeting-prep/queue':
    'The shelf of meeting briefs already prepared and how many have not been heard yet. Metadata only.',
  'GET /meeting-prep/routine':
    'The shape of the overnight meeting-prep routine. It does not say whether it is installed and it does not run it.',
  'POST /meeting-prep/routine':
    'Install the overnight meeting-prep routine on the schedule, optionally at a given time. It schedules; it does not prep anything now.',
  'POST /meeting-followup':
    'After a meeting has ended: find it, pick out the notes taken while it was under way, pull the decisions and action items out of them, match the unread mail that belongs to it, and write a DRAFT summary into a dated folder, opened on screen. Write up the meeting, what did we decide, action items. The summary is a draft and stays one — nothing is emailed, no follow-up reminder is created and no matched mail is answered. To get ready BEFORE a meeting, GET /meeting-prep is the one.',
  'POST /mail/triage':
    "Sort the owner's unread mail into urgent, reply-soon, reference and noise, draft replies for the ones worth answering, and leave the list and the drafts on disk to review. Triage my inbox, what mail needs answering, draft replies. It never sends, never replies, never archives and never marks anything read.",
  'GET /mail/triage':
    'List the past mail triage runs. Read-only, and it does not touch the mailbox — there is no route on this process that reads mail; reading happens inside a triage run.',
  'GET /mail/triage/:runId':
    'Read one stored triage run and the review list it wrote, drafts included. It reads the saved artifact, not the mailbox, and it sends nothing.',
}

/*
 * Executor action types llmPlanner.js does not describe, either because the
 * type is a dispatch alias of one it does describe or because it reached
 * computerControl's switch without ever reaching a planner schema. Same rules
 * as the route notes: the caller's vocabulary, and never more than it does.
 */
const ACTION_NOTES = {
  /* Aliases. Each names its canonical spelling so a caller can tell that two
   * entries in the manifest are one behaviour, not two. */
  open_folder:
    'Open a folder in Finder, or any file with whatever app owns it. Dispatch alias of open_path.',
  mouse_scroll:
    'Scroll the view under the pointer. Dispatch alias of scroll; positive dy scrolls up.',
  set_clipboard:
    'Put text on the clipboard so the owner can paste it. Dispatch alias of copy_to_clipboard. To read the clipboard use get_clipboard.',
  set_keyboard_language:
    'Switch the typing/keyboard language or input source (Arabic, Korean, English/U.S., Japanese). Dispatch alias of set_input_source. Never drive this with raw keycodes.',
  research_topic:
    'Research a topic on the web and leave a written brief plus an audio version to play later from the pendant. Dispatch alias of research_brief. Use when nobody is waiting for the answer right now.',

  /* Dispatchable, never described anywhere until now. */
  check_input_permissions:
    'Report whether synthesized keyboard and mouse input actually reaches the screen from this process: whether macOS Accessibility trusts the binary that is executing, whether secure input is holding the keyboard, and where the pointer is. Answers "do I have permission", "is accessibility granted", "why is nothing clicking". It only reports that state — it grants nothing, opens no Settings pane, and says nothing about screen recording or microphone access.',
  remind_me:
    'Turn a spoken sentence into a reminder: parse the time and any repetition out of "remind me to call Sam at four" or "every weekday at nine", then create it in Apple Reminders. Use when the wording carries the schedule. create_reminder is the one to use when the title and due date are already separated out.',
  quick_capture:
    'Save a short thing the owner just said so it is not lost — an idea, a fact, a name, a number. Stores it as a durable remembered fact with no expiry. It captures the words; it does not act on them, schedule them, or turn them into a task.',
  recall_capture:
    'Search back over what was quick-captured and read the matches out. "What did I save about", "what was that thing I told you", "find my note on". Read-only.',
  preview_plan:
    'Foresee a list of executor actions before anyone approves it: how many steps, which apps, paths and URLs they would touch, how many of them write, and which of those writes could not be undone. It runs nothing and changes nothing — it is the answer to "what would this do".',
  start_focus_session:
    'Start a focus / deep-work / pomodoro block for N minutes: hide the distracting apps and mute output volume, then announce the end out loud. Hides rather than quits. It turns on no Do Not Disturb mode and blocks no website.',
  end_focus_session:
    'End the focus block early and restore what it changed: unhide the apps it hid, unmute if it was the one that muted. Stop, cancel, "I am done".',
  tidy_downloads_preview:
    'Propose filing the loose files in Downloads (or another folder) into subfolders by type or by month, and stage it as a plan. Nothing moves, and nothing here deletes — it returns a plan id. sweep_folder_preview is the one that also proposes deletions.',
  tidy_downloads_apply:
    'Carry out a filing plan from tidy_downloads_preview, using its planId. Renames each loose file into its subfolder without overwriting anything. Deletes nothing.',
  plan_my_day:
    "Read today's calendar and open reminders and say the day back as one short spoken plan: what is coming up, what is due. Reads and speaks only — it schedules nothing, moves nothing and replies to no one. When the calendar and the reminder list both come back empty it says the read failed rather than claiming the day is clear.",
  prepare_for_meeting:
    'Prepare for the NEXT meeting on the calendar: who is on it, what it is about, the related documents worth opening, and the mail threads that belong to it. Use for "what is my next meeting", "get me ready", "prep me". For work AFTER a meeting has finished use meeting_followup instead. It gathers and opens; it sends nothing.',
  triage_notifications:
    'Score what is competing for the owner\'s attention right now — unread mail, imminent meetings, open reminders — and say only the few things above the bar. Use for "what needs me", "anything urgent", "is there anything I should know". It ranks and speaks; it opens nothing, replies to nothing and dismisses nothing.',
}

/* Capabilities that are not HTTP routes on this process. A caller that only
 * probes this port would otherwise conclude they do not exist. */
const OFF_BOX_SURFACES = [
  {
    surface: 'cloud-relay',
    what:
      'Voice front door. Owns the Realtime session, the pendant work queue, audio storage and retention.',
    module: 'cloud-relay/server.js',
    reachedBy: 'local-agent/bridge.js polls it; it never calls in.',
  },
  {
    surface: 'realtime-planner',
    what:
      'Plans from pendant audio and emits executor actions. The Mac only executes.',
    module: 'cloud-relay/openaiRealtimeVoice.js (REALTIME_TOOLS)',
    reachedBy: 'Relay work queue -> bridge -> POST /execute on this process.',
  },
  {
    surface: 'browser-extension',
    what: 'Runs browser_* actions inside the real logged-in Chrome profile.',
    module: 'browser-extension/',
    reachedBy: 'Long-polls GET /browser/poll on this process.',
  },
  {
    surface: 'pendant-firmware',
    what: 'nRF9160 pendant: captures mic audio, plays the spoken reply.',
    module: 'firmware/nrf9160/',
    reachedBy: 'Speaks only to the relay over LTE-M.',
  },
]

/**
 * Every route the Express app actually has, read off the live router.
 * Method-less middleware layers are skipped: they match everything and
 * describe nothing.
 */
export function listRoutes(app) {
  const layers = app?.router?.stack ?? []
  const routes = []

  for (const layer of layers) {
    if (!layer.route) continue
    const paths = Array.isArray(layer.route.path)
      ? layer.route.path
      : [layer.route.path]

    for (const routePath of paths) {
      for (const method of Object.keys(layer.route.methods ?? {})) {
        routes.push({
          method: method.toUpperCase(),
          path: routePath,
          group: groupOf(routePath),
          params: [...String(routePath).matchAll(/:([A-Za-z0-9_]+)/g)].map(
            (match) => match[1],
          ),
          auth: isPublicPath(routePath) ? 'public' : 'bearer',
          /* Carried on the route itself, not looked up by the reader: a caller
           * that has one route in hand should not need the groups table to
           * find out what it does. */
          ...describeRoute(method, routePath),
        })
      }
    }
  }

  return routes.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  )
}

/**
 * Does this process have anything at all at `requestPath`?
 *
 * The auth middleware runs before routing, so without this every typo was a
 * 401 and discovery was impossible. Only real endpoint layers count — the
 * catch-all static middleware matches every path and would make the answer
 * always "yes" — so served files are checked separately, by existence.
 */
export function isKnownRoutePath(app, requestPath, { staticDir = null } = {}) {
  const candidate = String(requestPath || '/')
  const layers = app?.router?.stack ?? []

  for (const layer of layers) {
    if (!layer.route) continue
    try {
      if (layer.match(candidate)) return true
    } catch {
      // A layer that cannot answer is not evidence either way.
    }
  }

  return Boolean(staticDir) && staticFileExists(staticDir, candidate)
}

function staticFileExists(staticDir, requestPath) {
  const decoded = safeDecode(requestPath)
  if (!decoded || decoded.includes('\0')) return false

  const resolved = path.resolve(staticDir, `.${path.posix.normalize(decoded)}`)
  // Never let a traversal attempt answer "yes" about a file outside dist/.
  if (resolved !== staticDir && !resolved.startsWith(`${staticDir}${path.sep}`)) {
    return false
  }

  try {
    return fs.statSync(resolved).isFile()
  } catch {
    return false
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function groupOf(routePath) {
  return String(routePath).split('/').filter(Boolean)[0] ?? ''
}

/**
 * What one route says about itself: its own line if it has one, otherwise its
 * family's. Exported because a caller holding a captured manifest (or a test)
 * needs the same answer this file gives, from the same table.
 */
export function describeRoute(method, routePath) {
  const own = ROUTE_NOTES[`${String(method).toUpperCase()} ${routePath}`]
  const group = GROUP_NOTES[groupOf(routePath)] ?? {}
  return { what: own ?? group.what ?? null, module: group.module ?? null }
}

/**
 * What one executor action type says about itself.
 *
 * llmPlanner's schemas are asked first and are the authority: they already
 * describe 82 of the dispatch table's types, in the house style, and the
 * planner and the manifest disagreeing about what an action does would be a
 * worse bug than either being silent. ACTION_NOTES covers only what is left —
 * dispatch aliases and the types that reached the executor without ever
 * reaching a planner schema.
 */
export function describeAction(type) {
  return plannerActionDescription(type) ?? ACTION_NOTES[type] ?? null
}

/** Action types the executor can dispatch, with who else knows about them. */
export function describeActions() {
  const types = SUPPORTED_ACTION_TYPES.map((type) => {
    const reversibility = staticReversibility(type)
    return {
      type,
      what: describeAction(type),
      // Advertised to the local LLM planner. A type that is false here is
      // dispatchable but gets dropped by llmPlanner's sanitizeActions, so a
      // plan naming it silently loses the step.
      plannerAdvertised: isKnownActionType(type),
      handsFree: classifyAction({ type, params: {} }).safe,
      reversible: reversibility.reversible,
      reversedBy: reversibility.reversedBy,
    }
  })

  return {
    count: types.length,
    executor: 'local-agent/computerControl.js',
    plannerRegistry: 'local-agent/llmPlanner.js',
    handsFreeRegistry: 'local-agent/actionRisk.js',
    // Named, not hidden: this is the misalignment the manifest exists to show.
    drift: {
      dispatchableButNotPlannable: types
        .filter((entry) => !entry.plannerAdvertised)
        .map((entry) => entry.type),
      note:
        'Types listed here execute fine over POST /execute but are stripped from LLM-authored plans by llmPlanner.sanitizeActions.',
    },
    /* The other half of the same rot report: a type nobody has described is
     * dispatchable and unfindable, which is how 95 of them shipped silent. */
    undocumented: types.filter((entry) => !entry.what).map((entry) => entry.type),
    types,
  }
}

/**
 * The full manifest. Synchronous and cheap on purpose: `permissions` is passed
 * in by the caller, which already has it, rather than triggering a macOS
 * Automation probe on every request.
 */
export function buildCapabilityManifest(
  app,
  { permissions = null, relayUrl = null, version = '0.5.0' } = {},
) {
  const routes = listRoutes(app)
  const groups = [...new Set(routes.map((route) => route.group))].sort()

  return {
    ok: true,
    service: 'AI Pendant Mac Local Agent',
    version,
    generatedAt: new Date().toISOString(),
    generatedFrom: [
      'express router stack',
      'computerControl dispatch table',
      'llmPlanner action registry',
      'actionRisk hands-free allowlist',
      'macos/permissions report',
    ],
    http: {
      port: PORT,
      baseUrl: `http://127.0.0.1:${PORT}`,
      auth: {
        scheme: 'Bearer',
        header: 'Authorization: Bearer <AGENT_TOKEN>',
        tokenConfigured: Boolean(AGENT_TOKEN),
        alsoAccepts: 'loopback dashboard session cookie',
        // Written down because the previous behaviour taught callers to read
        // 401 as "this route exists".
        statusContract: {
          401: 'route exists, token missing or wrong',
          404: 'no such route on this process',
          503: 'AGENT_TOKEN not configured on the Mac',
        },
      },
      routeCount: routes.length,
      publicPaths: routes
        .filter((route) => route.auth === 'public')
        .map((route) => route.path),
      groups: groups.map((group) => ({
        group: group || '/',
        routeCount: routes.filter((route) => route.group === group).length,
        ...(GROUP_NOTES[group] ?? { what: null, module: null }),
      })),
      // Self-reported rot: a new route family with no note shows up here.
      undocumentedGroups: groups.filter((group) => !GROUP_NOTES[group]),
      /* Finer-grained than the above and the one that actually bites: a route
       * inside a documented family still resolves against nothing of its own
       * until someone writes its line. */
      undocumentedRoutes: routes
        .filter((route) => !route.what)
        .map((route) => `${route.method} ${route.path}`),
      routes,
    },
    actions: describeActions(),
    models: {
      planner: {
        // Mirrors llmPlanner's own default; capabilityManifest.test.js fails
        // if that default is edited without updating this one.
        model: String(process.env.LLM_MODEL || 'gpt-5.6-luna').trim(),
        env: 'LLM_MODEL',
        enabled: isLlmPlannerEnabled(),
        fullControlPlanner: isFullControlPlanner(),
      },
      vision: {
        model: visionModelName(),
        env: 'LLM_VISION_MODEL',
        configured: isVisionConfigured(),
      },
      voice: {
        runsOn: 'cloud-relay',
        module: 'cloud-relay/openaiRealtimeVoice.js',
        env: 'OPENAI_REALTIME_MODEL',
        note: 'The relay selects the Realtime model; this process never does.',
      },
    },
    permissions,
    surfaces: OFF_BOX_SURFACES,
    relay: {
      configured: Boolean(relayUrl),
      url: relayUrl || null,
    },
    fullControlMode: FULL_CONTROL_MODE,
  }
}
