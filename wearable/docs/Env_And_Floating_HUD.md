# Root `.env` + floating command HUD

## One env file: repo root only

```
agentic-gadget/.env          ← the only secrets file
agentic-gadget/.env.example  ← template (committed)
```

There are **no** `software/*/.env` files. Packages load root via:

```js
import '../../load-pendant-env.mjs'  // resolves to <repo>/.env
```

### Required keys (6)

| Key | Purpose |
|-----|---------|
| `PAIRING_CODE` | Mission Control login + device pairing |
| `RELAY_API_KEY` | Bridge / dashboard / worker |
| `AGENT_TOKEN` | Local Mac agent |
| `OPENROUTER_API_KEY` | LLM (+ multimodal) |
| `RELAY_URL` | Cloudflare relay |
| `SESSION_SECRET` | Dashboard cookies |

Aliases applied in `load-pendant-env.mjs`: `LLM_API_KEY`, `DASHBOARD_ACCESS_KEY`, `DASHBOARD_SESSION_SECRET`, `VITE_*`.

## Floating HUD

Menu bar AI Pendant → **Floating Command…** — always-on-top text + mic over other apps.

## Dashboard idle

Stuck `status=transcribing` jobs older than 90s are treated as failed. The hero shows **Ready / Idle** when nothing useful is active.
