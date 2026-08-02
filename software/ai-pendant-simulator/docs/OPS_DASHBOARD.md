# Mac Ops Dashboard

Local control room for pendant sessions, context/memory, jobs, and system health.

## Open it

```bash
npm run build
npm run agent
open http://localhost:8000/dashboard
```

During UI development:

```bash
npm run agent    # terminal 1
npm run dev:ops  # terminal 2
```

Connect panel uses `AGENT_TOKEN` / `VITE_AGENT_TOKEN` from `.env`.

## Panels

| Panel | Capabilities |
|-------|----------------|
| Overview | Agent / relay / bridge / browser status, working memory, Mac app scan |
| Sessions | List, rename, clear turns, delete, read conversation history |
| Context | View/edit/delete entities & relations, reset, load demo graph |
| Jobs | Live plan/execute history from this Mac agent |
| Activity | Execution logs |

Polling refreshes overview data every 4 seconds. Thinking Trace uses a live `/thinking/stream` feed so LLM drafting updates appear while the model is still working.
