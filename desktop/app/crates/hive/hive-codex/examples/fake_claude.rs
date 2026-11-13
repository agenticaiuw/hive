//! A stand-in for the `claude` CLI in stream-json mode, for the Claude backend's tests: it speaks
//! the Claude Agent SDK's control protocol on stdin/stdout (one JSON object per line), answers
//! `initialize` and `interrupt`, and plays one scripted turn per user message, calling the
//! in-process "mac" MCP server through `mcp_message` control requests as the real CLI does.
//!
//! - `FAKE_CLAUDE_LOG`: a file it appends to (JSON lines): its command line, environment and
//!   working directory first, then `{"in": message}` for each line it reads and
//!   `{"mcp": {"method", "response"}}` for each MCP reply it gets.
//! - `FAKE_CLAUDE_EXIT=<code>`: exits with that code once it has read the first line.
//! - `FAKE_CLAUDE_SESSION`: the session id it reports (default: `--resume`'s, else a fixed one).
//! - `FAKE_CLAUDE_STEP`: the `step` of the batch it calls.
//! - A request containing "SLOW" streams a sentence, then waits for `interrupt` and ends with an
//!   error result; one containing "FAIL" ends with an error result and exits 1. (What it is told
//!   was said before the request doesn't count.)

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const DEFAULT_SESSION: &str = "8f14e45f-ceea-4e67-a1b2-5b7c3d2e9f10";

struct Fake {
    out: Mutex<std::io::Stdout>,
    log: Option<Mutex<std::fs::File>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    counter: AtomicU64,
    interrupted: (Mutex<bool>, Condvar),
    session: String,
    mac: bool,
}

impl Fake {
    fn send(&self, message: Value) {
        let mut out = self.out.lock().unwrap();
        let _ = writeln!(out, "{message}");
        let _ = out.flush();
    }

    fn log(&self, entry: Value) {
        if let Some(file) = &self.log {
            // One write, so lines from two processes don't interleave.
            let _ = file
                .lock()
                .unwrap()
                .write_all(format!("{entry}\n").as_bytes());
        }
    }

    /// An `mcp_message` control request to one of the SDK's servers; its JSON-RPC reply.
    fn mcp(&self, server: &str, message: Value) -> Value {
        let n = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let id = format!("fake_{n}");
        let method = message["method"].clone();
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        self.send(json!({"type": "control_request", "request_id": id,
                         "request": {"subtype": "mcp_message", "server_name": server, "message": message}}));
        let response = rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| json!({"timeout": true}));
        self.log(json!({"mcp": {"method": method, "response": response}}));
        response
    }

    fn stream(&self, parent: Option<&str>, event: Value) {
        self.send(
            json!({"type": "stream_event", "uuid": "u-stream", "session_id": self.session,
                         "event": event, "parent_tool_use_id": parent}),
        );
    }

    fn delta(&self, text: &str) {
        self.stream(
            None,
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
        );
    }

    fn message_start(&self, parent: Option<&str>, id: &str) {
        self.stream(
            parent,
            json!({"type": "message_start", "message": {"id": id, "role": "assistant", "content": []}}),
        );
    }

    fn assistant(&self, id: &str, content: Value) {
        self.send(json!({"type": "assistant", "message": {"id": id, "model": "claude-test", "role": "assistant",
                                                           "content": content, "stop_reason": "end_turn",
                                                           "usage": {"output_tokens": 7}},
                         "parent_tool_use_id": null, "session_id": self.session, "uuid": format!("u-{id}")}));
    }

    fn result(&self, error: Option<&str>) {
        let mut result = json!({"type": "result", "subtype": "success", "is_error": false, "duration_ms": 12,
                                "duration_api_ms": 10, "num_turns": 2, "result": "Done. It is open now.",
                                "session_id": self.session, "total_cost_usd": 0.01,
                                "usage": {"output_tokens": 42}, "modelUsage": {}, "permission_denials": [],
                                "uuid": "u-result"});
        if let Some(error) = error {
            result["subtype"] = json!("error_during_execution");
            result["is_error"] = json!(true);
            result["result"] = json!(error);
            result["errors"] = json!([error]);
        }
        self.send(result);
    }

    /// One turn, for a user message.
    fn turn(&self, text: &str) {
        // Only the request itself decides, not what it was told was said before it.
        let text = match text.strip_prefix("Also said in this conversation") {
            Some(rest) => rest.split_once("\n\n").map_or("", |(_, request)| request),
            None => text,
        };
        self.send(json!({"type": "system", "subtype": "init", "session_id": self.session, "model": "claude-test",
                         "tools": ["Read", "Bash"], "uuid": "u-init"}));
        self.send(
            json!({"type": "system", "subtype": "session_state_changed", "state": "running",
                         "sdk_host_only": true}),
        );
        if text.contains("FAIL") {
            self.result(Some("API Error: overloaded"));
            std::process::exit(1);
        }
        if text.contains("SLOW") {
            self.message_start(None, "msg_slow");
            self.delta("Working on it. ");
            let (lock, wake) = &self.interrupted;
            let mut interrupted = lock.lock().unwrap();
            let mut waited = 0;
            while !*interrupted && waited < 100 {
                interrupted = wake
                    .wait_timeout(interrupted, Duration::from_millis(100))
                    .unwrap()
                    .0;
                waited += 1;
            }
            *interrupted = false;
            drop(interrupted);
            self.result(Some("Request interrupted by user"));
            return;
        }
        if self.mac {
            self.mcp(
                "mac",
                json!({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                       "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                  "clientInfo": {"name": "claude-code", "version": "2"}}}),
            );
            self.mcp(
                "mac",
                json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            );
            self.mcp(
                "mac",
                json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            );
        }
        let step = std::env::var("FAKE_CLAUDE_STEP").unwrap_or_else(|_| "Opening Notes.".into());
        self.message_start(None, "msg_1");
        self.delta("Opening it");
        self.delta(" now. ");
        self.stream(
            None,
            json!({"type": "content_block_start", "index": 1,
                   "content_block": {"type": "tool_use", "id": "toolu_1", "name": "mcp__mac__batch", "input": {}}}),
        );
        let input = json!({"steps": [{"tool": "open_app", "name": "Notes"}], "step": step});
        self.assistant(
            "msg_1",
            json!([{"type": "text", "text": "Opening it now. "},
                   {"type": "tool_use", "id": "toolu_1", "name": "mcp__mac__batch", "input": input},
                   {"type": "tool_use", "id": "toolu_2", "name": "Bash",
                    "input": {"command": "ls", "description": "List files"}}]),
        );
        let output = if self.mac {
            self.mcp(
                "mac",
                json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                       "params": {"name": "batch", "arguments": input}}),
            )["result"]["content"]
                .clone()
        } else {
            json!([])
        };
        self.send(json!({"type": "user", "message": {"role": "user", "content": [
                             {"type": "tool_result", "tool_use_id": "toolu_1", "content": output, "is_error": false},
                             {"type": "tool_result", "tool_use_id": "toolu_2", "content": "ls: boom", "is_error": true}]},
                         "parent_tool_use_id": null, "session_id": self.session, "uuid": "u-results",
                         "tool_use_result": {"stdout": "", "stderr": "ls: boom"}}));
        self.message_start(Some("toolu_9"), "msg_sub"); // a subagent's: not the reply
        self.message_start(None, "msg_2");
        self.delta("Done. It is open");
        self.delta(" now.");
        self.assistant(
            "msg_2",
            json!([{"type": "text", "text": "Done. It is open now."}]),
        );
        self.send(json!({"type": "rate_limit_event",
                         "rate_limit_info": {"status": "allowed", "resetsAt": 1700000000, "rateLimitType": "five_hour"},
                         "uuid": "u-rate", "session_id": self.session}));
        self.send(
            json!({"type": "system", "subtype": "session_state_changed", "state": "idle",
                         "sdk_host_only": true}),
        );
        self.result(None);
    }

    /// One of our control requests: initialize and interrupt succeed, anything else is an error.
    fn control(&self, id: &Value, request: &Value) {
        let subtype = request["subtype"].as_str().unwrap_or("");
        let response = match subtype {
            "initialize" => {
                json!({"subtype": "success", "request_id": id,
                       "response": {"commands": [], "output_style": "default", "models": []}})
            }
            "interrupt" => {
                let (lock, wake) = &self.interrupted;
                *lock.lock().unwrap() = true;
                wake.notify_all();
                json!({"subtype": "success", "request_id": id, "response": {}})
            }
            other => {
                json!({"subtype": "error", "request_id": id, "error": format!("Unsupported: {other}")})
            }
        };
        self.send(json!({"type": "control_response", "response": response}));
    }
}

fn main() {
    if let Ok(code) = std::env::var("FAKE_CLAUDE_EXIT") {
        let _ = std::io::stdin().lock().lines().next(); // so the first request was written
        std::process::exit(code.parse().unwrap_or(1));
    }
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let resume = argv
        .iter()
        .find_map(|a| a.strip_prefix("--resume="))
        .map(str::to_owned);
    let config = argv
        .iter()
        .position(|a| a == "--mcp-config")
        .and_then(|i| argv.get(i + 1))
        .and_then(|c| serde_json::from_str::<Value>(c).ok())
        .unwrap_or(Value::Null);
    let log = std::env::var("FAKE_CLAUDE_LOG").ok().map(|path| {
        Mutex::new(
            std::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(path)
                .unwrap(),
        )
    });
    let fake = Arc::new(Fake {
        out: Mutex::new(std::io::stdout()),
        log,
        pending: Mutex::new(HashMap::new()),
        counter: AtomicU64::new(0),
        interrupted: (Mutex::new(false), Condvar::new()),
        session: std::env::var("FAKE_CLAUDE_SESSION")
            .ok()
            .or(resume)
            .unwrap_or_else(|| DEFAULT_SESSION.into()),
        mac: config["mcpServers"].get("mac").is_some(),
    });
    let env: serde_json::Map<String, Value> = [
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_AGENT_SDK_VERSION",
        "CLAUDECODE",
        "CLAUDE_CODE_SDK_READS_SESSION_STATE",
        "PWD",
    ]
    .iter()
    .map(|k| (k.to_string(), json!(std::env::var(k).ok())))
    .collect();
    let cwd = std::env::current_dir()
        .map(|d| d.display().to_string())
        .unwrap_or_default();
    fake.log(json!({"pid": std::process::id(), "argv": argv, "env": env, "cwd": cwd}));
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        fake.log(json!({"in": message}));
        match message["type"].as_str() {
            Some("control_request") => fake.control(&message["request_id"], &message["request"]),
            Some("control_response") => {
                let response = &message["response"];
                let id = response["request_id"].as_str().unwrap_or("");
                if let Some(tx) = fake.pending.lock().unwrap().remove(id) {
                    let _ = tx.send(response["response"]["mcp_response"].clone());
                }
            }
            Some("user") => {
                let text = message["message"]["content"][0]["text"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                let fake = fake.clone();
                std::thread::spawn(move || fake.turn(&text));
            }
            _ => {}
        }
    }
}
