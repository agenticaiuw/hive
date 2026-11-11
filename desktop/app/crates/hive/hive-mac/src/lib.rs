//! The Mac: helper (VHID) client, screenshots, desktop, the mac tools, credentials.
//!
//! - [`vhid`]: the client of agent-vhid-helper, the virtual keyboard and mouse (python/agent_vhid.py),
//!   and the helper-watching bits of python/voice_agent.py.
//! - [`screen`]: in-process screenshots with ScreenCaptureKit (replaces screencapture + sips).
//! - [`desktop`]: the window list and the browsers' tabs (python/desktop.py).
//! - [`virtual_monitor`]: Hive's second, hidden display (python/virtual_monitor.py).
//! - [`tools`]: [`MacTools`], the "mac" tool namespace (python/mac_mcp.py) and the Mac's
//!   authentication tools (python/authentication_mcp.py).
//! - [`credentials`]: typing the saved Mac password, and the phone passcode (python/credentials.py).
//! - [`system`]: what the tools read from the Mac outside the helper, behind a trait tests fake.

pub mod credentials;
pub mod desktop;
mod ffi;
pub mod process;
pub mod screen;
pub mod system;
pub mod tools;
pub mod vhid;
pub mod virtual_monitor;

pub use ffi::Bounds;
pub use system::{RealMac, System};
pub use tools::MacTools;
pub use vhid::{AgentVHID, Fields, HelperWatcher, Screenshot, TextBox, VhidError};
