//! Bridge durable identity decisions to the host's already-connected app server.
use personal_agent_core::thread_identity::{IdentityError, ResumableThread, SessionTransport};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn send(value: &Value) -> io::Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, value)?;
    writeln!(out)?;
    out.flush()
}
fn read() -> Result<Value, String> {
    let mut line = String::new();
    io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&line).map_err(|e| format!("Invalid host response: {e}"))
}
struct Host;
impl SessionTransport for Host {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        send(&json!({"type":"request", "method":method, "params":params}))
            .map_err(|e| e.to_string())?;
        let reply = read()?;
        if let Some(error) = reply.get("error").and_then(Value::as_str) {
            return Err(error.into());
        }
        reply
            .get("result")
            .cloned()
            .ok_or_else(|| "Missing host result".into())
    }
}
fn run() -> Result<(), String> {
    let args = read()?;
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("Missing state path")?;
    let params = args.get("params").ok_or("Missing parameters")?;
    let expected = match args.get("expected") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        _ => return Err("Invalid expected identity".into()),
    };
    let mut identity = ResumableThread::with_expected(path, expected).map_err(|e| e.to_string())?;
    match identity.connect(&mut Host, params) {
        Ok(id) => send(&json!({"type":"result", "id":id})),
        Err(e) => {
            let is_io = matches!(&e, IdentityError::Io { source, .. } if source.kind() != io::ErrorKind::InvalidData);
            send(&json!({"type":"error", "error":e.to_string(), "io":is_io}))
        },
    }
    .map_err(|e| e.to_string())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
