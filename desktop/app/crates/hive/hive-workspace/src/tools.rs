//! Workspace and personal-memory operations called by the agent's host process
//! (python/agent_workspace_tools.py), which agent.py routes `mac.type_text` / `mac.read_ingested`
//! calls whose text starts with `workspace:` or `memory:` through.

use crate::pydump::dumps;
use hive_common::paths::home;
use personal_agent_core::{memory, workspace_client};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// What the model gets for any other physical Mac tool while the virtual workspace is active
/// (agent.py): the physical keyboard and mouse stay out of it.
pub const PHYSICAL_INPUT_DISABLED: &str =
    "Physical Mac input is disabled while the virtual workspace is active. Use mac.type_text with workspace:{JSON} as instructed.";

/// `~/Library/Application Support/Personal Agent`, which python hard-coded here (it equals
/// `state_dir()` unless `AGENT_STATE_DIR` is set).
pub fn default_state() -> PathBuf {
    home().join("Library/Application Support/Personal Agent")
}

/// Sends one request to the workspace socket (`<state>/control/workspace.sock`) and returns the
/// MCP-style result. A failed transport is never retried: the request may have had an effect.
pub fn workspace(state: &Path, value: &Value) -> Result<Value, String> {
    let socket = state.join("control/workspace.sock");
    let response = workspace_client::request(&socket, value, Duration::from_secs(50))
        .map_err(|_| "Workspace request failed; check agent availability".to_string())?;
    workspace_result(&response)
}

pub fn workspace_result(response: &Value) -> Result<Value, String> {
    let response = response
        .as_object()
        .ok_or("Workspace returned invalid JSON")?;
    let ok = match response.get("ok") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    };
    if !ok {
        let error = response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Workspace unavailable");
        return Ok(json!({"isError": true, "content": [{"type": "text", "text": error}]}));
    }
    let result = response.get("result").cloned().unwrap_or_else(|| json!({}));
    if let Some(tools) = result.get("tools") {
        return Ok(json!({"content": [{"type": "text", "text": dumps(tools, false)}]}));
    }
    Ok(result)
}

/// Stores sourced, editable memories without requiring the model's shell access.
/// `value` is `{"op": "list"}` or `{"op": "add", "statement", "source", "kind"}`.
pub fn memory(state: &Path, value: &Value) -> Result<Value, String> {
    let op = value.get("op").and_then(Value::as_str);
    if op != Some("list") && op != Some("add") {
        return Err("Memory operation must be list or add".into());
    }
    if op == Some("add") {
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
        };
        match text("statement") {
            Some(s) if s.chars().count() <= 2000 => {}
            _ => return Err("A statement of at most 2000 characters is required".into()),
        }
        match text("source") {
            Some(s) if s.chars().count() <= 1024 => {}
            _ => return Err("A source of at most 1024 characters is required".into()),
        }
        if !matches!(
            value.get("kind").and_then(Value::as_str),
            Some("fact" | "inference" | "question")
        ) {
            return Err("kind must be fact, inference, or question".into());
        }
    }
    memory::execute(state, value).map_err(|_| "Memory store unavailable".to_string())
}

/// agent.py's routing: a `mac` tool call whose text (`read_ingested`'s `id`, `type_text`'s `text`)
/// starts with `workspace:` or `memory:` is a JSON request for this process, not for the Mac.
/// `None` when the call isn't one; otherwise the MCP-style result, or the failure for the driver to
/// report as "Failed: ...".
pub fn route(
    state: &Path,
    namespace: &str,
    tool: &str,
    arguments: &Value,
) -> Option<Result<Value, String>> {
    let key = match tool {
        "read_ingested" => "id",
        "type_text" => "text",
        _ => return None,
    };
    let encoded = arguments.get(key).and_then(Value::as_str)?;
    if namespace != "mac" || !(encoded.starts_with("workspace:") || encoded.starts_with("memory:"))
    {
        return None;
    }
    let (prefix, body) = encoded.split_once(':')?;
    Some((|| {
        let request: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
        if !request.is_object() {
            return Err("Tool request must be a JSON object".to_string());
        }
        if prefix == "workspace" {
            workspace(state, &request)
        } else {
            memory(state, &request)
        }
    })())
}
