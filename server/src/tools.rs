//! The cloud's own tools. Every device declares its own (see protocol/), and a task's agent gets those of the task's devices.
use hive_protocol::{n, s, tool};
use serde_json::{json, Value};

pub fn cloud(nodes: &[String], vm: bool) -> Vec<Value> {
    let mut t = vec![
        tool("message_agent", "Send a message to the agent working on another task (to coordinate, hand over, or ask).",
            json!({ "task": n("The other task's id."), "text": s("The message.") }), &["task", "text"]),
        tool("info", "The owner's personal info catalogue (not passwords): give key and value to save, key alone to read one, \
            neither to list all.", json!({ "key": s("e.g. home_address"), "value": s("Value to save; empty to read.") }), &["key", "value"]),
    ];
    if vm {
        t.push(tool("vm_type_password", "Type a saved password into the focused field of the VM's screen (:99) without you seeing it.",
            json!({ "site": s("The site, e.g. x.com"), "username": s("Which login; empty for the only one.") }), &["site", "username"]));
    }
    if nodes.iter().any(|n| n == "browser") {
        t.push(tool("page_code", "Make a site rule take effect in the owner's browsers: CSS, and JavaScript if CSS can't do it, that \
            Hive's extension applies on every page of the rule's site as it loads. Replaces the rule's earlier code. Check it on a real \
            page with the browser tools first.", json!({ "rule": n("The rule's id (R12 is 12)."), "css": s("CSS; may be empty."),
            "js": s("JavaScript run on the page after it loads; may be empty.") }), &["rule", "css", "js"]));
    }
    if nodes.iter().any(|n| n == "hive") {
        t.push(tool("reinstall", "After you've committed a change to Hive's code: rebuild and restart Hive on the VM (devices update \
            themselves when they see the new version). Returns the build output if it fails.", json!({}), &[]));
    }
    t
}

/// As Codex wants a dynamic tool: without Hive's own fields (lock, timeout).
pub fn for_codex(t: &Value) -> Value {
    json!({ "type": "function", "name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"] })
}
