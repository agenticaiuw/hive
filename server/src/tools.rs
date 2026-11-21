//! The tools Hive gives its agents, by node. Every agent has the common ones; the rest come with the task's nodes.
use serde_json::{json, Value};

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({ "type": "function", "name": name, "description": description,
        "inputSchema": { "type": "object", "properties": props, "required": required, "additionalProperties": false } })
}
fn s(d: &str) -> Value { json!({ "type": "string", "description": d }) }
fn n(d: &str) -> Value { json!({ "type": "number", "description": d }) }

pub fn common() -> Vec<Value> {
    vec![
        tool("message_agent", "Send a message to the agent working on another task (to coordinate, hand over, or ask).",
            json!({ "task": n("The other task's id."), "text": s("The message.") }), &["task", "text"]),
        tool("list_tasks", "Hive's open tasks and who is working on each.", json!({}), &[]),
        tool("info", "The owner's personal info catalogue (not passwords): give key and value to save, key alone to read one, \
            neither to list all.", json!({ "key": s("e.g. home_address"), "value": s("Value to save; empty to read.") }), &["key", "value"]),
    ]
}

pub fn for_node(node: &str) -> Vec<Value> {
    let xy = || json!({ "x": n("x in the latest screenshot"), "y": n("y in the latest screenshot") });
    match node {
        "vm" => vec![
            tool("vm_type_password", "Type a saved password into the focused field of the VM's screen (:99) without you seeing it.",
                json!({ "site": s("The site, e.g. x.com"), "username": s("Which login; empty for the only one.") }), &["site", "username"]),
        ],
        "mac" => vec![
            tool("mac_screenshot", "See the owner's Mac screen. x/y in the other mac tools are pixels in this image.", json!({}), &[]),
            tool("mac_click", "Click on the Mac at (x, y). count 2 = double click; button left|right.",
                { let mut p = xy(); p["button"] = s("left or right"); p["count"] = n("1 or 2"); p }, &["x", "y", "button", "count"]),
            tool("mac_move", "Move the Mac's pointer to (x, y).", xy(), &["x", "y"]),
            tool("mac_drag", "Drag on the Mac from (x, y) to (to_x, to_y).",
                { let mut p = xy(); p["to_x"] = n("end x"); p["to_y"] = n("end y"); p }, &["x", "y", "to_x", "to_y"]),
            tool("mac_scroll", "Scroll on the Mac at (x, y): dy > 0 scrolls down, dx > 0 right (in lines).",
                { let mut p = xy(); p["dy"] = n("lines down"); p["dx"] = n("lines right"); p }, &["x", "y", "dy", "dx"]),
            tool("mac_type", "Type text on the Mac into whatever has focus.", json!({ "text": s("Text to type") }), &["text"]),
            tool("mac_key", "Press keys on the Mac, e.g. cmd+space, return, cmd+shift+t, escape, down.",
                json!({ "keys": s("Keys joined with +") }), &["keys"]),
            tool("mac_shell", "Run a shell command on the owner's Mac (zsh, as the owner) and get its output.",
                json!({ "command": s("The command"), "timeout": n("Seconds, default 120") }), &["command", "timeout"]),
            tool("mac_get_file", "Copy a file from the Mac into Hive's files (the VM's /var/lib/hive/files); returns its VM path.",
                json!({ "path": s("Path on the Mac") }), &["path"]),
            tool("mac_put_file", "Copy a file from the VM to the Mac.", json!({ "vm_path": s("Path on the VM"), "path": s("Path on the Mac") }),
                &["vm_path", "path"]),
        ],
        "browser" => vec![
            tool("browser_tabs", "The owner's open Chrome tabs (id, title, url, active).", json!({}), &[]),
            tool("browser_open", "Open a URL in the owner's Chrome: in tab (id) or, with tab 0, a new tab.",
                json!({ "url": s("URL"), "tab": n("Tab id, or 0 for a new tab") }), &["url", "tab"]),
            tool("browser_read", "Read a tab's page: title, url and visible text (0 = active tab).", json!({ "tab": n("Tab id or 0") }), &["tab"]),
            tool("browser_js", "Run JavaScript in a tab's page (0 = active tab) and get its result (JSON). Use it to click, type, \
                read the DOM, or anything a page script can do. The code is a function body; return a value.",
                json!({ "tab": n("Tab id or 0"), "code": s("Function body, e.g. return document.title") }), &["tab", "code"]),
            tool("browser_screenshot", "See a tab (0 = active tab; it becomes the visible tab).", json!({ "tab": n("Tab id or 0") }), &["tab"]),
            tool("save_page_rule", "Change how a site looks for the owner from now on: CSS and/or JavaScript Hive's extension applies on \
                every page of that site (remove, rearrange, restyle). Replaces the site's earlier rule with the same text.",
                json!({ "site": s("Host, e.g. youtube.com"), "text": s("The rule in words"), "css": s("CSS, may be empty"),
                    "js": s("JavaScript run on each page load, may be empty") }), &["site", "text", "css", "js"]),
        ],
        "phone" => vec![
            tool("phone_unlock", "Unlock the owner's iPhone with its saved passcode (the relay types it; you never see it). \
                If it fails, stop using the phone and say why.", json!({}), &[]),
            tool("phone_screenshot", "See the iPhone's screen. x/y in other phone tools are pixels in this image.", json!({}), &[]),
            tool("phone_tap", "Tap the iPhone at (x, y).", xy(), &["x", "y"]),
            tool("phone_tap_element", "Tap something on the iPhone by its label.", json!({ "label": s("Label or text") }), &["label"]),
            tool("phone_swipe", "Swipe on the iPhone from (x, y) to (to_x, to_y).",
                { let mut p = xy(); p["to_x"] = n("end x"); p["to_y"] = n("end y"); p }, &["x", "y", "to_x", "to_y"]),
            tool("phone_type", "Type into the focused field on the iPhone ('\\n' = Return).", json!({ "text": s("Text") }), &["text"]),
            tool("phone_home", "Go to the iPhone's home screen (unlocked phones only).", json!({}), &[]),
            tool("phone_open_app", "Open an iPhone app by bundle id (e.g. com.apple.mobilesafari).",
                json!({ "bundle_id": s("Bundle id") }), &["bundle_id"]),
            tool("phone_elements", "List what's on the iPhone's screen with each thing's center in screenshot pixels.", json!({}), &[]),
        ],
        "hive" => vec![
            tool("reinstall", "After you've committed and pushed a change to Hive's code: pull it on the VM, rebuild and restart \
                Hive's server (nodes update themselves when they see the new version). Returns the build output if it fails.",
                json!({}), &[]),
        ],
        _ => vec![],
    }
}

/// Tools for a task on these nodes (vm is always there: every agent runs on the VM).
pub fn for_nodes(nodes: &[String]) -> Vec<Value> {
    let mut all = common();
    all.extend(for_node("vm"));
    for node in nodes { if node != "vm" { all.extend(for_node(node)); } }
    all
}

/// Tools that drive a device one agent at a time, and the lock each takes.
pub fn lock_for(tool: &str) -> Option<&'static str> {
    match tool {
        "mac_click" | "mac_move" | "mac_drag" | "mac_scroll" | "mac_type" | "mac_key" => Some("mac input"),
        t if t.starts_with("phone_") => Some("phone touch"),
        _ => None,
    }
}
