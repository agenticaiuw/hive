import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  TIER_BACKGROUND,
  TIER_DETERMINISTIC,
  TIER_PLANNER,
  classifyTier,
  matchDeterministic,
} from './policyRouter.js'

/* Machine context is real disk I/O; pin a fake one so app matching is
 * deterministic on any Mac, including CI where /Applications differs. */
const MACHINE = {
  applications: ['Safari', 'Notes', 'Google Chrome', 'Visual Studio Code', 'Mail'],
}

const only = async (command) => {
  const match = await matchDeterministic(command, { machine: MACHINE })
  assert.ok(match, `expected a deterministic match for: ${command}`)
  assert.equal(match.actions.length, 1)
  return match.actions[0]
}

const none = async (command) => {
  const match = await matchDeterministic(command, { machine: MACHINE })
  assert.equal(match, null, `expected NO deterministic match for: ${command}`)
}

test('volume, brightness and mute resolve to one action with the right slot', async () => {
  assert.deepEqual(await only('set volume to 30'), {
    type: 'set_volume',
    label: 'Set volume to 30%',
    params: { level: 30 },
  })
  assert.equal((await only('volume 55%')).params.level, 55)
  assert.equal((await only('set the brightness to 80 percent')).params.level, 80)
  assert.equal((await only('mute')).params.muted, true)
  assert.equal((await only('unmute the volume')).params.muted, false)
  assert.equal((await only("what's the volume")).type, 'get_volume')
})

test('out-of-range levels fall through to the model instead of being clamped', async () => {
  // 300% is not a volume; guessing what it meant is the planner's job.
  await none('set volume to 300')
})

test('status questions pick the narrow field, not a whole system poll', async () => {
  const battery = await only("what's my battery")
  assert.equal(battery.type, 'get_mac_status')
  assert.deepEqual(battery.params.fields, ['battery'])

  assert.deepEqual((await only("how's my wifi")).params.fields, ['wifi'])
  assert.deepEqual((await only('mac status')).params.fields, ['all'])
})

test('time and weather map to their builtins, with the location slot', async () => {
  assert.equal((await only('what time is it')).type, 'get_time')
  assert.equal((await only("what's the date")).type, 'get_time')

  const weather = await only("what's the weather in Seoul")
  assert.equal(weather.type, 'get_weather')
  assert.equal(weather.params.location, 'Seoul')
  assert.deepEqual((await only('weather')).params, {})
})

test('open resolves URL before path before app', async () => {
  const url = await only('open github.com')
  assert.equal(url.type, 'open_url')
  assert.equal(url.params.url, 'https://github.com')

  const app = await only('open Safari')
  assert.equal(app.type, 'open_app')
  assert.equal(app.params.appName, 'Safari')

  const home = await only(`open ${os.homedir()}`)
  assert.equal(home.type, 'open_path')
})

test('a path is only deterministic when it actually exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-router-'))
  try {
    const list = await only(`list ${dir}`)
    assert.equal(list.type, 'list_directory')
    assert.equal(list.params.path, path.resolve(dir))

    await none(`list ${dir}/definitely-not-here`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('list_directory refuses a path that is a file, not a folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-router-'))
  const file = path.join(dir, 'note.txt')
  fs.writeFileSync(file, 'hello')
  try {
    await none(`list ${file}`)
    // Opening it is still fine — that is what open_path is for.
    assert.equal((await only(`open ${file}`)).type, 'open_path')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an app the Mac does not have is never launched on a guess', async () => {
  await none('open Photoshop')
  await none('open the pod bay doors')
  // Loose token overlap ("my email" vs "Mail") must not be good enough.
  await none('open my email')
})

test('anything with a second step is disqualified', async () => {
  await none('open Safari and then search for flights')
  await none('set volume to 30 then open Notes')
  await none('open Safari; open Notes')
})

test('close-but-ambiguous wording falls through rather than acting', async () => {
  await none('turn up the volume')
  await none('is my battery going to last the flight')
  await none('open something to write in')
})

test('tier classification keeps judgement on the full planner', async () => {
  const deterministic = await matchDeterministic('set volume to 30', {
    machine: MACHINE,
  })
  assert.equal(
    classifyTier('set volume to 30', { deterministic }).tier,
    TIER_DETERMINISTIC,
  )

  assert.equal(
    classifyTier('compare the two files and summarize what changed').tier,
    TIER_PLANNER,
  )
  assert.equal(classifyTier('click the checkout button on the page').tier, TIER_PLANNER)
  assert.equal(classifyTier('remind me to call mom at 6').tier, TIER_BACKGROUND)
})

test('an unrecognised question goes to the model that can answer it', () => {
  // Measured: the small tier answered this one with open_app instead of a list.
  assert.equal(
    classifyTier('what apps do I have installed for editing photos').tier,
    TIER_PLANNER,
  )
  assert.equal(classifyTier('how do I get to the airport from here').tier, TIER_PLANNER)
  // Imperatives are still cheap — this only redirects questions.
  assert.equal(classifyTier('add milk to my shopping list').tier, TIER_BACKGROUND)
})

test('routines never occupy the expensive tier — nobody is waiting on them', () => {
  const spoken = classifyTier('summarize my notes from today')
  const routine = classifyTier('summarize my notes from today', { source: 'routine' })
  assert.equal(spoken.tier, TIER_PLANNER)
  assert.equal(routine.tier, TIER_BACKGROUND)
})

test('classification never refuses — every command gets some tier', () => {
  for (const command of ['', 'asdfghjkl', 'do the thing', '날씨 어때']) {
    const { tier } = classifyTier(command)
    assert.ok([TIER_DETERMINISTIC, TIER_BACKGROUND, TIER_PLANNER].includes(tier))
  }
})
