# Hive

The club's one project: agents that use your computer, phone and browser the way you do.

**Get Hive:** two downloads. **Hive Server** goes on one computer that stays on and online 24/7 (an old laptop at home, a desktop, or a cloud VM; it's the same): it's where Hive's agents run. **Hive** goes on the devices you use every day (your laptop, browser and phone), which connect to your Hive Server. On Linux, one command fetches the build for its processor: `curl -fLo hive-server https://github.com/agenticaiuw/hive/releases/download/latest/hive-server-linux-$(uname -m) && chmod +x hive-server && sudo ./hive-server`. On a [Mac](https://github.com/agenticaiuw/hive/releases/download/latest/Hive-Server.dmg) (one build for Apple and Intel chips) or [Windows](https://github.com/agenticaiuw/hive/releases/download/latest/hive-server-windows.exe), download it and open it: a window (on a Mac, double-click Hive Server in the disk image: it installs itself into Applications and opens) asks whether Hive's agents use Claude or ChatGPT, gets Claude Code or Codex, and signs in to your account. On Linux the same steps run in the terminal. It then has you sign in to a free Tailscale account, built into Hive, so your own devices reach it from anywhere and nobody else can. It starts with the computer from then on (on Linux as its own `hive` user, never root), and gives you your dashboard's link. Then add your devices, each signing in to the same Tailscale account once: the Hive app for [Mac](https://github.com/agenticaiuw/hive/releases/download/latest/Hive-Mac.dmg) (drag it into Applications and open it, then allow it under Accessibility when macOS asks: it has no window, pressing fn opens a bar to ask Hive, and Hive for Safari comes inside, turn it on in Safari's Settings, under Extensions, and Control+Shift+H opens it) or [Windows](https://github.com/agenticaiuw/hive/releases/download/latest/hive-windows.exe), and the [browser extension](https://github.com/agenticaiuw/hive/releases/download/latest/Hive-Browser.zip) for Chrome, Edge and Brave. The server keeps itself at the latest build, and the apps follow their server.

## How it fits together

- **One brain.** The server is the only place agents run, on whichever computer the owner made their Hive; every computer starts it the same way, and the owner's devices reach it through their own Tailscale network, built in. Codex is signed in there and nowhere else.
- **Every request goes to the orchestrator first**, which answers from available context and routes work to the agent already on that task, or to a new one. Agent progress, answers and requests for input return to the orchestrator chat, labeled with their task. The agent that takes it writes the rules (standing instructions, scoped to everywhere, a node, a site, an app or a folder) and any further tasks, since it has the context; an agent outside Hive (Claude Code, Codex, Cursor, …) does the same with Hive's MCP tools (below).
- **Agents can claim several tasks** and run them sequentially, with the tools each task needs. Related tasks reuse their project’s agent. A turn ends with done and the outcome, or exactly why it stopped and what the owner must do; there is no "stuck".
- **Nodes bring their own tools.** A Mac or Windows computer, the iPhone, a browser or a wearable says what agents can do with it when it connects. Tools that share a lock (the Mac's keyboard and mouse, the phone's screen) go to one agent at a time; everything else runs in parallel.
- **Context carries forward.** The orchestrator sees recent requests, and agents receive earlier work and owner corrections from the same project. Agents can retrieve original requests, outcomes and follow-ups with `history`. Historical context stays separate from explicit standing rules.
- **Everything is kept** in one database the dashboard shows: requests, tasks, rules, every agent's log and tool calls, files, and the owner's info catalogue.
- **Hive changes itself.** An agent on a "hive" task edits this repo on the VM, rebuilds and restarts Hive and pushes to GitHub, which builds and signs what every device downloads and updates to.

The desktop app streams Claude Code and Codex session messages and tool activity into separate dashboard chats for sessions that explicitly created Hive tasks. Transcript imports do not create tasks. It reads local session transcripts, imports recent context (up to 1 MiB per existing transcript), then follows new records every two seconds while connected. Restarting resumes from acknowledged offsets. Completion records clear the running indicator; silent sessions expire after two minutes. Provider-private reasoning is not imported.

## Adding Hive to your agents

With the Hive app on your computer, any agent you use there (Claude Code, Codex, Cursor, Claude Desktop, …) saves the work you give it as your Hive tasks, and follows and adds to your rules, through `hive mcp`, an MCP server with six tools: `add_task`, `end_task`, `task_status`, `add_rule` and `get_rules`, and `hand_off` for work Hive's own agents should do (on your phone, say). On a Mac the program is `/Applications/Hive.app/Contents/MacOS/hive`; on Windows use the path of `hive-windows.exe` instead.

- **Claude Code:** `claude mcp add --scope user hive -- /Applications/Hive.app/Contents/MacOS/hive mcp`. So every prompt also goes to Hive's orchestrator first, add the hook to `~/.claude/settings.json`: `"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "/Applications/Hive.app/Contents/MacOS/hive hook"}]}], "PostToolUse": [{"hooks": [{"type": "command", "command": "/Applications/Hive.app/Contents/MacOS/hive hook"}]}]}`.
- **Codex:** `codex mcp add hive -- /Applications/Hive.app/Contents/MacOS/hive mcp`, or in `~/.codex/config.toml`:

  ```toml
  [mcp_servers.hive]
  command = "/Applications/Hive.app/Contents/MacOS/hive"
  args = ["mcp"]
  ```
- **Anything else** that speaks MCP over stdio: the command `/Applications/Hive.app/Contents/MacOS/hive` with the argument `mcp`.

## Where things are

Folders follow the parts of Hive, not the club's teams: parts last longer than team lineups, and one team often looks after several parts.

| Folder | What it is | Looked after by |
|---|---|---|
| `protocol/` | The one agreement between the server and everything that connects to it, and the Rust library nodes use to speak it | Cloud, with every team that uses it |
| `server/` | The brain, its own download (`hive-server`): orchestrator, agents, database, API | Cloud |
| `vm/` | How the VM runs Hive: its services, installer and screen | Cloud |
| `dashboard/` | The dashboard the server shows at `/` | Product Design |
| `desktop/` | The Hive app for Mac and Windows (`hive`, no window; fn's type bar on a Mac): the computer as a node (screen, mouse, keyboard, shell, files); also every agent's way into Hive (`hive mcp`, `hive hook`) | Automation |
| `browser/` | The browser extension as a node: agents use the owner's browser, site rules apply on every page, any page can ask Hive; Tailscale built in (`tailnet/wasm.sh`) reaches the Hive Server on its owner's tailnet | Automation |
| `tailnet/` | Tailscale built into Hive (`hive-tailnet`, Go): how a Hive Server, on a laptop or a cloud VM, is reached by its owner's own devices, privately and encrypted, with nobody installing Tailscale; the browser extension's is the same module, built for the browser (`wasm.go`) | Cloud |
| `phone/` | The iPhone as a node: the Hive app (`ios/`) dials in to the server over a WebSocket and shows the dashboard (it reaches the Hive Server through Tailscale built in), and the server runs the phone's tools (this crate), on any computer | Automation |

A folder appears with its first code: a new device, like Hardware's wearable, is a new top-level folder that speaks `protocol/`, and the server doesn't change for it.

## Working together

- Change anything inside a part freely. Parts meet only at `protocol/`, so changes there follow its rules: add, never alter, in a pull request of its own.
- Keep pull requests small and merge them into `main` within a day or two; long-lived branches drift.
- Tests sit next to the code they test: `#[cfg(test)]` in the same file, or a `tests/` folder inside the part.
- `cargo build --release` builds everything and `cargo test` tests it. Every push and pull request runs both, plus a check that keeps personal details out of this public repo (`.github/`).
