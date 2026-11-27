//! Claude Code as an agent engine: one `claude -p` process per agent while it works, speaking stream-json over stdio, with
//! Hive's tools served to it over MCP (`POST /mcp/<token>`, api.rs). The other engine is Codex (codex.rs).
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// The owner's own hooks don't run in Hive's agents: on their own Claude Code sign-in, Hive's hook (desktop/, `hive hook`) would
/// send each agent's prompts back to Hive.
const NO_HOOKS: &str = r#"{"disableAllHooks": true}"#;

/// What an agent's process says, already in Hive's terms.
#[derive(Debug, PartialEq)]
pub enum Out {
    /// Its session, which `--resume` picks up after a restart.
    Session(String),
    /// A line for the task's log: who (agent, files, search) and the text.
    Log(&'static str, String),
    /// A Bash command and its output, plus whether the tool result reported an error.
    Command { text: String, failed: bool },
    /// A turn ended, with the failure if it failed; `queued` turns are still to run (steers it hadn't taken yet).
    Ended { error: Option<String>, queued: u64 },
}

pub struct Claude {
    stdin: Mutex<Option<ChildStdin>>,
    /// The agent's MCP secret, which also tells this process apart from the agent's earlier ones.
    pub token: String,
    /// Mid-turn: a user message went in and its result hasn't come out.
    pub busy: AtomicBool,
    pub interrupted: AtomicBool,
}

fn command(cmd: &str, env: &[(String, String)], cwd: &Path) -> Command {
    let mut c = Command::new(cmd);
    c.envs(env.iter().cloned()).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    #[cfg(windows)] // no console window
    { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    c
}

impl Claude {
    /// Starts an agent's process; `on` hears everything it says, then None once it has exited.
    pub fn spawn(cmd: &str, args: &[String], env: &[(String, String)], cwd: &Path, token: String,
        on: impl Fn(&Claude, Option<Out>) + Send + 'static) -> Result<Arc<Claude>, String> {
        let mut child = command(cmd, env, cwd).args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions", "--strict-mcp-config", "--settings", NO_HOOKS]).args(args)
            .spawn().map_err(|e| format!("couldn't start Claude Code ({cmd}): {e}"))?;
        let stdout = child.stdout.take().unwrap();
        let c = Arc::new(Claude { stdin: Mutex::new(child.stdin.take()), token, busy: AtomicBool::new(false), interrupted: AtomicBool::new(false) });
        let me = c.clone();
        std::thread::spawn(move || {
            let mut p = Parser::default();
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
                for out in p.read(&m) { on(&me, Some(out)); }
            }
            child.wait().ok();
            on(&me, None);
        });
        Ok(c)
    }

    fn send(&self, m: &Value) -> Result<(), String> {
        let mut s = self.stdin.lock().unwrap();
        let s = s.as_mut().ok_or("Claude Code was stopped")?;
        writeln!(s, "{m}").and_then(|_| s.flush()).map_err(|e| format!("Claude Code stopped ({e})"))
    }

    /// A user message: a new turn, or, mid-turn, a steer it reads once its current tool calls finish.
    pub fn say(&self, text: &str) -> Result<(), String> {
        self.send(&json!({ "type": "user", "message": { "role": "user", "content": text } }))?;
        self.busy.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn interrupt(&self) {
        self.interrupted.store(true, Ordering::SeqCst);
        self.send(&json!({ "type": "control_request", "request_id": crate::api::random(8), "request": { "subtype": "interrupt" } })).ok();
    }

    /// Ends the process once it's done with what it has: it exits when its input closes.
    pub fn close(&self) { self.stdin.lock().unwrap().take(); }
}

/// Turns stream-json messages into Hive's log lines, remembering each Bash call until its output comes back.
#[derive(Default)]
pub struct Parser { bash: HashMap<String, String> }

fn text_of(v: &Value) -> String {
    match v {
        Value::String(t) => t.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

impl Parser {
    pub fn read(&mut self, m: &Value) -> Vec<Out> {
        // A subagent's own messages stay inside its Task call, as a Codex agent's do.
        if !m["parent_tool_use_id"].is_null() { return vec![]; }
        let mut out = vec![];
        match (m["type"].as_str().unwrap_or(""), m["subtype"].as_str().unwrap_or("")) {
            ("system", "init") => if let Some(id) = m["session_id"].as_str() { out.push(Out::Session(id.into())) },
            ("assistant", _) => for b in m["message"]["content"].as_array().into_iter().flatten() {
                let input = &b["input"];
                match (b["type"].as_str().unwrap_or(""), b["name"].as_str().unwrap_or("")) {
                    ("text", _) => { let t = text_of(&b["text"]); if !t.trim().is_empty() { out.push(Out::Log("agent", t)) } }
                    ("tool_use", "Bash") => { self.bash.insert(text_of(&b["id"]), text_of(&input["command"])); }
                    ("tool_use", "Edit" | "Write" | "MultiEdit") => out.push(Out::Log("files", text_of(&input["file_path"]))),
                    ("tool_use", "NotebookEdit") => out.push(Out::Log("files", text_of(&input["notebook_path"]))),
                    ("tool_use", "WebSearch") => out.push(Out::Log("search", text_of(&input["query"]))),
                    _ => {}
                }
            },
            ("user", _) => for b in m["message"]["content"].as_array().into_iter().flatten() {
                if b["type"] != "tool_result" { continue }
                if let Some(cmd) = self.bash.remove(&text_of(&b["tool_use_id"])) {
                    let output = text_of(&b["content"]);
                    let text = format!("$ {cmd}\n{}", if output.chars().count() > 3000 { output.chars().take(3000).collect::<String>() + "…" } else { output });
                    out.push(Out::Command { text, failed: b["is_error"] == true });
                }
            },
            ("result", sub) => {
                let error = (m["is_error"] == true || sub.starts_with("error")).then(|| {
                    let r = text_of(&m["result"]);
                    if r.is_empty() { sub.to_string() } else { r }
                });
                out.push(Out::Ended { error, queued: m["queued_turn_count"].as_u64().unwrap_or(0) });
            }
            _ => {}
        }
        out
    }
}

/// The tool a Claude agent ends every turn with, since stream-json has no final-message schema like Codex's.
pub fn end_turn() -> Value {
    let st = |d: &str| json!({ "type": "string", "description": d });
    json!({ "name": "end_turn", "description": "Say how your turn ended; call it as your turn's last action.",
        "inputSchema": { "type": "object", "additionalProperties": false, "required": ["done", "outcome", "why", "need"], "properties": {
            "done": { "type": "boolean", "description": "Every part of what the owner asked for is done." },
            "outcome": st("When done: what was done."), "why": st("When not done: exactly why you stopped."),
            "need": st("When not done: exactly what you need from the owner.") } } })
}

/// The orchestrator planner: one `claude -p` with a JSON schema for its answer and optional read-only MCP tools.
pub fn plan(cmd: &str, env: &[(String, String)], cwd: &Path, model: (&str, &str), prompt: &str, schema: &Value, input: &str, mcp: Option<&str>) -> Result<Value, String> {
    let mut cmd_exec = command(cmd, env, cwd);
    cmd_exec.args(["-p", "--output-format", "json", "--json-schema", &schema.to_string(), "--model", model.0,
        "--effort", model.1, "--append-system-prompt", prompt, "--strict-mcp-config", "--permission-mode", "plan", "--no-session-persistence", "--settings", NO_HOOKS]);
    if let Some(cfg) = mcp { cmd_exec.args(["--mcp-config", cfg]); }
    let mut child = cmd_exec.spawn().map_err(|e| format!("couldn't start Claude Code ({cmd}): {e}"))?;
    // The input goes in as the prompt on stdin, which has no length limit the way a command line does.
    let mut stdin = child.stdin.take().unwrap();
    let input = input.to_string();
    std::thread::spawn(move || { stdin.write_all(input.as_bytes()).ok(); });
    let mut stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || { let mut s = String::new(); stdout.read_to_string(&mut s).ok(); tx.send(s).ok(); });
    let got = rx.recv_timeout(Duration::from_secs(240));
    child.kill().ok();
    child.wait().ok();
    planned(&got.map_err(|_| "the planner took too long".to_string())?)
}

/// The planner's answer from its result: `structured_output`, else its text as JSON.
fn planned(out: &str) -> Result<Value, String> {
    let r: Value = serde_json::from_str(out.trim()).map_err(|_| format!("Claude Code said: {}", out.trim()))?;
    if r["is_error"] == true { return Err(format!("planner error: {}", text_of(&r["result"]))); }
    if r["structured_output"].is_object() { return Ok(r["structured_output"].clone()); }
    serde_json::from_str::<Value>(&text_of(&r["result"])).map_err(|e| format!("the planner's answer wasn't JSON ({e})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_stream_json() {
        let mut p = Parser::default();
        let lines = [
            json!({ "type": "system", "subtype": "init", "session_id": "s1", "tools": ["Bash"], "mcp_servers": [{ "name": "hive", "status": "connected" }] }),
            json!({ "type": "assistant", "parent_tool_use_id": null, "session_id": "s1", "message": { "role": "assistant", "content": [
                { "type": "text", "text": "I'll look." },
                { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls", "description": "list" } },
                { "type": "tool_use", "id": "t2", "name": "Write", "input": { "file_path": "/w/a.txt", "content": "x" } },
                { "type": "tool_use", "id": "t3", "name": "WebSearch", "input": { "query": "rust mcp" } },
                { "type": "tool_use", "id": "t4", "name": "mcp__hive__info", "input": { "key": "", "value": "" } }] } }),
            json!({ "type": "user", "parent_tool_use_id": null, "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "t1", "content": "a.txt\nb.txt", "is_error": false },
                { "type": "tool_result", "tool_use_id": "t4", "content": [{ "type": "text", "text": "home: x" }] }] } }),
            json!({ "type": "assistant", "parent_tool_use_id": "t9", "message": { "content": [{ "type": "text", "text": "subagent" }] } }),
            json!({ "type": "result", "subtype": "success", "is_error": false, "result": "ok", "session_id": "s1", "queued_turn_count": 0 }),
        ];
        let out: Vec<Out> = lines.iter().flat_map(|l| p.read(l)).collect();
        assert_eq!(out, vec![
            Out::Session("s1".into()), Out::Log("agent", "I'll look.".into()), Out::Log("files", "/w/a.txt".into()),
            Out::Log("search", "rust mcp".into()), Out::Command { text: "$ ls\na.txt\nb.txt".into(), failed: false },
            Out::Ended { error: None, queued: 0 },
        ]);
        let err_cmd = [
            json!({ "type": "assistant", "parent_tool_use_id": null, "message": { "content": [{ "type": "tool_use", "id": "t5", "name": "Bash", "input": { "command": "false" } }] } }),
            json!({ "type": "user", "parent_tool_use_id": null, "message": { "content": [{ "type": "tool_result", "tool_use_id": "t5", "content": "exit 1", "is_error": true }] } }),
        ];
        let err_out: Vec<Out> = err_cmd.iter().flat_map(|l| p.read(l)).collect();
        assert_eq!(err_out, vec![Out::Command { text: "$ false\nexit 1".into(), failed: true }]);
        // As the CLI really ends a turn it couldn't run (signed out): subtype success, is_error true.
        let failed = json!({ "type": "result", "subtype": "success", "is_error": true, "result": "Not logged in · Please run /login", "queued_turn_count": 0 });
        assert_eq!(p.read(&failed), vec![Out::Ended { error: Some("Not logged in · Please run /login".into()), queued: 0 }]);
        assert_eq!(p.read(&json!({ "type": "result", "subtype": "error_max_turns", "queued_turn_count": 1 })),
            vec![Out::Ended { error: Some("error_max_turns".into()), queued: 1 }]);
    }

    #[test]
    fn reads_the_planners_answer() {
        assert_eq!(planned(r#"{"type":"result","is_error":false,"result":"","structured_output":{"reply":"ok"}}"#), Ok(json!({ "reply": "ok" })));
        assert_eq!(planned(r#"{"type":"result","is_error":false,"result":"{\"reply\":\"ok\"}"}"#), Ok(json!({ "reply": "ok" })));
        assert!(planned(r#"{"type":"result","is_error":true,"result":"Not logged in"}"#).unwrap_err().contains("Not logged in"));
    }
}
