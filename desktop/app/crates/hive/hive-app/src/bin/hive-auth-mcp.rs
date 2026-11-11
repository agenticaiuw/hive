//! Codex's "authentication" MCP server over stdio (`python3 python/authentication_mcp.py`); hive-agent
//! gives Codex `build/hive-auth-mcp`.

fn main() {
    std::process::exit(hive_app::auth_mcp::main());
}
