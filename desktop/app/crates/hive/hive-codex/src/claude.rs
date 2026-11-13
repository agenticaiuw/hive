//! The computer agent on Claude, through your Claude subscription (python/claude_agent.py): the
//! logged-in `claude` CLI, driven the way the Claude Agent SDK (0.2.176) drives it, in place of
//! Codex when `AGENT_BACKEND=claude`. [`crate::Agent`] decides once, when it is made; then
//! [`crate::CodexTask`] runs its request here and [`ClaudeSession`] is the conversation.
//!
//! One Claude Code process per conversation, started when you tap fn so it is ready before you've
//! finished talking; each request is a turn on it, so it has the earlier ones in context. Its own
//! tools are Read, Edit, Write, Bash, Glob and Grep; the Mac's and the iPhone's (`mcp__mac__*`,
//! `mcp__phone__*`) are "sdk" MCP servers answered in this process. Replies stream, so each
//! sentence goes to the voice as soon as it is written.
//!
//! The SDK's protocol, on the CLI's stdin and stdout (`--input-format/--output-format
//! stream-json`), one JSON object per line:
//! - We send `control_request`s (`initialize`, then `interrupt` to stop a turn) and user messages.
//!   The CLI answers each request with a `control_response` and streams its messages.
//! - The CLI sends `control_request`s too: `mcp_message` carries a JSON-RPC message for the mac
//!   or phone server, answered on a thread of its own ([`ToolNamespace::call`] for `tools/call`).
//!
//! Environment: `AGENT_MODEL` (a `claude-*` model; default claude-opus-5-5), `AGENT_EFFORT`
//! (default low), `AGENT_FAST` (Claude Code's fast mode). Log in once with `claude auth login`.

use crate::agent::Agent;
use crate::app_server::{executable, Server};
use crate::describe::{describe_call, doing};
use crate::look::first_look;
use crate::prompts;
use crate::py;
use crate::session::TaskSession;
use crate::task::CodexTask;
use crate::util::{lock, panic_text, random_hex, AgentError, Env, Event};
use hive_common::tools::ToolNamespace;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fmt::Display;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

/// The model when `AGENT_MODEL` isn't a Claude one.
pub const MODEL: &str = "claude-opus-5-5";
/// The Claude Agent SDK whose protocol this speaks (`CLAUDE_AGENT_SDK_VERSION`).
pub const SDK_VERSION: &str = "0.2.176";
/// Claude Code's own tools that stay on.
const BUILT_IN: [&str; 6] = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];
/// The MCP protocol versions the SDK's in-process servers accept (else they answer the latest).
const PROTOCOL_VERSIONS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const LATEST_PROTOCOL: &str = "2025-11-25";
const NOT_FOUND: &str = "Claude Code not found. Install with:\n  npm install -g @anthropic-ai/claude-code\n\nIf already installed locally, try:\n  export PATH=\"$HOME/node_modules/.bin:$PATH\"\n\nOr provide the path via ClaudeAgentOptions:\n  ClaudeAgentOptions(cli_path='/path/to/claude')";
const ENDED: &str = "Claude Code exited before the request was done";

/// `AGENT_BACKEND=claude` (any case; Codex is the default).
pub(crate) fn wanted(env: &Env) -> bool {
    env.get("AGENT_BACKEND")
        .unwrap_or_else(|| "codex".into())
        .to_lowercase()
        == "claude"
}

/// `AGENT_MODEL` when it is a Claude model, else [`MODEL`].
pub fn model(agent: &Agent) -> String {
    let m = agent.env.get("AGENT_MODEL").unwrap_or_default();
    if m.starts_with("claude") {
        m
    } else {
        MODEL.into()
    }
}

/// E.g. 'claude-opus-5-5, low effort, on your Claude subscription'.
pub fn describe_model(agent: &Agent) -> String {
    format!(
        "{}, {} effort{}, on your Claude subscription",
        model(agent),
        agent.effort(),
        if agent.fast() { ", fast mode" } else { "" }
    )
}

/// The Claude log beside Codex's: agent-vhid-claude.log (`LOG.replace("codex", "claude")`).
pub fn log_path(codex_log: &Path) -> PathBuf {
    match codex_log.file_name().and_then(|n| n.to_str()) {
        Some(name) => codex_log.with_file_name(name.replace("codex", "claude")),
        None => codex_log.to_path_buf(),
    }
}

/// `str(uuid.UUID(value))`: the canonical form, or None if it isn't a UUID.
pub(crate) fn canonical_uuid(value: &str) -> Option<String> {
    let hex = value.replace("urn:", "").replace("uuid:", "");
    let hex = hex.trim_matches(|c| c == '{' || c == '}').replace('-', "");
    if hex.len() != 32 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let h = hex.to_lowercase();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}

// -- the conversation ---------------------------------------------------------------------------

#[derive(Default)]
struct SessionState {
    primary: Option<Arc<Conn>>,
    closed: bool,
}

/// The requests from when you tap fn to talk (claude_agent.py's `Session`): turns on one Claude
/// Code process, so each has the ones before it in context. Its identity is saved in
/// `<state>/claude-session-id` and resumed after a restart. A request while another's turn is under
/// way (the phone while the Mac works) gets a process of its own, told what was said so far.
pub struct ClaudeSession {
    agent: Weak<Agent>,
    me: Weak<ClaudeSession>,
    tasks: Mutex<Vec<Arc<CodexTask>>>,
    state: Mutex<SessionState>,
    /// Every process it started, for [`ClaudeSession::terminate`].
    conns: Mutex<Vec<Weak<Conn>>>,
}

impl ClaudeSession {
    pub fn new(agent: &Arc<Agent>) -> Arc<ClaudeSession> {
        Self::with_agent(Arc::downgrade(agent))
    }

    pub(crate) fn with_agent(agent: Weak<Agent>) -> Arc<ClaudeSession> {
        Arc::new_cyclic(|me| ClaudeSession {
            agent,
            me: me.clone(),
            tasks: Mutex::new(Vec::new()),
            state: Mutex::new(SessionState::default()),
            conns: Mutex::new(Vec::new()),
        })
    }

    /// Its requests, oldest first.
    pub fn tasks(&self) -> Vec<Arc<CodexTask>> {
        lock(&self.tasks).clone()
    }

    /// One of its requests is running.
    pub fn busy(&self) -> bool {
        self.tasks().iter().any(|t| t.running())
    }

    fn connect(&self, persistent: bool) -> Result<Arc<Conn>, AgentError> {
        let agent = self
            .agent
            .upgrade()
            .ok_or_else(|| AgentError::Resume("Conversation is closed".into()))?;
        let conn = Conn::new(&agent, persistent)?;
        let mut conns = lock(&self.conns);
        conns.retain(|c| c.strong_count() > 0);
        conns.push(Arc::downgrade(&conn));
        Ok(conn)
    }

    /// Starts the process now, so the first request doesn't wait for it. (A saved identity that
    /// can't be resumed fails the first request instead.)
    pub fn prepare(&self) {
        let mut state = lock(&self.state);
        if state.primary.is_none() && !state.closed {
            state.primary = self.connect(true).ok();
        }
    }

    /// The process for a task's turn: the conversation's own when it is free (true), else a new
    /// one of its own (false).
    pub(crate) fn acquire(&self, task: &Arc<CodexTask>) -> Result<(Arc<Conn>, bool), AgentError> {
        {
            let mut state = lock(&self.state);
            let dead = state.primary.as_ref().map(|p| p.dead() && p.free());
            if dead != Some(false) {
                // None yet, or it exited between requests: start it again, resuming the conversation.
                if let Some(old) = state.primary.take() {
                    old.close();
                }
                state.primary = Some(self.connect(true)?);
            }
            let primary = state
                .primary
                .clone()
                .expect("the primary process was just made");
            if primary.free() {
                primary.set_task(task);
                return Ok((primary, true));
            }
        }
        let conn = self.connect(false)?;
        conn.set_task(task);
        Ok((conn, false))
    }

    /// Ends its process.
    pub fn close(&self) {
        let conn = {
            let mut state = lock(&self.state);
            state.closed = true;
            state.primary.take()
        };
        if let Some(conn) = conn {
            conn.close();
        }
    }

    /// What was said in the conversation that `task`'s process hasn't seen (everything, for a
    /// process of its own), to tell it before the request.
    pub fn said_before(&self, task: &CodexTask, everything: bool) -> String {
        let tasks = self.tasks();
        let Some(index) = tasks.iter().position(|t| std::ptr::eq(t.as_ref(), task)) else {
            return String::new();
        };
        let mut lines = Vec::new();
        for t in &tasks[..index] {
            if everything || !(t.on_thread() || t.told()) {
                lines.push(format!(
                    "  They asked: {}",
                    py::dumps(&json!(t.task()), false)
                ));
                lines.push(format!("  You: {}", t.outcome()));
                if !everything && !t.running() {
                    t.set_told();
                }
            }
        }
        if lines.is_empty() {
            return String::new();
        }
        format!("{}{}\n\n", prompts::SAID_BEFORE, lines.join("\n"))
    }

    /// Keeps the conversation when listening is toggled (false while one of its requests runs).
    pub(crate) fn new_session(&self) -> bool {
        if self.busy() {
            return false;
        }
        self.prepare();
        true
    }

    /// SIGTERMs every Claude Code process still running (what the SDK does at exit).
    pub fn terminate(&self) {
        let conns: Vec<Arc<Conn>> = lock(&self.conns).iter().filter_map(Weak::upgrade).collect();
        for conn in conns {
            conn.signal(libc::SIGTERM);
        }
    }
}

impl TaskSession for ClaudeSession {
    fn add(&self, task: &Arc<CodexTask>) {
        lock(&self.tasks).push(task.clone());
    }
    fn thread_for(
        &self,
        _: &Arc<CodexTask>,
        _: &Arc<dyn Server>,
        _: Value,
        _: Option<&str>,
    ) -> Result<(String, String), AgentError> {
        Err(AgentError::Value(
            "A Claude conversation has no Codex thread".into(),
        ))
    }
    fn release(&self, _: &CodexTask) {}
    fn context_error(&self) -> Option<String> {
        None
    }
    fn tasks(&self) -> Vec<Arc<CodexTask>> {
        ClaudeSession::tasks(self)
    }
    fn claude(&self) -> Option<Arc<ClaudeSession>> {
        self.me.upgrade()
    }
}

// -- one Claude Code process --------------------------------------------------------------------

/// What the CLI sent, in order: a message, the error it ended with, or its end.
pub(crate) enum Incoming {
    Message(Value),
    Error(String),
    End,
}

type Reply = mpsc::Sender<Result<Value, String>>;

/// One Claude Code process and the task whose turn is on it (claude_agent.py's `Conn`, with the
/// SDK's transport and control protocol).
pub(crate) struct Conn {
    task: Mutex<Option<Weak<CodexTask>>>,
    identity_path: Option<PathBuf>,
    session_id: Mutex<Option<String>>,
    /// The in-process MCP servers: each device and its tools.
    servers: Vec<(String, Vec<Value>)>,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    /// Our control requests waiting for their response.
    pending: Mutex<HashMap<String, Reply>>,
    /// The CLI's control requests being answered (true: it cancelled the request).
    inflight: Mutex<HashMap<String, bool>>,
    counter: AtomicU64,
    sender: Mutex<Option<mpsc::Sender<Incoming>>>,
    messages: Mutex<mpsc::Receiver<Incoming>>,
    /// Held for a turn: the process takes one at a time.
    turn: Mutex<()>,
    ready: Event,
    connected: Mutex<Option<Result<(), String>>>,
    ended: AtomicBool,
    closed: AtomicBool,
}

impl Conn {
    /// Starts one (in the background: the first turn waits for it). `persistent`: the
    /// conversation's own process, which resumes and saves its identity.
    pub(crate) fn new(agent: &Arc<Agent>, persistent: bool) -> Result<Arc<Conn>, AgentError> {
        let conn = Self::unconnected(agent, persistent)?;
        let (c, agent) = (conn.clone(), agent.clone());
        std::thread::spawn(move || {
            let result = c.connect(&agent);
            if result.is_err() {
                c.ended.store(true, Ordering::SeqCst);
                if lock(&c.child).is_some() {
                    c.close();
                }
            }
            *lock(&c.connected) = Some(result);
            c.ready.set();
        });
        Ok(conn)
    }

    /// One whose process isn't started yet.
    pub(crate) fn unconnected(agent: &Agent, persistent: bool) -> Result<Arc<Conn>, AgentError> {
        let identity_path = persistent.then(|| agent.state_dir().join("claude-session-id"));
        let mut session_id = None;
        if let Some(path) = identity_path.as_ref().filter(|p| p.exists()) {
            let saved = std::fs::read_to_string(path)?;
            session_id = Some(canonical_uuid(py::strip(&saved)).ok_or_else(|| {
                AgentError::Resume(
                    "Invalid saved Claude session ID; refusing to replace the conversation".into(),
                )
            })?);
        }
        let devices = (agent.hooks.device_tools)();
        let servers = prompts::DEVICES
            .iter()
            .filter_map(|(device, _)| devices.iter().find(|t| t.namespace() == *device))
            .map(|t| (t.namespace().to_owned(), t.tools()))
            .collect();
        for t in &devices {
            t.close();
        }
        let (sender, messages) = mpsc::channel();
        Ok(Arc::new(Conn {
            task: Mutex::new(None),
            identity_path,
            session_id: Mutex::new(session_id),
            servers,
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            sender: Mutex::new(Some(sender)),
            messages: Mutex::new(messages),
            turn: Mutex::new(()),
            ready: Event::new(false),
            connected: Mutex::new(None),
            ended: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        }))
    }

    pub(crate) fn session_id(&self) -> Option<String> {
        lock(&self.session_id).clone()
    }

    fn set_task(&self, task: &Arc<CodexTask>) {
        *lock(&self.task) = Some(Arc::downgrade(task));
    }

    fn task(&self) -> Option<Arc<CodexTask>> {
        lock(&self.task).as_ref().and_then(Weak::upgrade)
    }

    /// No turn is on it (Python: `task is None or not task.running`).
    fn free(&self) -> bool {
        self.task().is_none_or(|t| !t.running())
    }

    /// `task`'s turn is on it.
    fn serves(&self, task: &CodexTask) -> bool {
        self.task().is_some_and(|t| std::ptr::eq(t.as_ref(), task))
    }

    /// Its turn is over (`conn.task = None`, unless another task's turn is on it by now).
    fn release(&self, task: &CodexTask) {
        let mut current = lock(&self.task);
        if current
            .as_ref()
            .and_then(Weak::upgrade)
            .is_none_or(|t| std::ptr::eq(t.as_ref(), task))
        {
            *current = None;
        }
    }

    /// The process couldn't start, or has exited.
    fn dead(&self) -> bool {
        self.ended.load(Ordering::SeqCst) || self.exit_code().is_some()
    }

    /// The CLI's command line after the executable (the SDK's `_build_command` for
    /// claude_agent.py's options).
    pub(crate) fn arguments(&self, agent: &Agent) -> Result<Vec<String>, AgentError> {
        let spaceo = agent.env.get("AGENT_SPACEO_COMMAND");
        let mut allowed: Vec<String> = BUILT_IN.iter().map(|t| t.to_string()).collect();
        let mut servers = Map::new();
        for (device, tools) in &self.servers {
            for tool in tools {
                if let Some(name) = tool.get("name").and_then(Value::as_str) {
                    allowed.push(format!("mcp__{device}__{name}"));
                }
            }
            servers.insert(device.clone(), json!({"type": "sdk", "name": device}));
        }
        if let Some(spaceo) = &spaceo {
            let bridge = agent.config.repo.join("build/spaceo-mcp-bridge");
            servers.insert(
                "spaceo".into(),
                json!({"type": "stdio", "command": bridge.display().to_string(), "args": [spaceo]}),
            );
            allowed.push("mcp__spaceo__*".into());
        }
        let mut system = format!("{}\n\n{}", agent.instructions()?, prompts::RULES);
        if spaceo.is_some() {
            system.push_str(prompts::SPACEO_RULES);
        }
        let mut args: Vec<String> = ["--output-format", "stream-json", "--verbose"]
            .map(String::from)
            .to_vec();
        args.extend(["--system-prompt".into(), system]);
        args.extend(["--tools".into(), BUILT_IN.join(",")]);
        args.extend(["--allowedTools".into(), allowed.join(",")]);
        args.extend(["--model".into(), model(agent)]);
        if let Some(id) = self.session_id() {
            args.push(format!("--resume={id}"));
        }
        if agent.fast() {
            args.extend([
                "--settings".into(),
                py::dumps(&json!({"fastMode": true}), true),
            ]);
        }
        if !servers.is_empty() {
            args.extend([
                "--mcp-config".into(),
                py::dumps(&json!({"mcpServers": servers}), true),
            ]);
        }
        args.extend(
            [
                "--include-partial-messages",
                "--strict-mcp-config",
                "--setting-sources=",
            ]
            .map(String::from),
        );
        if self.identity_path.is_none() {
            args.push("--no-session-persistence".into());
        }
        args.extend(["--effort".into(), agent.effort()]);
        args.extend(["--input-format".into(), "stream-json".into()]);
        Ok(args)
    }

    /// Starts the CLI and its control protocol (the SDK's `connect` and `initialize`).
    fn connect(self: &Arc<Self>, agent: &Agent) -> Result<(), String> {
        std::fs::create_dir_all(&agent.config.workdir).map_err(|e| e.to_string())?;
        let args = self.arguments(agent).map_err(|e| e.to_string())?;
        let cli = find_cli(agent)?;
        let cwd = agent.config.repo.clone();
        let mut command = Command::new(&cli);
        command
            .args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        agent.env.apply(&mut command);
        command.env_remove("CLAUDECODE"); // so it doesn't think it runs inside Claude Code
        command.env("CLAUDE_CODE_ENTRYPOINT", "sdk-py");
        command.env("CLAUDE_AGENT_SDK_VERSION", SDK_VERSION);
        if agent
            .env
            .raw("CLAUDE_CODE_SDK_READS_SESSION_STATE")
            .is_none()
        {
            command.env("CLAUDE_CODE_SDK_READS_SESSION_STATE", "1");
        }
        command.env("PWD", &cwd);
        let mut child = command.spawn().map_err(|e| {
            if e.kind() != std::io::ErrorKind::NotFound {
                format!("Failed to start Claude Code: {e}")
            } else if !cwd.exists() {
                format!("Working directory does not exist: {}", cwd.display())
            } else {
                format!("Claude Code not found at: {cli}")
            }
        })?;
        let stdout = child.stdout.take();
        *lock(&self.stdin) = child.stdin.take();
        *lock(&self.child) = Some(child);
        let sender = lock(&self.sender).take();
        if let (Some(stdout), Some(sender)) = (stdout, sender) {
            let me = self.clone();
            std::thread::spawn(move || me.read(stdout, sender));
        }
        let timeout = agent
            .env
            .get("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT")
            .and_then(|ms| py::strip(&ms).parse::<f64>().ok())
            .unwrap_or(60_000.0);
        self.request(
            json!({"subtype": "initialize", "hooks": null, "skills": []}),
            (timeout / 1000.0).max(60.0),
        )?;
        Ok(())
    }

    /// Waits for its start; why it couldn't, if it couldn't.
    fn wait_ready(&self) -> Result<(), String> {
        self.ready.wait(None);
        lock(&self.connected).clone().unwrap_or(Ok(()))
    }

    /// Reads the CLI's output until it ends, routing control messages (the SDK's
    /// `read_messages` and `_read_messages`).
    fn read(self: Arc<Self>, stdout: ChildStdout, sender: mpsc::Sender<Incoming>) {
        let mut reader = BufReader::new(stdout);
        let mut buffer = String::new();
        let mut line = Vec::new();
        let mut last_error: Option<Value> = None;
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&line);
            for part in text.trim().split('\n').map(str::trim) {
                if part.is_empty() {
                    continue;
                }
                buffer.push_str(part);
                let Ok(message) = serde_json::from_str::<Value>(&buffer) else {
                    continue; // a message split across lines
                };
                buffer.clear();
                if !self.closed.load(Ordering::SeqCst) {
                    self.route(message, &sender, &mut last_error);
                }
            }
        }
        let code = self.wait_exit(10.0);
        self.ended.store(true, Ordering::SeqCst);
        let error = match code {
            Some(code) if code != 0 && !self.closed.load(Ordering::SeqCst) => Some(match &last_error {
                // It exits 1 after an error result, on purpose; that result says why.
                Some(result) => format!(
                    "Claude Code returned an error result: {}",
                    error_result_text(result)
                ),
                None => format!(
                    "Command failed with exit code {code} (exit code: {code})\nError output: Check stderr output for details"
                ),
            }),
            _ => None,
        };
        let pending: Vec<Reply> = lock(&self.pending).drain().map(|(_, r)| r).collect();
        for reply in pending {
            let _ = reply.send(Err(error.clone().unwrap_or_else(|| ENDED.into())));
        }
        if let Some(error) = error {
            let _ = sender.send(Incoming::Error(error));
        }
        let _ = sender.send(Incoming::End);
    }

    fn route(
        self: &Arc<Self>,
        message: Value,
        sender: &mpsc::Sender<Incoming>,
        last_error: &mut Option<Value>,
    ) {
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "control_response" => {
                let response = message
                    .get("response")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let id = response.get("request_id").and_then(Value::as_str);
                let Some(reply) = id.and_then(|id| lock(&self.pending).remove(id)) else {
                    return;
                };
                let result = if response.get("subtype").and_then(Value::as_str) == Some("error") {
                    Err(response
                        .get("error")
                        .map(py::str_of)
                        .unwrap_or_else(|| "Unknown error".into()))
                } else {
                    Ok(match response.get("response") {
                        Some(data) if data.is_object() => data.clone(),
                        _ => json!({}),
                    })
                };
                let _ = reply.send(result);
                return;
            }
            "control_request" => {
                let me = self.clone();
                std::thread::spawn(move || me.answer(&message));
                return;
            }
            "control_cancel_request" => {
                if let Some(id) = message.get("request_id").and_then(Value::as_str) {
                    if let Some(cancelled) = lock(&self.inflight).get_mut(id) {
                        *cancelled = true;
                    }
                }
                return;
            }
            "transcript_mirror" => return,
            _ => {}
        }
        let state_change = kind == "system"
            && message.get("subtype").and_then(Value::as_str) == Some("session_state_changed");
        if state_change && message.get("sdk_host_only") == Some(&Value::Bool(true)) {
            return; // sent only because we asked (CLAUDE_CODE_SDK_READS_SESSION_STATE)
        }
        if kind == "result" {
            *last_error = py::truthy(message.get("is_error")).then(|| message.clone());
        } else if !state_change {
            *last_error = None;
        }
        let _ = sender.send(Incoming::Message(message));
    }

    /// Answers one of the CLI's control requests (the SDK's `_handle_control_request`).
    fn answer(&self, message: &Value) {
        let Some(id) = message.get("request_id").and_then(Value::as_str) else {
            return;
        };
        lock(&self.inflight).insert(id.to_owned(), false);
        let empty = json!({});
        let outcome = self.control_reply(message.get("request").unwrap_or(&empty));
        let cancelled = lock(&self.inflight).remove(id).unwrap_or(false);
        if cancelled {
            return; // the CLI has given up on it
        }
        let response = match outcome {
            Ok(data) => {
                json!({"type": "control_response", "response": {"subtype": "success", "request_id": id, "response": data}})
            }
            Err(error) => {
                json!({"type": "control_response", "response": {"subtype": "error", "request_id": id, "error": error}})
            }
        };
        let _ = self.write(&response);
    }

    /// What a control request from the CLI gets: the response's data, or the error.
    pub(crate) fn control_reply(&self, request: &Value) -> Result<Value, String> {
        let subtype = request.get("subtype").map(py::str_of).unwrap_or_default();
        match subtype.as_str() {
            "can_use_tool" => Err("canUseTool callback is not provided".into()),
            "hook_callback" => Err(format!(
                "No hook callback found for ID: {}",
                request
                    .get("callback_id")
                    .map(py::str_of)
                    .unwrap_or_default()
            )),
            "mcp_message" => {
                let server = py::text(request.get("server_name"));
                let message = request.get("message").filter(|m| py::truthy(Some(m)));
                let (Some(server), Some(message)) = (server, message) else {
                    return Err("Missing server_name or message for MCP request".into());
                };
                // A notification gets no reply, but the request that carried it gets an ack.
                let reply = self
                    .mcp(server, message)
                    .unwrap_or_else(|| json!({"jsonrpc": "2.0", "result": {}}));
                Ok(json!({"mcp_response": reply}))
            }
            other => Err(format!("Unsupported control request subtype: {other}")),
        }
    }

    /// The in-process MCP servers (`create_sdk_mcp_server`'s): the JSON-RPC reply to a message
    /// for `server`, or None for a notification.
    pub(crate) fn mcp(&self, server: &str, message: &Value) -> Option<Value> {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let Some((_, tools)) = self.servers.iter().find(|(device, _)| device == server) else {
            return Some(json!({"jsonrpc": "2.0", "id": id,
                               "error": {"code": -32601, "message": format!("Server '{server}' not found")}}));
        };
        let method = message.get("method").and_then(Value::as_str);
        let (Some(method), true) = (method, message.get("id").is_some()) else {
            return None; // a notification (or a response)
        };
        let result = match method {
            "initialize" => {
                let asked = message
                    .get("params")
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(Value::as_str);
                let version = asked
                    .filter(|v| PROTOCOL_VERSIONS.contains(v))
                    .unwrap_or(LATEST_PROTOCOL);
                json!({"protocolVersion": version, "capabilities": {"tools": {"listChanged": false}},
                       "serverInfo": {"name": server, "version": "1.0.0"}})
            }
            "ping" => json!({}),
            "tools/list" => {
                let listed: Vec<Value> = tools
                    .iter()
                    .map(|t| {
                        let mut tool = Map::new();
                        for key in ["name", "description", "inputSchema"] {
                            if let Some(v) = t.get(key) {
                                tool.insert(key.into(), v.clone());
                            }
                        }
                        Value::Object(tool)
                    })
                    .collect();
                json!({"tools": listed})
            }
            "tools/call" => self.call(server, tools, message.get("params")),
            _ => {
                return Some(json!({"jsonrpc": "2.0", "id": id,
                                   "error": {"code": -32601, "message": "Method not found"}}))
            }
        };
        Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }

    /// A tool call from the model: run by the task whose turn this is.
    fn call(&self, device: &str, tools: &[Value], params: Option<&Value>) -> Value {
        let name = params
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let args = match params.and_then(|p| p.get("arguments")) {
            Some(a) if py::truthy(Some(a)) => a.clone(),
            _ => json!({}),
        };
        if !tools
            .iter()
            .any(|t| t.get("name").and_then(Value::as_str) == Some(name))
        {
            return error_result(&format!("Tool '{name}' not found"));
        }
        let Some(task) = self.task() else {
            return error_result("No task.");
        };
        let result = call_tool(&task, device, name, &args);
        json!({"content": convert_content(result.get("content")), "isError": py::truthy(result.get("isError"))})
    }

    /// Sends one message (the SDK transport's `write`).
    pub(crate) fn write(&self, message: &Value) -> Result<(), String> {
        let mut stdin = lock(&self.stdin);
        let Some(pipe) = stdin.as_mut() else {
            return Err("ProcessTransport is not ready for writing".into());
        };
        if let Some(code) = self.exit_code() {
            return Err(format!(
                "Cannot write to terminated process (exit code: {code})"
            ));
        }
        let line = py::dumps(message, true) + "\n";
        if let Err(e) = pipe.write_all(line.as_bytes()).and_then(|_| pipe.flush()) {
            *stdin = None;
            return Err(format!("Failed to write to process stdin: {e}"));
        }
        Ok(())
    }

    /// Sends a control request and waits up to `timeout` seconds for its response.
    pub(crate) fn request(&self, request: Value, timeout: f64) -> Result<Value, String> {
        let n = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let suffix = random_hex()
            .map(|h| h[..8].to_owned())
            .unwrap_or_else(|_| format!("{:08x}", n));
        let id = format!("req_{n}_{suffix}");
        let subtype = request.get("subtype").map(py::str_of).unwrap_or_default();
        let (reply, response) = mpsc::channel();
        lock(&self.pending).insert(id.clone(), reply);
        let sent =
            self.write(&json!({"type": "control_request", "request_id": id, "request": request}));
        if let Err(e) = sent {
            lock(&self.pending).remove(&id);
            return Err(e);
        }
        match response.recv_timeout(Duration::from_secs_f64(timeout)) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                lock(&self.pending).remove(&id);
                Err(format!("Control request timeout: {subtype}"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(ENDED.into()),
        }
    }

    /// Stops the turn under way (`client.interrupt()`; errors don't matter).
    fn interrupt(&self) {
        if self.ready.is_set() {
            let _ = self.request(json!({"subtype": "interrupt"}), 60.0);
        }
    }

    /// The next thing the CLI sent (End once it has exited).
    fn next(&self) -> Incoming {
        lock(&self.messages).recv().unwrap_or(Incoming::End)
    }

    /// Saves the conversation's identity the first time Claude gives it, and refuses another.
    pub(crate) fn remember_session(&self, value: Option<&Value>) -> Result<(), AgentError> {
        let Some(path) = &self.identity_path else {
            return Ok(());
        };
        let identity = value
            .and_then(Value::as_str)
            .and_then(canonical_uuid)
            .ok_or_else(|| AgentError::Resume("Claude returned an invalid session ID".into()))?;
        let mut saved = lock(&self.session_id);
        match saved.as_deref() {
            Some(known) if known != identity => Err(AgentError::Resume(
                "Claude session ID changed; refusing to replace the conversation".into(),
            )),
            Some(_) => Ok(()),
            None => {
                personal_agent_core::thread_identity::atomic_write_standard(
                    path,
                    format!("{identity}\n").as_bytes(),
                )
                .map_err(|e| AgentError::Os(e.to_string()))?;
                *saved = Some(identity);
                Ok(())
            }
        }
    }

    /// Its exit code (minus the signal, if one ended it), once it has exited.
    fn exit_code(&self) -> Option<i32> {
        use std::os::unix::process::ExitStatusExt;
        let mut child = lock(&self.child);
        let status = child.as_mut()?.try_wait().ok()??;
        Some(
            status
                .code()
                .unwrap_or_else(|| -status.signal().unwrap_or(0)),
        )
    }

    /// Waits up to `seconds` for it to exit; its exit code if it has.
    fn wait_exit(&self, seconds: f64) -> Option<i32> {
        let end = Instant::now() + Duration::from_secs_f64(seconds);
        loop {
            if let Some(code) = self.exit_code() {
                return Some(code);
            }
            if lock(&self.child).is_none() || Instant::now() >= end {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn signal(&self, signal: i32) {
        if self.exit_code().is_none() {
            if let Some(child) = lock(&self.child).as_ref() {
                // SAFETY: kill(2) on our own child's pid, which isn't reaped while we hold it.
                unsafe {
                    libc::kill(child.id() as i32, signal);
                }
            }
        }
    }

    /// Ends the process in the background: closes its input, then SIGTERM after 5 s and SIGKILL
    /// after 5 more (the SDK's `close`).
    pub(crate) fn close(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::spawn(move || {
            me.ready.wait(Some(120.0));
            me.closed.store(true, Ordering::SeqCst);
            lock(&me.stdin).take();
            if me.wait_exit(5.0).is_none() {
                me.signal(libc::SIGTERM);
                if me.wait_exit(5.0).is_none() {
                    me.signal(libc::SIGKILL);
                    me.wait_exit(5.0);
                }
            }
        });
    }
}

/// `_error_result_text`: the most telling text of an error result.
pub(crate) fn error_result_text(message: &Value) -> String {
    let errors: Vec<String> = match message.get("errors") {
        Some(Value::Array(errors)) => errors
            .iter()
            .map(py::str_of)
            .filter(|e| !py::strip(e).is_empty())
            .collect(),
        _ => Vec::new(),
    };
    if !errors.is_empty() {
        return errors.join("; ");
    }
    if let Some(result) = message
        .get("result")
        .and_then(Value::as_str)
        .filter(|r| !py::strip(r).is_empty())
    {
        return py::strip(result).to_owned();
    }
    if let Some(subtype) = py::text(message.get("subtype")).filter(|s| *s != "success") {
        return subtype.to_owned();
    }
    match message.get("api_error_status").filter(|s| !s.is_null()) {
        Some(status) => format!("API error (HTTP {})", py::str_of(status)),
        None => "unknown error".into(),
    }
}

fn error_result(text: &str) -> Value {
    json!({"content": [{"type": "text", "text": text}], "isError": true})
}

/// A tool result's content as MCP content (`_convert_tool_content`): text and images pass, links
/// and text resources become text, anything else is left out.
pub(crate) fn convert_content(content: Option<&Value>) -> Value {
    let items = content
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let field = |item: &Value, key: &str| item.get(key).cloned().unwrap_or(Value::Null);
    let mut out = Vec::new();
    for item in &items {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => out.push(json!({"type": "text", "text": field(item, "text")})),
            Some("image") => out.push(json!({"type": "image", "data": field(item, "data"),
                                              "mimeType": field(item, "mimeType")})),
            Some("resource_link") => {
                let parts: Vec<String> = ["name", "uri", "description"]
                    .iter()
                    .filter_map(|k| item.get(*k).filter(|v| py::truthy(Some(v))))
                    .map(py::str_of)
                    .collect();
                let text = if parts.is_empty() {
                    "Resource link".to_owned()
                } else {
                    parts.join("\n")
                };
                out.push(json!({"type": "text", "text": text}));
            }
            Some("resource") => {
                if let Some(text) = item.get("resource").and_then(|r| r.get("text")) {
                    out.push(json!({"type": "text", "text": text}));
                }
            }
            _ => {}
        }
    }
    Value::Array(out)
}

/// The `claude` executable: on PATH, else where npm, yarn or the installer put it.
pub(crate) fn find_cli(agent: &Agent) -> Result<String, String> {
    let path = agent
        .env
        .raw("PATH")
        .unwrap_or_else(|| "/bin:/usr/bin".into());
    if let Some(found) = path
        .split(':')
        .map(|dir| Path::new(if dir.is_empty() { "." } else { dir }).join("claude"))
        .find(|candidate| executable(candidate))
    {
        return Ok(found.display().to_string());
    }
    let home = agent
        .env
        .get("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(hive_common::paths::home);
    [
        home.join(".npm-global/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        home.join(".local/bin/claude"),
        home.join("node_modules/.bin/claude"),
        home.join(".yarn/bin/claude"),
        home.join(".claude/local/claude"),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .map(|p| p.display().to_string())
    .ok_or_else(|| NOT_FOUND.into())
}

// -- a request on Claude (ClaudeTask) -----------------------------------------------------------

/// What a [`CodexTask`] keeps for its Claude turn.
#[derive(Default)]
pub(crate) struct TaskPart {
    /// The process its turn is on (Python's `_conn`).
    conn: Mutex<Option<Arc<Conn>>>,
}

/// The id of the message being written (Python's `_message`).
#[derive(Default)]
struct Turn {
    message: String,
}

/// Runs a request (ClaudeTask's `_run`), on the task's own thread.
pub(crate) fn run(task: &CodexTask, look: bool) {
    let log = log_path(&task.agent.config.log);
    *lock(&task.log) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&log)
        .ok();
    task.log_write(&format!(
        "\n=== {}: {}  ({})\n",
        task.device(),
        task.task(),
        describe_model(&task.agent)
    ));
    let failed = |e: &dyn Display| format!("Claude: {e} (see {})", log.display());
    let tools = task.device_tools_for_task();
    *lock(&task.tools) = tools.clone();
    let content = prompt_with_look(task, look, &tools);
    if task.st().stopped {
        task.finish("failed", "stopped", None);
    } else {
        converse(task, content, &failed);
    }
    if let Some(mac) = tools.get("mac") {
        mac.close();
    }
    lock(&task.log).take();
}

fn converse(task: &CodexTask, mut content: Vec<Value>, failed: &dyn Fn(&dyn Display) -> String) {
    let Some(session) = task
        .session()
        .claude()
        .or_else(|| task.agent.claude_session())
    else {
        task.finish("failed", &failed(&"not a Claude conversation"), None);
        return;
    };
    let (conn, on_thread) = match session.acquire(&task.arc()) {
        Ok(acquired) => acquired,
        Err(e) => {
            task.finish("failed", &failed(&e), None);
            return;
        }
    };
    *lock(&task.claude.conn) = Some(conn.clone());
    task.set_on_thread(on_thread);
    let earlier = session.said_before(task, !on_thread);
    let text = content[0]["text"].as_str().unwrap_or("").to_owned();
    content[0]["text"] = json!(format!("{earlier}{text}"));
    task.time("codex");
    if let Err(e) = take_turn(task, &conn, Value::Array(content)) {
        task.finish("failed", &failed(&e), None);
    }
    task.done.wait(None);
    conn.release(task);
    if !on_thread {
        conn.close();
    }
}

/// The request's words, with the screenshot taken now (or as they started talking) attached.
fn prompt_with_look(
    task: &CodexTask,
    look: bool,
    tools: &HashMap<String, Arc<dyn ToolNamespace>>,
) -> Vec<Value> {
    let mut seen = None;
    if look {
        seen = task.ahead.as_ref().and_then(|a| a.seen());
        let ahead = seen.is_some();
        task.st().looked_ahead = ahead;
        if seen.is_none() {
            seen = tools
                .get(task.device())
                .and_then(|t| first_look(t.as_ref(), task.device() == "mac"));
        }
        task.time("look");
    }
    let mut content = vec![json!({"type": "text", "text": ""})];
    let mut attached = String::new();
    if let Some((image, about)) = seen {
        attached = format!(
            "\nAttached: a screenshot of the {} taken as they asked, in the same coordinates as its tools. {about}\n",
            prompts::device_name(task.device())
        );
        let (head, data) = image.split_once(',').unwrap_or((&image, ""));
        let mime = head.get(5..).unwrap_or("").split(';').next().unwrap_or("");
        content.push(json!({"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}}));
        let ahead = task.st().looked_ahead;
        task.event(
            "action",
            if ahead {
                "screenshot (taken as you started talking)"
            } else {
                "screenshot (attached to the request)"
            },
        );
    }
    let prompt = task.st().prompt.clone();
    content[0]["text"] = json!(format!("{prompt}{attached}{}", prompts::STEP_HINT));
    content
}

/// One turn: the request goes in, and what Claude sends is handled until its result.
fn take_turn(task: &CodexTask, conn: &Arc<Conn>, content: Value) -> Result<(), AgentError> {
    conn.wait_ready().map_err(AgentError::Codex)?;
    let _turn = lock(&conn.turn); // one turn at a time (a stopped one is over in a moment)
    if task.st().stopped {
        task.finish("failed", "stopped", None);
        return Ok(());
    }
    let system = format!("{}\n\n{}", task.agent.instructions()?, prompts::RULES);
    task.record_context(
        "Claude request",
        &json!({"system_prompt": system, "content": content}),
    );
    conn.write(
        &json!({"type": "user", "message": {"role": "user", "content": content},
                        "parent_tool_use_id": null, "session_id": "default"}),
    )
    .map_err(AgentError::Codex)?;
    task.event("doing", "Thinking");
    let mut turn = Turn::default();
    loop {
        match conn.next() {
            Incoming::Message(m) => {
                if handle(task, conn, &m, &mut turn)? {
                    return Ok(());
                }
            }
            Incoming::Error(e) => return Err(AgentError::Codex(e)),
            Incoming::End => return Err(AgentError::Codex(ENDED.into())),
        }
    }
}

/// One message from Claude (ClaudeTask's `_handle`); true for the turn's result.
fn handle(task: &CodexTask, conn: &Conn, m: &Value, turn: &mut Turn) -> Result<bool, AgentError> {
    let kind = m.get("type").and_then(Value::as_str).unwrap_or("");
    if kind != "stream_event" {
        if let Some((name, fields)) = as_dataclass(m) {
            task.record_context(name, &fields);
        }
    }
    match kind {
        "system" => {
            if m.get("subtype").and_then(Value::as_str) == Some("init") {
                conn.remember_session(m.get("session_id"))?;
            }
        }
        "stream_event" => stream_event(task, m, turn),
        "assistant" => assistant(task, m, turn),
        "user" => tool_results(task, m),
        "result" => {
            result(task, conn, m)?;
            return Ok(true);
        }
        _ => {}
    }
    Ok(false)
}

fn stream_event(task: &CodexTask, m: &Value, turn: &mut Turn) {
    if py::truthy(m.get("parent_tool_use_id")) || task.st().stopped {
        return;
    }
    let empty = json!({});
    let e = m.get("event").unwrap_or(&empty);
    let field = |key: &str| e.get(key).filter(|v| py::truthy(Some(v))).unwrap_or(&empty);
    match e.get("type").and_then(Value::as_str) {
        Some("message_start") => {
            turn.message = field("message")
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let mut s = task.st();
            s.model_calls += 1;
            s.written.insert(turn.message.clone(), String::new());
        }
        Some("content_block_start")
            if field("content_block").get("type").and_then(Value::as_str) == Some("tool_use") =>
        {
            let name = field("content_block")
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let tool = name.rsplit("__").next().unwrap_or(name);
            task.event("doing", &doing(&json!({"tool": tool, "arguments": {}})));
        }
        Some("content_block_delta")
            if field("delta").get("type").and_then(Value::as_str) == Some("text_delta") =>
        {
            let delta = field("delta")
                .get("text")
                .map(py::str_of)
                .unwrap_or_default();
            let text = {
                let mut s = task.st();
                let written = s.written.entry(turn.message.clone()).or_default();
                written.push_str(&delta);
                written.clone()
            };
            task.speak(&turn.message, &text, false);
        }
        _ => {}
    }
}

fn assistant(task: &CodexTask, m: &Value, turn: &Turn) {
    let empty = json!({});
    let message = m.get("message").unwrap_or(&empty);
    let blocks = message
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let block_text = |b: &Value| b.get("text").map(py::str_of).unwrap_or_default();
    let is_text = |b: &&Value| b.get("type").and_then(Value::as_str) == Some("text");
    let error = m.get("error").filter(|e| py::truthy(Some(e)));
    if let Some(error) = error {
        let texts: Vec<String> = blocks.iter().filter(is_text).map(block_text).collect();
        let joined = texts.join(" ");
        let shown = py::chars(&joined, 300);
        let text = if shown.is_empty() {
            py::str_of(error)
        } else {
            shown.to_owned()
        };
        task.event("error", &text);
    }
    let mut texts = Vec::new();
    for b in &blocks {
        match b.get("type").and_then(Value::as_str) {
            Some("tool_use") => {
                let name = b.get("name").and_then(Value::as_str).unwrap_or("");
                let (device, tool) = match name.strip_prefix("mcp__") {
                    Some(rest) => rest.split_once("__").unwrap_or((rest, "")),
                    None => ("", name),
                };
                let item = json!({"tool": tool, "namespace": device,
                                  "arguments": b.get("input").cloned().unwrap_or(Value::Null)});
                task.event(
                    "action",
                    &describe_call(&item, task.agent.hooks.knowledge.as_ref()),
                );
                task.event("doing", &doing(&item));
                announce(task, &item);
                if name == "Bash" {
                    // The shell doesn't need the mouse: the user can have it meanwhile.
                    if let Some(mac) = task.device_tool("mac") {
                        std::thread::spawn(move || mac.let_go());
                    }
                }
            }
            Some("text") => texts.push(block_text(b)),
            _ => {}
        }
    }
    let text = py::strip(&texts.concat()).to_owned();
    if !text.is_empty() && error.is_none() {
        task.st().final_ = Some(text.clone());
        let stopped = task.st().stopped;
        if !stopped {
            let id = py::text(message.get("id"))
                .unwrap_or(&turn.message)
                .to_owned();
            task.speak(&id, &text, true);
        }
    }
}

/// A step that can't be undone, said aloud as it happens (when the user's words allow it).
fn announce(task: &CodexTask, item: &Value) {
    let empty = json!({});
    let arguments = match item.get("arguments") {
        Some(v) if py::truthy(Some(v)) => v,
        _ => &empty,
    };
    let step = match arguments.get("step") {
        Some(v) if py::truthy(Some(v)) => py::strip(&py::str_of(v)).to_owned(),
        _ => String::new(),
    };
    if step.to_lowercase().starts_with("one-way")
        && hive_common::mcp::check_step(arguments, &task.words()).is_none()
    {
        let said = step.split_once(':').map(|(_, rest)| rest).unwrap_or(&step);
        task.event("announce", py::strip(said));
    }
}

fn tool_results(task: &CodexTask, m: &Value) {
    let Some(blocks) = m
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for b in blocks {
        if b.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        if py::truthy(b.get("is_error")) {
            let body = match b.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(items)) => items
                    .iter()
                    .filter(|c| c.is_object())
                    .map(|c| c.get("text").map(py::str_of).unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => String::new(),
            };
            let shown = py::chars(&body, 300);
            task.event("error", if shown.is_empty() { "failed" } else { shown });
        }
        task.event("doing", "Thinking");
    }
}

fn result(task: &CodexTask, conn: &Conn, m: &Value) -> Result<(), AgentError> {
    conn.remember_session(m.get("session_id"))?;
    let wrote = m
        .get("usage")
        .and_then(|u| u.get("output_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let (stopped, final_) = {
        let mut s = task.st();
        s.wrote = wrote;
        (s.stopped, s.final_.clone().filter(|f| !f.is_empty()))
    };
    let result = py::text(m.get("result")).map(str::to_owned);
    if stopped {
        task.finish("failed", "stopped", None);
    } else if py::truthy(m.get("is_error")) {
        let text = result
            .or(final_)
            .unwrap_or_else(|| m.get("subtype").map(py::str_of).unwrap_or_default());
        task.finish("failed", py::chars(&text, 300), None);
    } else {
        let text = final_.or(result).unwrap_or_else(|| "Done.".into());
        task.finish("done", &text, None);
    }
    Ok(())
}

/// A tool call from Claude (ClaudeTask's `_call_tool`): the device's tools run it here, and the
/// context inspector gets what went in and what came out.
pub(crate) fn call_tool(task: &CodexTask, device: &str, name: &str, args: &Value) -> Value {
    task.record_context(
        "Claude tool input",
        &json!({"namespace": device, "tool": name, "arguments": args}),
    );
    let tools = task.device_tool(device);
    let stopped = task.st().stopped;
    let result = match tools {
        _ if stopped => error_result("Stopped by the user."),
        None => error_result(&format!("There are no {device} tools.")),
        Some(tools) => {
            let call =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tools.call(name, args)))
                    .unwrap_or_else(|panic| Err(panic_text(&*panic)));
            let result = match call {
                Ok(result) => result,
                Err(error) => error_result(&format!("Failed: {error}")),
            };
            let ok = result.get("isError") != Some(&Value::Bool(true));
            task.record_action(device, name, args, ok);
            result
        }
    };
    task.record_context("Claude tool output", &result);
    result
}

/// Stops the turn (ClaudeTask's `stop`): Claude Code is interrupted, and it ends now.
pub(crate) fn stop(task: &CodexTask) {
    task.st().stopped = true;
    let conn = lock(&task.claude.conn).clone();
    if let Some(conn) = conn.filter(|c| c.serves(task)) {
        std::thread::spawn(move || conn.interrupt());
    }
    task.st().final_ = None;
    task.finish("failed", "stopped", None);
}

/// The SDK's message type for a message from the CLI and its fields (`type(m).__name__` and
/// `asdict(m)`, which the context inspector records); None for one the SDK skips.
pub(crate) fn as_dataclass(m: &Value) -> Option<(&'static str, Value)> {
    let get = |key: &str| m.get(key).cloned().unwrap_or(Value::Null);
    let empty = json!({});
    let message = m.get("message").unwrap_or(&empty);
    let inner = |key: &str| message.get(key).cloned().unwrap_or(Value::Null);
    let origin = || match m.get("origin") {
        Some(o) if o.get("kind").is_some_and(Value::is_string) => o.clone(),
        _ => Value::Null,
    };
    Some(match m.get("type").and_then(Value::as_str)? {
        "user" => {
            let content = match message.get("content") {
                Some(Value::Array(blocks)) => {
                    Value::Array(blocks.iter().filter_map(block).collect())
                }
                other => other.cloned().unwrap_or(Value::Null),
            };
            (
                "UserMessage",
                json!({"content": content, "uuid": get("uuid"), "parent_tool_use_id": get("parent_tool_use_id"),
                       "tool_use_result": get("tool_use_result"), "origin": origin()}),
            )
        }
        "assistant" => {
            let content: Vec<Value> = message
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| blocks.iter().filter_map(block).collect())
                .unwrap_or_default();
            (
                "AssistantMessage",
                json!({"content": content, "model": inner("model"), "parent_tool_use_id": get("parent_tool_use_id"),
                       "error": get("error"), "usage": inner("usage"), "message_id": inner("id"),
                       "stop_reason": inner("stop_reason"), "session_id": get("session_id"), "uuid": get("uuid")}),
            )
        }
        "system" => {
            let subtype = get("subtype");
            let name = match subtype.as_str() {
                Some("hook_started" | "hook_response") => {
                    let event = ["hook_event", "hook_name", "hook_event_name"]
                        .iter()
                        .find_map(|k| m.get(*k).filter(|v| py::truthy(Some(v))))
                        .cloned()
                        .unwrap_or_else(|| json!(""));
                    return Some((
                        "HookEventMessage",
                        json!({"subtype": subtype, "hook_event_name": event, "data": m,
                               "session_id": get("session_id"), "uuid": get("uuid")}),
                    ));
                }
                Some("task_started") => "TaskStartedMessage",
                Some("task_progress") => "TaskProgressMessage",
                Some("task_notification") => "TaskNotificationMessage",
                Some("task_updated") => "TaskUpdatedMessage",
                Some("mirror_error") => "MirrorErrorMessage",
                _ => "SystemMessage",
            };
            (name, json!({"subtype": subtype, "data": m}))
        }
        "result" => {
            let deferred = match m.get("deferred_tool_use") {
                Some(d) if py::truthy(Some(d)) => {
                    json!({"id": d.get("id"), "name": d.get("name"), "input": d.get("input")})
                }
                _ => Value::Null,
            };
            (
                "ResultMessage",
                json!({"subtype": get("subtype"), "duration_ms": get("duration_ms"),
                       "duration_api_ms": get("duration_api_ms"), "is_error": get("is_error"),
                       "num_turns": get("num_turns"), "session_id": get("session_id"),
                       "stop_reason": get("stop_reason"), "total_cost_usd": get("total_cost_usd"),
                       "usage": get("usage"), "result": get("result"),
                       "structured_output": get("structured_output"), "model_usage": get("modelUsage"),
                       "permission_denials": get("permission_denials"), "deferred_tool_use": deferred,
                       "errors": get("errors"), "api_error_status": get("api_error_status"),
                       "uuid": get("uuid"), "terminal_reason": get("terminal_reason"), "origin": origin()}),
            )
        }
        "rate_limit_event" => {
            let info = m.get("rate_limit_info").unwrap_or(&empty);
            let i = |key: &str| info.get(key).cloned().unwrap_or(Value::Null);
            (
                "RateLimitEvent",
                json!({"rate_limit_info": {"status": i("status"), "resets_at": i("resetsAt"),
                                           "rate_limit_type": i("rateLimitType"), "utilization": i("utilization"),
                                           "overage_status": i("overageStatus"), "overage_resets_at": i("overageResetsAt"),
                                           "overage_disabled_reason": i("overageDisabledReason"), "raw": info},
                       "uuid": get("uuid"), "session_id": get("session_id")}),
            )
        }
        "conversation_reset" => (
            "ConversationResetMessage",
            json!({"new_conversation_id": get("new_conversation_id"), "uuid": get("uuid"),
                   "session_id": get("session_id")}),
        ),
        _ => return None,
    })
}

/// A content block as its dataclass's fields (TextBlock, ToolUseBlock, ...).
fn block(b: &Value) -> Option<Value> {
    let f = |key: &str| b.get(key).cloned().unwrap_or(Value::Null);
    Some(match b.get("type").and_then(Value::as_str)? {
        "text" => json!({"text": f("text")}),
        "thinking" => json!({"thinking": f("thinking"), "signature": f("signature")}),
        "tool_use" | "server_tool_use" => {
            json!({"id": f("id"), "name": f("name"), "input": f("input")})
        }
        "tool_result" => {
            json!({"tool_use_id": f("tool_use_id"), "content": f("content"), "is_error": f("is_error")})
        }
        "advisor_tool_result" => json!({"tool_use_id": f("tool_use_id"), "content": f("content")}),
        _ => return None,
    })
}
