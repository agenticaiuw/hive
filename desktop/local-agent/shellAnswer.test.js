import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import './testWorkspace.js'
import {
  answerForShellOutput,
  condenseToAnswer,
  formatShellAnswer,
} from './shellAnswer.js'
import { executeComputerAction } from './computerControl.js'

const moduleDirectory = path.dirname(new URL(import.meta.url).pathname)

/*
 * The incident, verbatim. "Tell me how much free disk space the Mac currently
 * has" ran `df -h` and the raw table below became the dashboard's hero
 * headline and the pendant's queued spoken reply. The answer must be built
 * from the table's own numbers — parsed, never hardcoded — and must not
 * contain a shred of the table's shape.
 */
const DF_H_OUTPUT = [
  'Filesystem     Size   Used  Avail Capacity iused ifree %iused  Mounted on',
  '/dev/disk3s1s1 460Gi   12Gi  125Gi     9%    425k  1.3G    0%   /',
].join('\n')

test('a df -h table becomes a sentence built from its own numbers', () => {
  const answer = answerForShellOutput({ command: 'df -h', stdout: DF_H_OUTPUT })

  assert.equal(answer, '125 GB free of 460 GB (9% used).')
  assert.equal(answer.includes('\n'), false)
  assert.equal(answer.includes('Filesystem'), false)
})

test('the df numbers are derived, not memorised', () => {
  const answer = answerForShellOutput({
    command: 'df -h',
    stdout: [
      'Filesystem     Size   Used  Avail Capacity iused ifree %iused  Mounted on',
      '/dev/disk1s1   1.8Ti  900Gi 890Gi    49%    811k  8.9G    0%   /',
    ].join('\n'),
  })

  assert.equal(answer, '890 GB free of 1.8 TB (49% used).')
})

test('df picks the root row, not whichever row comes first', () => {
  const answer = answerForShellOutput({
    command: 'df -h',
    stdout: [
      'Filesystem      Size   Used  Avail Capacity iused ifree %iused  Mounted on',
      'devfs          207Ki  207Ki    0Bi   100%     716     0   100%   /dev',
      '/dev/disk3s1s1 460Gi   12Gi  125Gi     9%    425k  1.3G    0%   /',
      '/dev/disk3s5   460Gi  321Gi  125Gi    72%    3.2M  1.3G    0%   /System/Volumes/Data',
    ].join('\n'),
  })

  assert.equal(answer, '125 GB free of 460 GB (9% used).')
})

test('plain df block counts are converted rather than spoken as blocks', () => {
  const answer = answerForShellOutput({
    command: 'df /',
    stdout: [
      'Filesystem   512-blocks      Used Available Capacity iused ifree %iused  Mounted on',
      '/dev/disk3s1s1 965595304  25165824 262144000     9%  425000 13000000    3%   /',
    ].join('\n'),
  })

  // 262144000 × 512 bytes ≈ 134 GB free of 965595304 × 512 ≈ 494 GB.
  assert.equal(answer, '134 GB free of 494 GB (9% used).')
})

test('a df aimed at a non-root volume names the mount point', () => {
  const answer = answerForShellOutput({
    command: 'df -h /Volumes/Media',
    stdout: [
      'Filesystem     Size   Used  Avail Capacity iused ifree %iused  Mounted on',
      '/dev/disk5s1   2.0Ti  1.5Ti 500Gi    75%    100k  5.0G    0%   /Volumes/Media',
    ].join('\n'),
  })

  assert.equal(answer, '500 GB free of 2.0 TB (75% used) on /Volumes/Media.')
})

test('df output the parser cannot read declines to the generic layer, not to raw', () => {
  assert.equal(formatShellAnswer('df -h', 'garbage'), null)
  assert.equal(answerForShellOutput({ command: 'df -h', stdout: 'garbage' }), 'garbage')
})

test('pmset battery output is spoken as charge, state and time', () => {
  const discharging = answerForShellOutput({
    command: 'pmset -g batt',
    stdout: [
      "Now drawing from 'Battery Power'",
      ' -InternalBattery-0 (id=6094947)\t85%; discharging; 3:42 remaining present: true',
    ].join('\n'),
  })
  assert.equal(discharging, 'Battery at 85%, discharging, about 3:42 remaining.')

  const charging = answerForShellOutput({
    command: 'pmset -g batt',
    stdout: [
      "Now drawing from 'AC Power'",
      ' -InternalBattery-0 (id=6094947)\t62%; charging; 1:10 remaining present: true',
    ].join('\n'),
  })
  assert.equal(charging, 'Battery at 62%, charging, about 1:10 until full.')

  const charged = answerForShellOutput({
    command: 'pmset -g batt',
    stdout: [
      "Now drawing from 'AC Power'",
      ' -InternalBattery-0 (id=6094947)\t100%; charged; 0:00 remaining present: true',
    ].join('\n'),
  })
  assert.equal(charged, 'Battery at 100%, fully charged.')

  const desktop = answerForShellOutput({
    command: 'pmset -g batt',
    stdout: "Now drawing from 'AC Power'",
  })
  assert.equal(desktop, 'On AC power.')
})

test('uptime is spoken as a duration, not as the whole status line', () => {
  const answer = answerForShellOutput({
    command: 'uptime',
    stdout: '10:14  up 3 days, 2:11, 2 users, load averages: 1.72 1.90 2.02',
  })

  assert.equal(answer, 'Up for 3 days, 2:11 — load 1.72.')
})

test('a plain ls becomes a count with a few names', () => {
  const answer = answerForShellOutput({
    command: 'ls ~/Downloads',
    stdout: ['invoice.pdf', 'photo.jpg', 'archive.zip', 'notes.txt', 'demo.mov'].join('\n'),
  })

  assert.equal(answer, '5 items — invoice.pdf, photo.jpg, archive.zip, and 2 more.')
  assert.equal(
    answerForShellOutput({ command: 'ls /tmp/empty', stdout: '' }),
    'Command completed.',
  )
})

test('du totals are spoken with their unit and target', () => {
  assert.equal(
    answerForShellOutput({
      command: 'du -sh /Users/evanliu/Downloads',
      stdout: '1.5G\t/Users/evanliu/Downloads',
    }),
    '1.5 GB in /Users/evanliu/Downloads.',
  )
})

test('sw_vers becomes the version sentence, not three labelled lines', () => {
  const answer = answerForShellOutput({
    command: 'sw_vers',
    stdout: 'ProductName:\t\tmacOS\nProductVersion:\t\t15.5\nBuildVersion:\t\t24F74',
  })

  assert.equal(answer, 'macOS 15.5 (build 24F74).')
})

test('scutil --nwi is spoken as the connection, not the interface dump', () => {
  const answer = answerForShellOutput({
    command: 'scutil --nwi',
    stdout: [
      'Network information',
      '',
      'IPv4 network interface information',
      '     en0 : flags      : 0x5 (IPv4,DNS)',
      '           address    : 192.168.1.23',
      '           reach      : 0x00000002 (Reachable)',
      '',
      '   REACH : flags 0x00000002 (Reachable)',
      '',
      'Network interfaces: en0',
    ].join('\n'),
  })

  assert.equal(answer, 'Online via en0 (192.168.1.23).')
})

test('the volume readback is spoken as a percentage', () => {
  assert.equal(
    answerForShellOutput({
      command: "osascript -e 'output volume of (get volume settings)'",
      stdout: '40',
    }),
    'Volume at 40%.',
  )
})

/*
 * The generic layer. Most commands have no formatter, and the contract there
 * is asymmetric on purpose: output that is already one short line IS the
 * answer and must pass byte-for-byte, while anything shaped like a report is
 * reduced to its first line plus an honest count of what was left out.
 */
test('a short single-line answer passes through untouched', () => {
  const date = 'Sat Aug  9 14:03:12 EDT 2026'
  assert.equal(answerForShellOutput({ command: 'date', stdout: date }), date)
  assert.equal(answerForShellOutput({ command: 'whoami', stdout: 'evanliu' }), 'evanliu')
})

test('multi-line output falls back to the first line plus a count', () => {
  const answer = answerForShellOutput({
    command: 'system_profiler SPHardwareDataType',
    stdout: [
      'Hardware:',
      '',
      '    Hardware Overview:',
      '',
      '      Model Name: Mac mini',
      '      Chip: Apple M2',
      '      Memory: 16 GB',
    ].join('\n'),
  })

  assert.equal(answer, 'Hardware: … and 4 more lines.')
  assert.equal(answer.includes('\n'), false)
})

test('one very long line is clipped at a word boundary, never mid-word', () => {
  const line = 'word '.repeat(60).trim() // 299 characters of five-character words
  const answer = condenseToAnswer(line)

  assert.ok(answer.length <= 200, `condensed answer is ${answer.length} chars`)
  assert.match(answer, /…$/)
  assert.equal(answer.includes('\n'), false)
  // Every kept token is a whole word — the clip landed on a boundary.
  for (const token of answer.replace(/…$/, '').split(' ')) {
    assert.equal(token, 'word')
  }
})

test('a single tab-separated table row is not mistaken for prose', () => {
  const answer = condenseToAnswer('PID\tTTY\tTIME\tCMD')

  assert.equal(answer.includes('\t'), false)
  assert.equal(answer, 'PID TTY TIME CMD')
})

/*
 * End to end through the executor: the message a result carries is the
 * sentence, and the raw output stays on the record for the job store and the
 * detail views. This is the exact pair of fields the dashboard headline and
 * the transcript read.
 */
test('run_shell reports the sentence as its message and keeps the raw stdout', async () => {
  const result = await executeComputerAction({
    type: 'run_shell',
    label: 'multi-line output',
    params: { command: 'printf "alpha one\\nbeta two\\ngamma three\\n"' },
  })

  assert.equal(result.ok, true)
  assert.equal(result.message, 'alpha one … and 2 more lines.')
  assert.equal(result.stdout, 'alpha one\nbeta two\ngamma three')
})

test('a run_shell answer that was already a sentence is left alone', async () => {
  const result = await executeComputerAction({
    type: 'run_shell',
    label: 'short output',
    params: { command: 'echo disk is fine' },
  })

  assert.equal(result.message, 'disk is fine')
  assert.equal(result.stdout, 'disk is fine')
})

test('a real df -h answers with free space, not a filesystem table', async () => {
  const result = await executeComputerAction({
    type: 'run_shell',
    label: 'Check free disk space',
    params: { command: 'df -h' },
  })

  assert.equal(result.ok, true)
  assert.match(result.message, /^[\d.,]+ [KMGT]B free of [\d.,]+ [KMGT]B/)
  assert.equal(result.message.includes('Filesystem'), false)
  assert.equal(result.message.includes('\n'), false)
  // The table itself is still on the record.
  assert.match(result.stdout, /Filesystem/)
})

test('get_mac_status speaks one utterance and files the raw transcript', async () => {
  const result = await executeComputerAction({
    type: 'get_mac_status',
    label: 'Read Mac battery',
    params: { fields: ['battery'] },
  })

  assert.equal(result.ok, true)
  assert.equal(result.message.includes('\n'), false)
  assert.match(result.message, /^(Battery at \d{1,3}%|On AC power)/)
  // The raw pmset output is preserved for the detail view, not spoken.
  assert.match(result.stdout, /drawing from/i)
})

/*
 * The wiring itself, read from source the way computerControl's own tests
 * read the dispatcher: runShell's success message must go through the
 * formatter, so nobody reintroduces raw stdout with a refactor.
 */
test('runShell builds its success message from shellAnswer, not from raw stdout', () => {
  const source = fs.readFileSync(
    path.join(moduleDirectory, 'computerControl.js'),
    'utf8',
  )

  assert.match(source, /import \{ answerForShellOutput \} from '\.\/shellAnswer\.js'/)
  assert.match(source, /answerForShellOutput\(\{ command, stdout, stderr \}\)/)
  assert.equal(
    source.includes("truncateMessage(stdout || stderr || 'Command completed.'"),
    false,
    'the old raw-stdout message construction must not come back',
  )
})
