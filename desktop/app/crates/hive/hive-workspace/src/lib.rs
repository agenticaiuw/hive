//! Virtual workspace bridge, workspace fence/recovery/update, the local request socket and the
//! scripts that sit around them. Replaces python/workspace_mcp_bridge.py, workspace_fence.py,
//! workspace_recovery.py, workspace_update.py, agent_workspace_tools.py, local_request.py and
//! scripts/workspace-tool.py, scripts/restart-agent-once.py, scripts/hive_bundle_migration.py.

pub mod bridge;
pub mod credentials;
pub mod fence;
pub mod local_request;
pub mod migration;
pub mod pydump;
pub mod recovery;
pub mod restart;
pub mod tool_cli;
pub mod tools;
pub mod update;
