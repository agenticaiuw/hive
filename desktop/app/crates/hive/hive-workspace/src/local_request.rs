//! The private request socket of the already-running agent (python/local_request.py, whose live
//! implementation was the `agent-local-requests` helper process): other programs send one JSON
//! line `{"text", "sourceId", "resume_goal", "goal_objective"}` to
//! `<state>/control/request.sock` and get one JSON line back. The protocol is unchanged, byte for
//! byte. Here the server runs inside the agent, in threads.
//!
//! - [`LocalRequests`]: `request.sock`. Every accepted request is first made durable in the request
//!   ledger (agent-core), then handed to the host as a [`LocalRequest`] to reply to within 5
//!   seconds; the reply gets `receiptId` and `status` added.
//! - [`WorkspaceSocket`]: `workspace.sock`, the virtual workspace's tool socket, same framing, 50 s.

use personal_agent_core::request_ledger;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// A request line (with its newline) may not be longer than this.
pub const MAX_REQUEST_BYTES: u64 = 16384;
/// A request must start within this long of arriving, as python's `deadline`.
pub const START_WITHIN: Duration = Duration::from_secs(4);
const REPLY_WITHIN: Duration = Duration::from_secs(5);
const WORKSPACE_WITHIN: Duration = Duration::from_secs(50);

/// One request from another program, python's `("local_request", (text, reply, deadline,
/// resume_goal, goal_objective, receipt_id))` event. Answer it with [`LocalRequest::reply`]
/// (`{"ok": true}`, or `{"ok": false, "error": ...}`) before `deadline` has long passed; the host
/// checks `deadline` itself before starting work (voice_agent.py `on_local_request`).
pub struct LocalRequest {
    /// The text, trimmed.
    pub text: String,
    pub resume_goal: bool,
    /// Only with `resume_goal`: the goal's new objective, as sent.
    pub goal_objective: Option<String>,
    /// The durable receipt of the request (`ingress_receipt` of `on_transcript`).
    pub receipt_id: Option<String>,
    /// `Instant::now() + 4 s` when the request arrived.
    pub deadline: Instant,
    reply: SyncSender<Value>,
}

impl LocalRequest {
    pub fn reply(&self, value: Value) {
        let _ = self.reply.try_send(value);
    }
}

type Handle = Arc<dyn Fn(UnixStream) + Send + Sync>;

/// A listening unix socket and its accept thread.
struct Endpoint {
    path: PathBuf,
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn bind(directory: &Path, name: &str) -> Result<(UnixListener, PathBuf, u64), String> {
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let path = directory.join(name);
    match fs::symlink_metadata(&path) {
        Ok(info) => {
            // SAFETY: getuid has no preconditions.
            if !info.file_type().is_socket() || info.uid() != unsafe { libc::getuid() } {
                return Err("Refusing to replace an unexpected request socket path".into());
            }
            match UnixStream::connect(&path) {
                Ok(_) => return Err("Another personal-agent request channel is active".into()),
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                    fs::remove_file(&path).map_err(|e| e.to_string())?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    let inode = fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?
        .ino();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok((listener, path, inode))
}

impl Endpoint {
    fn start(
        directory: &Path,
        name: &str,
        thread_name: &str,
        handle: Handle,
    ) -> Result<Endpoint, String> {
        let (listener, path, inode) = bind(directory, name)?;
        let stop = Arc::new(AtomicBool::new(false));
        let (flag, own_path) = (stop.clone(), path.clone());
        let thread = thread::Builder::new()
            .name(thread_name.into())
            .spawn(move || {
                while !flag.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            // macOS can inherit O_NONBLOCK from the listener; accepted clients
                            // need blocking reads so fragmented requests are not rejected.
                            if stream.set_nonblocking(false).is_err() {
                                continue;
                            }
                            let handle = handle.clone();
                            thread::spawn(move || handle(stream));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20))
                        }
                        Err(_) => break,
                    }
                }
                // Remove only our own socket: a replacement at the path is not ours.
                if fs::symlink_metadata(&own_path)
                    .map(|m| m.ino() == inode)
                    .unwrap_or(false)
                {
                    let _ = fs::remove_file(&own_path);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Endpoint {
            path,
            stop,
            thread: Mutex::new(Some(thread)),
        })
    }

    fn close(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.lock().unwrap().take() {
            let _ = thread.join();
        }
    }
}

fn rejected() -> Value {
    json!({"ok": false, "error": "Request not accepted; check agent availability."})
}

/// The request line: up to a newline, never more than [`MAX_REQUEST_BYTES`] including it.
fn read_line(stream: &UnixStream, timeout: Duration) -> Option<Value> {
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let mut bytes = Vec::new();
    BufReader::new(stream)
        .take(MAX_REQUEST_BYTES + 1)
        .read_until(b'\n', &mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES || !bytes.ends_with(b"\n") {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn answer(mut stream: UnixStream, result: Value) {
    if let Ok(mut bytes) = serde_json::to_vec(&result) {
        bytes.push(b'\n');
        let _ = stream.write_all(&bytes);
    }
}

fn unknown_outcome(receipt: &str) -> Value {
    json!({"ok": false, "status": "unknown", "receiptId": receipt,
           "error": "Request outcome unknown; no repeat was started."})
}

fn local_request(
    stream: UnixStream,
    directory: &Path,
    host: &(dyn Fn(LocalRequest) + Send + Sync),
) {
    let result = (|| -> Option<Value> {
        let request = read_line(&stream, REPLY_WITHIN)?;
        let text = request.get("text")?.as_str()?.trim();
        if text.is_empty() {
            return None;
        }
        let resume = match request.get("resume_goal") {
            None => false,
            Some(Value::Bool(v)) => *v,
            _ => return None,
        };
        let objective = match request.get("goal_objective") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if resume && !s.trim().is_empty() => Some(s.as_str()),
            _ => return None,
        };
        let source = match request.get("sourceId") {
            None => None,
            Some(Value::String(s)) => Some(s.as_str()),
            _ => return None,
        };
        // The durable dispatching state is committed before the host hears of the request.
        let saved = request_ledger::admit(directory, source, text, objective).ok()?;
        if saved.duplicate {
            return Some(
                json!({"ok": false, "status": saved.status, "receiptId": saved.id,
                               "error": "Request already received; no repeat was started."}),
            );
        }
        let receipt = saved.id;
        let (reply, answered) = mpsc::sync_channel(1);
        let event = LocalRequest {
            text: text.to_string(),
            resume_goal: resume,
            goal_objective: objective.map(str::to_string),
            receipt_id: Some(receipt.clone()),
            deadline: Instant::now() + START_WITHIN,
            reply,
        };
        let delivered = catch_unwind(AssertUnwindSafe(|| host(event))).is_ok();
        let mut reply = if delivered {
            match answered.recv_timeout(REPLY_WITHIN) {
                Ok(value) => Some(value),
                Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => None,
            }
        } else {
            None
        };
        let refusal = reply
            .as_ref()
            .and_then(|v| v.get("error"))
            .and_then(Value::as_str);
        let status = match reply
            .as_ref()
            .and_then(|v| v.get("ok"))
            .and_then(Value::as_bool)
        {
            Some(true) => "accepted",
            Some(false)
                if matches!(
                    refusal,
                    Some("The request expired before it could start.")
                        | Some("The personal-agent is already working.")
                ) =>
            {
                "rejected"
            }
            _ => "unknown",
        };
        if request_ledger::finish(directory, &receipt, status).is_err() {
            return Some(unknown_outcome(&receipt));
        }
        match reply {
            Some(Value::Object(ref mut object)) => {
                object.insert("receiptId".into(), json!(receipt));
                object.insert("status".into(), json!(status));
            }
            _ => reply = Some(unknown_outcome(&receipt)),
        }
        reply
    })()
    .unwrap_or_else(rejected);
    answer(stream, result);
}

/// `request.sock`: requests from other programs.
pub struct LocalRequests {
    endpoint: Endpoint,
}

impl LocalRequests {
    /// Serves `<directory>/request.sock`, sending each request to `requests` (python's events
    /// queue). Errors: the path is not ours to replace, or another agent already listens on it.
    pub fn start(
        directory: &Path,
        requests: Sender<LocalRequest>,
    ) -> Result<LocalRequests, String> {
        let requests = Mutex::new(requests);
        LocalRequests::start_with(
            directory,
            Arc::new(move |request| {
                let _ = requests.lock().unwrap().send(request);
            }),
        )
    }

    /// As [`start`](Self::start), calling `host` on the connection's thread for each request. It
    /// should hand the request on and return; the reply is given to [`LocalRequest::reply`] later.
    pub fn start_with(
        directory: &Path,
        host: Arc<dyn Fn(LocalRequest) + Send + Sync>,
    ) -> Result<LocalRequests, String> {
        let ledger = directory.to_path_buf();
        let handle: Handle = Arc::new(move |stream| local_request(stream, &ledger, host.as_ref()));
        Ok(LocalRequests {
            endpoint: Endpoint::start(
                directory,
                "request.sock",
                "personal-agent-local-requests",
                handle,
            )?,
        })
    }

    pub fn path(&self) -> &Path {
        &self.endpoint.path
    }

    /// Stops listening and removes the socket, unless something else replaced it.
    pub fn close(&self) {
        self.endpoint.close();
    }
}

impl Drop for LocalRequests {
    fn drop(&mut self) {
        self.endpoint.close();
    }
}

/// `workspace.sock`: the virtual workspace's tool socket. The handler gets each request object
/// and returns the reply (`{"ok": true, "result": ...}` or `{"ok": false, "error": ...}`).
pub struct WorkspaceSocket {
    endpoint: Endpoint,
}

impl WorkspaceSocket {
    pub fn start(
        directory: &Path,
        handler: Arc<dyn Fn(Value) -> Value + Send + Sync>,
    ) -> Result<WorkspaceSocket, String> {
        let handle: Handle = Arc::new(move |stream| {
            let result = (|| {
                let request = read_line(&stream, WORKSPACE_WITHIN)?;
                if !request.is_object() {
                    return None;
                }
                catch_unwind(AssertUnwindSafe(|| handler(request))).ok()
            })()
            .unwrap_or_else(rejected);
            answer(stream, result);
        });
        Ok(WorkspaceSocket {
            endpoint: Endpoint::start(
                directory,
                "workspace.sock",
                "personal-agent-workspace-socket",
                handle,
            )?,
        })
    }

    pub fn path(&self) -> &Path {
        &self.endpoint.path
    }

    pub fn close(&self) {
        self.endpoint.close();
    }
}

impl Drop for WorkspaceSocket {
    fn drop(&mut self) {
        self.endpoint.close();
    }
}

/// A convenience for the host's event loop: the receiving end of [`LocalRequests::start`].
pub fn channel() -> (Sender<LocalRequest>, Receiver<LocalRequest>) {
    mpsc::channel()
}
