//! Lean, role-scoped LLM tool catalogs backed by ops.rs.
//! Every device declares its own tools (see protocol/); a worker receives strictly its task's nodes' tools.
use hive_protocol::{n, s, tool};
use serde_json::{json, Value};

fn memory_tool() -> Value {
    tool("memory", "Three-tier memory (Tier 1: owner profile & contacts; Tier 2: verified site playbooks) with SQLite FTS5 BM25 search. \
        Never store passwords, tokens, or payment cards here—those stay in the Tier 0 encrypted vault (`hive-cred` / `type_password`). \
        Actions: search (query, optional tier), get (optional tier/key/host/id), save_profile (key, value), save_contact (name, relation, email, phone, org, notes), \
        save_playbook (host, title, steps, selectors—stable CSS/ARIA/URLs only, never data-hive indices), report_playbook (id, ok), delete (tier, key/id/name).",
        json!({
            "action": s("search | get | save_profile | save_contact | save_playbook | report_playbook | delete"),
            "tier": s("profile | contact | playbook | empty for all"),
            "query": s("BM25 search query (for action='search')"),
            "key": s("Profile key (e.g. home_address) or contact name filter"),
            "value": s("Profile value (for save_profile)"),
            "id": n("Numeric id for contact/playbook update, report, or delete; 0 otherwise"),
            "name": s("Contact full name (for save_contact)"),
            "relation": s("Relationship to owner (e.g. advisor, parent, teammate)"),
            "email": s("Contact email"),
            "phone": s("Contact phone"),
            "org": s("Contact organization"),
            "notes": s("Concise contact notes"),
            "host": s("Site host for playbook (e.g. canvas.wisc.edu)"),
            "title": s("Playbook short title"),
            "steps": s("Verified concise workflow steps / stable URLs"),
            "selectors": s("Stable CSS/ARIA selectors (never transient data-hive indices)"),
            "ok": { "type": "boolean", "description": "Whether a playbook succeeded (for report_playbook)" }
        }),
        &["action"])
}

/// Read-only inspection + memory tools for the orchestrator agent (control plane).
pub fn orchestrator() -> Vec<Value> {
    vec![
        tool("inspect", "Read details on demand so orchestrator context stays small. Returns compact JSON for one project, task, request, worker, or scoped rule set.",
            json!({ "kind": s("project | task | request | rules | worker"),
                "id": n("Numeric id for task, request, or worker; 0 otherwise."),
                "name": s("Project slug (for kind='project') or rule scope prefix like 'site:' or 'project:hive' (for kind='rules'); empty for all.") }),
            &["kind", "id", "name"]),
        tool("history", "Retrieve original owner requests, task outcomes and owner follow-ups from Hive's database. Newest first, ten requests per page. Historical evidence is not a standing rule.",
            json!({ "query": s("Literal text to find in requests or owner follow-ups; empty for recent history."),
                "project": s("Exact project slug; empty for all projects."),
                "before": n("Only requests before this id; 0 for newest. Use the last returned id for the next page.") }),
            &["query", "project", "before"]),
        memory_tool(),
    ]
}

/// Core + capability-scoped tools for a worker agent (execution plane).
pub fn worker(nodes: &[String]) -> Vec<Value> {
    let has = |k: &str| nodes.iter().any(|n| n == k);
    let mut t = vec![
        tool("handoff", "Send a structured handoff to the worker on another task in the same project or request (max 2 hops between a pair; logged to the orchestrator).",
            json!({ "task": n("Target task id."),
                "kind": s("artifact | fact | lock_release | question"),
                "text": s("Concise payload (paths, facts, or question).") }),
            &["task", "kind", "text"]),
        tool("request_help", "Escalate to the orchestrator agent when you need clarification, an extra device capability not granted to this task, or a separate follow-up worker task (max 2 escalations per task).",
            json!({ "kind": s("orchestrator | capability | propose_task"),
                "text": s("What you need, or the proposed follow-up task and why."),
                "node": s("Needed node kind (e.g. phone, mac, browser, hive) when kind='capability'; empty otherwise.") }),
            &["kind", "text", "node"]),
        tool("history", "Retrieve original owner requests, task outcomes and owner follow-ups from Hive's database. Newest first, ten requests per page. Historical evidence is not a standing rule.",
            json!({ "query": s("Literal text to find in requests or owner follow-ups; empty for recent history."),
                "project": s("Exact project slug; empty for all projects."),
                "before": n("Only requests before this id; 0 for newest. Use the last returned id for the next page.") }),
            &["query", "project", "before"]),
        memory_tool(),
        tool("rule", "Save a standing instruction the owner just gave (always, never, from now on, a preference) as one of their rules.",
            json!({ "text": s("The rule, short."), "quote": s("The owner's exact words."),
                "scope": s("How far it reaches: project:<slug>, folder:<path>, site:<host>, app:<name>, or node:<kind>; empty only when they clearly mean everything they do.") }),
            &["text", "quote", "scope"]),
    ];
    if nodes.is_empty() || has("vm") || has("browser") || has("mac") || has("windows") {
        t.push(tool("type_password", "Blind-type a Tier 0 encrypted secret (`hive-cred list` shows logins and card labels/last4) without seeing it. \
            For logins: kind='login' (default), site, username. For payment cards (ONE-WAY DOOR: only after explicit owner confirmation of item, total amount, and card): \
            kind='card', site=<card label>, field='number'|'exp'|'cvv'|'zip'|'cardholder', confirmed=true. With tool empty, types into VM screen (:99); else via browser_type, mac_input, or windows_input.",
            json!({ "site": s("Login site (e.g. x.com) or saved card label (when kind='card')."),
                "username": s("Login username; empty for the only one or when kind='card'."),
                "tool": s("Empty for the VM's screen, else browser_type, mac_input, or windows_input."),
                "args": s("That tool's other arguments as JSON, all but text, e.g. {\"tab\": 3, \"i\": 5}."),
                "kind": s("login (default) | card"),
                "field": s("When kind='card': number | exp | cvv | zip | cardholder"),
                "confirmed": { "type": "boolean", "description": "Required true for kind='card', confirming the owner explicitly approved this payment." } }),
            &["site", "username", "tool", "args"]));
    }
    if has("browser") {
        t.push(tool("browser_devices", "List browser device IDs, names and last contact times. Select the requested browser and pass its ID as browser on each browser tool call. For iPhone Safari, coordinate with a phone worker via handoff.", json!({}), &[]));
        t.push(tool("page_code", "Make a site rule take effect in the owner's browsers: CSS, and JavaScript if CSS can't do it, that \
            Hive's extension applies on every page of the rule's site as it loads. Replaces the rule's earlier code. Check it on a real \
            page with the browser tools first.", json!({ "rule": n("The rule's id (R12 is 12)."), "css": s("CSS; may be empty."),
            "js": s("JavaScript run on the page after it loads; may be empty.") }), &["rule", "css", "js"]));
    }
    if has("hive") {
        t.push(tool("lock", "Lock files in Hive's checkout before you change them: other workers work in the same checkout at the same \
            time, and none can lock a file you hold. All or none: it fails, naming the task, when another worker holds one (then wait and \
            lock again, or handoff to that task). Your locks go when your turn ends.", json!({ "files": { "type": "array",
            "items": { "type": "string" }, "description": "Paths in the checkout, e.g. server/src/hive.rs" } }), &["files"]));
        t.push(tool("sim", "Hive's Self-Improvement Memory (SIM) and recent friction summary, for editing Hive itself. \
            mode='read' shows full SIM + friction; 'propose' logs a pre-edit root cause, edit, and prediction (returns id); \
            'outcome' appends post-eval fixed/missed/status to an attempt id; 'export' formats an anonymized JSONL line for server/sim.jsonl.",
            json!({ "mode": s("read | propose | outcome | export"), "id": n("Attempt id (for outcome/export; 0 otherwise)."),
                "problem": s("Root-cause hypothesis (reuse existing exact name when it matches)."),
                "what": s("Edit and rationale."), "files": s("Comma-separated files touched."),
                "predicted": s("Concrete failure/test predicted to improve before evaluation."),
                "fixed": s("Observed fixes after evaluation."), "missed": s("Unresolved predictions or regressions."),
                "status": s("active | missed | reverted | pruned"), "days": n("Lookback days for read friction (default 7).") }),
            &["mode"]));
        t.push(tool("reinstall", "After you've committed a change to Hive's code: run cargo test, rebuild and restart this Hive from \
            its checkout (aborts if tests or build fail). Links test pass/total and commit SHA onto sim_id (or latest proposed SIM entry).",
            json!({ "sim_id": n("Optional SIM attempt id from sim(mode='propose'); 0 for latest proposed.") }), &[]));
    }
    t
}

/// As Codex wants a dynamic tool: without Hive's own fields (lock, timeout).
pub fn for_codex(t: &Value) -> Value {
    json!({ "type": "function", "name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"] })
}

/// As an MCP server lists a tool (Claude Code agents), likewise without Hive's own fields.
pub fn for_mcp(t: &Value) -> Value {
    json!({ "name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"] })
}
