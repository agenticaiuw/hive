/*
 * Test-only: give this process a workspace of its own.
 *
 * Several modules — actionReceipts.js (.undo), briefing.js and audioBrief.js
 * (briefings/), logger.js (mac-agent-activity-log.json), meetingFollowup.js,
 * sessionStore.js — resolve their store path from config.workspacePath once,
 * at import time, and offer no parameter or env var to point it elsewhere.
 * Prefer the module's own { filePath } argument or its store-path env var
 * wherever one exists; this is the fallback for the ones that have neither.
 *
 * Why it matters: `node --test` runs each test file in its own process, but
 * every one of them defaults to the same real ~/AI-Pendant-Workspace — as does
 * the agent app the owner actually has running. Those stores are read-modify-
 * write over a whole JSON document, and several cap themselves at the last N
 * entries, so a concurrent writer silently drops what a test just wrote. The
 * test then fails on a record it created moments earlier, and only sometimes.
 *
 * Import this BEFORE any module that reads config.js. ESM evaluates an import
 * list in order, so the redirect lands before config.js is ever touched:
 *
 *   import test from 'node:test'
 *   import './testWorkspace.js'
 *   import { runBriefing } from './briefing.js'
 *
 * No production default changes. Nothing imports this outside tests, and the
 * owner's PENDANT_WORKSPACE_PATH is untouched in every other process.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const testWorkspacePath = fs.mkdtempSync(
  path.join(os.tmpdir(), 'pendant-test-workspace-'),
)

process.env.PENDANT_WORKSPACE_PATH = testWorkspacePath

/*
 * capabilityGapInbox.js mirrors each NEW gap into the design commons — by
 * default the real diagnostics/harness-derivation at the repo root, which the
 * design committee reads. A test that trips any gap writer must not wake the
 * committee on fiction, so the commons is pointed into this temp workspace
 * too (created eagerly: a missing directory makes the inbox skip the deposit,
 * and tests should exercise the deposit path, not the skip path). Production
 * never sets PENDANT_COMMONS_DIR; only this file does.
 */
process.env.PENDANT_COMMONS_DIR = path.join(testWorkspacePath, 'harness-derivation')
fs.mkdirSync(process.env.PENDANT_COMMONS_DIR, { recursive: true })

process.on('exit', () => {
  try {
    fs.rmSync(testWorkspacePath, { force: true, recursive: true })
  } catch {
    // A leftover directory under the OS temp dir is not worth failing a run.
  }
})
