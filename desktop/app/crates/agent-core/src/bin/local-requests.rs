#[cfg(unix)]
mod unix {
    use personal_agent_core::request_ledger;
    use serde_json::{json, Value};
    use std::{
        collections::HashMap,
        env, fs,
        io::{self, BufRead, BufReader, Read, Write},
        os::unix::{
            fs::{FileTypeExt, MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            mpsc, Arc, Mutex,
        },
        thread,
        time::Duration,
    };
    const MAX: u64 = 16384;
    type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>;
    fn emit(value: &Value) -> io::Result<()> {
        let mut out = io::stdout().lock();
        serde_json::to_writer(&mut out, value)?;
        writeln!(out)?;
        out.flush()
    }
    fn rejected() -> Value {
        json!({"ok": false, "error":"Request not accepted; check agent availability."})
    }
    fn handle(
        mut stream: UnixStream,
        pending: Pending,
        next: Arc<AtomicU64>,
        workspace: bool,
        directory: Arc<PathBuf>,
    ) {
        let timeout = Duration::from_secs(if workspace { 50 } else { 5 });
        let _ = stream.set_read_timeout(Some(timeout));
        let _ = stream.set_write_timeout(Some(timeout));
        let result = (|| -> Option<Value> {
            let mut bytes = Vec::new();
            BufReader::new(&stream).take(MAX + 1).read_until(b'\n', &mut bytes).ok()?;
            if bytes.len() as u64 > MAX || !bytes.ends_with(b"\n") { return None; }
            let request: Value = serde_json::from_slice(&bytes).ok()?;
            let id = next.fetch_add(1, Ordering::Relaxed);
            let mut receipt = None;
            let event = if workspace {
                if !request.is_object() { return None; }
                json!({"type":"workspace_request", "id":id, "value":request})
            } else {
                let text = request.get("text")?.as_str()?.trim();
                if text.is_empty() { return None; }
                let resume = match request.get("resume_goal") { None => false, Some(Value::Bool(v)) => *v, _ => return None };
                let objective = match request.get("goal_objective") { None | Some(Value::Null) => None, Some(Value::String(s)) if resume && !s.trim().is_empty() => Some(s), _ => return None };
                let source = match request.get("sourceId") { None => None, Some(Value::String(s)) => Some(s.as_str()), _ => return None };
                // The durable dispatching state is committed before any host event.
                let saved = request_ledger::admit(&directory, source, text, objective.map(String::as_str)).ok()?;
                if saved.duplicate {
                    return Some(json!({"ok":false,"status":saved.status,"receiptId":saved.id,"error":"Request already received; no repeat was started."}));
                }
                receipt = Some(saved.id.clone());
                json!({"type":"request", "id":id, "text":text, "resume_goal":resume, "goal_objective":objective, "receiptId":saved.id})
            };
            let (tx, rx) = mpsc::channel();
            pending.lock().ok()?.insert(id, tx);
            if emit(&event).is_err() { pending.lock().ok()?.remove(&id); return None; }
            let mut reply = rx.recv_timeout(timeout).ok();
            pending.lock().ok()?.remove(&id);
            if let Some(receipt) = receipt {
                let status = match reply.as_ref().and_then(|v| v.get("ok")).and_then(Value::as_bool) {
                    Some(true) => "accepted",
                    Some(false) if matches!(reply.as_ref().and_then(|v| v.get("error")).and_then(Value::as_str),
                        Some("The request expired before it could start.") | Some("The personal-agent is already working.")) => "rejected",
                    _ => "unknown",
                };
                if request_ledger::finish(&directory, &receipt, status).is_err() {
                    return Some(json!({"ok":false,"status":"unknown","receiptId":receipt,"error":"Request outcome unknown; no repeat was started."}));
                }
                if let Some(Value::Object(ref mut object)) = reply {
                    object.insert("receiptId".into(), json!(receipt));
                    object.insert("status".into(), json!(status));
                } else {
                    reply = Some(json!({"ok":false,"status":"unknown","receiptId":receipt,"error":"Request outcome unknown; no repeat was started."}));
                }
            }
            reply
        })().unwrap_or_else(rejected);
        if let Ok(mut bytes) = serde_json::to_vec(&result) {
            bytes.push(b'\n');
            let _ = stream.write_all(&bytes);
        }
    }
    pub fn run() -> Result<(), String> {
        let mut args = env::args_os();
        args.next();
        let directory = PathBuf::from(args.next().ok_or("Missing directory")?);
        let workspace = match args.next() {
            None => false,
            Some(mode) if mode == "workspace" => true,
            _ => return Err("Invalid arguments".into()),
        };
        if args.next().is_some() {
            return Err("Invalid arguments".into());
        }
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let path = directory.join(if workspace {
            "workspace.sock"
        } else {
            "request.sock"
        });
        match fs::symlink_metadata(&path) {
            Ok(info) => {
                if !info.file_type().is_socket() || info.uid() != unsafe { libc::getuid() } {
                    return Err("Refusing to replace an unexpected request socket path".into());
                }
                match UnixStream::connect(&path) {
                    Ok(_) => return Err("Another personal-agent request channel is active".into()),
                    Err(e)
                        if e.kind() == io::ErrorKind::ConnectionRefused
                            || e.kind() == io::ErrorKind::NotFound =>
                    {
                        if e.kind() != io::ErrorKind::NotFound {
                            fs::remove_file(&path).map_err(|e| e.to_string())?;
                        }
                    }
                    Err(e) => return Err(e.to_string()),
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
        let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        let inode = fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .ino();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let running = Arc::new(AtomicBool::new(true));
        let requests = pending.clone();
        let live = running.clone();
        thread::spawn(move || {
            for line in io::stdin().lock().lines() {
                let Ok(line) = line else {
                    break;
                };
                let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let (Some(id), Some(result)) =
                    (reply.get("id").and_then(Value::as_u64), reply.get("result"))
                {
                    if let Some(tx) = requests.lock().unwrap().remove(&id) {
                        let _ = tx.send(result.clone());
                    }
                }
            }
            live.store(false, Ordering::Relaxed);
        });
        emit(&json!({"type":"ready"})).map_err(|e| e.to_string())?;
        let next = Arc::new(AtomicU64::new(1));
        let directory = Arc::new(directory);
        while running.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    // macOS can inherit O_NONBLOCK from the listener; accepted clients
                    // need blocking reads so fragmented requests are not rejected.
                    if stream.set_nonblocking(false).is_err() {
                        continue;
                    }
                    let pending = pending.clone();
                    let next = next.clone();
                    let directory = directory.clone();
                    thread::spawn(move || handle(stream, pending, next, workspace, directory));
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20))
                }
                Err(_) => break,
            }
        }
        if fs::symlink_metadata(&path)
            .map(|m| m.ino() == inode)
            .unwrap_or(false)
        {
            let _ = fs::remove_file(path);
        }
        Ok(())
    }
}
#[cfg(unix)]
fn main() {
    if let Err(error) = unix::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
#[cfg(not(unix))]
fn main() {
    eprintln!("Unix sockets required");
    std::process::exit(1);
}
