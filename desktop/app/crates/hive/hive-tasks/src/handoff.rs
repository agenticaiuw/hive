//! Hive on the Mac handing a task to another of the owner's agents, through the cloud board (the
//! owner: "every node should be able to reach every other node: through the cloud"). The agent's
//! `agents.hand_off` tool makes a run for that agent on the board (POST /v1/runs), says the task to it
//! (POST /v1/runs/message, the same way the owner talks to an agent from a dashboard), and waits for
//! the run to end, reading it back (GET /v1/runs). The browser agent is the Hive extension in the
//! owner's own Safari or Chrome: it takes the message (browser/chrome/src/cloud-peer.js), runs it in
//! that signed-in browser and reports each step in the same run, so every dashboard shows the one
//! conversation.

use crate::Cloud;
use hive_common::tools::{result, text, ToolNamespace};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a hand-off waits for the other agent unless told otherwise, and at most.
pub const WAIT_S: u64 = 120;
pub const MOST_WAIT_S: u64 = 600;
const POLL: Duration = Duration::from_secs(3);

/// The cloud board, as the hand-off uses it (a fake in tests).
pub trait Board: Send + Sync {
    fn post(&self, path: &str, body: &Value) -> Result<Value, String>;
    fn get(&self, path: &str) -> Result<Value, String>;
}

impl Board for Cloud {
    fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        Cloud::post(self, path, body)
    }
    fn get(&self, path: &str) -> Result<Value, String> {
        Cloud::get(self, path)
    }
}

/// The `agents` tools.
pub struct HandOff {
    board: Option<Arc<dyn Board>>,
    /// The board's machine for the owner's browser: "ext:<the extension key's name>".
    browser: Option<String>,
    sleep: Box<dyn Fn(Duration) + Send + Sync>,
}

impl Default for HandOff {
    fn default() -> Self {
        Self::new()
    }
}

impl HandOff {
    /// This Mac's board (~/.config/hive/tasks.json) and its browsers' key (~/.config/hive/extension.json,
    /// which hive-tasks sync writes).
    pub fn new() -> HandOff {
        let key_file = hive_common::paths::home().join(".config/hive/extension.json");
        let browser = std::fs::read_to_string(key_file)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.get("key").and_then(Value::as_str).and_then(browser_machine));
        HandOff {
            board: Cloud::load().map(|c| Arc::new(c) as Arc<dyn Board>),
            browser,
            sleep: Box::new(std::thread::sleep),
        }
    }

    pub fn with(board: Arc<dyn Board>, browser: &str, sleep: impl Fn(Duration) + Send + Sync + 'static) -> HandOff {
        HandOff { board: Some(board), browser: Some(browser.to_owned()), sleep: Box::new(sleep) }
    }

    fn hand_off(&self, args: &Value) -> Result<Value, String> {
        let task = args.get("task").and_then(Value::as_str).unwrap_or("").trim();
        if task.is_empty() {
            return Ok(said(true, "Say the task (task), in words the other agent can act on alone."));
        }
        let to = args.get("to").and_then(Value::as_str).unwrap_or("browser");
        if to != "browser" {
            return Ok(said(true, format!("There is no {to} agent to hand to; the one there is: browser.")));
        }
        let board = self.board.as_ref().ok_or("This Mac has no cloud board set up (~/.config/hive/tasks.json).")?;
        let machine = self.browser.as_deref().ok_or(
            "The owner's browser has no key to the cloud yet (hive-tasks sync makes one in ~/.config/hive/extension.json).",
        )?;
        let run = new_run_id();
        let title: String = task.chars().take(300).collect();
        board.post(
            "/v1/runs",
            &json!({"machine": machine, "run": run, "agent": "browser", "title": title, "status": "queued"}),
        )?;
        let sent = board.post("/v1/runs/message", &json!({"machine": machine, "run": run, "text": task, "from": "mac"}))?;
        let message = sent["message"]["id"].as_i64();
        self.follow(board.as_ref(), machine, &run, message, wait_of(args))
    }

    fn check(&self, args: &Value) -> Result<Value, String> {
        let run = args.get("run").and_then(Value::as_str).unwrap_or("").trim();
        if run.is_empty() {
            return Ok(said(true, "Say which hand-off (run), as hand_off gave it."));
        }
        let board = self.board.as_ref().ok_or("This Mac has no cloud board set up (~/.config/hive/tasks.json).")?;
        let machine = self.browser.as_deref().ok_or("The owner's browser has no key to the cloud yet.")?;
        self.follow(board.as_ref(), machine, run, None, wait_of(args))
    }

    /// Reads the run back until it ends, its message fails, or `wait` runs out; what came of it so far.
    fn follow(&self, board: &dyn Board, machine: &str, run: &str, message: Option<i64>, wait: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + wait;
        loop {
            let got = board.get(&format!("/v1/runs?machine={}&run={}&tail=30", encode(machine), encode(run)))?;
            let status = got["run"]["status"].as_str().unwrap_or("");
            let messages = got["messages"].as_array().cloned().unwrap_or_default();
            let mine = messages
                .iter()
                .rev()
                .find(|m| message.is_none_or(|id| m["id"].as_i64() == Some(id)));
            let handed = mine.and_then(|m| m["status"].as_str()).unwrap_or("");
            let steps = steps_text(&got["steps"]);
            if handed == "failed" {
                let why = mine.and_then(|m| m["detail"].as_str()).unwrap_or("it didn't say why");
                return Ok(said(true, format!("The browser agent couldn't take it: {why}")));
            }
            let ended = matches!(status, "done" | "failed" | "stopped") && handed != "queued" && handed != "taken";
            if ended {
                let how = match status {
                    "done" => "The browser agent finished",
                    "failed" => "The browser agent failed",
                    _ => "The browser agent stopped (handed it on)",
                };
                return Ok(said(status != "done", format!("{how} (run {run}):\n{steps}")));
            }
            if Instant::now() >= deadline {
                let text = if handed == "queued" || handed.is_empty() {
                    format!(
                        "Not picked up yet: the Hive extension in the owner's browser isn't listening right now. It will take \
                         it when the browser next connects (within a day). Check later with check_hand_off run {run}."
                    )
                } else {
                    format!("Still working (run {run}); so far:\n{steps}\nCheck again with check_hand_off run {run}.")
                };
                return Ok(said(false, text));
            }
            (self.sleep)(POLL.min(deadline.saturating_duration_since(Instant::now())).max(Duration::from_millis(1)));
        }
    }
}

impl ToolNamespace for HandOff {
    fn namespace(&self) -> &'static str {
        "agents"
    }

    fn about(&self) -> &'static str {
        "The owner's other agents, reached through Hive's cloud: the browser agent is the Hive extension in the owner's own \
         Safari or Chrome, signed in as them."
    }

    fn tools(&self) -> Vec<Value> {
        let step = json!({"type": "string", "description": "One line for the owner: what you're doing and why."});
        let wait = json!({"type": "integer", "minimum": 0, "maximum": MOST_WAIT_S,
                          "description": format!("Seconds to wait for it to finish (default {WAIT_S}).")});
        vec![
            json!({
                "name": "hand_off",
                "description": "Give a task to another of the owner's agents and wait for it to finish. The browser agent works in \
                    the owner's own signed-in browser, in a tab of its own: hand it a task about a site the owner is signed in \
                    to there, or one their browser should do. Say the whole task in words it can act on alone; it can't see \
                    this conversation. It answers with what the agent did. Every dashboard shows the run as it goes.",
                "inputSchema": {"type": "object", "properties": {
                    "step": step,
                    "to": {"type": "string", "enum": ["browser"], "description": "Which agent."},
                    "task": {"type": "string", "description": "The task, in full."},
                    "wait_s": wait,
                }, "required": ["step", "task"], "additionalProperties": false},
            }),
            json!({
                "name": "check_hand_off",
                "description": "How a task you handed off is going: whether it was taken, its latest steps, and how it ended.",
                "inputSchema": {"type": "object", "properties": {
                    "step": step,
                    "run": {"type": "string", "description": "The run hand_off gave."},
                    "wait_s": wait,
                }, "required": ["step", "run"], "additionalProperties": false},
            }),
        ]
    }

    fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
        match tool {
            "hand_off" => self.hand_off(args),
            "check_hand_off" => self.check(args),
            other => Err(format!("No agents tool {other}.")),
        }
    }

    fn look(&self, _context: bool) -> Result<Value, String> {
        Err("The agents have no screen.".into())
    }
}

/// "ext.<name>.<signature>" → "ext:<name>", the board's machine for that browser.
pub fn browser_machine(key: &str) -> Option<String> {
    let rest = key.strip_prefix("ext.")?;
    let (name, _) = rest.rsplit_once('.')?;
    (!name.is_empty()).then(|| format!("ext:{name}"))
}

fn said(error: bool, words: impl Into<String>) -> Value {
    result(vec![text(words)], error)
}

fn wait_of(args: &Value) -> Duration {
    Duration::from_secs(args.get("wait_s").and_then(Value::as_u64).unwrap_or(WAIT_S).min(MOST_WAIT_S))
}

fn steps_text(steps: &Value) -> String {
    let lines: Vec<String> = steps
        .as_array()
        .map(|s| s.iter().filter_map(|step| step["text"].as_str().map(|t| format!("- {t}"))).collect())
        .unwrap_or_default();
    if lines.is_empty() {
        "(no steps yet)".into()
    } else {
        lines.join("\n")
    }
}

fn new_run_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("handoff-{:x}-{:x}", nanos, std::process::id())
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}
