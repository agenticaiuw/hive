//! The contract between a device's tools and the Codex driver.
//!
//! A device (`mac`, `phone`) is a [`ToolNamespace`]: it lists its tools in MCP's shape
//! (`{"name", "description", "inputSchema"}`) and answers calls with MCP-style results
//! (`{"content": [{"type": "text", "text"} | {"type": "image", "data", "mimeType"}], "isError"}`).
//! The driver turns those into Codex's dynamic-tool replies with [`tool_reply`]. This is what
//! python/mac_mcp.py's `MacTools` and python/phone_mcp.py's `PhoneTools` were.

use serde_json::{json, Value};

/// One device's tools, called in-process by the Codex driver.
pub trait ToolNamespace: Send + Sync {
    /// The namespace the model calls them under: "mac" or "phone".
    fn namespace(&self) -> &'static str;
    /// One line on what the device is, shown to the model with the namespace.
    fn about(&self) -> &'static str;
    /// The tools, MCP-style: `[{"name", "description", "inputSchema"}]`. Always the same list,
    /// so it stays in the model's prompt cache from task to task.
    fn tools(&self) -> Vec<Value>;
    /// Runs one tool. `Err` is a failure the driver reports to the model as "Failed: ...";
    /// a tool that ran but could not do what was asked returns `Ok` with `"isError": true`.
    fn call(&self, tool: &str, args: &Value) -> Result<Value, String>;
    /// A screenshot for the model's first step (MCP-style, an image and a text about it).
    /// `context`: also list the open windows and the browsers' tabs (the Mac only).
    fn look(&self, context: bool) -> Result<Value, String>;
    /// Lets go of anything the tools hold (the Mac's helper connection). Called when a task ends.
    fn close(&self) {}
    /// What the user asked for in this conversation lately (CodexTask's `words`): a step marked
    /// one-way must quote it ([`crate::mcp::check_step`]). Set for each task.
    fn set_words(&self, _words: &str) {}
    /// Hands the mouse and keyboard back while the agent works without the screen (a shell command).
    fn let_go(&self) {}
    /// The user handed the screen back (fn, or "continue"): the tools hold it as if just used.
    fn handed_back(&self) {}
    /// The user just took the mouse and keyboard: on the virtual monitor, the Mac tools put the
    /// user's cursor and app back on their screen.
    fn took_over(&self) {}
}

pub fn text(t: impl Into<String>) -> Value {
    json!({"type": "text", "text": t.into()})
}

pub fn image(mime: &str, base64_data: impl Into<String>) -> Value {
    json!({"type": "image", "data": base64_data.into(), "mimeType": mime})
}

pub fn image_bytes(mime: &str, bytes: &[u8]) -> Value {
    use base64::Engine;
    image(
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes),
    )
}

/// An MCP tool result from its content items.
pub fn result(content: Vec<Value>, error: bool) -> Value {
    json!({"content": content, "isError": error})
}

pub fn ok_text(t: impl Into<String>) -> Value {
    result(vec![text(t)], false)
}

pub fn error_text(t: impl Into<String>) -> Value {
    result(vec![text(t)], true)
}

pub fn is_error(res: &Value) -> bool {
    res.get("isError").and_then(Value::as_bool).unwrap_or(false)
}

/// All the text items of a result, joined by spaces.
pub fn texts(res: &Value) -> String {
    content(res)
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|c| c.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The first image of a result as a data: URL.
pub fn image_url(res: &Value) -> Option<String> {
    content(res)
        .find(|c| c.get("type").and_then(Value::as_str) == Some("image"))
        .and_then(|c| {
            Some(format!(
                "data:{};base64,{}",
                c.get("mimeType")?.as_str()?,
                c.get("data")?.as_str()?
            ))
        })
}

fn content(res: &Value) -> impl Iterator<Item = &Value> {
    res.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// An MCP-style tool result as Codex's dynamic tool reply (agent.py's `tool_reply`).
pub fn tool_reply(res: &Value) -> Value {
    let items: Vec<Value> = content(res)
        .filter_map(|c| match c.get("type").and_then(Value::as_str) {
            Some("image") => Some(json!({"type": "inputImage", "imageUrl": format!(
                "data:{};base64,{}",
                c.get("mimeType").and_then(Value::as_str).unwrap_or("image/png"),
                c.get("data").and_then(Value::as_str).unwrap_or(""))})),
            Some("text") => Some(json!({"type": "inputText", "text": c.get("text").and_then(Value::as_str).unwrap_or("")})),
            _ => None,
        })
        .collect();
    json!({"success": !is_error(res), "contentItems": items})
}

/// A Codex dynamic-tool reply with one text item.
pub fn reply_text(success: bool, t: impl Into<String>) -> Value {
    json!({"success": success, "contentItems": [{"type": "inputText", "text": t.into()}]})
}

/// The device's tools as one of Codex's dynamic-tool namespaces (agent.py's `tool_specs`).
pub fn namespace_spec(tools: &dyn ToolNamespace) -> Value {
    let list: Vec<Value> = tools
        .tools()
        .into_iter()
        .map(|t| {
            json!({"type": "function", "name": t["name"], "description": t["description"],
                         "inputSchema": t["inputSchema"]})
        })
        .collect();
    json!({"type": "namespace", "name": tools.namespace(), "description": tools.about(), "tools": list})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_converts_text_and_images() {
        let res = result(vec![text("hi"), image("image/jpeg", "QUJD")], false);
        let reply = tool_reply(&res);
        assert_eq!(reply["success"], true);
        assert_eq!(
            reply["contentItems"][0],
            json!({"type": "inputText", "text": "hi"})
        );
        assert_eq!(
            reply["contentItems"][1]["imageUrl"],
            "data:image/jpeg;base64,QUJD"
        );
        assert_eq!(tool_reply(&error_text("no"))["success"], false);
        assert_eq!(image_url(&res).unwrap(), "data:image/jpeg;base64,QUJD");
        assert_eq!(texts(&res), "hi");
    }
}
