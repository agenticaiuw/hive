//! Exercise desktop harness wiring and MCP routing on every CI platform without desktop UI dependencies.
#![allow(dead_code)]
mod os { pub const KIND: &str = "test"; }
mod tailnet { pub fn load() -> Option<hive_protocol::Conf> { None } }
#[path = "../../desktop/src/mcp.rs"]
mod mcp;
#[path = "../../desktop/src/connect.rs"]
mod connect;
