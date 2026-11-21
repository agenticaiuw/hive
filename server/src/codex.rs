//! One Codex app-server for all of Hive's agents (JSON-RPC over stdio); each agent is a thread in it.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

pub enum Event {
    Note(String, Value),
    Tool(Value, Value),
    Stopped,
}

type Reply = mpsc::Sender<Result<Value, String>>;

pub struct Codex {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<i64, Reply>>,
    serial: AtomicI64,
    pub alive: AtomicBool,
}

impl Codex {
    pub fn spawn(cmd: &str, env: &[(String, String)], events: mpsc::Sender<Event>) -> Result<Arc<Codex>, String> {
        let mut c = Command::new(cmd);
        c.arg("app-server").envs(env.iter().cloned()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        #[cfg(windows)] // no console window
        { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
        let mut child = c.spawn().map_err(|e| format!("couldn't start Codex ({cmd}): {e}"))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let codex = Arc::new(Codex {
            stdin: Mutex::new(stdin), child: Mutex::new(child), pending: Mutex::new(HashMap::new()),
            serial: AtomicI64::new(0), alive: AtomicBool::new(true),
        });
        let c = codex.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
                let method = m.get("method").and_then(|v| v.as_str()).map(String::from);
                match (m.get("id").cloned(), method) {
                    (Some(id), None) => {
                        let tx = id.as_i64().and_then(|n| c.pending.lock().unwrap().remove(&n));
                        if let Some(tx) = tx {
                            let r = match m.get("error") {
                                Some(e) => Err(e["message"].as_str().unwrap_or("Codex error").to_string()),
                                None => Ok(m["result"].clone()),
                            };
                            tx.send(r).ok();
                        }
                    }
                    (Some(id), Some(method)) if method == "item/tool/call" => { events.send(Event::Tool(id, m["params"].clone())).ok(); }
                    (Some(id), Some(_)) => c.send(&json!({ "id": id, "error": { "code": -32601, "message": "Hive answers no interactive requests." } })),
                    (None, Some(method)) => { events.send(Event::Note(method, m["params"].clone())).ok(); }
                    _ => {}
                }
            }
            c.alive.store(false, Ordering::SeqCst);
            for (_, tx) in c.pending.lock().unwrap().drain() { tx.send(Err("Codex stopped.".into())).ok(); }
            c.child.lock().unwrap().wait().ok();
            events.send(Event::Stopped).ok();
        });
        codex.request("initialize", json!({ "clientInfo": { "name": "hive", "version": "1" },
            "capabilities": { "experimentalApi": true } }), 60)?;
        Ok(codex)
    }

    fn send(&self, m: &Value) {
        let mut s = self.stdin.lock().unwrap();
        writeln!(s, "{m}").ok();
        s.flush().ok();
    }

    pub fn request(&self, method: &str, params: Value, secs: u64) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) { return Err("Codex stopped.".into()); }
        let id = self.serial.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send(&json!({ "id": id, "method": method, "params": params }));
        match rx.recv_timeout(Duration::from_secs(secs)) {
            Ok(r) => r,
            Err(_) => { self.pending.lock().unwrap().remove(&id); Err(format!("Codex didn't answer {method} in {secs}s")) }
        }
    }

    pub fn respond(&self, id: Value, result: Value) {
        self.send(&json!({ "id": id, "result": result }));
    }
}

/// A tool's answer in the app-server's shape: text, plus images as data URLs.
pub fn tool_result(ok: bool, text: &str, images: &[String]) -> Value {
    let mut items = vec![json!({ "type": "inputText", "text": text })];
    for url in images { items.push(json!({ "type": "inputImage", "imageUrl": url })); }
    json!({ "success": ok, "contentItems": items })
}
