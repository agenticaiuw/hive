# One env file + floating command HUD

## Secrets: `software/ai-pendant.env`

All packages load this single file (via `software/load-pendant-env.js` or a symlink named `.env`).

### Required keys (6)

| Key | Purpose |
|-----|---------|
| `PAIRING_CODE` | Mission Control login **and** device pairing |
| `RELAY_API_KEY` | Bridge / dashboard / worker auth |
| `AGENT_TOKEN` | Local Mac agent Bearer token |
| `OPENROUTER_API_KEY` | LLM + multimodal (also accepted as `LLM_API_KEY`) |
| `RELAY_URL` | Cloudflare relay base URL |
| `SESSION_SECRET` | Dashboard cookie signing |

Everything else (models, ports, retention, computer-use flags) has **code defaults** — only set them to override.

### Aliases applied automatically

- `OPENROUTER_API_KEY` ↔ `LLM_API_KEY`
- `PAIRING_CODE` → `DASHBOARD_ACCESS_KEY` (login code)
- `SESSION_SECRET` → `DASHBOARD_SESSION_SECRET`
- `RELAY_URL` → `VITE_RELAY_URL`

### Cloudflare

`wrangler secret put` for the worker should still set `RELAY_API_KEY`, `PAIRING_CODE`, and `LLM_API_KEY` / `OPENROUTER_API_KEY` to match this file.

## Floating command HUD

In **AI Pendant** (menu bar app):

1. Menu bar icon → **Floating Command…** (or rebuild/install the app)
2. Always-on-top panel with **mic + text field + send**
3. Stays over other apps (`NSPanel` floating, all Spaces)
4. Sends to local agent `POST /plan` then auto-`/execute` when actions are returned

Rebuild:

```bash
cd software/mac-menubar && bash build.sh
# then copy build/AI\ Pendant.app to /Applications
```

Mic needs **Speech Recognition** + **Microphone** permission for the app.
