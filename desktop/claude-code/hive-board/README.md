# hive-board

Hive's task board in a pane beside the chat in Claude Code. The owner asked for Claude Code to show
the tasks their instructions became (hive T24), so nobody has to remind an agent of the same thing
twice. The pane lists this project's tasks that need you, the ones agents are working on, the ones
not started and the last five done, plus other projects' tasks that wait on you. It reads
`hive-tasks board --json` (the ledger every machine syncs to the cloud board, the same data the Hive
dashboard shows), every 20 seconds and whenever a turn starts. `/hive-board` reopens the pane.

Needs `~/.local/bin/hive-tasks` (desktop/app/crates/hive/hive-tasks).
