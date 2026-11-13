//! Your iPhone, through the relay of the "Phone Control Automation" project, and the tools that let
//! Codex use it. Replaces python/phone.py and python/phone_mcp.py.
//!
//! - [`Phone`]: the transport (python/phone.py). It calls agent-core's phone transport directly.
//! - [`PhoneTools`]: the `phone` tool namespace ([`hive_common::tools::ToolNamespace`]).

mod elements;
mod phone;
mod tools;

pub use phone::{
    status_line, CoreTransport, Phone, PhoneError, Transport, LOCKED_HOME, OFFLINE, UNLOCK_STEPS,
};
pub use tools::{
    shrink, tool_list, PhoneAuthenticator, PhoneTools, BATCHABLE, INSTRUCTIONS, SETTLE,
};
