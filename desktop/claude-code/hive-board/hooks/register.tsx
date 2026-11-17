// Hive's task board in a pane beside the chat (hive T24): the owner asked for Claude Code to show
// the tasks their instructions became, so they never have to remind an agent twice. It reads the
// same ledger the dashboard shows (`hive-tasks board --json`, which every machine syncs to the
// cloud board) and refreshes every 20 seconds and whenever a turn starts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, BoardTask } from '../types'

const PANE = 'hive-board'
const EMPTY: Board = {
  project: '',
  needsYou: [],
  working: [],
  notStarted: [],
  done: [],
  elsewhere: [],
  readAt: 0,
  error: '',
}
// Change the tag when Board's fields change: it declines what an earlier version stored.
const board = atom({ plugin: 'hive-board', key: 'board' } as const, EMPTY, { shape: 'board-1' })

type Row = Record<string, unknown>
const text = (v: unknown) => (v == null || v === 'None' ? '' : String(v))
const task = (r: Row): BoardTask => ({
  id: text(r.id),
  title: text(r.title),
  status: text(r.status),
  project: text(r.project),
  outcome: text(r.outcome),
  updated: text(r.updated_at),
})
const list = (v: unknown): BoardTask[] => (Array.isArray(v) ? v.map(r => task(r as Row)) : [])

// hive-tasks lives in ~/.local/bin, which a host's PATH may not have.
const HIVE_TASKS = 'exec "$HOME/.local/bin/hive-tasks" board --json "$@"'

async function refresh($: EngineInterface): Promise<void> {
  try {
    const here = await $.process.run(['/bin/sh', '-c', HIVE_TASKS, 'hive-tasks'], { timeoutMs: 15000 })
    const all = await $.process.run(['/bin/sh', '-c', HIVE_TASKS, 'hive-tasks', '--all'], { timeoutMs: 15000 })
    if (here.exitCode !== 0) throw new Error(here.stderr.trim() || `hive-tasks exited ${here.exitCode}`)
    const mine = JSON.parse(here.stdout) as Row
    const every = all.exitCode === 0 ? (JSON.parse(all.stdout) as Row) : {}
    const project = text(mine.project)
    const next: Board = {
      project,
      needsYou: list(mine.needs_you),
      working: list(mine.in_progress),
      notStarted: [...list(mine.not_started), ...list(mine.left_open), ...list(mine.not_split)],
      done: list(mine.done).slice(0, 5),
      elsewhere: list(every.needs_you).filter(t => t.project !== project),
      readAt: await $.clock.now(),
      error: '',
    }
    await update($, board, () => next)
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err)
    await update($, board, old => ({ ...old, error: said }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hive-board', description: "Show Hive's task board beside the chat" })
    void $.ui.open({ id: PANE, title: 'Hive tasks' })
    void refresh($)
    $.clock.every(20000, () => refresh($))
    return next(e)
  })

  on('command.run', { command: 'hive-board' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Hive tasks' })
    await refresh($)
    return { text: "Hive's task board is open beside the chat." }
  })

  // A new instruction becomes tasks as the turn starts; show them without waiting for the timer.
  on('turn.start', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const b = await read($, board)
    const short = (p: string) => p.replace(/^github\.com\//, '').split('/').pop() || p
    const line = (t: BoardTask, color: string, showProject = false) => (
      <Box flexDirection="column" marginBottom={1}>
        <Text wrap="truncate-end">
          <Text color={color}>● </Text>
          <Text dimColor>{t.id} </Text>
          {t.title}
          {showProject ? <Text dimColor> · {short(t.project)}</Text> : null}
        </Text>
        {t.outcome ? (
          <Text dimColor wrap="truncate-end">
            {'  '}
            {t.outcome}
          </Text>
        ) : null}
      </Box>
    )
    const section = (name: string, tasks: BoardTask[], color: string, showProject = false) =>
      tasks.length === 0 ? null : (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>
            {name} <Text dimColor>{tasks.length}</Text>
          </Text>
          {tasks.map(t => line(t, color, showProject))}
        </Box>
      )
    const nothing =
      b.needsYou.length + b.working.length + b.notStarted.length + b.done.length + b.elsewhere.length === 0

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {b.project ? short(b.project) : 'Hive tasks'}
          {b.readAt ? ' · every machine' : ' · reading…'}
        </Text>
        {b.error ? <Text color="red">Couldn't read the board: {b.error}</Text> : null}
        <Box flexDirection="column" marginTop={1}>
          {section('Needs you', b.needsYou, 'yellow')}
          {section('Working on it', b.working, 'blue')}
          {section('Not started', b.notStarted, 'gray')}
          {section('Done lately', b.done, 'green')}
          {section('Other projects need you', b.elsewhere, 'yellow', true)}
          {nothing && b.readAt ? <Text dimColor>No tasks in this project yet.</Text> : null}
        </Box>
      </Box>
    )
  })
}
