# Hive — Agent Harness Instructions

Hive is an open-source, self-evolving personal agent system (Rust workspace: `server/`, `desktop/`, `protocol/`, `phone/`; JS browser extension: `browser/`; single-file dashboard: `dashboard/index.html`).

## Architecture & Invariants
- **Control vs. execution planes:** The orchestrator agent holds the big picture (projects, scoped rules, routing, owner communication) with read-only context; worker agents execute scoped tasks in isolation with strictly their task's granted device tools.
- **Keep tool count lean (<15 flat tools):** Consolidate primitives with action enums (`mac_input`, `mac_apple`, `memory`, `sim`); spill large tool outputs (>6,000 chars) to disk instead of flooding context.
- **Three-tier memory:**
  - **Tier 0** (`server/src/cred.rs`, `systemd-creds`): encrypted logins and payment cards. Never read or print secrets in plain text; payment card entry is a one-way door requiring explicit owner confirmation (`confirmed=true`).
  - **Tier 1** (`info`, `contacts`) & **Tier 2** (`playbooks`): backed by SQLite FTS5 BM25 (`server/src/memory.rs`) with a secret firewall. Store only stable CSS/ARIA/URL patterns in playbooks (never transient `data-hive` indices).
- **Apple Reminders & Calendar SSOT:** Use `mac_apple` (EventKit read-through/write-through) directly; never build a 2-way reminder/calendar mirror in SQLite (store only sidecar `external_id` links in `apple_links`).
- **Build-to-Delete:** Prefer deleting dead/duplicate code and simplifying over adding layers. Never edit `SPECS.md` and never delete or weaken tests.
- **Privacy gate:** Never commit owner personal details, real non-example emails, tokens, or `wearable/` local hardware experiments.

## Shared Harness Integration (`hive mcp` + `hive hook`)
- Connect Claude Code, Codex, and Antigravity to one shared Hive backend with `hive connect` (wires `hive mcp` for `memory`, `get_rules`, `add_rule`, `add_task`, `hand_off`, `end_task`, `task_status`, plus lifecycle hooks for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`).
- Never copy raw chat transcripts across harnesses; share only structured rules, Tier 1–2 memory, and explicit handoffs.

## Verify Before Finishing
```bash
cargo test --workspace
node --test .github/privacy.test.mjs
node --test browser/tests/*.test.cjs
```

## Club Collaboration & Self-Improvement Governance
- Keep owner-specific edits local (SQLite rules/memory/local `sim`, `<state>/*.md`, or a local branch + `reinstall`).
- For generalizable club fixes or subtraction wins, append an anonymized `sim(mode="export")` entry to `server/sim.jsonl`, push a feature branch (`hive/<slug>`), and open a **draft PR** (`gh pr create --draft`). Never push automated self-edits directly to club `main`.
