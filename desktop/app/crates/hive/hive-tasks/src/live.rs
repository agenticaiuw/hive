//! Every Claude Code and Codex session on this Mac, live on the owner's board (2026-11-16).
//!
//! The owner: "make sure when i use claude code or codex on this mac it streams the live outputs to
//! the hive as well", so that in Hive they can click an agent and see what it is doing. Each session
//! is one run on the board (POST /v1/runs, cloud/tasks/worker.js), named "<harness>:<session>":
//! what the owner asked it last is its title, each thing it says or does is a step, and it is
//! "working" from the owner's message until the turn ends ("done").
//!
//! The hooks feed it ([`note`] on every hook, main.rs): each one reads what the session's transcript
//! gained since the last hook (Claude Code's ~/.claude/projects/…/<session>.jsonl, Codex's rollout
//! file) and keeps those steps here until they are sent. Sending happens in a detached
//! `hive-tasks live-send`, one at a time, so a hook never waits on the network. Steps are numbered
//! per session, so a step sent twice lands once; what a post couldn't deliver goes with the next.
//! History from before Hive first saw a session is skipped, as the ledger does.

use crate::{default_path, from_the_owner, now, owner_message, parse_iso_utc, project_of, redact, Cloud};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Steps a post carries at most (the board takes 100).
const MOST_A_POST: usize = 100;
/// Steps one hook keeps from a transcript at most (a session resumed after a long gap).
const MOST_A_READ: usize = 300;
const MOST_TEXT: usize = 500;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sessions (
  harness TEXT NOT NULL,
  session TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  offset INTEGER NOT NULL DEFAULT 0,  -- how far the transcript has been read
  n INTEGER NOT NULL DEFAULT 0,       -- the last step's number
  title TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'working',
  version INTEGER NOT NULL DEFAULT 1, -- goes up with each change
  sent INTEGER NOT NULL DEFAULT 0,    -- the version the board has
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (harness, session)
);
CREATE TABLE IF NOT EXISTS steps (
  harness TEXT NOT NULL,
  session TEXT NOT NULL,
  n INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (harness, session, n)
);
";

/// Where the live sessions are kept: beside the ledger.
pub fn live_path() -> PathBuf {
    default_path().with_file_name("live.sqlite3")
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub struct Live {
    db: Connection,
}

/// What a post to the board covers: the session (harness, id), its last step and its version.
pub type Covers = (String, String, i64, i64);

impl Live {
    pub fn open(path: &Path) -> Result<Live, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        let db = Connection::open(path).map_err(err)?;
        db.busy_timeout(std::time::Duration::from_secs(3)).map_err(err)?;
        db.execute_batch("PRAGMA journal_mode = WAL;").map_err(err)?;
        db.execute_batch(SCHEMA).map_err(err)?;
        Ok(Live { db })
    }

    /// Takes one hook's input (its JSON on stdin): the session's new steps, title and state. True
    /// when the board has something to catch up on.
    pub fn note(&self, harness: &str, input: &Value) -> Result<bool, String> {
        let str_of = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
        let session = str_of("session_id");
        let event = str_of("hook_event_name");
        if session.is_empty() {
            return Ok(false);
        }
        let status = match event {
            "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => "working",
            // A turn that ends to wait for its own background work is still at it.
            "Stop" if matches!(input.get("background_tasks"), Some(Value::Array(a)) if !a.is_empty()) => {
                "working"
            }
            "Stop" => "done",
            _ => return Ok(false),
        };
        let path = str_of("transcript_path");
        let project = project_of(str_of("cwd")).id;
        let prompt = str_of("prompt");
        let title = (event == "UserPromptSubmit" && from_the_owner(prompt))
            .then(|| clip(&redact(prompt), 300));

        let tx = self.db.unchecked_transaction().map_err(err)?;
        type Row = (String, i64, i64, String, String, String);
        let row: Option<Row> = tx
            .query_row(
                "SELECT path, offset, n, title, project, status FROM sessions WHERE harness = ?1 AND session = ?2",
                params![harness, session],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()
            .map_err(err)?;
        let len = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
        // First sight of a session: its history so far is skipped, but what the owner last asked
        // it names the run.
        let first = row.is_none();
        let (old_path, offset, mut n, old_title, old_project, old_status) =
            row.unwrap_or_else(|| (path.to_string(), len, 0, String::new(), String::new(), String::new()));
        // (A run still untitled, seen before this was added, gets its name when a turn ends.)
        let look = first || (old_title.is_empty() && event == "Stop");
        let title = title.or_else(|| look.then(|| last_ask(harness, path, len)).flatten());
        let offset = if old_path == path { offset } else { 0 };
        let (steps, read_to) = read_steps(harness, path, offset);
        let steps = &steps[steps.len().saturating_sub(MOST_A_READ)..];
        for (at, kind, text) in steps {
            n += 1;
            tx.execute(
                "INSERT OR REPLACE INTO steps (harness, session, n, at, kind, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![harness, session, n, at, kind, text],
            )
            .map_err(err)?;
        }
        let title = title.unwrap_or(old_title.clone());
        let changed = !steps.is_empty()
            || title != old_title
            || status != old_status
            || project != old_project;
        tx.execute(
            "INSERT INTO sessions (harness, session, path, offset, n, title, project, status, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (harness, session) DO UPDATE SET
               path = excluded.path, offset = excluded.offset, n = excluded.n, title = excluded.title,
               project = excluded.project, status = excluded.status, updated_at = excluded.updated_at,
               version = version + ?10",
            params![harness, session, path, read_to, n, title, project, status, now(), changed as i64],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(changed)
    }

    /// The next post the board needs, with what it covers (session, last step, version), if any.
    pub fn next_post(&self, machine: &str) -> Result<Option<(Value, Covers)>, String> {
        type Row = (String, String, String, String, String, i64);
        let row: Option<Row> = self
            .db
            .query_row(
                "SELECT harness, session, title, project, status, version FROM sessions s
                 WHERE sent < version
                    OR EXISTS (SELECT 1 FROM steps t WHERE t.harness = s.harness AND t.session = s.session)
                 ORDER BY updated_at LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()
            .map_err(err)?;
        let Some((harness, session, title, project, status, version)) = row else {
            return Ok(None);
        };
        let mut stmt = self
            .db
            .prepare(
                "SELECT n, at, kind, text FROM steps WHERE harness = ?1 AND session = ?2 ORDER BY n LIMIT ?3",
            )
            .map_err(err)?;
        let steps: Vec<Value> = stmt
            .query_map(params![harness, session, MOST_A_POST as i64], |r| {
                Ok(json!({"n": r.get::<_, i64>(0)?, "at": r.get::<_, i64>(1)?,
                          "kind": r.get::<_, String>(2)?, "text": r.get::<_, String>(3)?}))
            })
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        let through = steps.last().and_then(|s| s["n"].as_i64()).unwrap_or(0);
        let body = json!({
            "machine": machine, "run": format!("{harness}:{session}"), "agent": harness,
            "title": title, "project": project, "status": status, "steps": steps,
        });
        Ok(Some((body, (harness, session, through, version))))
    }

    /// The board took a post: its steps leave, and its version is the board's.
    pub fn sent(&self, (harness, session, through, version): &Covers) -> Result<(), String> {
        self.db
            .execute(
                "DELETE FROM steps WHERE harness = ?1 AND session = ?2 AND n <= ?3",
                params![harness, session, through],
            )
            .map_err(err)?;
        self.db
            .execute(
                "UPDATE sessions SET sent = MAX(sent, ?3) WHERE harness = ?1 AND session = ?2",
                params![harness, session, version],
            )
            .map_err(err)?;
        // Sessions quiet for a week are forgotten.
        self.db
            .execute(
                "DELETE FROM sessions WHERE updated_at < ?1 AND sent >= version",
                [now() - 7 * 86400],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Posts everything the board hasn't got, a post at a time; stops at the first that fails.
    pub fn send(&self, machine: &str, post: &mut impl FnMut(&Value) -> Result<(), String>) -> Result<usize, String> {
        let mut posts = 0;
        while let Some((body, covers)) = self.next_post(machine)? {
            post(&body)?;
            self.sent(&covers)?;
            posts += 1;
            if posts > 200 {
                break;
            }
        }
        Ok(posts)
    }
}

/// From a hook: notes it, and if the board has something to catch up on, starts a detached
/// `hive-tasks live-send`. Never fails the hook.
pub fn note_soon(harness: &str, input: &Value) {
    let changed = Live::open(&live_path()).and_then(|live| live.note(harness, input));
    match changed {
        Ok(true) => {}
        Ok(false) => return,
        Err(e) => {
            eprintln!("hive-tasks: live: {e}");
            return;
        }
    }
    if Cloud::load().is_none() || std::env::var_os("HIVE_TASKS_NO_SYNC").is_some() {
        return;
    }
    let me = std::env::current_exe()
        .ok()
        .filter(|p| p.file_name().is_some_and(|n| n == "hive-tasks"));
    let program = me.unwrap_or_else(|| hive_common::paths::home().join(".local/bin/hive-tasks"));
    let mut cmd = std::process::Command::new(program);
    cmd.arg("live-send")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let _ = cmd.spawn();
}

/// `hive-tasks live-send`: one sender at a time (a lock beside the live sessions); one started
/// while another runs leaves it to that one, which looks again after letting go of the lock.
pub fn send_now() -> Result<String, String> {
    let Some(cloud) = Cloud::load() else {
        return Ok(String::new());
    };
    let path = live_path();
    let live = Live::open(&path)?;
    let lock_path = path.with_file_name("live-send.lock");
    let mut posts = 0;
    for _ in 0..20 {
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)
            .map_err(err)?;
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Ok(String::new()); // another sender has it
        }
        posts += live.send(&cloud.machine, &mut |body| cloud.post("/v1/runs", body).map(|_| ()))?;
        drop(lock);
        // Something noted while the lock was held, by a hook whose sender found it taken.
        if live.next_post(&cloud.machine)?.is_none() {
            break;
        }
    }
    Ok(format!("{posts} posts"))
}

/// The owner's last message in the transcript's last few megabytes (where a session first seen
/// mid-turn was asked what it is doing).
fn last_ask(harness: &str, path: &str, len: i64) -> Option<String> {
    let from = (len - 4 * 1024 * 1024).max(0);
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(from as u64)).ok()?;
    let mut last = None;
    for line in BufReader::new(file.take((len - from) as u64)).lines().skip((from > 0) as usize) {
        let Ok(line) = line else { break };
        if let Some((text, _)) = owner_message(harness, &line) {
            if from_the_owner(&text) {
                last = Some(text);
            }
        }
    }
    last.map(|t| clip(&redact(&t), 300))
}

/// The steps in `path` from `offset` on (whole lines only), and how far that read.
pub fn read_steps(harness: &str, path: &str, offset: i64) -> (Vec<(i64, String, String)>, i64) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return (vec![], offset);
    };
    let len = file.metadata().map(|m| m.len() as i64).unwrap_or(0);
    let start = offset.clamp(0, len);
    if file.seek(SeekFrom::Start(start as u64)).is_err() {
        return (vec![], offset);
    }
    let mut reader = BufReader::new(file.take((len - start) as u64));
    let (mut pos, mut steps) = (start, vec![]);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(n) if n > 0 && line.ends_with('\n') => {
                pos += n as i64;
                steps.extend(steps_of(harness, &line));
            }
            _ => break, // a line still being written is read next time
        }
    }
    (steps, pos)
}

/// What one transcript line adds to the session's run: `(at, kind, text)` for each thing the owner
/// said, the agent said, thought aloud or did.
pub fn steps_of(harness: &str, line: &str) -> Vec<(i64, String, String)> {
    let mut out = vec![];
    if let Some((text, at)) = owner_message(harness, line) {
        out.push((at.unwrap_or_else(now), "asked".to_string(), clip(&redact(&text), MOST_TEXT)));
        return out;
    }
    let Ok(d) = serde_json::from_str::<Value>(line) else {
        return out;
    };
    let at = d
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso_utc)
        .unwrap_or_else(now);
    let mut push = |kind: &str, text: String| {
        let text = clip(&redact(&home_short(&text)), MOST_TEXT);
        if !text.is_empty() {
            out.push((at, kind.to_string(), text));
        }
    };
    if harness == "codex" {
        if d["type"] != "response_item" {
            return out;
        }
        let p = &d["payload"];
        match p["type"].as_str().unwrap_or("") {
            "message" if p["role"] == "assistant" => {
                for part in p["content"].as_array().into_iter().flatten() {
                    if let Some(t) = part["text"].as_str() {
                        push("say", t.to_string());
                    }
                }
            }
            "reasoning" => {
                for part in p["summary"].as_array().into_iter().flatten() {
                    if let Some(t) = part["text"].as_str() {
                        push("think", t.to_string());
                    }
                }
            }
            "function_call" => {
                let name = match p["namespace"].as_str() {
                    Some(ns) if !ns.is_empty() => format!("{ns}.{}", p["name"].as_str().unwrap_or("")),
                    _ => p["name"].as_str().unwrap_or("").to_string(),
                };
                let args = p["arguments"]
                    .as_str()
                    .and_then(|a| serde_json::from_str(a).ok())
                    .unwrap_or(Value::Null);
                push("action", tool_step(&name, &args));
            }
            "custom_tool_call" => {
                let name = p["name"].as_str().unwrap_or("");
                let input = p["input"].as_str().unwrap_or("");
                push("action", tool_step(name, &json!({"input": input})));
            }
            "local_shell_call" => push("action", tool_step("shell", &p["action"])),
            "web_search_call" => push("action", tool_step("web_search", &p["action"])),
            _ => {}
        }
        return out;
    }
    // Claude Code: the agent's own lines (a subagent's are in its own file).
    if d["isSidechain"] == true {
        return out;
    }
    let parts = d["message"]["content"].as_array().cloned().unwrap_or_default();
    match d["type"].as_str().unwrap_or("") {
        "assistant" => {
            for part in &parts {
                match part["type"].as_str().unwrap_or("") {
                    "text" => push("say", part["text"].as_str().unwrap_or("").to_string()),
                    "tool_use" => push(
                        "action",
                        tool_step(part["name"].as_str().unwrap_or(""), &part["input"]),
                    ),
                    _ => {}
                }
            }
        }
        "user" => {
            for part in &parts {
                if part["type"] == "tool_result" && part["is_error"] == true {
                    let said = match &part["content"] {
                        Value::String(s) => s.clone(),
                        Value::Array(a) => a
                            .iter()
                            .filter_map(|p| p["text"].as_str())
                            .collect::<Vec<_>>()
                            .join(" "),
                        _ => String::new(),
                    };
                    let first = said.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
                    push("failed", first);
                }
            }
        }
        _ => {}
    }
    out
}

static PATCH_FILE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$").expect("valid pattern")
});

/// One tool call as a line on the board: "$ git status", "Edit src/live.rs", "Read ~/notes.md",
/// "mac.click: x=367, y=472".
pub fn tool_step(name: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let short = name.rsplit("__").next().unwrap_or(name);
    match name {
        "Bash" | "exec_command" => format!("$ {}", first_line(&if s("command").is_empty() { s("cmd") } else { s("command") })),
        "shell" | "local_shell" => {
            let command = match &input["command"] {
                Value::Array(a) => a.last().and_then(Value::as_str).unwrap_or("").to_string(),
                Value::String(c) => c.clone(),
                _ => String::new(),
            };
            format!("$ {}", first_line(&command))
        }
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" | "NotebookRead" => {
            let path = if s("file_path").is_empty() { s("notebook_path") } else { s("file_path") };
            format!("{name} {path}")
        }
        "apply_patch" => {
            let patch = if s("input").is_empty() { s("patch") } else { s("input") };
            let files: Vec<&str> = PATCH_FILE
                .captures_iter(&patch)
                .filter_map(|c| c.get(1).map(|m| m.as_str()))
                .collect();
            format!("Edit {}", files.join(", "))
        }
        "Grep" => format!("Search for \"{}\"{}", s("pattern"), in_place(&s("path"))),
        "Glob" => format!("Find {}{}", s("pattern"), in_place(&s("path"))),
        "WebFetch" => format!("Open {}", s("url")),
        "WebSearch" => format!("Search the web: {}", s("query")),
        "Agent" | "Task" => format!("Agent: {}", s("description")),
        "Skill" => format!("Skill: {}", s("skill")),
        "exec" => format!("Run code: {}", first_line(&s("input"))),
        _ => {
            // Anything else: its name and the first thing it was told.
            let said = ["step", "description", "command", "cmd", "query", "q", "url", "path", "text", "title", "name", "action"]
                .iter()
                .map(|k| s(k))
                .find(|v| !v.is_empty())
                .unwrap_or_else(|| match input {
                    Value::Object(m) if !m.is_empty() => m
                        .iter()
                        .take(4)
                        .map(|(k, v)| match v {
                            Value::String(t) => format!("{k}={t}"),
                            other => format!("{k}={other}"),
                        })
                        .collect::<Vec<_>>()
                        .join(", "),
                    _ => String::new(),
                });
            if said.is_empty() { short.to_string() } else { format!("{short}: {}", first_line(&said)) }
        }
    }
}

fn in_place(path: &str) -> String {
    if path.is_empty() { String::new() } else { format!(" in {path}") }
}

fn first_line(text: &str) -> String {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next().unwrap_or("").to_string();
    if lines.next().is_some() { format!("{first} …") } else { first }
}

/// The owner's home folder as "~" (their user name stays off the board).
fn home_short(text: &str) -> String {
    let home = hive_common::paths::home();
    let home = home.to_string_lossy();
    if home.len() > 1 { text.replace(home.as_ref(), "~") } else { text.to_string() }
}

fn clip(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        text
    } else {
        format!("{}…", text.chars().take(max).collect::<String>().trim_end())
    }
}
