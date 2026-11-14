# Hive — live observability aggregator for the AI pendant hive mind

One JSON/SSE feed that shows, live: which nodes are active, the
context/environment and tool calls inside each node, and what is shared/synced
between nodes. The UI is the SvelteKit dashboard's **/hive** route
(`dashboard`), which reads this server's `/api/*` when the
browser is on the Mac and the relay snapshot copy everywhere else; the old
hand-rolled page this server used to serve at `/` was folded into it.

## Run

```sh
node dashboard/aggregator/server.mjs   # from the repo root
```

It binds **http://127.0.0.1:8010** (if 8010 is busy it walks 8011…8020 and
prints which one it bound). Node 18+, zero npm dependencies, binds 127.0.0.1
only.

## What it aggregates

| Source | How | Cadence |
|---|---|---|
| Mac local agent (`127.0.0.1:8000`) | Bearer `AGENT_TOKEN` from the repo-root `.env` | 2.5–5 s fast paths (`/jobs`, `/pipeline`, `/browser/status`), 20–30 s heavy (`/ops/snapshot`, `/observe`, `/catchup`, `/memory/facts`), 60 s `/capabilities` |
| Cloud relay (workers.dev) | Bearer `RELAY_API_KEY` | `/health` 5 s, `/v1/devices/status` + `/v1/ops/history` 10 s |
| Design committee files (`diagnostics/harness-derivation/`) | read-only, stat-gated (mtime+size) so unchanged files are never re-read; `commons.jsonl` is tailed from the end (last 256 KB) | bulletin/commons 5 s, orchestrator 10 s, ledger 60 s |

Deliberately **not** called: `GET /memory/projection` (write side effects) and
`/observe?probeInput=1` (spawns a helper process).

## Endpoints

- `GET /api/overview` — full aggregated snapshot
- `GET /api/events` — SSE stream, diffs + new ticker events every ~2 s
- `GET /api/node/:id` — drill-down (`mac`, `relay`, `extension`, `pendant`,
  `ios`, `committee`, or a committee agent name like `mac-planner`);
  `GET /api/node/mac?job=<jobId>` lazily proxies that job's receipts
- `POST /api/credentials/:tokenId/revoke` — the one write path: kills a relay
  credential using the admin key this server already holds (the dashboard only
  ever names a tokenId)

## Honesty & secrets

- A failing source renders as failed **with the real error string** — there is
  no sample data and no demo mode. Pendant status is "unknown via relay" when
  the relay has no pendant device row.
- Secrets stay server-side. Every value from `.env` is scrubbed from every
  outbound byte, and memory-fact values that look like secrets are masked
  before they leave the server.
