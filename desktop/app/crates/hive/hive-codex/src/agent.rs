//! The agent's Codex: where it is, how its app-server is started (agent.py's
//! `app_server_command`), the thread parameters every conversation gets, and the one app-server
//! every task shares. agent.py kept these as module globals; here they live on an [`Agent`] the
//! app makes once (with its [`Hooks`]) and hands to every task.

use crate::app_server::{AppServer, Server};
use crate::claude::{self, ClaudeSession};
use crate::hooks::Hooks;
use crate::prompts;
use crate::py;
use crate::session::{Session, TaskSession};
use crate::util::{lock, AgentError, Env};
use hive_common::tools::{namespace_spec, ToolNamespace};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

/// The Codex inside the ChatGPT app.
pub const BUNDLED_CODEX: &str = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
pub const MODEL: &str = "gpt-6.1-terra";
/// Each step is a look and a click; more thinking mostly adds seconds to every one.
pub const EFFORT: &str = "low";
/// Tokens of context past which Codex compacts (summarizes) a session's thread. The models hold
/// 272k, but every step re-reads the context, and each screenshot in it is a thousand tokens or more.
pub const COMPACT_AT: u32 = 150_000;

/// Where the agent's files are, and its timings. [`Config::default`] is what agent.py used.
#[derive(Clone, Debug)]
pub struct Config {
    /// Codex's log, and each task's events (`LOG`: $TMPDIR/agent-vhid-codex.log).
    pub log: PathBuf,
    /// The app-server's working directory ($TMPDIR/agent-vhid-work).
    pub workdir: PathBuf,
    /// Where the direct-tools model catalog is written ($TMPDIR/agent-vhid-models.json).
    pub models_catalog: PathBuf,
    /// Our instructions in place of Codex's own (`python/instructions.md`, read for each thread).
    pub instructions: PathBuf,
    /// The threads' working directory (desktop/app).
    pub repo: PathBuf,
    /// `build/agent-app-server-transport`, which the app-server runs under when it's there.
    pub transport: Option<PathBuf>,
    /// The sign-in tools' MCP server (build/hive-auth-mcp; agent.py started
    /// `sys.executable python/authentication_mcp.py`).
    pub authentication_command: String,
    pub authentication_args: Vec<String>,
    /// Seconds an active goal's thread may sit idle before the watchdog wakes it (30).
    pub goal_watchdog_idle: f64,
    /// Seconds between the watchdog's checks (2).
    pub goal_watchdog_check: f64,
}

impl Default for Config {
    fn default() -> Self {
        let temp = hive_common::paths::temp_dir();
        let python = hive_common::python_dir();
        Self {
            log: temp.join("agent-vhid-codex.log"),
            workdir: temp.join("agent-vhid-work"),
            models_catalog: temp.join("agent-vhid-models.json"),
            instructions: python.join("instructions.md"),
            repo: hive_common::repo_root(),
            transport: AppServer::transport(),
            authentication_command: hive_common::build_dir()
                .join("hive-auth-mcp")
                .display()
                .to_string(),
            authentication_args: Vec::new(),
            goal_watchdog_idle: 30.0,
            goal_watchdog_check: 2.0,
        }
    }
}

type ServerFactory = Box<dyn FnMut(&Agent) -> Result<Arc<dyn Server>, AgentError> + Send>;

/// The agent's Codex: one app-server shared by every task, and the conversation they're part of.
pub struct Agent {
    pub env: Env,
    pub config: Config,
    pub hooks: Hooks,
    server: Mutex<Option<Arc<dyn Server>>>,
    session: Mutex<Arc<Session>>,
    /// The Claude conversation, when `AGENT_BACKEND=claude` chose Claude over Codex.
    claude: Option<Arc<ClaudeSession>>,
    /// The tests' stand-in for starting `codex app-server`.
    pub(crate) server_factory: Mutex<Option<ServerFactory>>,
    /// The tests' thread parameters (Python's `mock.patch.object(agent, "thread_params")`).
    pub(crate) params_override: Mutex<Option<Value>>,
}

impl Agent {
    pub fn new(env: Env, config: Config, hooks: Hooks) -> Arc<Agent> {
        let claude = claude::wanted(&env);
        Arc::new_cyclic(|me: &Weak<Agent>| Agent {
            env,
            config,
            hooks,
            server: Mutex::new(None),
            session: Mutex::new(Session::with_agent(me.clone(), None)),
            claude: claude.then(|| ClaudeSession::with_agent(me.clone())),
            server_factory: Mutex::new(None),
            params_override: Mutex::new(None),
        })
    }

    /// The conversation requests are part of (Python's `_session`).
    pub fn session(&self) -> Arc<Session> {
        lock(&self.session).clone()
    }

    /// Makes `session` the current conversation (as `use_claude` and the tests replaced `_session`).
    pub fn set_session(&self, session: Arc<Session>) {
        *lock(&self.session) = session;
    }

    /// `AGENT_BACKEND=claude`'s conversation (claude_agent.py's `_session`); None on Codex.
    pub fn claude_session(&self) -> Option<Arc<ClaudeSession>> {
        self.claude.clone()
    }

    /// What runs the requests: "claude" or "codex" (`AGENT_BACKEND`, read when it was made).
    pub fn backend(&self) -> &'static str {
        if self.claude.is_some() {
            "claude"
        } else {
            "codex"
        }
    }

    /// The conversation a new task is part of.
    pub(crate) fn task_session(&self) -> Arc<dyn TaskSession> {
        match &self.claude {
            Some(claude) => claude.clone(),
            None => self.session(),
        }
    }

    /// Compatibility entry point: prepares the durable conversation when listening starts (false,
    /// doing nothing, while one of its requests is running). Listening toggles never reset the
    /// conversation's identity, including after a restart.
    pub fn new_session(&self) -> bool {
        if let Some(claude) = &self.claude {
            return claude.new_session();
        }
        let session = self.session();
        if session.busy() {
            return false;
        }
        session.prepare();
        true
    }

    /// The agent's private state: `AGENT_STATE_DIR`, else ~/Library/Application Support/Personal Agent.
    pub fn state_dir(&self) -> PathBuf {
        if let Some(dir) = self.env.get("AGENT_STATE_DIR") {
            return PathBuf::from(dir);
        }
        let home = self
            .env
            .get("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(hive_common::paths::home);
        home.join("Library/Application Support/Personal Agent")
    }

    /// `CODEX_HOME`, else ~/.codex.
    pub fn codex_home(&self) -> PathBuf {
        if let Some(home) = self.env.raw("CODEX_HOME") {
            return PathBuf::from(home);
        }
        let home = self
            .env
            .get("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(hive_common::paths::home);
        home.join(".codex")
    }

    pub fn effort(&self) -> String {
        self.env
            .get("AGENT_EFFORT")
            .unwrap_or_else(|| EFFORT.into())
    }

    pub fn model(&self) -> String {
        self.env.get("AGENT_MODEL").unwrap_or_else(|| MODEL.into())
    }

    /// `AGENT_FAST`: Codex's Fast tier.
    pub fn fast(&self) -> bool {
        let value = self.env.raw("AGENT_FAST").unwrap_or_default();
        matches!(
            py::strip(&value).to_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    }

    /// The model and effort the computer agent runs with, e.g. 'gpt-6.1-terra, low effort'.
    pub fn describe_model(&self) -> String {
        if self.claude.is_some() {
            return claude::describe_model(self);
        }
        format!(
            "{}, {} effort{}",
            self.model(),
            self.effort(),
            if self.fast() { ", Fast tier" } else { "" }
        )
    }

    /// The codex executable: `CODEX_BIN`, the one inside ChatGPT.app, else `codex` on PATH
    /// (`AgentError::Exit` with how to install it if there's none).
    pub fn find_codex(&self) -> Result<String, AgentError> {
        let on_path = self.which("codex");
        for candidate in [
            self.env.get("CODEX_BIN"),
            Some(BUNDLED_CODEX.to_owned()),
            on_path,
        ]
        .into_iter()
        .flatten()
        {
            if Path::new(&candidate).exists() {
                return Ok(candidate);
            }
        }
        Err(AgentError::Exit(prompts::CODEX_NOT_FOUND.into()))
    }

    /// `shutil.which(name)`.
    fn which(&self, name: &str) -> Option<String> {
        let path = self.env.raw("PATH")?;
        path.split(':')
            .map(|dir| Path::new(if dir.is_empty() { "." } else { dir }).join(name))
            .find(|candidate| crate::app_server::executable(candidate))
            .map(|found| found.display().to_string())
    }

    /// Names of the MCP servers in ~/.codex/config.toml, so they can be switched off for this run.
    pub fn configured_mcp_servers(&self) -> Vec<String> {
        let Ok(text) = std::fs::read_to_string(self.codex_home().join("config.toml")) else {
            return Vec::new();
        };
        let Ok(config) = text.parse::<toml::Table>() else {
            return Vec::new();
        };
        match config.get("mcp_servers") {
            Some(toml::Value::Table(servers)) => servers.keys().cloned().collect(),
            _ => Vec::new(),
        }
    }

    /// `codex app-server` with the agent's settings.
    pub fn app_server_command(&self) -> Result<Vec<String>, AgentError> {
        let mut devices: Vec<Value> = prompts::DEVICES.iter().map(|(d, _)| json!(d)).collect();
        devices.extend([json!("knowledge"), json!("spaceo")]);
        let mut overrides: Vec<String> = vec![
            "notify=[]".into(), // no sounds or notifications when a task ends
            // Quick steps and short replies: it's read aloud, and nobody reads the reasoning summaries.
            format!("model_reasoning_effort=\"{}\"", self.effort()),
            "model_verbosity=\"low\"".into(),
            "model_reasoning_summary=\"auto\"".into(),
            "skills.include_instructions=false".into(),
            "tools.update_plan.enabled=false".into(),
            // Codex's own lines on its sandbox ("only permits reading files") are about its shell and
            // file tools, which are off; the model took them to mean it couldn't edit what's on the screen.
            "include_permissions_instructions=false".into(),
            "tools.experimental_request_user_input.enabled=false".into(),
            // Our tools go straight to the model instead of through code mode's JavaScript `exec`
            // tool, which would have it look the tools up first and unpack every screenshot by hand.
            format!(
                "features.code_mode.direct_only_tool_namespaces={}",
                py::dumps(&Value::Array(devices), true)
            ),
            format!("model_auto_compact_token_limit={COMPACT_AT}"),
        ];
        if self.env.get("AGENT_SPACEO_COMMAND").is_some() {
            let state = self.state_dir();
            let roots: Vec<String> = ["memory", "captures", "updates"]
                .iter()
                .map(|r| state.join(r).display().to_string())
                .collect();
            for root in &roots {
                make_dirs(Path::new(root))?;
            }
            let socket = state
                .join("control")
                .join("workspace.sock")
                .display()
                .to_string();
            let root_table = format!(
                "{{{}}}",
                roots
                    .iter()
                    .map(|r| format!("{} = true", py::dumps(&json!(r), true)))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let socket_table = format!("{{{} = \"allow\"}}", py::dumps(&json!(socket), true));
            overrides.extend([
                "permissions.personal-agent.extends=\":workspace\"".into(),
                "permissions.personal-agent.network.enabled=true".into(),
                "permissions.personal-agent.network.domains={\"registry.npmjs.org\" = \"allow\"}"
                    .into(),
                format!("permissions.personal-agent.network.unix_sockets={socket_table}"),
                format!("permissions.personal-agent.workspace_roots={root_table}"),
                "features.network_proxy=true".into(),
            ]);
        }
        overrides.extend(
            prompts::FEATURES_OFF
                .iter()
                .map(|name| format!("features.{name}=false")),
        );
        overrides.extend(
            self.configured_mcp_servers()
                .iter()
                .map(|name| format!("mcp_servers.{name}.enabled=false")),
        );
        // Static MCP tools also reach existing conversations whose saved dynamic tool list predates
        // authentication. No thread replacement or history loss is needed to add this capability.
        overrides.extend([
            "mcp_servers.authentication.enabled=true".into(),
            format!(
                "mcp_servers.authentication.command={}",
                py::dumps(&json!(self.config.authentication_command), true)
            ),
            format!(
                "mcp_servers.authentication.args={}",
                py::dumps(&json!(self.config.authentication_args), true)
            ),
            // Codex 0.167 asks before running an MCP tool; with approvalPolicy "never" that ask
            // becomes a refusal, so Hive's own tools are approved up front.
            "mcp_servers.authentication.default_tools_approval_mode=\"approve\"".into(),
            // Codex's hosted web search clashes with Hive's own web.run tool (OpenAI 400).
            "web_search=\"disabled\"".into(),
        ]);
        if let (Some(bridge), Some(connection)) = (
            self.env.get("AGENT_WORKSPACE_BRIDGE"),
            self.env.get("AGENT_WORKSPACE_CONNECTION"),
        ) {
            overrides.extend([
                "mcp_servers.workspace.enabled=true".into(),
                format!(
                    "mcp_servers.workspace.command={}",
                    py::dumps(&json!(bridge), true)
                ),
                format!(
                    "mcp_servers.workspace.args={}",
                    py::dumps(&json!(["mcp-bridge", "--connection", connection]), true)
                ),
                "mcp_servers.workspace.default_tools_approval_mode=\"approve\"".into(),
            ]);
        }
        if let Some(catalog) = self.direct_tools_catalog() {
            overrides.push(format!(
                "model_catalog_json={}",
                py::dumps(&json!(catalog), true)
            ));
        }
        let mut command = vec![self.find_codex()?, "app-server".to_owned()];
        for o in overrides {
            command.push("-c".into());
            command.push(o);
        }
        Ok(command)
    }

    /// Codex's list of models (its cache of what your account offers), with each one set to call
    /// tools directly rather than in code mode, without sub-agents or the file-patching tool. That
    /// halves what the model reads on each request. None if Codex hasn't cached the list.
    pub fn direct_tools_catalog(&self) -> Option<String> {
        let text = std::fs::read_to_string(self.codex_home().join("models_cache.json")).ok()?;
        let cache: Value = serde_json::from_str(&text).ok()?;
        let mut models = cache.as_object()?.get("models")?.as_array()?.clone();
        for m in models.iter_mut() {
            let m = m.as_object_mut()?;
            m.insert("tool_mode".into(), json!("direct"));
            m.shift_remove("multi_agent_version");
            m.shift_remove("apply_patch_tool_type");
        }
        let path = &self.config.models_catalog;
        std::fs::write(path, py::dumps(&json!({"models": models}), true)).ok()?;
        Some(path.display().to_string())
    }

    /// The app-server every task shares, started (or restarted) when needed.
    pub fn codex_server(&self) -> Result<Arc<dyn Server>, AgentError> {
        let mut server = lock(&self.server);
        if let Some(running) = server.as_ref().filter(|s| s.alive()) {
            return Ok(running.clone());
        }
        let started: Arc<dyn Server> = match lock(&self.server_factory).as_mut() {
            Some(factory) => factory(self)?,
            None => {
                let command = self.app_server_command()?;
                std::fs::create_dir_all(&self.config.workdir)?;
                let log = std::fs::OpenOptions::new()
                    .append(true)
                    .create(true)
                    .open(&self.config.log)?;
                AppServer::start(
                    &command,
                    self.config.transport.as_deref(),
                    Some(log),
                    Some(&self.config.workdir),
                    &self.env,
                )?
            }
        };
        *server = Some(started.clone());
        Ok(started)
    }

    /// The app-server, if it's running; never starts one.
    pub fn running_server(&self) -> Option<Arc<dyn Server>> {
        lock(&self.server).as_ref().filter(|s| s.alive()).cloned()
    }

    /// Ends the app-server (agent.py did this at exit).
    pub fn stop_server(&self) {
        if let Some(claude) = &self.claude {
            claude.terminate();
        }
        let server = lock(&self.server).take();
        if let Some(server) = server {
            server.close();
        }
    }

    /// Starts Codex now, so the first task doesn't wait for it. Reads the browsers' tabs once too:
    /// the first time, macOS asks whether the agent may (so it asks now, not halfway through a task).
    pub fn warm_up(&self) {
        let tabs = self.hooks.warm_browser_tabs.clone();
        std::thread::spawn(move || tabs());
        if let Some(claude) = &self.claude {
            claude.prepare(); // its process starts in the background
            return;
        }
        if let Ok(server) = self.codex_server() {
            if self.env.get("AGENT_SPACEO_COMMAND").is_some() {
                // Force MCP startup so the virtual display exists before the first spoken task.
                let _ = server.request("mcpServerStatus/list", json!({}), 45.0);
            }
        } // the first task reports it
    }

    /// Each device's tools, which Codex's tool calls come back to. None connects until used.
    pub fn device_tools(&self) -> HashMap<String, Arc<dyn ToolNamespace>> {
        (self.hooks.device_tools)()
            .into_iter()
            .map(|t| (t.namespace().to_owned(), t))
            .collect()
    }

    /// Both devices' tools, as Codex's dynamic tools: the model calls them as `mac.click`,
    /// `phone.tap` etc. Always the same, so they stay in the prompt cache from task to task.
    pub fn tool_specs(&self) -> Vec<Value> {
        let tools = (self.hooks.device_tools)();
        let mut specs: Vec<Value> = prompts::DEVICES
            .iter()
            .filter_map(|(device, _)| tools.iter().find(|t| t.namespace() == *device))
            .map(|t| namespace_spec(t.as_ref()))
            .collect();
        for t in &tools {
            t.close();
        }
        specs.extend(self.hooks.knowledge.namespace());
        specs
    }

    /// Our instructions (instructions.md), in place of Codex's own.
    pub fn instructions(&self) -> Result<String, AgentError> {
        Ok(std::fs::read_to_string(&self.config.instructions)?)
    }

    /// Persistent threads with our instructions, rules and tools.
    pub fn thread_params(&self) -> Result<Value, AgentError> {
        if let Some(params) = lock(&self.params_override).clone() {
            return Ok(params);
        }
        let spaceo = self.env.get("AGENT_SPACEO_COMMAND").is_some();
        let mut rules = prompts::RULES.to_owned();
        if self.env.get("AGENT_WORKSPACE_CONNECTION").is_some() {
            rules.push_str(prompts::WORKSPACE_RULES);
        }
        if spaceo {
            rules.push_str(prompts::SPACEO_RULES);
        } else {
            rules.push_str(&prompts::virtual_monitor_rules((self
                .hooks
                .virtual_monitor_enabled)(
            )));
            rules.push_str(prompts::SIGN_IN_RULES);
        }
        // Applied on resume as well, so the long-running conversation builds the knowledge base too.
        rules.push_str(&self.hooks.knowledge.rules());
        let mut params = json!({
            "baseInstructions": self.instructions()?, "developerInstructions": rules, "dynamicTools": self.tool_specs(),
            "model": self.model(), "ephemeral": false, "approvalPolicy": "never",
            "cwd": self.config.repo.display().to_string(),
        });
        if spaceo {
            params["permissions"] = json!("personal-agent");
        } else {
            params["sandbox"] = json!("workspace-write");
            // Its shell can reach the internet (curl, gh, wrangler, APIs). Without this the shell is
            // offline, and an agent that can't reach an API turns to the screen and does the work as
            // the user. It can also write in hive-dream's folder: the nightly self-review hands Hive's
            // agent a git worktree there to write a failing test and the fix in, and builds there.
            params["config"] = json!({"sandbox_workspace_write": {
                "network_access": true,
                "writable_roots": [dream_dir().display().to_string()],
            }});
        }
        if self.fast() {
            params["serviceTier"] = json!("priority"); // the id Codex's model list gives its Fast tier
        }
        Ok(params)
    }
}

/// hive-dream's folder (`<state>/dream`): its worktrees and build folder.
pub fn dream_dir() -> PathBuf {
    hive_common::state_dir().join("dream")
}

fn make_dirs(path: &Path) -> Result<(), AgentError> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    Ok(())
}

/// The device a request is for: "phone" when it says so ("on my phone", "open Maps on the
/// iPhone"; not "my phone number"), else "mac".
pub fn focus(request: &str) -> &'static str {
    use std::sync::OnceLock;
    static IPHONE: OnceLock<regex::Regex> = OnceLock::new();
    static PHONE: OnceLock<regex::Regex> = OnceLock::new();
    let lower = request.to_lowercase();
    let iphone = IPHONE.get_or_init(|| regex::Regex::new(r"\biphone\b").expect("valid pattern"));
    if iphone.is_match(&lower) {
        return "phone";
    }
    // `\b(?:my|the|on|from|with|using) phone\b(?! numbers?\b)`, the lookahead by hand.
    let phone = PHONE.get_or_init(|| {
        regex::Regex::new(r"\b(?:my|the|on|from|with|using) phone\b").expect("valid pattern")
    });
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let about_a_number = |rest: &str| match rest.strip_prefix(" number") {
        Some(after) => {
            let after = after.strip_prefix('s').unwrap_or(after);
            !after.chars().next().is_some_and(word)
        }
        None => false,
    };
    if phone
        .find_iter(&lower)
        .any(|m| !about_a_number(&lower[m.end()..]))
    {
        "phone"
    } else {
        "mac"
    }
}

/// How the command line shows a task's events (agent.py's `print_event`): the line to print,
/// or None for the ones it doesn't show.
pub fn print_event(kind: &str, text: &str) -> Option<String> {
    let text = match kind {
        "context" | "doing" => return None, // the viewer's location is shown once; actions as they start
        "done" => "done",                   // the final message was already shown as it arrived
        _ => text,
    };
    let mark = match kind {
        "action" => "  →",
        "error" => "  ✗",
        "say" => "  💬",
        "think" => "  …",
        "done" => "✅",
        "failed" => "❌",
        _ => "  ",
    };
    Some(format!("{mark} {text}"))
}

/// agent.py's usage text, for the command line's `--help`.
pub const USAGE: &str = "Give your Mac or iPhone a task in plain English; Codex does it with the real mouse and keyboard,
or with taps on the phone.

Environment (or .env):
  CODEX_BIN     codex executable (default: the one inside ChatGPT.app, else `codex` on PATH)
  AGENT_MODEL   model (default: gpt-6.1-terra)
  AGENT_EFFORT  reasoning effort for each step: low (default, quickest), medium, high. Higher
                thinks longer before every click, which makes the agent several times slower
  AGENT_FAST    1: Codex's Fast tier, which OpenAI says is 1.5x quicker but uses up your plan's
                usage sooner (off by default)
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_for_the_phone_only_when_it_says_so() {
        assert_eq!(focus("open Maps on my phone"), "phone");
        assert_eq!(focus("open Maps on the iPhone"), "phone");
        assert_eq!(focus("what's my phone number"), "mac");
        assert_eq!(focus("call the phone numbers on my list"), "mac");
        assert_eq!(focus("text using phone numberless"), "phone");
        assert_eq!(focus("make a note that says buy milk"), "mac");
        assert_eq!(focus("phone home"), "mac");
    }

    #[test]
    fn events_print_like_the_command_line() {
        assert_eq!(print_event("say", "Hi.").as_deref(), Some("  💬 Hi."));
        assert_eq!(
            print_event("done", "Opened it.").as_deref(),
            Some("✅ done")
        );
        assert_eq!(print_event("doing", "Thinking"), None);
        assert_eq!(print_event("data", "x").as_deref(), Some("   x"));
    }
}
