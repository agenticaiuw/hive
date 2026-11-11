# Instruction ledger

The local ledger records instruction text, stable source identity, relationships,
constraints, attempts, approvals and evidence in an append-only private file.
New instruction text, constraints and evidence are encrypted with AES-256-GCM;
the key is a separate mode-0600 local file, not a Keychain-backed secret.
Conservative screening withholds recognizable credential-bearing instructions,
but cannot reliably detect every unlabeled secret. Identifiers and other event
metadata are not encrypted. The retained migration backup contains plaintext
reviewed summaries and must be protected as private data.
The default is `~/.hivemind/orchestrator/tasks.jsonl`; set
`HIVEMIND_TASK_LEDGER` to use another path. This file contains user instructions;
protect and back it up as private data. A successful write is fsynced. A damaged
or incomplete tail fails closed; retain it and review recovery rather than
truncating it automatically. A `.lock` left by a crash must only be removed
once the prior writer is known to have stopped. Concurrent writers can receive
an error and must not dispatch until recording succeeds. There is no automatic
backup or guarantee against disk loss.

`node cloud/orchestrator/ledger-cli.mjs reconcile` reports unfinished work and the
next observation needed. `snapshot` includes all recorded work. `record`,
`stop`, `resume`, `approve`, `relate`, `observe`, and `complete` take a JSON object on
stdin. These local commands never dispatch work; `resume` and `approve` are
explicit owner operations. Evidence records are supplied by the caller and
must be checked against their sources; syntactic validation does not prove
that the underlying work finished. Completion is never inferred from an
admission. Unknown or interrupted attempts are never replayed automatically.
Parent and related links preserve context; adding a child to a completed parent
reopens it for renewed review. Constraints are recorded as context, not parsed
or enforced as action policy. Execution integrations must separately declare
and enforce approvals and irreversible-action boundaries.

The opt-in PC mesh runner records authenticated, allowlisted requests before
local dispatch and shares the default ledger. Hivemind local-agent `/plan` and
`/execute` record request instructions; clients can pass the returned
`instructionId` to link a plan to its execution. The local dashboard command
flow, browser fallback and the applicable relay bridge path pass that ID.
Planner action proposals are recorded as child tasks before a plan response;
these remain unfinished until separately supported by completion evidence.
Direct `/research` and `/briefing` calls are recorded before their handlers and
uncertain outcomes are not retried. Authenticated
`/instruction-ledger` exposes read-only reconciliation, stop, explicit resume,
approval and evidence entry. A stop requests cancellation of active local jobs
and prevents new planner, executor, and routine launches; a cancellation request
does not prove an already running effect was interrupted. Local-agent monitors
reconciliation every ten seconds, reporting its last successful check and
staleness; it does not automatically dispatch, resume or claim completion.
Other ingress routes, browser-local execution, Codex chat messages, and the club
queue are not automatically captured or globally stopped by this integration.
Personal-agent socket receipts are reconciled separately as described below.
It does not classify all actions as reversible or irreversible.

`seed-tasks.mjs` can import explicitly supplied private JSON records; it does
not schedule or execute work. Callers must review sources, privacy and status
before import.

The `reconcile-personal-agent` CLI operation accepts `{ "receipts": [...] }`
from the local Rust `request-ledger` helper over stdin. It links an existing
mesh receipt when possible, or records a separate task observation; it never
executes, resumes or retries work. An in-progress receipt becomes unknown,
not eligible for dispatch. It rejects stale or contradictory terminal states.
The local agent monitor invokes the local receipt helper periodically and
reports errors and stale checks. It is fixture-tested but has not been verified
against the running personal-agent process. Caller provenance and the receipt
snapshot must be verified before use; an incomplete scan records no absences.

`reconcilePersonalAgentPages` accepts a caller-provided page reader and starts
at a null cursor on every scan. It collects the full page sequence before
recording observations, rejects duplicate IDs/cursors and incomplete scans,
and never infers deletion. The cursor is not a change feed: later status
updates and newly inserted receipts require another full scan.
