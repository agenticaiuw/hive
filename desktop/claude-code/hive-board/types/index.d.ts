export type BoardTask = {
  id: string
  title: string
  status: string
  project: string
  outcome: string
  updated: string
}

export type Board = {
  /** The session's project as hive-tasks names it (a git remote, or the folder). */
  project: string
  needsYou: BoardTask[]
  working: BoardTask[]
  notStarted: BoardTask[]
  done: BoardTask[]
  /** Other projects' tasks that wait on the owner. */
  elsewhere: BoardTask[]
  /** When the board was read (ms since the epoch), or 0 before the first read. */
  readAt: number
  /** Why the last read failed, or "" when it worked. */
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'hive-board': { board: Shaped<Board> }
  }
}
