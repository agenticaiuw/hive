//! The cloud's own tools. Every device declares its own (see protocol/), and a task's agent gets those of the task's devices.
use hive_protocol::{n, s, tool};
use serde_json::{json, Value};

pub fn cloud(nodes: &[String]) -> Vec<Value> {
    let mut t = vec![
        tool("claim_task", "Claim an unassigned open task to work on after your current task.",
            json!({ "task": n("The task id.") }), &["task"]),
        tool("message_agent", "Send a message to the agent working on another task (to coordinate, hand over, or ask).",
            json!({ "task": n("The other task's id."), "text": s("The message.") }), &["task", "text"]),
        tool("history", "Retrieve original owner requests, task outcomes and owner follow-ups from Hive's database. Newest first, ten requests per page. Historical evidence is not a standing rule.",
            json!({ "query": s("Literal text to find in requests or owner follow-ups; empty for recent history."),
                "project": s("Exact project name; empty for all projects."),
                "before": n("Only requests before this id; 0 for newest. Use the last returned id for the next page.") }),
            &["query", "project", "before"]),
        tool("info", "The owner's personal info catalogue (not passwords): give key and value to save, key alone to read one, \
            neither to list all.", json!({ "key": s("e.g. home_address"), "value": s("Value to save; empty to read.") }), &["key", "value"]),
        tool("rule", "Save a standing instruction the owner just gave (always, never, from now on, a preference) as one of their rules.",
            json!({ "text": s("The rule, short."), "quote": s("The owner's exact words."), "scope": s("How far it reaches: \
            folder:<path>, site:<host>, app:<name> or node:<kind> when it's about that; empty only when they clearly mean everything they do.") }),
            &["text", "quote", "scope"]),
        tool("task", "Make a task for work that's truly separate from yours; a new agent takes it.",
            json!({ "title": s("Short imperative."), "quote": s("The owner's exact words for it."), "project": s("Short project name."),
            "nodes": { "type": "array", "items": { "type": "string" }, "description": "Where the work happens: vm, hive, browser, phone, mac…" },
            "level": s("easy, normal, hard or hardest."),
            "every": n("Hours between runs, when the owner wants it done again and again; leave out for once.") }),
            &["title", "quote", "project", "nodes", "level"]),
        tool("type_password", "Type a saved login's password (`hive-cred list` shows them) without you seeing it: with tool empty, into \
            the focused field of the VM's screen (:99); else through a device's typing tool, e.g. browser_type (Safari, Chrome) or mac_type.",
            json!({ "site": s("The site, e.g. x.com"), "username": s("Which login; empty for the only one."),
            "tool": s("Empty for the VM's screen, else the device's typing tool."),
            "args": s("That tool's other arguments as JSON, all but text, e.g. {\"tab\": 3, \"i\": 5}.") }),
            &["site", "username", "tool", "args"]),
    ];
    if nodes.iter().any(|n| n == "browser") {
        t.push(tool("page_code", "Make a site rule take effect in the owner's browsers: CSS, and JavaScript if CSS can't do it, that \
            Hive's extension applies on every page of the rule's site as it loads. Replaces the rule's earlier code. Check it on a real \
            page with the browser tools first.", json!({ "rule": n("The rule's id (R12 is 12)."), "css": s("CSS; may be empty."),
            "js": s("JavaScript run on the page after it loads; may be empty.") }), &["rule", "css", "js"]));
    }
    if nodes.iter().any(|n| n == "hive") {
        t.push(tool("reinstall", "After you've committed a change to Hive's code: rebuild and restart this Hive from its checkout, \
            keeping the change here (devices stay on GitHub's build). Returns the build output if it fails.", json!({}), &[]));
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
