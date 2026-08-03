# AI Pendant companion

Standalone macOS menu-bar + desktop app. Menu bar shows green/red agent status; the window has two tabs — **Dashboard**, the same web app the browser and iPhone show (WKWebView, persistent cookie store, sign in once, mic granted for that origin), and **This Mac**, a native live view of the local agent (SSE from `http://localhost:8000`, current command + steps, recent jobs, log tail). The native view reads `AGENT_TOKEN` at runtime from the repo-root `.env` (`~/agentic-gadget/.env`; path overridable via `defaults write com.aipendant.menubar AgentEnvPath`) and no credential is embedded in the app. It never modifies the agent's LaunchAgent, app bundle, or TCC permissions.

Rebuild: `./build.sh`, then copy `build/AI Pendant.app` to `/Applications` and `open` it.
