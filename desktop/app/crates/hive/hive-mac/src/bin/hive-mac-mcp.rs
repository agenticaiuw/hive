//! The Mac's tools as an MCP server over stdio (`python3 python/mac_mcp.py`), for any agent:
//!
//!     codex exec -c mcp_servers.mac.command=/path/to/hive-mac-mcp "open Calculator"

use std::sync::Arc;

use hive_common::mcp::Server;
use hive_mac::tools::{MacTools, INSTRUCTIONS, SERVER_NAME};

fn main() -> std::io::Result<()> {
    Server::for_namespace(Arc::new(MacTools::new()), SERVER_NAME, INSTRUCTIONS).serve_stdio()
}
