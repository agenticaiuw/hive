//! A connection to `codex app-server` (python/codex_app.py): the server the Codex app and its IDE
//! extensions use, signed in with your ChatGPT account, so it runs on your Codex subscription. The
//! agent keeps one running the whole time, with a thread on it for each conversation and a turn for
//! each request, which beats `codex exec` because
//! - our own few lines of instructions replace Codex's coding-agent system prompt,
//! - the model gets our Mac and iPhone tools directly, and calls back into this process to use them
//!   (no MCP server in between),
//! - nothing starts up per task, and the prompt cache stays warm from one task to the next.
//!
//! The protocol is JSON-RPC, one message per line on stdin/stdout (`codex app-server
//! generate-json-schema` describes it). When `build/hive-app-server-transport` is there, the
//! server runs under it: it forwards the bytes and kills Codex if this process goes away.

use crate::util::{lock, panic_text, AgentError, Env};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A thread's notifications: `(method, params)`, and `("exited", {"code"})` if the server stops.
pub type OnMessage = Arc<dyn Fn(&str, &Value) + Send + Sync>;
/// Answers the server's tool calls (`item/tool/call` params) with a dynamic-tool reply.
pub type OnToolCall = Arc<dyn Fn(&Value) -> Value + Send + Sync>;

/// Python's default `AppServer.request` timeout, in seconds.
pub const DEFAULT_TIMEOUT: f64 = 60.0;

/// What the driver needs from an app-server; [`AppServer`] is the real one (the tests use fakes).
pub trait Server: Send + Sync {
    /// A JSON-RPC request; the `result`, or `AgentError::Codex` for an error reply, no reply
    /// within `timeout` seconds, or a server that stopped.
    fn request(&self, method: &str, params: Value, timeout: f64) -> Result<Value, AgentError>;
    /// Routes a thread's notifications and tool calls to these handlers.
    fn attach(&self, thread: &str, on_message: OnMessage, on_tool_call: OnToolCall);
    fn detach(&self, thread: &str);
    /// The process is still running.
    fn alive(&self) -> bool;
    fn close(&self) {}
}

/// Whether two handles are the same server (Python's `is`).
pub fn same_server(a: &Arc<dyn Server>, b: &Arc<dyn Server>) -> bool {
    std::ptr::eq(Arc::as_ptr(a) as *const (), Arc::as_ptr(b) as *const ())
}

type Waiter = Sender<Option<Value>>;

pub struct AppServer {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, Waiter>>,
    threads: Mutex<HashMap<String, (OnMessage, OnToolCall)>>,
    next: AtomicU64,
    rust_transport: bool,
}

impl AppServer {
    /// Starts `command` (under `transport`, when given), initializes it and returns once Codex
    /// has answered. `stderr`: where its log goes. `env`: the agent's environment overrides.
    pub fn start(
        command: &[String],
        transport: Option<&Path>,
        stderr: Option<File>,
        cwd: Option<&Path>,
        env: &Env,
    ) -> Result<Arc<AppServer>, AgentError> {
        let mut argv: Vec<String> = Vec::new();
        if let Some(t) = transport {
            argv.push(t.to_string_lossy().into_owned());
        }
        argv.extend(command.iter().cloned());
        let (program, args) = argv
            .split_first()
            .ok_or_else(|| AgentError::Os("No command".into()))?;
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped());
        cmd.stderr(match stderr {
            Some(file) => Stdio::from(file),
            None => Stdio::inherit(),
        });
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        env.apply(&mut cmd);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // start_new_session=True: Codex and its children are a group of their own.
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::Os("No server output".into()))?;
        let server = Arc::new(AppServer {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            threads: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
            rust_transport: transport.is_some(),
        });
        let reader = server.clone();
        std::thread::spawn(move || reader.read(stdout));
        server.request(
            "initialize",
            json!({"clientInfo": {"name": "personal-agent", "title": "personal-agent voice agent",
                                  "version": "1.0"},
                   "capabilities": {"experimentalApi": true}}), // dynamicTools is experimental
            crate::app_server::DEFAULT_TIMEOUT,
        )?;
        server.notify("initialized", None)?;
        Ok(server)
    }

    /// `build/hive-app-server-transport`, if it's been built.
    pub fn transport() -> Option<PathBuf> {
        let path = hive_common::build_dir().join("hive-app-server-transport");
        executable(&path).then_some(path)
    }

    pub fn notify(&self, method: &str, params: Option<Value>) -> Result<(), AgentError> {
        let mut msg = json!({"method": method});
        if let Some(p) = params {
            msg["params"] = p;
        }
        self.send(&msg)
    }

    fn send(&self, msg: &Value) -> Result<(), AgentError> {
        let mut stdin = lock(&self.stdin);
        let pipe = stdin.as_mut().ok_or_else(|| {
            AgentError::Codex("Codex isn't running (I/O operation on closed file.)".into())
        })?;
        let line = format!("{msg}\n");
        pipe.write_all(line.as_bytes())
            .and_then(|_| pipe.flush())
            .map_err(|e| AgentError::Codex(format!("Codex isn't running ({e})")))
    }

    fn read(self: Arc<Self>, stdout: std::process::ChildStdout) {
        let mut lines = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match lines.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Ok(msg) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if msg.get("method").is_none() {
                // The answer to one of our requests.
                let id = msg.get("id").and_then(Value::as_u64);
                if let Some(waiter) = id.and_then(|id| lock(&self.pending).remove(&id)) {
                    let _ = waiter.send(Some(msg));
                }
            } else if msg.get("id").is_some() {
                // Codex asks us something: each on its own thread, since tools can take a while.
                let me = self.clone();
                std::thread::spawn(move || me.answer(msg));
            } else {
                let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
                let thread = params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let handlers = lock(&self.threads).get(thread).cloned();
                if let Some((on_message, _)) = handlers {
                    let method = msg["method"].as_str().unwrap_or_default();
                    on_message(method, &params);
                }
            }
        }
        let code = loop {
            // (Not wait() under the lock: alive() must keep answering meanwhile.)
            match lock(&self.child).try_wait() {
                Ok(Some(status)) => break exit_code(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(_) => break -1,
            }
        };
        for (_, waiter) in lock(&self.pending).drain() {
            let _ = waiter.send(None);
        }
        let handlers: Vec<OnMessage> = lock(&self.threads).values().map(|h| h.0.clone()).collect();
        for on_message in handlers {
            on_message("exited", &json!({"code": code}));
        }
    }

    fn answer(&self, msg: Value) {
        let method = msg
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        let thread = params
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let handlers = lock(&self.threads).get(thread).cloned();
        let mut reply = json!({"id": msg["id"]});
        if method == "item/tool/call" && handlers.is_some() {
            let on_tool_call = handlers.map(|h| h.1).expect("checked");
            reply["result"] = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                on_tool_call(&params)
            })) {
                Ok(result) => result,
                // A tool that crashed: tell the model rather than leave it waiting.
                Err(panic) => hive_common::tools::reply_text(
                    false,
                    format!("Failed: {}", panic_text(&*panic)),
                ),
            };
        } else if method == "currentTime/read" {
            reply["result"] = json!({"currentTimeAt": crate::util::unix_time() as i64});
        } else if method.ends_with("requestApproval") {
            // The agent has no shell or file edits to approve.
            reply["result"] = json!({"decision": "decline"});
        } else {
            reply["error"] =
                json!({"code": -32601, "message": format!("{method} isn't supported here")});
        }
        let _ = self.send(&reply);
    }
}

impl Server for AppServer {
    fn request(&self, method: &str, params: Value, timeout: f64) -> Result<Value, AgentError> {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = channel();
        lock(&self.pending).insert(id, tx);
        if let Err(e) = self.send(&json!({"id": id, "method": method, "params": params})) {
            lock(&self.pending).remove(&id);
            return Err(e);
        }
        let reply = match rx.recv_timeout(Duration::from_secs_f64(timeout.max(0.0))) {
            Ok(reply) => reply,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                lock(&self.pending).remove(&id);
                return Err(AgentError::Codex(format!(
                    "{method}: no answer from Codex in {timeout:.0} s"
                )));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => None,
        };
        let Some(reply) = reply else {
            return Err(AgentError::Codex(format!("{method}: Codex stopped")));
        };
        if let Some(error) = reply.get("error") {
            let message = match error.get("message") {
                Some(Value::String(m)) => m.clone(),
                Some(other) => crate::py::str_of(other),
                None => crate::py::str_of(error),
            };
            return Err(AgentError::Codex(format!("{method}: {message}")));
        }
        Ok(match reply.get("result") {
            Some(r) if crate::py::truthy(Some(r)) => r.clone(),
            _ => json!({}),
        })
    }

    fn attach(&self, thread: &str, on_message: OnMessage, on_tool_call: OnToolCall) {
        lock(&self.threads).insert(thread.to_owned(), (on_message, on_tool_call));
    }

    fn detach(&self, thread: &str) {
        lock(&self.threads).remove(thread);
    }

    fn alive(&self) -> bool {
        matches!(lock(&self.child).try_wait(), Ok(None))
    }

    /// Ends it: it exits when its input ends; killed (with its group, under the transport) if it
    /// hasn't in 3 seconds.
    fn close(&self) {
        lock(&self.stdin).take();
        for _ in 0..300 {
            if !self.alive() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let mut child = lock(&self.child);
        if self.rust_transport {
            unsafe {
                libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
            }
        } else {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

/// Python's `returncode`: the exit code, or minus the signal that ended it.
fn exit_code(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return -signal;
        }
    }
    status.code().unwrap_or(-1)
}

pub(crate) fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}
