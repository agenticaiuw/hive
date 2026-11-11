//! Codex's "authentication" MCP server (python/authentication_mcp.py): credential-free sign-in
//! tools, including for older persisted conversations. The Mac's `authenticate` and
//! `read_selected_text` (hive-mac) and the phone's `authenticate` (hive-phone, with hive-mac's
//! passcode entry), named `authenticate_mac`, `authenticate_phone` and `read_selected_text`.

use hive_common::mcp::Server;
use hive_common::tools::{error_text, ToolNamespace};
use hive_mac::tools::{
    authentication_tools, call_authentication, MacTools, AUTHENTICATION_INSTRUCTIONS,
    AUTHENTICATION_SERVER_NAME, UNKNOWN_AUTHENTICATION_TOOL,
};
use serde_json::{json, Value};
use std::sync::Arc;

/// The tools, in authentication_mcp.py's order: authenticate_mac, authenticate_phone,
/// read_selected_text.
pub fn tools() -> Vec<Value> {
    let (mac, selected_text) = authentication_tools();
    let mut phone = hive_phone::tool_list()
        .into_iter()
        .find(|t| t.get("name") == Some(&json!("authenticate")))
        .expect("the phone has an authenticate tool");
    phone["name"] = json!("authenticate_phone");
    vec![mac, phone, selected_text]
}

/// Runs one, each with a fresh set of the device's tools (as Python's `MacTools()` / `PhoneTools()`).
pub fn call(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "authenticate_mac" | "read_selected_text" => {
            call_authentication(&MacTools::new(), name, args)
        }
        "authenticate_phone" => hive_phone::PhoneTools::new()
            .with_authenticator(Arc::new(crate::real::PhonePasscode))
            .call("authenticate", args),
        _ => Ok(error_text(UNKNOWN_AUTHENTICATION_TOOL)),
    }
}

pub fn server() -> Server {
    Server::new(
        call,
        tools(),
        AUTHENTICATION_SERVER_NAME,
        AUTHENTICATION_INSTRUCTIONS,
    )
}

/// `hive-auth-mcp`: loads .env, then serves stdio.
pub fn main() -> i32 {
    if let Err(error) = hive_common::settings::load(None) {
        eprintln!("{error}");
        return 1;
    }
    match server().serve_stdio() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}
