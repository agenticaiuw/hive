//! `hive-phone-mcp`: the phone's tools (hive-phone, with hive-mac's passcode entry for
//! `authenticate`) as a stand-alone stdio MCP server. Hive's agent on the cloud VM reaches the phone
//! through it: desktop/hive-bridge.mjs runs one per connection on the Mac and forwards it over SSH.
//! One phone connection is kept for the server's life.

use hive_common::mcp::Server;
use hive_common::tools::ToolNamespace;
use std::sync::Arc;

pub const NAME: &str = "phone";

pub fn server() -> Server {
    let phone = Arc::new(
        hive_phone::PhoneTools::new().with_authenticator(Arc::new(crate::real::PhonePasscode)),
    );
    Server::new(
        move |name, args| phone.call(name, args),
        hive_phone::tool_list(),
        NAME,
        hive_phone::INSTRUCTIONS,
    )
}

/// Loads .env (for PHONE_RELAY), then serves stdio.
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
