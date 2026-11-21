# How Hive fits together

- **One brain.** The server on the VM is the only place agents run. Codex is signed in there and nowhere else.
- **Every request goes to the orchestrator first.** It turns the owner's words into rules (standing instructions, scoped to everywhere, a device, a site, an app or a folder) and tasks, or passes them to the agent already on that task.
- **One agent per task.** Each task gets its own agent and chat, with the tools of the devices the task needs. A turn ends with done and the outcome, or exactly why it stopped and what the owner must do. Nothing else ends it, so there is no "stuck".
- **Devices bring their own tools.** Desktop, phone, browser and wearable each declare their tools when they connect. Tools that share a lock (the Mac's keyboard and mouse, the phone's screen) go to one agent at a time; everything else runs in parallel.
- **Everything is kept.** Requests, tasks, rules, every agent's log, tool calls, files and the owner's info catalogue live in one database the dashboard shows.
- **Hive changes itself.** An agent on a "hive" task edits this repo on the VM, rebuilds, and restarts Hive. Devices with a checkout pick the change up from the VM.

Open questions for this team: how an agent decides what to keep in mind as a task grows, and which models can run on the club's own hardware.
