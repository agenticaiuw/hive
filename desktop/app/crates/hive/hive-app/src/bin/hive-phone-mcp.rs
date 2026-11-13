//! The phone's tools as an MCP server over stdio, for Hive's agent on the cloud VM
//! (desktop/hive-bridge.mjs runs it).

fn main() {
    std::process::exit(hive_app::phone_mcp::main());
}
