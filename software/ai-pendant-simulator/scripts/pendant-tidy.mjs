#!/usr/bin/env node
/**
 * The deterministic payload behind "Every Friday, tidy my Downloads into dated
 * folders, show me a preview, and only then apply it."
 *
 * A routine's command is replanned by the model on every fire, which is right
 * for "brief me" and wrong for this: the whole promise is that the same thing
 * happens each week and that nothing moves until the owner has read it. So the
 * routine names one shell command and this file is that command.
 *
 * It previews and stops. Applying is a separate act, because "only then apply
 * it" is the owner reserving a decision, not a delay to be optimised away.
 *
 *   node scripts/pendant-tidy.mjs --weekly          Fridays only: preview by month, notify
 *   node scripts/pendant-tidy.mjs --weekly --force  run the sweep on any day
 *   node scripts/pendant-tidy.mjs --preview [type|date]
 *   node scripts/pendant-tidy.mjs --apply <planId>
 *   node scripts/pendant-tidy.mjs --undo <planId>
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  applyTidy,
  formatPreview,
  isWeeklySweepDay,
  planTidy,
  undoTidy,
} from '../local-agent/downloadsTidy.js'
import { workspacePath } from '../local-agent/config.js'

const execFileAsync = promisify(execFile)
const [flag, value] = process.argv.slice(2)

async function main() {
  if (flag === '--apply') {
    if (!value) throw new Error('--apply needs the plan id from a preview.')
    const result = applyTidy(value)
    console.log(result.spoken)
    if (result.drifted.length) {
      console.log('Skipped, because they changed after you saw the preview:')
      for (const entry of result.drifted) console.log(`  ${entry.name} — ${entry.reason}`)
    }
    return
  }

  if (flag === '--undo') {
    if (!value) throw new Error('--undo needs the plan id.')
    console.log(JSON.stringify(undoTidy(value)))
    return
  }

  const weekly = flag === '--weekly'

  /*
   * The day gate lives here, not in the schedule.
   *
   * routines.js knows "daily" and "interval" and neither can say "only on
   * Friday", so the routine fires every evening and this decides whether that
   * particular evening was the one the owner meant. Putting the gate in the
   * payload also means it stays true when the routine is run by hand, which a
   * gate expressed in the schedule would not.
   */
  if (weekly && value !== '--force' && !isWeeklySweepDay()) {
    console.log('Not Friday — the weekly Downloads sweep is skipped today.')
    return
  }

  const plan = planTidy({ groupBy: weekly ? 'date' : value === 'date' ? 'date' : 'type' })
  const preview = formatPreview(plan)
  console.log(preview)

  if (!weekly) return

  /*
   * Written to a file rather than only spoken: the weekly run happens while
   * nobody is listening, and a preview the owner cannot go back and read is not
   * a preview. The path is stable so the newest sweep is always in one place.
   */
  const reportPath = path.join(workspacePath, 'downloads-tidy-preview.txt')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(
    reportPath,
    `${preview}\n\nNothing has been moved.\nTo apply: node ${path.resolve(
      new URL('.', import.meta.url).pathname,
    )}pendant-tidy.mjs --apply ${plan.id}\n`,
    'utf8',
  )
  console.log(`\nPreview saved to ${reportPath}`)

  await notify(
    `${plan.fileCount} files ready to file into ${plan.groups.length} dated folders. Nothing moved yet.`,
  )
}

async function notify(text) {
  try {
    await execFileAsync('osascript', [
      '-e',
      `display notification "${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with title "Downloads tidy — preview ready"`,
    ])
  } catch {
    /* A missing banner must not fail the sweep; the preview file is the record. */
  }
}

main().catch((error) => {
  console.error(String(error?.message || error))
  process.exitCode = 1
})
