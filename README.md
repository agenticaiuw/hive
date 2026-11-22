# Hive

The club's one project: agents that use your computer, phone and browser the way you do.

**Get Hive:** your Hive is the server, its own download for a computer that stays on (a VM or an old laptop at home, it's the same). On Linux, one command fetches the build for its processor: `curl -fLo hive-server https://github.com/agenticaiuw/hive/releases/download/latest/hive-server-linux-$(uname -m) && chmod +x hive-server && sudo ./hive-server`. On a [Mac](https://github.com/agenticaiuw/hive/releases/download/latest/hive-server-macos.zip) (one build for Apple and Intel chips) or [Windows](https://github.com/agenticaiuw/hive/releases/download/latest/hive-server-windows.exe), download it and open it. It signs in to ChatGPT with a code, starts with the computer from then on, and gives you your dashboard's link. Then add your devices from the dashboard's **Pair a device**: the Hive app for [Mac](https://github.com/agenticaiuw/hive/releases/download/latest/Hive-Mac.dmg) (drag it into Applications and open it right after Pair a device: it has no window; Hive for Safari comes inside, turn it on in Safari's Settings, under Extensions, and Control+Shift+H opens it) or [Windows](https://github.com/agenticaiuw/hive/releases/download/latest/hive-windows.exe), and the [browser extension](https://github.com/agenticaiuw/hive/releases/download/latest/Hive-Browser.zip) for Chrome, Edge and Brave. The server keeps itself at the latest build, and the apps follow their server.

## How it fits together

- **One brain.** The server is the only place agents run, on whichever computer the owner made their Hive; every computer starts it the same way and serves it over HTTPS on its own public address (a home router opens the ports itself). Codex is signed in there and nowhere else.
- **Every request goes to the orchestrator first**, which only routes it: to the agent already on that task, or to a new one. The agent that takes it writes the rules (standing instructions, scoped to everywhere, a node, a site, an app or a folder) and any further tasks, since it has the context; a Claude Code session does the same with `hive rule` and `hive task`.
- **One agent per task**, with the tools of the nodes the task needs. A turn ends with done and the outcome, or exactly why it stopped and what the owner must do; there is no "stuck".
- **Nodes bring their own tools.** A Mac or Windows computer, the iPhone, a browser or a wearable says what agents can do with it when it connects. Tools that share a lock (the Mac's keyboard and mouse, the phone's screen) go to one agent at a time; everything else runs in parallel.
- **Everything is kept** in one database the dashboard shows: requests, tasks, rules, every agent's log and tool calls, files, and the owner's info catalogue.
- **Hive changes itself.** An agent on a "hive" task edits this repo on the VM, rebuilds and restarts Hive; nodes with a checkout pick the change up from the VM.

## Where things are

Folders follow the parts of Hive, not the club's teams: parts last longer than team lineups, and one team often looks after several parts.

| Folder | What it is | Looked after by |
|---|---|---|
| `protocol/` | The one agreement between the server and everything that connects to it, and the Rust library nodes use to speak it | Cloud, with every team that uses it |
| `server/` | The brain, its own download (`hive-server`): orchestrator, agents, database, API | Cloud |
| `vm/` | How the VM runs Hive: its services, installer and screen | Cloud |
| `dashboard/` | The dashboard the server shows at `/` | Product Design |
| `desktop/` | The Hive app for Mac and Windows (`hive`, no window): the computer as a node (screen, mouse, keyboard, shell, files); also Claude Code's hook | Automation |
| `browser/` | The browser extension as a node: agents use the owner's browser, site rules apply on every page, any page can ask Hive | Automation |
| `phone/` | The iPhone as a node: Hive Phone (`ios/`) dials in to the server over a WebSocket, and the server runs the phone's tools (this crate), on any computer | Automation |

A folder appears with its first code: a new device, like Hardware's wearable, is a new top-level folder that speaks `protocol/`, and the server doesn't change for it.

## Working together

- Change anything inside a part freely. Parts meet only at `protocol/`, so changes there follow its rules: add, never alter, in a pull request of its own.
- Keep pull requests small and merge them into `main` within a day or two; long-lived branches drift.
- Tests sit next to the code they test: `#[cfg(test)]` in the same file, or a `tests/` folder inside the part.
- `cargo build --release` builds everything and `cargo test` tests it. Every push and pull request runs both, plus a check that keeps personal details out of this public repo (`.github/`).
