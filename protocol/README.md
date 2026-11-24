# The protocol

The one agreement between Hive's server and everything that connects to it. Every part of Hive meets the others only here, so a change to this file is a change for every team: add, never alter (new optional fields and new routes are fine; changing what an existing one means is not), and do it in a pull request of its own that the teams using it review. Nodes update themselves from the server, but an old node must keep working until it does.

Every call is HTTP to the server across the owner's tailnet (WireGuard encrypts it) with `Authorization: Bearer <token>`. JSON in, JSON out; errors are `{error}` with a 4xx or 5xx status.

## Nodes

A node is anything agents can use: a Mac or Windows computer, the iPhone, a browser, a wearable. It needs four calls, and `src/lib.rs` makes them for nodes written in Rust.

1. **Join once.** `POST /api/pair/tailnet {kind, name}` → `{token}`, from a device signed in to the same Tailscale account as the server (the iPhone: `POST /api/phone/tailnet` → `{url, token}`). `kind` is the node's type (`mac`, `windows`, `phone`, `browser`, …) and prefixes its tool names.
2. **Say hello every minute.** `POST /api/node/hello {id, kind, name, version, notes, tools}` → `{version}`, the last change to the devices' code (a node updates itself to GitHub's build when theirs differs).
   - `notes`: a sentence or two agents should know about this node.
   - `tools`: `[{name, description, inputSchema, lock?, timeout?}]`, everything agents can do with it. Tools sharing a `lock` (say `"input"`) go to one agent at a time; the rest run in parallel. `timeout` is in seconds (default 120).
3. **Take calls.** `GET /api/node/next?id=<id>` waits up to 25 s → `{id, tool, args}`, or 204 when there's nothing.
4. **Answer.** `POST /api/node/result {id, result}`, where `result` is `{text, images?, data?, name?}` or `{error}`. `images` are data URLs.

Files cross with calls: an argument named `vm_path` reaches the node with the file's base64 in `args.data`, and a result with base64 `data` and a `name` is saved into Hive's files, so the agent gets its path on the VM.

## Everything else

What the dashboard, the extension's pages and any node can call. Every request from anywhere goes to the orchestrator first.

| Call | What it does |
|---|---|
| `POST /api/requests[?wait=1] {text, node, agent?, context?}` | Give Hive a request. `context` is `{site?, app?, folder?, url?, title?}`. With `wait=1` the answer comes back: `{status, reply, tasks, rules}`. |
| `GET /api/state` | Open tasks, working agents, nodes, recent requests, locks. |
| `GET /api/tasks[?status=]`, `GET /api/tasks/:id` | Tasks (done ones unless `status` says otherwise), and one task with its log. |
| `POST /api/tasks/:id/message {text}` | Tell the agent on a task something. |
| `POST /api/tasks/:id/end {done: true, outcome}` or `{why, need}` | End a task: done, or exactly why it stopped and what the owner must do (agents outside the server, like Claude Code, use this). |
| `POST /api/tasks/:id/drop` | Cancel a task. |
| `GET /api/rules[?site=&app=&folder=&node=]`, `POST /api/rules {text, quote, scope}`, `DELETE /api/rules/:id` | The owner's rules, all or those that apply to a place. |
| `GET /api/inbox?session=` | Messages and tasks waiting for a Claude Code session. |
| `GET /api/info`, `POST /api/info {key, value}` | The owner's info catalogue. |
| `GET /api/files`, `POST /api/files?name=` (the body is the file), `GET /api/files/:id` | Hive's files. |
| `GET /api/log`, `GET /api/db`, `GET /api/db/:table`, `GET /api/tools` | Everything Hive has recorded, and every tool agents can use. |
| `GET /api/vm/screen` | A screenshot of the VM's screen. |
| `GET` and `PUT /api/sites/:name/data`, `GET /sites/:name/…` | Pages Hive builds (dashboards, cross-site views) and their data. |
