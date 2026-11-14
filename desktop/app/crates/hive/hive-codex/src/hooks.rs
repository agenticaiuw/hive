//! What the driver uses from crates written alongside it, as traits and closures the app wires
//! in (hive-app), so this crate depends on none of them. Every one has a default that does
//! nothing, which is what the tests use unless they give their own.
//!
//! | hook | Python it stands for |
//! |---|---|
//! | [`Hooks::device_tools`] | `device_tools()`: `{"mac": MacTools(), "phone": PhoneTools()}` |
//! | [`Knowledge`] | `knowledge.py`: NAMESPACE, RULES, TURN_HINT, is_call, describe, call |
//! | [`Memory`] | `memory_search.automatic_context`, `activity_summary` |
//! | [`ActionLog`] | (Rust only) hive-knowledge's action memory: every tool step, recorded by Hive |
//! | [`ContextRecorder`] | `agent_context.ContextLog().record(...)` |
//! | [`WorkspaceTools`] | `agent_workspace_tools.workspace`, `.memory` |
//! | [`Hooks::virtual_monitor_enabled`] | `virtual_monitor.enabled()` |
//! | [`Hooks::warm_browser_tabs`] | `desktop.browser_tabs(timeout=120)` (warm_up) |
//! | [`ProviderWait`] | `provider_wait.py` (the default is [`FileProviderWait`]) |

use crate::provider_wait::{self, Reservation};
use crate::util::{AgentError, Env};
use hive_common::tools::ToolNamespace;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

/// A fresh set of each device's tools (`mac`, `phone`); none connects until used. Called once per
/// task (and for each LookAhead), like Python's `device_tools()`.
pub type DeviceTools = Arc<dyn Fn() -> Vec<Arc<dyn ToolNamespace>> + Send + Sync>;

/// The owner's knowledge base in the cloud (python/knowledge.py).
pub trait Knowledge: Send + Sync {
    /// `knowledge.NAMESPACE`: its tools as a Codex dynamic-tool namespace (None: no namespace).
    fn namespace(&self) -> Option<Value> {
        None
    }
    /// `knowledge.RULES`, added to the thread's developer instructions.
    fn rules(&self) -> String {
        String::new()
    }
    /// `knowledge.TURN_HINT`, added to every request.
    fn turn_hint(&self) -> String {
        String::new()
    }
    /// Whether a tool call is the knowledge base's (`knowledge.lookup`, or a `mac.batch` of
    /// knowledge steps).
    fn is_call(&self, _namespace: Option<&str>, _tool: Option<&str>, _args: &Value) -> bool {
        false
    }
    /// What the call looks up or saves, for the logs (never the facts' values).
    fn describe(&self, namespace: Option<&str>, tool: Option<&str>, _args: &Value) -> String {
        format!("{}.{}", namespace.unwrap_or("None"), tool.unwrap_or("None"))
    }
    /// Runs it: the MCP-style result and a summary for the logs.
    fn call(
        &self,
        _namespace: Option<&str>,
        _tool: Option<&str>,
        _args: &Value,
        _task: &str,
        _device: &str,
    ) -> Result<(Value, String), String> {
        Err("the knowledge base isn't available".into())
    }
}

/// No knowledge base.
pub struct NoKnowledge;
impl Knowledge for NoKnowledge {}

/// The local personal memory (python/memory_search.py).
pub trait Memory: Send + Sync {
    /// `automatic_context(request)`: `{"status": "ok"|"skipped"|"unavailable", "results": [...]}`.
    fn automatic_context(&self, _request: &str) -> Result<Value, String> {
        Ok(json!({"status": "skipped", "results": []}))
    }
    /// `activity_summary(result)`: a line for the activity view, if any.
    fn activity_summary(&self, _result: &Value) -> Option<String> {
        None
    }
    /// What the knowledge base has for the request (matching facts, and the steps that worked
    /// in an earlier task like it), from the Mac's copies only, bounded and marked as data. Must
    /// return quickly and never reach the network; None when there is nothing.
    fn knowledge_context(&self, _request: &str) -> Option<String> {
        None
    }
}

/// No personal memory.
pub struct NoMemory;
impl Memory for NoMemory {}

/// One run of a task, as the action memory knows it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActionTask {
    /// Unique to this run.
    pub run: String,
    /// What the user asked for.
    pub request: String,
    /// "mac" or "phone".
    pub device: String,
    /// The ingress receipt the request came with.
    pub receipt: Option<String>,
}

/// Hive's action memory: each tool step the agent takes, recorded by Hive, not the model. Every
/// call must return at once (the recording happens on a thread of its own): it sits on the
/// action path.
pub trait ActionLog: Send + Sync {
    /// The task began.
    fn begin(&self, _task: &ActionTask) {}
    /// A step finished: namespace "mac" or "phone" with the tool's arguments; "shell" with tool
    /// "command" (`{"command", "cwd", "paths"}`) or "file_change" (`{"paths", "kinds"}`).
    fn step(&self, _task: &ActionTask, _namespace: &str, _tool: &str, _args: &Value, _ok: bool) {}
    /// The task ended: "done", "failed", "stopped" or "interrupted".
    fn end(&self, _task: &ActionTask, _outcome: &str) {}
}

/// Records nothing.
pub struct NoActionLog;
impl ActionLog for NoActionLog {}

/// The context inspector (python/agent_context.py's `ContextLog`): every payload that went to
/// or came from Codex, for the user to look at.
pub trait ContextRecorder: Send + Sync {
    /// Records one; returns the inspector's index page (the task sends it as a "context" event),
    /// or None when there is nothing to show.
    fn record(
        &self,
        kind: &str,
        payload: &Value,
        task: Option<&str>,
        thread: Option<&str>,
    ) -> Result<Option<String>, String>;
}

/// Records nothing.
pub struct NoContext;
impl ContextRecorder for NoContext {
    fn record(
        &self,
        _: &str,
        _: &Value,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<Option<String>, String> {
        Ok(None)
    }
}

/// The background workspace's tools, reached through `mac.type_text` with `workspace:{JSON}` or
/// `memory:{JSON}` (python/agent_workspace_tools.py).
pub trait WorkspaceTools: Send + Sync {
    fn workspace(&self, _request: &Value) -> Result<Value, String> {
        Err("the workspace tools aren't available".into())
    }
    fn memory(&self, _request: &Value) -> Result<Value, String> {
        Err("the memory tools aren't available".into())
    }
}

/// No workspace tools.
pub struct NoWorkspaceTools;
impl WorkspaceTools for NoWorkspaceTools {}

/// Waiting for the model provider after a connection failure (python/provider_wait.py).
pub trait ProviderWait: Send + Sync {
    fn exists(&self, dir: &Path, identity: &str) -> Result<bool, AgentError> {
        provider_wait::exists(dir, identity)
    }
    fn reserve(
        &self,
        dir: &Path,
        identity: &str,
        arm: bool,
    ) -> Result<Option<Reservation>, AgentError> {
        provider_wait::reserve(dir, identity, None, arm)
    }
    fn resolve(&self, dir: &Path, identity: &str) -> Result<bool, AgentError> {
        provider_wait::resolve(dir, identity)
    }
    fn reachable(&self, env: &Env) -> bool {
        provider_wait::reachable(env)
    }
    fn workspace_is_open(&self, dir: &Path) -> bool {
        provider_wait::workspace_is_open(dir)
    }
}

/// The real one: the state files and the configured proxy.
pub struct FileProviderWait;
impl ProviderWait for FileProviderWait {}

/// Everything the driver reaches outside this crate.
#[derive(Clone)]
pub struct Hooks {
    pub device_tools: DeviceTools,
    pub knowledge: Arc<dyn Knowledge>,
    pub memory: Arc<dyn Memory>,
    pub context: Arc<dyn ContextRecorder>,
    pub workspace_tools: Arc<dyn WorkspaceTools>,
    /// `virtual_monitor.enabled()`: the Mac tools work on the virtual monitor.
    pub virtual_monitor_enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Reads the browsers' tabs once (macOS asks for permission the first time); run on a
    /// thread of its own by `warm_up`.
    pub warm_browser_tabs: Arc<dyn Fn() + Send + Sync>,
    pub provider: Arc<dyn ProviderWait>,
    /// Hive's action memory.
    pub actions: Arc<dyn ActionLog>,
}

impl Default for Hooks {
    fn default() -> Self {
        Self {
            device_tools: Arc::new(Vec::new),
            knowledge: Arc::new(NoKnowledge),
            memory: Arc::new(NoMemory),
            context: Arc::new(NoContext),
            workspace_tools: Arc::new(NoWorkspaceTools),
            virtual_monitor_enabled: Arc::new(|| false),
            warm_browser_tabs: Arc::new(|| {}),
            provider: Arc::new(FileProviderWait),
            actions: Arc::new(NoActionLog),
        }
    }
}
