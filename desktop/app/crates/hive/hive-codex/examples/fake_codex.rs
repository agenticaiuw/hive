//! Stands in for `codex app-server` in the tests (tests/fake_codex.py). It answers the JSON-RPC
//! calls the agent makes and plays out each turn: a screenshot, one real call back to the agent's
//! tools (wait, without a screenshot, so nothing looks at your screen), some "work", then its final
//! message, written a few letters at a time as Codex streams it. turn/interrupt ends the turn early.
//!
//!   FAKE_CODEX_LOG      file it appends to: {"started": thread} for each thread, {"thread", "prompt",
//!                       "args", "model", "tools", "instructions", "rules", "effort", "images",
//!                       "tier"} for each turn, {"tool_reply": ...} for each answer to its tool call,
//!                       {"unsubscribed": thread} when the agent lets a thread go
//!   FAKE_CODEX_SECONDS  how long the "work" takes (default 0.3); "60,0.3" for each turn in turn
//!                       (the last for the rest)
//!   FAKE_CODEX_REPLY    the final message
//!
//! Like Codex, it refuses a turn on a thread whose last turn hasn't ended.

use serde_json::{json, Map, Value};
use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Flag {
    set: Mutex<bool>,
    changed: Condvar,
}

impl Flag {
    fn set(&self) {
        *self.set.lock().unwrap() = true;
        self.changed.notify_all();
    }
    fn wait(&self, seconds: f64) -> bool {
        let deadline = Instant::now() + Duration::from_secs_f64(seconds);
        let mut set = self.set.lock().unwrap();
        while !*set {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            set = self.changed.wait_timeout(set, deadline - now).unwrap().0;
        }
        true
    }
}

#[derive(Default)]
struct State {
    threads: HashMap<String, Value>,
    interrupted: HashMap<String, Arc<Flag>>,
    busy: HashSet<String>,
    pending: HashMap<u64, Sender<Value>>,
    counter: u64,
}

struct Fake {
    log: String,
    store: PathBuf,
    out: Mutex<()>,
    state: Mutex<State>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn hex_id() -> String {
    let mut out = String::new();
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn obj(pairs: &[(&str, Value)]) -> Value {
    Value::Object(
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
    )
}

fn merged(a: &Value, b: &Value) -> Value {
    let mut m: Map<String, Value> = a.as_object().cloned().unwrap_or_default();
    for (k, v) in b.as_object().cloned().unwrap_or_default() {
        m.insert(k, v);
    }
    Value::Object(m)
}

impl Fake {
    fn record(&self, entry: Value) {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)
            .unwrap();
        f.write_all(format!("{entry}\n").as_bytes()).unwrap(); // one write, so a reader never sees half a line
    }

    fn send(&self, msg: Value) {
        let _out = self.out.lock().unwrap();
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "{msg}").unwrap();
        stdout.flush().unwrap();
    }

    fn emit(&self, method: &str, params: Value) {
        self.send(json!({"method": method, "params": params}));
    }

    fn ask(&self, method: &str, params: Value) -> Value {
        let (tx, rx) = channel();
        let id = {
            let mut s = self.state.lock().unwrap();
            s.counter += 1;
            let id = s.counter;
            s.pending.insert(id, tx);
            id
        };
        self.send(json!({"id": id, "method": method, "params": params}));
        let reply = rx
            .recv_timeout(Duration::from_secs(30))
            .unwrap_or(Value::Null);
        match reply.get("result") {
            Some(r) if r.as_object().is_some_and(|o| !o.is_empty()) => r.clone(),
            _ => json!({}),
        }
    }

    fn seconds(turn: usize) -> f64 {
        let each: Vec<String> = std::env::var("FAKE_CODEX_SECONDS")
            .unwrap_or_else(|_| "0.3".into())
            .split(',')
            .map(str::to_owned)
            .collect();
        each[turn.min(each.len()) - 1].trim().parse().unwrap()
    }

    fn end(&self, thread_id: &str, turn_id: &str, status: &str) {
        {
            let mut s = self.state.lock().unwrap();
            s.busy.remove(thread_id);
            if status == "completed" {
                let thread = s.threads.get_mut(thread_id).unwrap();
                let done = thread
                    .get("completedTurns")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                thread["completedTurns"] = json!(done + 1);
            }
        }
        self.emit(
            "turn/completed",
            json!({"threadId": thread_id, "turn": {"id": turn_id, "items": [], "status": status}}),
        );
    }

    fn play(&self, thread_id: &str, turn_id: &str) {
        let ids = json!({"threadId": thread_id, "turnId": turn_id});
        let device =
            self.state.lock().unwrap().threads[thread_id]["dynamicTools"][0]["name"].clone();
        self.emit(
            "turn/started",
            json!({"threadId": thread_id, "turn": {"id": turn_id, "items": [], "status": "inProgress"}}),
        );
        let shot = json!({"type": "dynamicToolCall", "id": "1", "namespace": device, "tool": "screenshot",
                          "arguments": {}});
        self.emit(
            "item/started",
            merged(&ids, &obj(&[("item", shot.clone())])),
        );
        let done = merged(&shot, &json!({"success": true, "contentItems": []}));
        self.emit("item/completed", merged(&ids, &obj(&[("item", done)])));
        let wait = json!({"type": "dynamicToolCall", "id": "2", "namespace": device, "tool": "wait",
                          "arguments": {"seconds": 0.1, "screenshot": false}});
        self.emit(
            "item/started",
            merged(&ids, &obj(&[("item", wait.clone())])),
        );
        let call = json!({"callId": "2", "namespace": device, "tool": "wait", "arguments": wait["arguments"]});
        let reply = self.ask("item/tool/call", merged(&ids, &call));
        self.record(json!({"tool_reply": reply}));
        self.emit(
            "item/completed",
            merged(&ids, &obj(&[("item", merged(&wait, &reply))])),
        );
        let crash_marker = self.store.join("crashed-once");
        if env("FAKE_CODEX_CRASH_ONCE").is_some() && !crash_marker.exists() {
            std::fs::write(&crash_marker, "crashed").unwrap();
            std::process::exit(23);
        }
        let flag = self.state.lock().unwrap().interrupted[turn_id].clone();
        let n: usize = turn_id.split('-').nth(1).unwrap().parse().unwrap();
        if flag.wait(Self::seconds(n)) {
            return self.end(thread_id, turn_id, "interrupted");
        }
        let text =
            std::env::var("FAKE_CODEX_REPLY").unwrap_or_else(|_| "Calculator shows 408.".into());
        let chars: Vec<char> = text.chars().collect();
        for piece in chars.chunks(4) {
            let delta: String = piece.iter().collect();
            self.emit(
                "item/agentMessage/delta",
                merged(&ids, &json!({"itemId": "3", "delta": delta})),
            );
        }
        self.emit(
            "item/completed",
            merged(
                &ids,
                &json!({"item": {"type": "agentMessage", "id": "3", "text": text}}),
            ),
        );
        self.end(thread_id, turn_id, "completed");
    }

    fn save(&self, thread_id: &str, thread: &Value) {
        std::fs::write(
            self.store.join(format!("{thread_id}.json")),
            thread.to_string(),
        )
        .unwrap();
    }

    fn handle(self: &Arc<Self>, msg: Value) {
        let method = msg.get("method").and_then(Value::as_str).map(str::to_owned);
        let params = msg
            .get("params")
            .filter(|p| !p.is_null())
            .cloned()
            .unwrap_or(json!({}));
        let Some(method) = method else {
            // the agent answering our tool call
            let id = msg.get("id").and_then(Value::as_u64).unwrap_or(0);
            if let Some(waiter) = self.state.lock().unwrap().pending.remove(&id) {
                let _ = waiter.send(msg);
            }
            return;
        };
        let Some(id) = msg.get("id").cloned() else {
            return; // a notification ("initialized")
        };
        let error =
            |message: &str| json!({"id": id, "error": {"code": -32600, "message": message}});
        let mut result = json!({});
        let thread_of = |p: &Value| p["threadId"].as_str().unwrap_or("").to_owned();
        match method.as_str() {
            "thread/start" => {
                let thread_id = format!("thread-{}", hex_id());
                if !params
                    .get("ephemeral")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    self.save(&thread_id, &params);
                }
                self.state
                    .lock()
                    .unwrap()
                    .threads
                    .insert(thread_id.clone(), params);
                self.record(json!({"started": thread_id}));
                result = json!({"thread": {"id": thread_id}, "model": "fake"});
            }
            "thread/resume" => {
                let thread_id = thread_of(&params);
                self.record(json!({"resumed": thread_id}));
                let path = self.store.join(format!("{thread_id}.json"));
                if env("FAKE_CODEX_RESUME_ERROR").is_some() || !path.exists() {
                    return self.send(error("saved thread unavailable"));
                }
                let saved: Value =
                    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                self.state
                    .lock()
                    .unwrap()
                    .threads
                    .insert(thread_id.clone(), saved);
                result = json!({"thread": {"id": thread_id}, "model": "fake"});
            }
            "thread/goal/get" => {
                if env("FAKE_CODEX_GOAL").is_some() {
                    let s = self.state.lock().unwrap();
                    let turns = s.threads[&thread_of(&params)]
                        .get("completedTurns")
                        .and_then(Value::as_i64);
                    let done = turns.unwrap_or(0) >= 2;
                    result = json!({"goal": {"status": if done { "complete" } else { "active" }}});
                } else {
                    result = json!({"goal": null});
                }
            }
            "thread/goal/set" => self.record(json!({"goal": params})),
            "thread/read" => {
                let busy = self
                    .state
                    .lock()
                    .unwrap()
                    .busy
                    .contains(&thread_of(&params));
                result =
                    json!({"thread": {"status": {"type": if busy { "active" } else { "idle" }}}});
            }
            "turn/start" => {
                let thread_id = thread_of(&params);
                let mut s = self.state.lock().unwrap();
                if s.busy.contains(&thread_id) {
                    drop(s);
                    return self.send(error("a turn is already in progress"));
                }
                let turn_id = format!("turn-{}", s.interrupted.len() + 1);
                s.interrupted
                    .insert(turn_id.clone(), Arc::new(Flag::default()));
                s.busy.insert(thread_id.clone());
                let thread = s.threads.get_mut(&thread_id).unwrap();
                let input = params["input"].as_array().cloned().unwrap_or_default();
                let prompt = input[0]["text"].clone();
                let tools: Vec<Value> = thread["dynamicTools"]
                    .as_array()
                    .map(|a| a.iter().map(|ns| ns["name"].clone()).collect())
                    .unwrap_or_default();
                let tier = params
                    .get("serviceTier")
                    .filter(|t| truthy(t))
                    .or_else(|| thread.get("serviceTier"));
                let entry = json!({
                    "thread": thread_id, "prompt": prompt,
                    "args": std::env::args().skip(1).collect::<Vec<_>>(),
                    "effort": params.get("effort"), "model": thread.get("model"),
                    "tools": tools, "instructions": thread["baseInstructions"],
                    "rules": thread.get("developerInstructions"), "images": input.len() - 1,
                    "prior_prompts": thread.get("_history").cloned().unwrap_or(json!([])),
                    "tier": tier,
                });
                match thread.get_mut("_history").and_then(Value::as_array_mut) {
                    Some(history) => history.push(prompt),
                    None => thread["_history"] = json!([prompt]),
                }
                let ephemeral = thread
                    .get("ephemeral")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let saved = thread.clone();
                drop(s);
                self.record(entry);
                if !ephemeral {
                    self.save(&thread_id, &saved);
                }
                let me = self.clone();
                let turn = turn_id.clone();
                std::thread::spawn(move || me.play(&thread_id, &turn));
                result = json!({"turn": {"id": turn_id, "items": [], "status": "inProgress"}});
            }
            "turn/interrupt" => {
                let turn = params["turnId"].as_str().unwrap_or("").to_owned();
                let flag = self.state.lock().unwrap().interrupted.get(&turn).cloned();
                flag.expect("no such turn").set();
            }
            "thread/unsubscribe" => {
                self.record(json!({"unsubscribed": params["threadId"]}));
                result = json!({"status": "unsubscribed"});
            }
            _ => {}
        }
        self.send(json!({"id": id, "result": result}));
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn main() {
    let log = std::env::var("FAKE_CODEX_LOG").expect("FAKE_CODEX_LOG");
    let store = PathBuf::from(
        std::env::var("FAKE_CODEX_STORE").unwrap_or_else(|_| format!("{log}.threads")),
    );
    std::fs::create_dir_all(&store).unwrap();
    let fake = Arc::new(Fake {
        log,
        store,
        out: Mutex::new(()),
        state: Mutex::new(State::default()),
    });
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if let Ok(msg) = serde_json::from_str::<Value>(&line) {
            fake.handle(msg);
        }
    }
}
