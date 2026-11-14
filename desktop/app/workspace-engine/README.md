# workspace-engine

The Swift package for Hive.app's main executable and for Hive's virtual workspace: a display of
its own where the agent opens apps and works without taking your screen, mouse or keyboard.
`tools/build-workspace.sh` builds both under `build/swift/`; the Makefile puts them in
`build/Agent.app` as `Contents/MacOS/Agent` and `Contents/Helpers/workspace-engine`.

Hive starts the workspace only with `AGENT_EXPERIMENTAL_VIRTUAL_WORKSPACE=1`. Without it, Hive
works on your own screen and the engine never runs.

## Targets

| Target | What it is |
| --- | --- |
| `UnifiedAgent` (`agent-unified-host`) | The app shell, the context panel and the credential helper |
| `WorkspaceViewer` | The window in Hive.app that shows the workspace; Take Control (or right Option) pauses the agent and passes your clicks and keys to the workspace, Give Back resumes it |
| `WorkspaceDisplay` | The virtual display, made with CoreGraphics' `CGVirtualDisplay` classes looked up at run time |
| `WorkspaceCore` | The state folder, the session record, the daemon's wire format and the texts Hive parses |
| `WorkspaceEngine` | The daemon, the MCP server, the tools and the command line |
| `workspace-engine` | The executable: `WorkspaceEngine`'s command line |

## How it runs

Hive's Rust bridge (`crates/hive/hive-workspace`, `workspace-mcp-bridge`) runs
`workspace-engine mcp` and talks MCP to it over stdio. The first `mcp` process starts
`workspace-engine daemon run` in a session of its own; the daemon owns the display and the
session, and serves `<state>/workspace-engine/daemon.sock` (one JSON object per line). The
session belongs to the `mcp` connection that created or claimed it, and outlives it: when Hive
restarts, the new bridge claims the same session and display. An unclaimed session ends after its
grace period (30 minutes by default); so does one whose holder stops renewing its lease. When a
session ends, its apps are hidden and asked to quit and the display goes away. With no session and
no connection for a minute, the daemon exits.

The agent's clicks and keys go to the workspace's apps without moving your cursor: through
Accessibility (pressing buttons, setting text) when it can, otherwise as events posted to that
app's process only. Websites open in a separate Chromium profile under
`<state>/workspace-engine/browser-profile`, driven over its local debugging port.

If the Mac is short of memory, the engine refuses to make a display and says so; Hive retries
later. If a display fails to appear, the engine blocks new displays until someone looks:
`workspace-engine safety clear-host-health --operator` clears a block caused by memory pressure
once the Mac is healthy, and `workspace-engine safety clear --operator` clears any block.

## Commands

```sh
workspace-engine doctor [--json]                  # display safety, displays, the daemon
workspace-engine session list [--operator] [--json]
workspace-engine daemon stop [--force]            # --force ends a session someone holds
workspace-engine safety clear-host-health --operator
workspace-engine safety clear --operator
```

`AGENT_STATE_DIR` picks the state folder, as for the rest of Hive.

## Tests

```sh
bash tools/build-workspace.sh && swift test --package-path build/swift
```

The tests run the real daemon and `mcp` processes on a stand-in display
(`HIVE_WORKSPACE_TEST_DISPLAY=1`), which makes no display and shows nothing; tools that need a
real screen answer `[unsupported]` there.
