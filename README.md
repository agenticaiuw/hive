# Hive

The club's one project ([agenticaiuw.com/hive](https://agenticaiuw.com/hive)): agents that use your computer, phone and browser the way you do. One brain runs in the cloud; every device connects to it and says what agents can do with it.

Each team works in its own folder:

| Folder | Team | What's in it |
|---|---|---|
| `cloud/` | Cloud | The server on the VM: orchestrator, agents, database, API. `cloud/node/` is the device contract. |
| `desktop/` | Automation | The Mac app (Windows next): keyboard, mouse, screen, shell, files. Also Claude Code's hook. |
| `mobile/` | Automation | The iPhone: tap, swipe, type and screenshots through its relay. |
| `browser/` | Automation | The Chrome and Safari extensions. |
| `dashboard/` | Product Design | The dashboard the server shows at `/`. |
| `research/` | Research | How Hive fits together and how agents handle what they know. |
| `wearable/` | Hardware | The screenless wearable. |

Teams meet in two places only:
- **The device contract** (top of `cloud/node/src/lib.rs`): pair, say hello with your tools, take calls, answer them. A new device is a new folder that speaks it; the cloud doesn't change.
- **The API** the dashboard and devices call (`cloud/src/api.rs`).

Build everything with `cargo build --release`. Before pushing, run `node --test tests/*.test.mjs`.
