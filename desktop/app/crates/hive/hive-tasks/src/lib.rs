//! The owner's instructions to every coding agent (Claude Code, Codex, Hive's own), kept so none
//! is lost.
//!
//! The owner gives an agent ten things in one message, then ten more while it is still on the
//! first, and the agent drops some: the owner ends up remembering and resending them. This keeps
//! every message the owner sends, word for word; the separate tasks the agent splits it into, each
//! quoting the owner's words, with an estimate, a value, a state and a report; and the owner's
//! standing rules, each scoped to the paths it is about. One SQLite file in Hive's state folder
//! (`tasks/tasks.sqlite3`; `HIVE_TASKS_DB` names another).
//!
//! The harnesses' hooks do the enforcing (`hive-tasks hook claude|codex`, the same protocol in
//! both):
//!
//! - UserPromptSubmit saves the message and asks the agent to register its tasks.
//! - Stop saves any message the prompt hook never saw (one queued while the agent worked) and keeps
//!   the agent going while a message has no tasks registered or a task is still open. The same
//!   unchanged list twice in a row lets the stop through, and its tasks are marked left open.
//! - PreToolUse on a file edit shows the rules whose paths match that file, once a session, so a
//!   rule reaches the agent exactly when it applies instead of sitting in a text file that may or
//!   may not be loaded.
//! - SessionStart puts this session's open tasks back after compaction, and names the project's
//!   open tasks from other sessions and its project-wide rules.
//!
//! A session's history from before Hive first saw it is skipped, not imported.

pub mod usage;

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

/// Every task state. `open` and `active` still need the agent; `waiting` means it asked the
/// owner something, `blocked` that something else is in the way, `dropped` that the owner
/// withdrew it.
pub const STATUSES: [&str; 6] = ["open", "active", "done", "waiting", "blocked", "dropped"];
pub const VALUES: [&str; 3] = ["low", "medium", "high"];
/// The same open list blocking a stop this many times in a row lets the next stop through.
pub const MAX_SAME_BLOCKS: i64 = 2;
/// A task worth less than this many minutes of work at low value is flagged worth asking about.
pub const ASK_MINUTES: i64 = 30;
/// The board's project for what the owner asks Hive's own agent (by voice or typed).
pub const HIVE_PROJECT: &str = "Hive";
/// How many tasks a hook names before it says how many more.
const LIST_MAX: usize = 12;
/// A folder's memories longer than this go in a file the agent is told to read whole.
pub const BRIEF_INLINE: usize = 24_000;
/// What a memory can be.
pub const MEMORY_KINDS: [&str; 4] = ["note", "spec", "decision", "report"];

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  harness TEXT NOT NULL,
  session TEXT NOT NULL,
  project TEXT NOT NULL,
  -- The text normalised (lower case words, first 300 characters): the same message seen by the
  -- prompt hook and in the transcript is stored once.
  text_key TEXT NOT NULL,
  text TEXT NOT NULL,
  said_at INTEGER NOT NULL,
  -- How many times the owner sent it: more than once means an agent made them repeat it.
  times INTEGER NOT NULL DEFAULT 1,
  -- When the agent registered its tasks (possibly none).
  split_at INTEGER,
  UNIQUE (harness, session, text_key)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  message INTEGER NOT NULL REFERENCES messages(id),
  quote TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  minutes INTEGER,
  value TEXT,
  outcome TEXT,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER,
  left_open_at INTEGER
);
CREATE TABLE IF NOT EXISTS task_events (
  task INTEGER NOT NULL REFERENCES tasks(id),
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  message INTEGER REFERENCES messages(id),
  project TEXT NOT NULL,
  -- JSON array of globs relative to the project; empty means the whole project.
  paths TEXT NOT NULL DEFAULT '[]',
  text TEXT NOT NULL,
  quote TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  shown INTEGER NOT NULL DEFAULT 0,
  last_shown_at INTEGER
);
CREATE TABLE IF NOT EXISTS rule_shown (
  session TEXT NOT NULL,
  rule INTEGER NOT NULL,
  PRIMARY KEY (session, rule)
);
CREATE TABLE IF NOT EXISTS scans (
  session TEXT NOT NULL,
  path TEXT NOT NULL,
  offset INTEGER NOT NULL,
  PRIMARY KEY (session, path)
);
CREATE TABLE IF NOT EXISTS stop_blocks (
  session TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  count INTEGER NOT NULL
);
-- What changed since the last push to the owner's cloud copy (`hive-tasks sync`), kept by the
-- triggers below.
CREATE TABLE IF NOT EXISTS outbox (
  kind TEXT NOT NULL,
  id INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
-- Rules set on the owner's other machines: their cloud name (\"vm:3\") and their row here, which
-- has no message and is never pushed back.
CREATE TABLE IF NOT EXISTS remote_rules (
  origin TEXT PRIMARY KEY,
  rule INTEGER NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS messages_added AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO outbox (kind, id) VALUES ('message', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS messages_changed AFTER UPDATE ON messages BEGIN
  INSERT OR IGNORE INTO outbox (kind, id) VALUES ('message', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS tasks_added AFTER INSERT ON tasks BEGIN
  INSERT OR IGNORE INTO outbox (kind, id) VALUES ('task', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS tasks_changed AFTER UPDATE ON tasks BEGIN
  INSERT OR IGNORE INTO outbox (kind, id) VALUES ('task', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS rules_added AFTER INSERT ON rules WHEN NEW.message IS NOT NULL BEGIN
  INSERT OR IGNORE INTO outbox (kind, id) VALUES ('rule', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS rules_changed AFTER UPDATE ON rules
  WHEN NEW.id NOT IN (SELECT rule FROM remote_rules) BEGIN
  INSERT OR IGNORE INTO outbox (kind, id) VALUES ('rule', NEW.id);
END;
-- Folders: the parts of a project (memory retrieval, major requirements validation), each holding
-- its tasks and its own memories. A project here is its short name in lower case (hive), the same
-- on every machine and on the web.
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  about TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 'cloud' when it came from another machine or the web: never pushed back.
  origin TEXT,
  UNIQUE (project, key)
);
-- What an agent put on a folder has to know, all of it loaded every time: notes, specs, decisions
-- and the reports of the folder's done tasks.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  folder TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  task TEXT,
  created_at INTEGER NOT NULL,
  -- Its cloud name (vm:3, web:2) when it came from elsewhere: never pushed back.
  origin TEXT UNIQUE
);
CREATE TRIGGER IF NOT EXISTS folders_added AFTER INSERT ON folders WHEN NEW.origin IS NULL BEGIN
  INSERT OR IGNORE INTO outbox (kind, id) VALUES ('folder', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS folders_changed AFTER UPDATE ON folders WHEN NEW.origin IS NULL BEGIN
  INSERT OR IGNORE INTO outbox (kind, id) VALUES ('folder', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS memories_added AFTER INSERT ON memories WHEN NEW.origin IS NULL BEGIN
  INSERT OR IGNORE INTO outbox (kind, id) VALUES ('memory', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS memories_changed AFTER UPDATE ON memories WHEN NEW.origin IS NULL BEGIN
  INSERT OR IGNORE INTO outbox (kind, id) VALUES ('memory', NEW.id);
END;
CREATE INDEX IF NOT EXISTS memories_folder ON memories (project, folder);
CREATE INDEX IF NOT EXISTS tasks_message ON tasks (message);
CREATE INDEX IF NOT EXISTS messages_session ON messages (harness, session);
";

/// Where the owner's cloud copy is and how this machine signs in to it: ~/.config/hive/tasks.json
/// (or `HIVE_TASKS_CLOUD`), `{"url", "token", "machine"}`. No file, no cloud copy.
pub struct Cloud {
    pub url: String,
    token: String,
    pub machine: String,
}

impl Cloud {
    pub fn load() -> Option<Cloud> {
        let path = std::env::var_os("HIVE_TASKS_CLOUD")
            .map(PathBuf::from)
            .unwrap_or_else(|| hive_common::paths::home().join(".config/hive/tasks.json"));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
        let url = str_of(&v, "url").trim_end_matches('/').to_string();
        let token = str_of(&v, "token").to_string();
        if url.is_empty() || token.is_empty() {
            return None;
        }
        let machine = match str_of(&v, "machine") {
            "" => std::process::Command::new("hostname")
                .arg("-s")
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default(),
            m => m.to_string(),
        };
        Some(Cloud {
            url,
            token,
            machine,
        })
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        let answer = ureq::post(&format!("{}{path}", self.url))
            .set("authorization", &format!("Bearer {}", self.token))
            .set("user-agent", "hive-tasks")
            .timeout(Duration::from_secs(20))
            .send_json(body);
        Self::answer(answer)
    }

    /// `GET path` on the cloud copy, signed in as this machine.
    pub fn get(&self, path: &str) -> Result<Value, String> {
        let answer = ureq::get(&format!("{}{path}", self.url))
            .set("authorization", &format!("Bearer {}", self.token))
            .set("user-agent", "hive-tasks")
            .timeout(Duration::from_secs(10))
            .call();
        Self::answer(answer)
    }

    fn answer(answer: Result<ureq::Response, ureq::Error>) -> Result<Value, String> {
        match answer {
            Ok(r) => r
                .into_json()
                .map_err(|e| format!("The cloud's answer isn't JSON: {e}")),
            Err(ureq::Error::Status(code, r)) => Err(format!(
                "The cloud said {code}: {}",
                clip(&r.into_string().unwrap_or_default(), 200)
            )),
            Err(e) => Err(format!("Couldn't reach the cloud: {e}")),
        }
    }
}

/// Pushes the ledger at `path` to the cloud in the background, if it is this machine's ledger
/// and there is a cloud copy: a detached `hive-tasks sync` (one at a time; it catches up on
/// whatever changed while another ran).
pub fn sync_soon(path: &Path) {
    if path != default_path()
        || Cloud::load().is_none()
        || std::env::var_os("HIVE_TASKS_NO_SYNC").is_some()
    {
        return;
    }
    let me = std::env::current_exe()
        .ok()
        .filter(|p| p.file_name().is_some_and(|n| n == "hive-tasks"));
    let program = me.unwrap_or_else(|| hive_common::paths::home().join(".local/bin/hive-tasks"));
    let mut cmd = std::process::Command::new(program);
    cmd.args(["sync", "--quiet"])
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

pub fn default_path() -> PathBuf {
    std::env::var_os("HIVE_TASKS_DB")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| hive_common::paths::state_dir().join("tasks/tasks.sqlite3"))
}

pub struct Ledger {
    db: Connection,
    /// The ledger's folder (long folder briefs are written in it).
    dir: PathBuf,
    /// How an agent runs this program, named in what the hooks tell it.
    pub command: String,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Ledger {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
            private(dir, 0o700);
        }
        let db = Connection::open(path).map_err(err)?;
        db.busy_timeout(Duration::from_secs(5)).map_err(err)?;
        db.execute_batch(SCHEMA).map_err(err)?;
        // Columns added since the first ledgers: what each task cost, the folder it's in (first
        // called its part) and its report.
        let has = |column: &str| -> Result<bool, String> {
            db.query_row("SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = ?1", [column], |r| r.get::<_, i64>(0))
                .map(|n| n > 0)
                .map_err(err)
        };
        if has("part")? && !has("folder")? {
            db.execute_batch("ALTER TABLE tasks RENAME COLUMN part TO folder").map_err(err)?;
        }
        for (column, kind) in [("work_seconds", "INTEGER"), ("tokens_in", "INTEGER"), ("tokens_out", "INTEGER"), ("folder", "TEXT"), ("report", "TEXT")] {
            if !has(column)? {
                db.execute_batch(&format!("ALTER TABLE tasks ADD COLUMN {column} {kind}")).map_err(err)?;
            }
        }
        private(path, 0o600);
        Ok(Self {
            db,
            dir: path.parent().map(Path::to_path_buf).unwrap_or_default(),
            command: command_name(),
        })
    }

    // ---- messages ------------------------------------------------------------------------------

    /// Saves a message the owner sent; the same text again in the same session is the same
    /// message. Returns its id and whether it was new.
    pub fn save_message(
        &self,
        harness: &str,
        session: &str,
        project: &str,
        text: &str,
        at: i64,
        count_repeat: bool,
    ) -> Result<(i64, bool), String> {
        let text = redact(text.trim());
        let key = text_key(&text);
        let added = self
            .db
            .execute(
                "INSERT OR IGNORE INTO messages (harness, session, project, text_key, text, said_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![harness, session, project, key, text, at],
            )
            .map_err(err)?;
        let id: i64 = self
            .db
            .query_row(
                "SELECT id FROM messages WHERE harness = ?1 AND session = ?2 AND text_key = ?3",
                params![harness, session, key],
                |r| r.get(0),
            )
            .map_err(err)?;
        if added == 0 && count_repeat {
            self.db
                .execute("UPDATE messages SET times = times + 1 WHERE id = ?1", [id])
                .map_err(err)?;
        }
        Ok((id, added > 0))
    }

    fn message(&self, id: i64) -> Result<Value, String> {
        self.db
            .query_row(
                "SELECT id, harness, session, project, text, said_at, times, split_at FROM messages
                 WHERE id = ?1",
                [id],
                |r| {
                    Ok(json!({
                        "id": format!("M{}", r.get::<_, i64>(0)?),
                        "harness": r.get::<_, String>(1)?,
                        "session": r.get::<_, String>(2)?,
                        "project": r.get::<_, String>(3)?,
                        "text": r.get::<_, String>(4)?,
                        "said_at": iso(r.get(5)?),
                        "times": r.get::<_, i64>(6)?,
                        "split": r.get::<_, Option<i64>>(7)?.is_some(),
                    }))
                },
            )
            .optional()
            .map_err(err)?
            .ok_or_else(|| format!("No message M{id}."))
    }

    // ---- tasks and rules -----------------------------------------------------------------------

    /// Registers what message `message` asks for: a JSON list of
    /// `{quote, title, minutes?, value?, kind?: "task"|"rule", paths?: [glob]}`. Every quote must
    /// be the owner's own words from that message. An empty list says it asks for nothing.
    pub fn add(&self, message: i64, entries: &Value) -> Result<Vec<String>, String> {
        let msg = self.message(message)?;
        let list = entries
            .as_array()
            .ok_or("Give a JSON list ([] if the message asks for nothing).")?;
        let said = words(msg["text"].as_str().unwrap_or(""));
        let project = msg["project"].as_str().unwrap_or("").to_string();
        let mut checked = Vec::new();
        for (i, e) in list.iter().enumerate() {
            let n = i + 1;
            let quote = str_of(e, "quote").trim().to_string();
            let title = str_of(e, "title").trim().to_string();
            if quote.is_empty() || title.is_empty() {
                return Err(format!("Entry {n} needs a quote and a title."));
            }
            if !said.contains(&words(&quote)) {
                return Err(format!(
                    "Entry {n}'s quote isn't in M{message}: copy the owner's exact words."
                ));
            }
            let kind = match e.get("kind").and_then(Value::as_str).unwrap_or("task") {
                k @ ("task" | "rule") => k,
                other => return Err(format!("Entry {n}: kind is task or rule, not {other:?}.")),
            };
            let minutes = match e.get("minutes") {
                None | Some(Value::Null) => None,
                Some(v) => Some(
                    v.as_i64()
                        .filter(|m| *m >= 0)
                        .ok_or(format!("Entry {n}: minutes is a whole number."))?,
                ),
            };
            let value = match e.get("value").and_then(Value::as_str) {
                None => None,
                Some(v) if VALUES.contains(&v) => Some(v.to_string()),
                Some(v) => {
                    return Err(format!(
                        "Entry {n}: value is low, medium or high, not {v:?}."
                    ))
                }
            };
            let paths: Vec<String> = match e.get("paths") {
                None | Some(Value::Null) => vec![],
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|p| p.as_str())
                    .map(|p| p.trim().trim_start_matches("./").to_string())
                    .filter(|p| !p.is_empty())
                    .collect(),
                Some(_) => return Err(format!("Entry {n}: paths is a list of globs.")),
            };
            let named = match str_of(e, "folder").trim() {
                "" => str_of(e, "part").trim(),
                f => f,
            };
            let folder = folder_place(&project, named);
            checked.push((kind, quote, clip(&title, 200), minutes, value, paths, folder));
        }
        let now = now();
        let mut out = Vec::new();
        let mut places: Vec<(String, String)> = Vec::new();
        for (kind, quote, title, minutes, value, paths, folder) in checked {
            if kind == "rule" {
                self.db
                    .execute(
                        "INSERT INTO rules (message, project, paths, text, quote, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            message,
                            project,
                            json!(paths).to_string(),
                            title,
                            quote,
                            now
                        ],
                    )
                    .map_err(err)?;
                let scope = if paths.is_empty() {
                    "whole project".to_string()
                } else {
                    paths.join(", ")
                };
                out.push(format!(
                    "R{} rule ({scope}): {title}",
                    self.db.last_insert_rowid()
                ));
            } else {
                // A task in another project's folder names that project ("hive › memory retrieval").
                let folder = match folder {
                    Some((p, name)) => {
                        let name = self.ensure_folder(&p, &name)?;
                        if !places.contains(&(p.clone(), name.clone())) {
                            places.push((p.clone(), name.clone()));
                        }
                        if p == project_key(&project) { name } else { format!("{p} › {name}") }
                    }
                    None => String::new(),
                };
                self.db
                    .execute(
                        "INSERT INTO tasks (message, quote, title, minutes, value, created_at, updated_at, folder)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULLIF(?7, ''))",
                        params![message, quote, title, minutes, value, now, folder],
                    )
                    .map_err(err)?;
                let id = self.db.last_insert_rowid();
                self.event(id, "open", None)?;
                out.push(format!("T{id} {title}"));
            }
        }
        self.db
            .execute(
                "UPDATE messages SET split_at = COALESCE(split_at, ?2) WHERE id = ?1",
                params![message, now],
            )
            .map_err(err)?;
        if out.is_empty() {
            out.push(format!("M{message}: no tasks."));
        }
        // Everything the folders know, loaded in full for the agent about to work in them.
        for (p, name) in places {
            out.push(self.folder_brief(&p, &name)?);
        }
        Ok(out)
    }

    /// Reports on tasks: a JSON list of `{id: "T3", status, outcome?, evidence?, minutes?,
    /// report?}`. done, waiting, blocked and dropped need an outcome saying what happened or what
    /// on. A task that's done gets a report (the agent's, else its outcome), with what it cost,
    /// kept on the task and in its folder's memories.
    pub fn report(&self, entries: &Value) -> Result<Vec<String>, String> {
        let list = entries.as_array().ok_or("Give a JSON list of reports.")?;
        let mut checked = Vec::new();
        for e in list {
            let id = task_id(str_of(e, "id"))?;
            let status = str_of(e, "status");
            if !STATUSES.contains(&status) {
                return Err(format!("T{id}: status is one of {}.", STATUSES.join(", ")));
            }
            let outcome = str_of(e, "outcome").trim().to_string();
            if !matches!(status, "open" | "active") && outcome.is_empty() {
                return Err(format!(
                    "T{id}: say what happened (outcome) when it's {status}."
                ));
            }
            let exists: Option<i64> = self
                .db
                .query_row("SELECT id FROM tasks WHERE id = ?1", [id], |r| r.get(0))
                .optional()
                .map_err(err)?;
            if exists.is_none() {
                return Err(format!("No task T{id}."));
            }
            let evidence = str_of(e, "evidence").trim().to_string();
            let minutes = e.get("minutes").and_then(Value::as_i64);
            let report = str_of(e, "report").trim().to_string();
            checked.push((id, status.to_string(), outcome, evidence, minutes, report));
        }
        let now = now();
        let closing: Vec<(i64, String)> = checked.iter().map(|c| (c.0, c.1.clone())).collect();
        self.charge(&closing, now)?;
        let mut out = Vec::new();
        for (id, status, outcome, evidence, minutes, report) in checked {
            self.db
                .execute(
                    "UPDATE tasks SET status = ?2, outcome = COALESCE(NULLIF(?3, ''), outcome),
                       evidence = COALESCE(NULLIF(?4, ''), evidence), minutes = COALESCE(?5, minutes),
                       updated_at = ?6, done_at = CASE WHEN ?2 = 'done' THEN ?6 ELSE NULL END,
                       left_open_at = CASE WHEN ?2 IN ('open', 'active') THEN left_open_at ELSE NULL END
                     WHERE id = ?1",
                    params![id, status, clip(&outcome, 2000), clip(&evidence, 2000), minutes, now],
                )
                .map_err(err)?;
            self.event(
                id,
                &status,
                Some(&outcome).filter(|o| !o.is_empty()).map(|o| o.as_str()),
            )?;
            if status == "done" {
                self.file_report(id, &report)?;
            }
            out.push(format!("T{id} {status}"));
        }
        Ok(out)
    }

    /// Writes a done task's report: what came of it (the agent's report, else its outcome), its
    /// evidence and what it cost. Kept on the task and, for a task in a folder, as one of the
    /// folder's memories (the same memory, rewritten, if the task is reported done again).
    fn file_report(&self, id: i64, given: &str) -> Result<(), String> {
        type Row = (String, Option<String>, Option<String>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<String>, String);
        let (title, outcome, evidence, minutes, secs, tokens_in, tokens_out, folder, project): Row = self
            .db
            .query_row(
                "SELECT t.title, t.outcome, t.evidence, t.minutes, t.work_seconds, t.tokens_in, t.tokens_out,
                        t.folder, m.project
                 FROM tasks t JOIN messages m ON m.id = t.message WHERE t.id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
            )
            .map_err(err)?;
        let mut text = match given {
            "" => outcome.unwrap_or_default(),
            given => given.to_string(),
        };
        if let Some(e) = evidence.filter(|e| !e.trim().is_empty()) {
            text.push_str(&format!("\nEvidence: {e}"));
        }
        let mut cost = Vec::new();
        if let Some(s) = secs.filter(|s| *s > 0) {
            cost.push(match minutes {
                Some(m) => format!("took {} (estimated {})", span(s), span(m * 60)),
                None => format!("took {}", span(s)),
            });
        }
        if let (Some(i), Some(o)) = (tokens_in, tokens_out) {
            if i + o > 0 {
                cost.push(format!("{} tokens read, {} written", token_count(i), token_count(o)));
            }
        }
        if !cost.is_empty() {
            text.push_str(&format!("\nCost: {}.", cost.join("; ")));
        }
        let text = clip(text.trim(), 6000);
        self.db
            .execute("UPDATE tasks SET report = ?2 WHERE id = ?1", params![id, text])
            .map_err(err)?;
        let Some((p, name)) = folder.and_then(|f| folder_place(&project, &f)) else {
            return Ok(());
        };
        let name = self.ensure_folder(&p, &name)?;
        let task = format!("T{id}");
        let title = format!("{task} {title}");
        let updated = self
            .db
            .execute(
                "UPDATE memories SET title = ?2, body = ?3, project = ?4, folder = ?5
                 WHERE task = ?1 AND kind = 'report' AND origin IS NULL",
                params![task, title, text, p, name.to_lowercase()],
            )
            .map_err(err)?;
        if updated == 0 {
            self.db
                .execute(
                    "INSERT INTO memories (project, folder, kind, title, body, task, created_at)
                     VALUES (?1, ?2, 'report', ?3, ?4, ?5, ?6)",
                    params![p, name.to_lowercase(), title, text, task, now()],
                )
                .map_err(err)?;
        }
        Ok(())
    }

    // ---- folders -------------------------------------------------------------------------------

    /// Makes the folder if it's new; returns its name as it was first written.
    pub fn ensure_folder(&self, project: &str, name: &str) -> Result<String, String> {
        let at = now();
        self.db
            .execute(
                "INSERT OR IGNORE INTO folders (project, key, name, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![project, name.to_lowercase(), name, at],
            )
            .map_err(err)?;
        self.db
            .query_row(
                "SELECT name FROM folders WHERE project = ?1 AND key = ?2",
                params![project, name.to_lowercase()],
                |r| r.get(0),
            )
            .map_err(err)
    }

    /// Says what a folder is for (shown above its memories).
    pub fn describe_folder(&self, project: &str, name: &str, about: &str) -> Result<String, String> {
        let name = self.ensure_folder(project, name)?;
        self.db
            .execute(
                "UPDATE folders SET about = ?3, updated_at = ?4, origin = NULL WHERE project = ?1 AND key = ?2",
                params![project, name.to_lowercase(), clip(about.trim(), 2000), now()],
            )
            .map_err(err)?;
        Ok(format!("{project} › {name}: described."))
    }

    /// Every folder (of one project, or all), with how many memories each holds.
    pub fn folders(&self, project: Option<&str>) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .db
            .prepare(
                "SELECT f.project, f.key, f.name, f.about, f.updated_at,
                        (SELECT COUNT(*) FROM memories m WHERE m.project = f.project AND m.folder = f.key)
                 FROM folders f WHERE ?1 IS NULL OR f.project = ?1 ORDER BY f.project, f.key",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([project], |r| {
                Ok(json!({
                    "project": r.get::<_, String>(0)?,
                    "key": r.get::<_, String>(1)?,
                    "name": r.get::<_, String>(2)?,
                    "about": r.get::<_, String>(3)?,
                    "updated_at": iso(r.get(4)?),
                    "memories": r.get::<_, i64>(5)?,
                }))
            })
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    /// A folder's memories, oldest first.
    pub fn memories(&self, project: &str, key: &str) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .db
            .prepare(
                "SELECT id, kind, title, body, task, created_at, origin FROM memories
                 WHERE project = ?1 AND folder = ?2 ORDER BY created_at, id",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([project, key], |r| {
                let origin: Option<String> = r.get(6)?;
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "title": r.get::<_, String>(2)?,
                    "body": r.get::<_, String>(3)?,
                    "task": r.get::<_, Option<String>>(4)?,
                    "created_at": iso(r.get(5)?),
                    "from": origin.as_deref().and_then(|o| o.split(':').next()),
                }))
            })
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    /// Puts a memory on a folder (made if new): `kind` is note, spec, decision or report; the
    /// body's first line is its title.
    pub fn remember(&self, project: &str, name: &str, kind: &str, body: &str) -> Result<String, String> {
        if !MEMORY_KINDS.contains(&kind) {
            return Err(format!("A memory is a {}, not {kind:?}.", MEMORY_KINDS.join(", ")));
        }
        let body = redact(body.trim());
        if body.is_empty() {
            return Err("Nothing to remember (give the memory on stdin; its first line is its title).".into());
        }
        let (title, rest) = body.split_once('\n').unwrap_or((body.as_str(), ""));
        let title = clip(title.trim().trim_start_matches('#').trim(), 200);
        let rest = rest.trim();
        let name = self.ensure_folder(project, name)?;
        self.db
            .execute(
                "INSERT INTO memories (project, folder, kind, title, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![project, name.to_lowercase(), kind, title, clip(if rest.is_empty() { &title } else { rest }, 60_000), now()],
            )
            .map_err(err)?;
        Ok(format!("Saved to {project} › {name} as a {kind}: {title}"))
    }

    /// Everything an agent put on a folder has to know, in full: what the folder is for and every
    /// one of its memories, saying how many there are, so nothing is left wondering whether they
    /// were all loaded. Past [`BRIEF_INLINE`] characters they go in a file to read whole.
    pub fn folder_brief(&self, project: &str, name: &str) -> Result<String, String> {
        let key = name.to_lowercase();
        let (name, about): (String, String) = self
            .db
            .query_row(
                "SELECT name, about FROM folders WHERE project = ?1 AND key = ?2",
                params![project, key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?
            .unwrap_or_else(|| (name.to_string(), String::new()));
        let place = format!("{project} › {name}");
        let about = if about.trim().is_empty() { String::new() } else { format!("\nWhat it's for: {}", about.trim()) };
        let list = self.memories(project, &key)?;
        let n = list.len();
        if n == 0 {
            return Ok(format!("Hive folder \"{place}\": no memories yet, so nothing earlier to load.{about}"));
        }
        let mut text = String::new();
        for (i, m) in list.iter().enumerate() {
            text.push_str(&format!(
                "--- {}/{n} · {} · {} · {} ---\n{}\n",
                i + 1,
                m["kind"].as_str().unwrap_or(""),
                m["title"].as_str().unwrap_or(""),
                m["created_at"].as_str().unwrap_or("").get(..10).unwrap_or(""),
                m["body"].as_str().unwrap_or("").trim_end()
            ));
        }
        let all = if n == 1 { "its 1 memory".to_string() } else { format!("all {n} of its memories") };
        let chars = text.chars().count();
        if chars <= BRIEF_INLINE {
            return Ok(format!(
                "Hive folder \"{place}\": {all}, in full. Read every one before working in it.{about}\n{text}--- end of \"{place}\" ({n} of {n}) ---"
            ));
        }
        let dir = self.dir.join("folders");
        std::fs::create_dir_all(&dir).map_err(err)?;
        let slug: String = format!("{project}--{key}")
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
            .collect();
        let file = dir.join(format!("{slug}.md"));
        std::fs::write(&file, format!("# {place}{about}\n\n{text}--- end ({n} of {n}) ---\n")).map_err(err)?;
        private(&file, 0o600);
        Ok(format!(
            "Hive folder \"{place}\": {all} ({chars} characters, too long to show here) are in {}. Read that whole file before working in it.",
            file.display()
        ))
    }

    /// The folder a request names ("For hive › memory retrieval: …", as the dashboard sends it),
    /// with all its memories, for Hive's own agent to read with the request.
    pub fn folder_context(&self, text: &str) -> Option<String> {
        let (p, name) = addressed_folder(text)?;
        let name = self.ensure_folder(&p, &name).ok()?;
        self.folder_brief(&p, &name).ok()
    }

    /// Charges each task a report closes (done, waiting, blocked or dropped, from open, active,
    /// waiting or blocked) with what the agent spent on it since it started on it: since the latest
    /// of the task's own message (or, coming back from waiting, the owner's latest message in that
    /// session), the last time another task there closed, and the task's own last report. Busy time
    /// and tokens come from the session's transcript (usage.rs); without one, the wall time. Tasks
    /// one report closes together share the stretch by their estimates.
    fn charge(&self, closing: &[(i64, String)], now: i64) -> Result<(), String> {
        let batch = closing.iter().map(|c| c.0.to_string()).collect::<Vec<_>>().join(",");
        let mut groups: HashMap<String, Vec<(i64, i64, i64)>> = HashMap::new();
        for (id, status) in closing {
            let (prev, harness, session, minutes, asked): (String, String, String, Option<i64>, i64) = self
                .db
                .query_row(
                    "SELECT t.status, m.harness, m.session, t.minutes, m.said_at
                     FROM tasks t JOIN messages m ON m.id = t.message WHERE t.id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .map_err(err)?;
            if prev == *status
                || matches!(prev.as_str(), "done" | "dropped")
                || !matches!(status.as_str(), "done" | "waiting" | "blocked" | "dropped")
            {
                continue;
            }
            let one = |sql: &str, args: &[&dyn rusqlite::ToSql]| -> Result<Option<i64>, String> {
                self.db.query_row(sql, args, |r| r.get(0)).map_err(err)
            };
            let own = one("SELECT MAX(at) FROM task_events WHERE task = ?1 AND status != 'open'", &[id])?;
            let said = if matches!(prev.as_str(), "waiting" | "blocked") {
                one(
                    "SELECT MAX(said_at) FROM messages WHERE harness = ?1 AND session = ?2 AND said_at <= ?3",
                    &[&harness, &session, &now],
                )?
            } else {
                Some(asked)
            };
            let others = one(
                &format!(
                    "SELECT MAX(e.at) FROM task_events e JOIN tasks t ON t.id = e.task JOIN messages m ON m.id = t.message
                     WHERE m.harness = ?1 AND m.session = ?2 AND e.at <= ?3
                       AND e.status IN ('done', 'waiting', 'blocked', 'dropped') AND e.task NOT IN ({batch})"
                ),
                &[&harness, &session, &now],
            )?;
            let start = [own, said, others].into_iter().flatten().max().unwrap_or(now).min(now);
            groups
                .entry(session)
                .or_default()
                .push((*id, start, minutes.unwrap_or(1).max(1)));
        }
        for (session, tasks) in groups {
            let from = tasks.iter().map(|t| t.1).min().unwrap_or(now);
            let path: Option<String> = self
                .db
                .query_row(
                    "SELECT path FROM scans WHERE session = ?1 ORDER BY rowid DESC LIMIT 1",
                    [&session],
                    |r| r.get(0),
                )
                .optional()
                .map_err(err)?;
            let spent = path.and_then(|p| usage::spent(Path::new(&p), from, now));
            let busy = spent.map_or(now - from, |s| s.busy_seconds);
            let total: i64 = tasks.iter().map(|t| t.2).sum();
            for (id, _, weight) in tasks {
                let share = |x: i64| x * weight / total;
                self.db
                    .execute(
                        "UPDATE tasks SET work_seconds = COALESCE(work_seconds, 0) + ?2,
                           tokens_in = CASE WHEN ?5 THEN COALESCE(tokens_in, 0) + ?3 ELSE tokens_in END,
                           tokens_out = CASE WHEN ?5 THEN COALESCE(tokens_out, 0) + ?4 ELSE tokens_out END
                         WHERE id = ?1",
                        params![
                            id,
                            share(busy),
                            spent.map_or(0, |s| share(s.tokens_in)),
                            spent.map_or(0, |s| share(s.tokens_out)),
                            spent.is_some()
                        ],
                    )
                    .map_err(err)?;
            }
        }
        Ok(())
    }

    /// How long done tasks have taken against their estimates lately (actual ÷ estimate over the
    /// last 30 with both), once there are 5 to go on.
    pub fn estimate_ratio(&self) -> Result<Option<f64>, String> {
        let (count, actual, estimate): (i64, Option<i64>, Option<i64>) = self
            .db
            .query_row(
                "SELECT COUNT(*), SUM(work_seconds), SUM(minutes * 60) FROM (
                   SELECT work_seconds, minutes FROM tasks
                   WHERE status = 'done' AND work_seconds > 0 AND minutes > 0
                   ORDER BY done_at DESC LIMIT 30)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(err)?;
        Ok(match (count, actual, estimate) {
            (5.., Some(a), Some(e)) if e > 0 => Some(a as f64 / e as f64),
            _ => None,
        })
    }

    // ---- Hive's own agent ----------------------------------------------------------------------

    /// Puts a request to Hive's own agent on the board, as one task that is now active: Hive
    /// calls this itself rather than through the hooks, because each of its turns to Codex or
    /// Claude carries Hive's memory and knowledge along with the owner's words, and a Stop hook
    /// would hold back its spoken answer. The same request again that day is the same task,
    /// active again (and counted as said twice). Returns the task's id ("T7").
    pub fn hive_request(&self, text: &str) -> Result<String, String> {
        let at = now();
        let day = &iso(at)[..10];
        let (message, _) =
            self.save_message("hive", &format!("hive-{day}"), HIVE_PROJECT, text, at, true)?;
        let existing: Option<i64> = self
            .db
            .query_row(
                "SELECT id FROM tasks WHERE message = ?1 ORDER BY id DESC LIMIT 1",
                [message],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        let id = match existing {
            Some(id) => id,
            None => {
                let said = self.message(message)?["text"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let title = clip(said.lines().next().unwrap_or(""), 120);
                let folder = addressed_folder(&said)
                    .map(|(p, name)| format!("{p} › {name}"))
                    .unwrap_or_default();
                let added = self.add(
                    message,
                    &json!([{"quote": said, "title": title, "folder": folder}]),
                )?;
                task_id(added[0].split_whitespace().next().unwrap_or(""))?
            }
        };
        self.report(&json!([{"id": format!("T{id}"), "status": "active"}]))?;
        Ok(format!("T{id}"))
    }

    /// How a request to Hive's own agent ended: Hive's "done", "stopped", "interrupted" (Hive
    /// restarted; it resumes the task) or "failed", and what the agent said (or why it failed).
    pub fn hive_finished(&self, task: &str, ended: &str, said: &str) -> Result<(), String> {
        let (status, fallback) = match ended {
            "done" => ("done", "Done."),
            "stopped" => ("dropped", "Stopped before it finished."),
            "interrupted" => ("waiting", ""),
            _ => ("blocked", "It failed."),
        };
        let outcome = match (status, said.trim()) {
            ("waiting", _) => {
                "Hive restarted in the middle of it; it picks it up again on its own."
            }
            (_, "") => fallback,
            (_, said) => said,
        };
        self.report(&json!([{"id": task, "status": status, "outcome": outcome}]))
            .map(|_| ())
    }

    // ---- the cloud copy ------------------------------------------------------------------------

    /// What to push next: up to `max` changed rows as `{messages, tasks, rules}`, and their
    /// outbox keys for `sync_sent`. The first time, everything the ledger already has.
    pub fn sync_batch(&self, max: usize) -> Result<(Value, Vec<(String, i64)>), String> {
        let backfilled: Option<String> = self
            .db
            .query_row("SELECT value FROM meta WHERE key = 'backfilled'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(err)?;
        if backfilled.is_none() {
            self.db
                .execute_batch(
                    "INSERT OR IGNORE INTO outbox SELECT 'message', id FROM messages;
                     INSERT OR IGNORE INTO outbox SELECT 'task', id FROM tasks;
                     INSERT OR IGNORE INTO outbox SELECT 'rule', id FROM rules
                       WHERE id NOT IN (SELECT rule FROM remote_rules);
                     INSERT OR IGNORE INTO outbox SELECT 'folder', id FROM folders WHERE origin IS NULL;
                     INSERT OR IGNORE INTO outbox SELECT 'memory', id FROM memories WHERE origin IS NULL;
                     INSERT OR REPLACE INTO meta (key, value) VALUES ('backfilled', '1');",
                )
                .map_err(err)?;
        }
        let keys: Vec<(String, i64)> = {
            let mut stmt = self
                .db
                .prepare("SELECT kind, id FROM outbox ORDER BY kind, id LIMIT ?1")
                .map_err(err)?;
            let rows = stmt
                .query_map([max as i64], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(err)?;
            rows.collect::<Result<_, _>>().map_err(err)?
        };
        let rows = |sql: &str, kind: &str| -> Result<Vec<Value>, String> {
            let mut out = Vec::new();
            let mut stmt = self.db.prepare(sql).map_err(err)?;
            for (_, id) in keys.iter().filter(|(k, _)| k == kind) {
                let row = stmt
                    .query_row([id], |r| {
                        let mut m = Map::new();
                        for (i, name) in r.as_ref().column_names().enumerate() {
                            let v = match r.get_ref(i)? {
                                rusqlite::types::ValueRef::Integer(n) => json!(n),
                                rusqlite::types::ValueRef::Text(t) => {
                                    json!(String::from_utf8_lossy(t))
                                }
                                rusqlite::types::ValueRef::Real(f) => json!(f),
                                _ => Value::Null,
                            };
                            m.insert(name.to_string(), v);
                        }
                        Ok(Value::Object(m))
                    })
                    .optional()
                    .map_err(err)?;
                out.extend(row);
            }
            Ok(out)
        };
        let payload = json!({
            "messages": rows("SELECT id, harness, session, project, text, said_at, times, split_at FROM messages WHERE id = ?1", "message")?,
            "tasks": rows("SELECT id, message, quote, title, status, minutes, value, outcome, evidence, created_at, updated_at, done_at, left_open_at, work_seconds, tokens_in, tokens_out, folder, report FROM tasks WHERE id = ?1", "task")?,
            "rules": rows("SELECT id, project, paths, text, quote, created_at, active, shown, last_shown_at FROM rules WHERE id = ?1", "rule")?,
            "folders": rows("SELECT id, project, key, name, about, created_at, updated_at FROM folders WHERE id = ?1", "folder")?,
            "memories": rows("SELECT id, project, folder, kind, title, body, task, created_at FROM memories WHERE id = ?1", "memory")?,
        });
        Ok((payload, keys))
    }

    /// The cloud has these rows now.
    pub fn sync_sent(&self, keys: &[(String, i64)]) -> Result<(), String> {
        let mut stmt = self
            .db
            .prepare("DELETE FROM outbox WHERE kind = ?1 AND id = ?2")
            .map_err(err)?;
        for (kind, id) in keys {
            stmt.execute(params![kind, id]).map_err(err)?;
        }
        Ok(())
    }

    /// Takes in the rules set on the owner's other machines (`[{machine, id, project, paths,
    /// text, quote, created_at, active}]`), so they reach agents here as well. A rule turned off
    /// here stays off.
    pub fn take_rules(&self, rules: &Value) -> Result<usize, String> {
        let mut taken = 0;
        for r in rules.as_array().map(Vec::as_slice).unwrap_or_default() {
            let origin = format!("{}:{}", str_of(r, "machine"), r["id"]);
            let paths = match &r["paths"] {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let active = r["active"].as_i64().unwrap_or(1);
            let created = r["created_at"].as_i64().unwrap_or_else(now);
            let known: Option<i64> = self
                .db
                .query_row(
                    "SELECT rule FROM remote_rules WHERE origin = ?1",
                    [&origin],
                    |x| x.get(0),
                )
                .optional()
                .map_err(err)?;
            match known {
                Some(id) => {
                    self.db
                        .execute(
                            "UPDATE rules SET project = ?2, paths = ?3, text = ?4, quote = ?5,
                               active = CASE WHEN ?6 = 0 THEN 0 ELSE active END WHERE id = ?1",
                            params![
                                id,
                                str_of(r, "project"),
                                paths,
                                str_of(r, "text"),
                                str_of(r, "quote"),
                                active
                            ],
                        )
                        .map_err(err)?;
                }
                None => {
                    self.db
                        .execute(
                            "INSERT INTO rules (message, project, paths, text, quote, created_at, active)
                             VALUES (NULL, ?1, ?2, ?3, ?4, ?5, ?6)",
                            params![str_of(r, "project"), paths, str_of(r, "text"), str_of(r, "quote"), created, active],
                        )
                        .map_err(err)?;
                    let id = self.db.last_insert_rowid();
                    self.db
                        .execute(
                            "INSERT INTO remote_rules (origin, rule) VALUES (?1, ?2)",
                            params![origin, id],
                        )
                        .map_err(err)?;
                }
            }
            taken += 1;
        }
        Ok(taken)
    }

    /// Takes in the folders and memories made on the owner's other machines and on the web
    /// (`{folders: [{project, key, name, about, created_at, updated_at}], memories: [{machine, id,
    /// project, folder, kind, title, body, task, created_at}]}`). Returns how many.
    pub fn take_folders(&self, answer: &Value) -> Result<usize, String> {
        let list = |key: &str| answer[key].as_array().cloned().unwrap_or_default();
        let (folders, memories) = (list("folders"), list("memories"));
        for f in &folders {
            let at = f["updated_at"].as_i64().unwrap_or_else(now);
            self.db
                .execute(
                    "INSERT INTO folders (project, key, name, about, created_at, updated_at, origin)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'cloud')
                     ON CONFLICT (project, key) DO UPDATE SET name = excluded.name, about = excluded.about,
                       updated_at = excluded.updated_at, origin = 'cloud'
                     WHERE excluded.updated_at >= folders.updated_at",
                    params![
                        str_of(f, "project"),
                        str_of(f, "key"),
                        str_of(f, "name"),
                        str_of(f, "about"),
                        f["created_at"].as_i64().unwrap_or(at),
                        at
                    ],
                )
                .map_err(err)?;
        }
        for m in &memories {
            let origin = format!("{}:{}", str_of(m, "machine"), m["id"]);
            self.db
                .execute(
                    "INSERT INTO memories (project, folder, kind, title, body, task, created_at, origin)
                     VALUES (?1, ?2, ?3, ?4, ?5, NULLIF(?6, ''), ?7, ?8)
                     ON CONFLICT (origin) DO UPDATE SET project = excluded.project, folder = excluded.folder,
                       kind = excluded.kind, title = excluded.title, body = excluded.body, task = excluded.task",
                    params![
                        str_of(m, "project"),
                        str_of(m, "folder"),
                        str_of(m, "kind"),
                        str_of(m, "title"),
                        str_of(m, "body"),
                        str_of(m, "task"),
                        m["created_at"].as_i64().unwrap_or_else(now),
                        origin
                    ],
                )
                .map_err(err)?;
        }
        Ok(folders.len() + memories.len())
    }

    /// Pushes what changed to the owner's cloud copy and takes in the other machines' rules, and
    /// the folders and memories made elsewhere since the last time.
    pub fn sync(&self, cloud: &Cloud) -> Result<String, String> {
        let mut pushed = 0;
        let mut rules = 0;
        let mut taken = 0;
        for _ in 0..50 {
            let (mut payload, keys) = self.sync_batch(200)?;
            payload["machine"] = json!(cloud.machine);
            let since: Option<String> = self
                .db
                .query_row("SELECT value FROM meta WHERE key = 'pulled_at'", [], |r| r.get(0))
                .optional()
                .map_err(err)?;
            payload["since"] = json!(since.and_then(|s| s.parse::<i64>().ok()).unwrap_or(0));
            let answer = cloud.post("/v1/sync", &payload)?;
            rules = self.take_rules(&answer["rules"])?;
            taken += self.take_folders(&answer)?;
            if let Some(at) = answer["now"].as_i64() {
                self.db
                    .execute(
                        "INSERT OR REPLACE INTO meta (key, value) VALUES ('pulled_at', ?1)",
                        [at.to_string()],
                    )
                    .map_err(err)?;
            }
            self.sync_sent(&keys)?;
            pushed += keys.len();
            if keys.len() < 200 {
                break;
            }
        }
        Ok(format!(
            "Pushed {pushed} changes; {rules} rules from other machines; {taken} folders and memories from elsewhere."
        ))
    }

    fn event(&self, task: i64, status: &str, note: Option<&str>) -> Result<(), String> {
        self.db
            .execute(
                "INSERT INTO task_events (task, at, status, note) VALUES (?1, ?2, ?3, ?4)",
                params![task, now(), status, note],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn rule_off(&self, id: &str) -> Result<String, String> {
        let n = prefixed(id, 'R')?;
        match self
            .db
            .execute("UPDATE rules SET active = 0 WHERE id = ?1", [n])
            .map_err(err)?
        {
            0 => Err(format!("No rule R{n}.")),
            _ => Ok(format!("R{n} is off.")),
        }
    }

    fn task_rows(&self, filter: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>, String> {
        let sql = format!(
            "SELECT t.id, t.title, t.status, t.quote, t.message, m.session, m.harness, m.project,
                    t.minutes, t.value, t.outcome, t.evidence, t.created_at, t.updated_at, t.done_at,
                    t.left_open_at, m.times, t.work_seconds, t.tokens_in, t.tokens_out, t.folder, t.report
             FROM tasks t JOIN messages m ON m.id = t.message WHERE {filter}"
        );
        let mut stmt = self.db.prepare(&sql).map_err(err)?;
        let rows = stmt
            .query_map(args, |r| {
                let minutes: Option<i64> = r.get(8)?;
                let value: Option<String> = r.get(9)?;
                let worth_asking =
                    value.as_deref() == Some("low") && minutes.is_some_and(|m| m >= ASK_MINUTES);
                Ok(json!({
                    "id": format!("T{}", r.get::<_, i64>(0)?),
                    "title": r.get::<_, String>(1)?,
                    "status": r.get::<_, String>(2)?,
                    "quote": r.get::<_, String>(3)?,
                    "message": format!("M{}", r.get::<_, i64>(4)?),
                    "session": r.get::<_, String>(5)?,
                    "harness": r.get::<_, String>(6)?,
                    "project": r.get::<_, String>(7)?,
                    "minutes": minutes,
                    "value": value,
                    "worth_asking": worth_asking,
                    "outcome": r.get::<_, Option<String>>(10)?,
                    "evidence": r.get::<_, Option<String>>(11)?,
                    "created_at": iso(r.get(12)?),
                    "updated_at": iso(r.get(13)?),
                    "done_at": r.get::<_, Option<i64>>(14)?.map(iso),
                    "left_open": r.get::<_, Option<i64>>(15)?.is_some(),
                    "repeated": r.get::<_, i64>(16)? > 1,
                    "work_seconds": r.get::<_, Option<i64>>(17)?,
                    "tokens_in": r.get::<_, Option<i64>>(18)?,
                    "tokens_out": r.get::<_, Option<i64>>(19)?,
                    "folder": r.get::<_, Option<String>>(20)?,
                    "report": r.get::<_, Option<String>>(21)?,
                }))
            })
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    fn open_in_session(&self, harness: &str, session: &str) -> Result<Vec<Value>, String> {
        self.task_rows(
            "m.harness = ?1 AND m.session = ?2 AND t.status IN ('open', 'active') ORDER BY t.id",
            &[&harness, &session],
        )
    }

    fn unsplit_in_session(&self, harness: &str, session: &str) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .db
            .prepare("SELECT id FROM messages WHERE harness = ?1 AND session = ?2 AND split_at IS NULL ORDER BY id")
            .map_err(err)?;
        let ids: Vec<i64> = stmt
            .query_map([harness, session], |r| r.get(0))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        ids.into_iter().map(|id| self.message(id)).collect()
    }

    fn rules(&self, project: Option<&str>, active_only: bool) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .db
            .prepare(
                "SELECT id, project, paths, text, quote, created_at, active, shown, last_shown_at, message
                 FROM rules WHERE (?1 IS NULL OR project = ?1) AND (?2 = 0 OR active = 1) ORDER BY id",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![project, active_only as i64], |r| {
                Ok(json!({
                    "id": format!("R{}", r.get::<_, i64>(0)?),
                    "project": r.get::<_, String>(1)?,
                    "paths": serde_json::from_str::<Value>(&r.get::<_, String>(2)?).unwrap_or(json!([])),
                    "text": r.get::<_, String>(3)?,
                    "quote": r.get::<_, String>(4)?,
                    "created_at": iso(r.get(5)?),
                    "active": r.get::<_, i64>(6)? == 1,
                    "shown": r.get::<_, i64>(7)?,
                    "last_shown_at": r.get::<_, Option<i64>>(8)?.map(iso),
                    "message": r.get::<_, Option<i64>>(9)?.map(|m| format!("M{m}")),
                }))
            })
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn rule_list(&self, project: Option<&str>) -> Result<Vec<Value>, String> {
        self.rules(project, false)
    }

    // ---- the board -----------------------------------------------------------------------------

    /// Every task and rule (of one project, or all), grouped the way the owner reads them.
    pub fn board(&self, project: Option<&str>) -> Result<Value, String> {
        let scope = "(?1 IS NULL OR m.project = ?1)";
        let p: &dyn rusqlite::ToSql = &project;
        let needs_you = self.task_rows(
            &format!("{scope} AND t.status IN ('waiting', 'blocked') ORDER BY t.updated_at DESC"),
            &[p],
        )?;
        let left_open = self.task_rows(&format!("{scope} AND t.status IN ('open', 'active') AND t.left_open_at IS NOT NULL ORDER BY t.id"), &[p])?;
        let in_progress = self.task_rows(&format!("{scope} AND t.status = 'active' AND t.left_open_at IS NULL ORDER BY t.updated_at DESC"), &[p])?;
        let not_started = self.task_rows(
            &format!("{scope} AND t.status = 'open' AND t.left_open_at IS NULL ORDER BY t.id"),
            &[p],
        )?;
        let done = self.task_rows(
            &format!(
                "{scope} AND t.status IN ('done', 'dropped') ORDER BY t.updated_at DESC LIMIT 15"
            ),
            &[p],
        )?;
        let mut stmt = self
            .db
            .prepare("SELECT m.id FROM messages m WHERE (?1 IS NULL OR m.project = ?1) AND m.split_at IS NULL ORDER BY m.id")
            .map_err(err)?;
        let ids: Vec<i64> = stmt
            .query_map([project], |r| r.get(0))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        let not_split: Vec<Value> = ids
            .into_iter()
            .map(|id| self.message(id))
            .collect::<Result<_, _>>()?;
        Ok(json!({
            "project": project,
            "generated_at": iso(now()),
            "needs_you": needs_you,
            "in_progress": in_progress,
            "not_started": not_started,
            "left_open": left_open,
            "not_split": not_split,
            "done": done,
            "rules": self.rules(project, true)?,
            "folders": self.folders(project.map(project_key).as_deref())?,
        }))
    }

    /// One task (with its history and the message it came from), message (with its tasks) or rule.
    pub fn show(&self, id: &str) -> Result<Value, String> {
        match id.chars().next().map(|c| c.to_ascii_uppercase()) {
            Some('T') => {
                let n = prefixed(id, 'T')?;
                let mut task = self
                    .task_rows("t.id = ?1", &[&n])?
                    .pop()
                    .ok_or(format!("No task T{n}."))?;
                let mut stmt = self
                    .db
                    .prepare(
                        "SELECT at, status, note FROM task_events WHERE task = ?1 ORDER BY rowid",
                    )
                    .map_err(err)?;
                let history: Vec<Value> = stmt
                    .query_map([n], |r| Ok(json!({"at": iso(r.get(0)?), "status": r.get::<_, String>(1)?, "note": r.get::<_, Option<String>>(2)?})))
                    .map_err(err)?
                    .collect::<Result<_, _>>()
                    .map_err(err)?;
                task["history"] = json!(history);
                let m = prefixed(task["message"].as_str().unwrap_or(""), 'M')?;
                task["message_text"] = self.message(m)?["text"].clone();
                Ok(task)
            }
            Some('M') => {
                let n = prefixed(id, 'M')?;
                let mut msg = self.message(n)?;
                msg["tasks"] = json!(self.task_rows("t.message = ?1 ORDER BY t.id", &[&n])?);
                Ok(msg)
            }
            Some('R') => {
                let n = format!("R{}", prefixed(id, 'R')?);
                self.rules(None, false)?
                    .into_iter()
                    .find(|r| r["id"] == n)
                    .ok_or(format!("No rule {n}."))
            }
            _ => Err(format!(
                "{id:?} isn't a task (T…), message (M…) or rule (R…)."
            )),
        }
    }

    // ---- transcripts ---------------------------------------------------------------------------

    /// Starts reading a session's transcript from its current end, if this is the first time
    /// Hive sees it: history from before is skipped.
    fn mark_transcript(&self, session: &str, path: &str) -> Result<(), String> {
        if path.is_empty() {
            return Ok(());
        }
        let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) as i64;
        self.db
            .execute(
                "INSERT OR IGNORE INTO scans (session, path, offset) VALUES (?1, ?2, ?3)",
                params![session, path, len],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// Saves the owner's messages written to the transcript since the last read, catching
    /// messages queued while the agent worked, which no prompt hook announces.
    fn scan_transcript(
        &self,
        harness: &str,
        session: &str,
        project: &str,
        path: &str,
    ) -> Result<usize, String> {
        if path.is_empty() {
            return Ok(0);
        }
        let offset: Option<i64> = self
            .db
            .query_row(
                "SELECT offset FROM scans WHERE session = ?1 AND path = ?2",
                params![session, path],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        let Some(offset) = offset else {
            self.mark_transcript(session, path)?;
            return Ok(0);
        };
        let Ok(mut file) = std::fs::File::open(path) else {
            return Ok(0);
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0) as i64;
        let start = if offset > len { len } else { offset };
        file.seek(SeekFrom::Start(start as u64)).map_err(err)?;
        let mut reader = BufReader::new(file.take((len - start) as u64));
        let (mut pos, mut saved) = (start, 0);
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader.read_line(&mut line).map_err(err)?;
            if n == 0 || !line.ends_with('\n') {
                break; // a line still being written is read next time
            }
            pos += n as i64;
            if let Some((text, at)) = owner_message(harness, &line) {
                if self
                    .save_message(
                        harness,
                        session,
                        project,
                        &text,
                        at.unwrap_or_else(now),
                        false,
                    )?
                    .1
                {
                    saved += 1;
                }
            }
        }
        self.db
            .execute(
                "UPDATE scans SET offset = ?3 WHERE session = ?1 AND path = ?2",
                params![session, path, pos],
            )
            .map_err(err)?;
        Ok(saved)
    }

    // ---- hooks ---------------------------------------------------------------------------------

    /// What a harness hook prints for `input` (its JSON on stdin); Null prints nothing.
    pub fn hook(&self, harness: &str, input: &Value) -> Result<Value, String> {
        let session = str_of(input, "session_id");
        if session.is_empty() {
            return Ok(Value::Null);
        }
        let transcript = str_of(input, "transcript_path");
        let event = str_of(input, "hook_event_name");
        if !matches!(
            event,
            "UserPromptSubmit" | "Stop" | "PreToolUse" | "SessionStart"
        ) {
            return Ok(Value::Null);
        }
        let project = project_of(str_of(input, "cwd"));
        let id = project.id.as_str();
        match event {
            "UserPromptSubmit" => {
                self.on_prompt(harness, session, id, transcript, str_of(input, "prompt"))
            }
            "Stop" => self.on_stop(harness, session, id, transcript, input),
            "PreToolUse" if matches!(str_of(input, "tool_name"), "Agent" | "Task") => {
                self.on_subagent(id, input)
            }
            "PreToolUse" => match self.on_command(input, id)? {
                Value::Null => self.on_edit(session, &project, input),
                done => Ok(done),
            },
            _ => self.on_start(harness, session, id, transcript, str_of(input, "source")),
        }
    }

    fn on_prompt(
        &self,
        harness: &str,
        session: &str,
        project: &str,
        transcript: &str,
        prompt: &str,
    ) -> Result<Value, String> {
        self.mark_transcript(session, transcript)?;
        if prompt.trim().is_empty() || !from_the_owner(prompt) {
            return Ok(Value::Null);
        }
        let (id, new) = self.save_message(harness, session, project, prompt, now(), true)?;
        let cmd = &self.command;
        let mut out = String::new();
        let msg = self.message(id)?;
        if !new && msg["split"] == true {
            let tasks = self.task_rows("t.message = ?1 ORDER BY t.id", &[&id])?;
            out.push_str(&format!(
                "Hive: the owner sent this same message before (M{id}); they are repeating themselves. Its tasks:\n{}\nFinish what is still open before anything else.",
                task_lines(&tasks)
            ));
        } else {
            out.push_str(&format!(
                "Hive saved this message as M{id}. Before you start, register each separate thing it asks for, in one command:\n\
                 {cmd} add M{id} <<'EOF'\n\
                 [{{\"quote\": \"<the owner's exact words for one instruction>\", \"title\": \"<one line>\", \"minutes\": <estimate>, \"value\": \"low|medium|high\"}}]\n\
                 EOF\n\
                 Use [] if it asks for nothing. A standing preference (\"never…\", \"always…\") is {{\"kind\": \"rule\", \"paths\": [\"<globs it applies to, or none for the whole project>\"], ...}} instead of a task. \
                 Put each task in its folder, the part of the project it's about: \"folder\": \"<project › folder>\" (Hive then loads every memory of that folder for you). If a task is low value but long, ask the owner before doing it. As you start each task, report it active (echo '[{{\"id\": \"T1\", \"status\": \"active\"}}]' | {cmd} report). As each task ends, report it: echo '[{{\"id\": \"T1\", \"status\": \"done|waiting|blocked|dropped\", \"outcome\": \"<what happened>\", \"report\": \"<when done: what you did, where, what's left>\"}}]' | {cmd} report. \
                 Handing folder work to a subagent, put a line \"Hive folder: <project › folder>\" in its prompt and Hive adds that folder's memories. Save what later agents in a folder must know: {cmd} remember \"<project › folder>\" [note|spec|decision] <<'EOF' (first line the title)."
            ));
            let here = project_key(project);
            let names: Vec<String> = self
                .folders(Some(&here))?
                .iter()
                .filter_map(|f| f["name"].as_str().map(str::to_string))
                .collect();
            if !names.is_empty() {
                out.push_str(&format!("\nFolders in {here}: {}.", names.join(", ")));
            }
        }
        if let Some((p, name)) = addressed_folder(prompt) {
            let name = self.ensure_folder(&p, &name)?;
            out.push_str(&format!(
                "\nThe owner sent this for the folder \"{p} › {name}\": put its tasks there.\n{}",
                self.folder_brief(&p, &name)?
            ));
        }
        if let Some(r) = self.estimate_ratio()?.filter(|r| !(0.8..=1.25).contains(r)) {
            out.push_str(&format!(
                "\nDone tasks lately took {r:.1}× their estimates; estimate with that in mind."
            ));
        }
        let earlier: Vec<Value> = self
            .open_in_session(harness, session)?
            .into_iter()
            .filter(|t| t["message"] != json!(format!("M{id}")))
            .collect();
        if !earlier.is_empty() {
            out.push_str(&format!(
                "\nStill open from earlier messages:\n{}",
                task_lines(&earlier)
            ));
        }
        Ok(context("UserPromptSubmit", &out))
    }

    fn on_stop(
        &self,
        harness: &str,
        session: &str,
        project: &str,
        transcript: &str,
        input: &Value,
    ) -> Result<Value, String> {
        self.scan_transcript(harness, session, project, transcript)?;
        if matches!(input.get("background_tasks"), Some(Value::Array(a)) if !a.is_empty()) {
            return Ok(Value::Null); // it ends its turn to wait for its own background work
        }
        let unsplit = self.unsplit_in_session(harness, session)?;
        let open = self.open_in_session(harness, session)?;
        if unsplit.is_empty() && open.is_empty() {
            self.db
                .execute("DELETE FROM stop_blocks WHERE session = ?1", [session])
                .map_err(err)?;
            return Ok(Value::Null);
        }
        let signature = unsplit
            .iter()
            .map(|m| m["id"].as_str().unwrap_or("").to_string())
            .chain(open.iter().map(|t| {
                format!(
                    "{}:{}",
                    t["id"].as_str().unwrap_or(""),
                    t["status"].as_str().unwrap_or("")
                )
            }))
            .collect::<Vec<_>>()
            .join(",");
        let last: Option<(String, i64)> = self
            .db
            .query_row(
                "SELECT signature, count FROM stop_blocks WHERE session = ?1",
                [session],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        let count = match &last {
            Some((s, c)) if *s == signature => c + 1,
            _ => 1,
        };
        self.db
            .execute(
                "INSERT INTO stop_blocks (session, signature, count) VALUES (?1, ?2, ?3)
                 ON CONFLICT (session) DO UPDATE SET signature = ?2, count = ?3",
                params![session, signature, count],
            )
            .map_err(err)?;
        if count > MAX_SAME_BLOCKS {
            // Reminded twice with nothing changed: let it stop, and show the tasks as left open.
            self.db
                .execute(
                    "UPDATE tasks SET left_open_at = COALESCE(left_open_at, ?3) WHERE status IN ('open', 'active')
                     AND message IN (SELECT id FROM messages WHERE harness = ?1 AND session = ?2)",
                    params![harness, session, now()],
                )
                .map_err(err)?;
            return Ok(Value::Null);
        }
        let cmd = &self.command;
        let mut reason = String::from("Hive: before you stop, account for every instruction the owner gave in this session.\n");
        for m in &unsplit {
            reason.push_str(&format!(
                "{} has no tasks registered: \"{}\". Register them: {cmd} add {} with a JSON list on stdin ([] if it asks for nothing).\n",
                m["id"].as_str().unwrap_or(""),
                clip(m["text"].as_str().unwrap_or(""), 160),
                m["id"].as_str().unwrap_or("")
            ));
        }
        if !open.is_empty() {
            reason.push_str(&format!("Still open:\n{}\n", task_lines(&open)));
            reason.push_str(&format!(
                "Finish each, or report it: echo '[{{\"id\": \"T1\", \"status\": \"done\", \"outcome\": \"<what happened>\"}}]' | {cmd} report \
                 (status waiting if you asked the owner something, blocked if something else is in the way, dropped only if the owner withdrew it)."
            ));
        }
        Ok(json!({"decision": "block", "reason": reason.trim_end()}))
    }

    /// An agent's `hive-tasks add|report|done|rule-off`, done here rather than by the command:
    /// the hook runs outside the harness's sandbox, which may not let the command write the
    /// ledger. The agent gets the result in place of running it.
    /// A subagent handed work in a folder (its prompt has a line "Hive folder: hive › memory
    /// retrieval") starts with every memory of that folder added to its prompt.
    fn on_subagent(&self, project: &str, input: &Value) -> Result<Value, String> {
        static NAMED: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(?mi)^[ \t*-]*Hive folder:[ \t]*(.+?)[ \t]*$").unwrap());
        let tool_input = input.get("tool_input").cloned().unwrap_or(Value::Null);
        let prompt = str_of(&tool_input, "prompt");
        let mut briefs = Vec::new();
        for c in NAMED.captures_iter(prompt) {
            if let Some((p, name)) = folder_place(project, c[1].trim_matches(['"', '\'', '`'])) {
                let name = self.ensure_folder(&p, &name)?;
                briefs.push(self.folder_brief(&p, &name)?);
            }
        }
        if briefs.is_empty() {
            return Ok(Value::Null);
        }
        let mut updated = tool_input.clone();
        updated["prompt"] = json!(format!("{prompt}\n\n{}", briefs.join("\n\n")));
        Ok(json!({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "Hive added the folder's memories to the subagent's prompt.",
            "updatedInput": updated,
        }}))
    }

    fn on_command(&self, input: &Value, project: &str) -> Result<Value, String> {
        let Some((command, id, body)) =
            agent_command(input.get("tool_input").unwrap_or(&Value::Null))
        else {
            return Ok(Value::Null);
        };
        let json = || {
            serde_json::from_str::<Value>(body.trim()).map_err(|e| format!("That isn't JSON: {e}"))
        };
        let result = match command.as_str() {
            "add" => prefixed(&id, 'M')
                .and_then(|m| self.add(m, &json()?))
                .map(|l| l.join("\n")),
            "report" => json().and_then(|j| self.report(&j)).map(|l| l.join("\n")),
            "done" => self
                .report(&json!([{"id": id, "status": "done", "outcome": body}]))
                .map(|l| l.join("\n")),
            "folder" => folder_place(project, &id)
                .ok_or_else(|| format!("{id:?} isn't a folder."))
                .and_then(|(p, name)| self.folder_brief(&p, &name)),
            remember if remember.starts_with("remember") => folder_place(project, &id)
                .ok_or_else(|| format!("{id:?} isn't a folder."))
                .and_then(|(p, name)| {
                    let kind = remember.strip_prefix("remember:").unwrap_or("note");
                    self.remember(&p, &name, kind, &body)
                }),
            _ => self.rule_off(&id),
        };
        let reason = match result {
            Ok(said) => format!("Hive did this for you (no need to run it): {said}"),
            Err(e) => format!("Hive couldn't do that: {e} Fix it and run the command again."),
        };
        Ok(json!({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}))
    }

    fn on_edit(&self, session: &str, project: &Project, input: &Value) -> Result<Value, String> {
        let paths = edited_paths(input.get("tool_input").unwrap_or(&Value::Null));
        if paths.is_empty() {
            return Ok(Value::Null);
        }
        let rules = self.rules(Some(&project.id), true)?;
        let mut lines = Vec::new();
        for path in &paths {
            let rel = relative(&project.root, path);
            for rule in &rules {
                let globs: Vec<&str> = rule["paths"]
                    .as_array()
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                if globs.is_empty() || !globs.iter().any(|g| glob_match(g, &rel)) {
                    continue;
                }
                let n = prefixed(rule["id"].as_str().unwrap_or(""), 'R')?;
                let fresh = self
                    .db
                    .execute(
                        "INSERT OR IGNORE INTO rule_shown (session, rule) VALUES (?1, ?2)",
                        params![session, n],
                    )
                    .map_err(err)?;
                if fresh == 0 {
                    continue;
                }
                self.db
                    .execute(
                        "UPDATE rules SET shown = shown + 1, last_shown_at = ?2 WHERE id = ?1",
                        params![n, now()],
                    )
                    .map_err(err)?;
                lines.push(rule_line(rule));
            }
        }
        if lines.is_empty() {
            return Ok(Value::Null);
        }
        Ok(context(
            "PreToolUse",
            &format!("The owner's rules for {} (Hive shows each once a session, when you edit a file it covers):\n{}", paths.iter().map(|p| relative(&project.root, p)).collect::<Vec<_>>().join(", "), lines.join("\n")),
        ))
    }

    fn on_start(
        &self,
        harness: &str,
        session: &str,
        project: &str,
        transcript: &str,
        source: &str,
    ) -> Result<Value, String> {
        self.mark_transcript(session, transcript)?;
        let mut out = Vec::new();
        if matches!(source, "compact" | "clear") {
            self.db
                .execute("DELETE FROM rule_shown WHERE session = ?1", [session])
                .map_err(err)?;
            let open = self.open_in_session(harness, session)?;
            if !open.is_empty() {
                out.push(format!(
                    "Hive: the owner's open tasks in this session, kept across the {source}:\n{}",
                    task_lines(&open)
                ));
            }
        } else {
            let open = self.task_rows(
                "m.project = ?1 AND t.status IN ('open', 'active', 'waiting', 'blocked') ORDER BY t.updated_at DESC",
                &[&project],
            )?;
            if !open.is_empty() {
                out.push(format!(
                    "Hive: the owner's unfinished tasks in this project, from earlier sessions (take one up only when the owner asks; {} board lists them):\n{}",
                    self.command,
                    task_lines(&open)
                ));
            }
        }
        let wide: Vec<String> = self
            .rules(Some(project), true)?
            .iter()
            .filter(|r| r["paths"].as_array().is_none_or(|a| a.is_empty()))
            .map(rule_line)
            .collect();
        if !wide.is_empty() {
            out.push(format!(
                "The owner's rules for this whole project:\n{}",
                wide.join("\n")
            ));
        }
        if out.is_empty() {
            return Ok(Value::Null);
        }
        Ok(context("SessionStart", &out.join("\n")))
    }
}

// ---- text --------------------------------------------------------------------------------------

/// Whether a submitted prompt is the owner's own message. A harness also submits its own notices
/// as prompts: a background task finishing, another session's message, a side-session or CI event.
/// Those aren't the owner's words, so they don't go on the board.
pub fn from_the_owner(prompt: &str) -> bool {
    const NOTICES: [&str; 6] = [
        "<task-notification>",
        "<cross-session-message",
        "<side-sessions-event",
        "<ci-monitor-event",
        "<system-reminder>",
        "[SYSTEM NOTIFICATION",
    ];
    let start = prompt.trim_start();
    !NOTICES.iter().any(|n| start.starts_with(n))
}

/// An agent's own board command, as `(command, id, body)`, when it is the whole shell command
/// (after an optional `cd <dir> &&`): `hive-tasks add M3 <<'EOF' … EOF`, `echo '…' | hive-tasks
/// report`, `hive-tasks done T3 <outcome>` or `hive-tasks rule-off R2`. Anything else, such as a
/// board command chained with other work, isn't taken over: the hook must never keep the rest of a
/// command from running.
pub fn agent_command(tool_input: &Value) -> Option<(String, String, String)> {
    let text = match &tool_input["command"] {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.last().and_then(Value::as_str).unwrap_or("").to_string(),
        _ => return None,
    };
    static WRAPPED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?s)^\S*\b(?:ba|z)?sh\s+-l?c\s+'(.*)'$"#).unwrap());
    static CD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^cd\s+\S+\s*&&\s*").unwrap());
    static HEREDOC: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?s)^(?:\S*/)?hive-tasks[ \t]+(add|report)[ \t]*([Mm]\d+)?[ \t]*<<-?[ \t]*['"]?(\w+)['"]?[ \t]*\n(.*?)\n[ \t]*(\w+)$"#).unwrap()
    });
    static PIPED: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?s)^(?:echo|printf(?:[ \t]+'%s\\n')?)[ \t]+'(.*)'[ \t]*\|[ \t]*(?:\S*/)?hive-tasks[ \t]+(add|report)[ \t]*([Mm]\d+)?$").unwrap()
    });
    static DONE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:\S*/)?hive-tasks[ \t]+done[ \t]+([Tt]\d+)[ \t]+([^\n;&|]+)$").unwrap()
    });
    static RULE_OFF: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:\S*/)?hive-tasks[ \t]+rule-off[ \t]+([Rr]\d+)$").unwrap()
    });
    static FOLDER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"^(?:\S*/)?hive-tasks[ \t]+folder[ \t]+(?:"([^"\n]+)"|'([^'\n]+)'|([^\n;&|<>]+?))[ \t]*$"#).unwrap()
    });
    static REMEMBER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?s)^(?:\S*/)?hive-tasks[ \t]+remember[ \t]+(?:"([^"\n]+)"|'([^'\n]+)')(?:[ \t]+(note|spec|decision))?[ \t]*<<-?[ \t]*['"]?(\w+)['"]?[ \t]*\n(.*?)\n[ \t]*(\w+)$"#).unwrap()
    });
    let quoted = |c: &regex::Captures, groups: &[usize]| {
        groups
            .iter()
            .find_map(|g| c.get(*g))
            .map_or(String::new(), |m| m.as_str().trim().to_string())
    };
    let text = text.trim();
    let text = WRAPPED
        .captures(text)
        .map(|c| c[1].replace("'\\''", "'"))
        .unwrap_or_else(|| text.to_string());
    let text = CD.replace(text.trim(), "").trim().to_string();
    let unquote = |s: &str| s.replace("'\\''", "'");
    let (command, id, body) = if let Some(c) = HEREDOC.captures(&text) {
        if c[3] != c[5] {
            return None;
        }
        (
            c[1].to_string(),
            c.get(2).map_or("", |m| m.as_str()).to_string(),
            c[4].to_string(),
        )
    } else if let Some(c) = PIPED.captures(&text) {
        (
            c[2].to_string(),
            c.get(3).map_or("", |m| m.as_str()).to_string(),
            unquote(&c[1]),
        )
    } else if let Some(c) = DONE.captures(&text) {
        let outcome = c[2].trim();
        let outcome = outcome
            .strip_prefix('\'')
            .and_then(|o| o.strip_suffix('\''))
            .map(unquote)
            .or_else(|| {
                outcome
                    .strip_prefix('"')
                    .and_then(|o| o.strip_suffix('"'))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| outcome.to_string());
        ("done".to_string(), c[1].to_string(), outcome)
    } else if let Some(c) = RULE_OFF.captures(&text) {
        ("rule-off".to_string(), c[1].to_string(), String::new())
    } else if let Some(c) = FOLDER.captures(&text) {
        ("folder".to_string(), quoted(&c, &[1, 2, 3]), String::new())
    } else if let Some(c) = REMEMBER.captures(&text) {
        if c[4] != c[6] {
            return None;
        }
        let kind = c.get(3).map_or("note", |m| m.as_str());
        (format!("remember:{kind}"), quoted(&c, &[1, 2]), c[5].to_string())
    } else {
        return None;
    };
    if command == "add" && prefixed(&id, 'M').is_err() {
        return None;
    }
    Some((command, id, body))
}

/// A project's short name, the same on every machine and on the web: the repository's name for
/// "github.com/owner/name", the folder's name for a path ("a scratch folder" for the desktop app's
/// throwaway session folders), in lower case (the dashboard's projectName, lower-cased).
pub fn project_key(project: &str) -> String {
    let text = project.trim().trim_end_matches('/');
    if text.contains("/scratch-workspaces/") {
        return "a scratch folder".into();
    }
    text.rsplit('/').next().unwrap_or(text).to_lowercase()
}

/// Where a folder named in a task or a message is, as (project, folder name): "hive › memory
/// retrieval" (or "hive > memory retrieval") names its project; "memory retrieval" is in
/// `project`, the project id of the session that names it.
pub fn folder_place(project: &str, folder: &str) -> Option<(String, String)> {
    let folder = folder.trim();
    let (p, name) = match folder.split_once('›').or_else(|| folder.split_once(" > ")) {
        Some((p, name)) => (p.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase(), name),
        None => (project_key(project), folder),
    };
    let name = clip(&name.split_whitespace().collect::<Vec<_>>().join(" "), 80);
    (!name.is_empty() && !p.is_empty()).then_some((p, name))
}

/// The folder a message from the dashboard is for: it starts "For hive › memory retrieval: ".
pub fn addressed_folder(text: &str) -> Option<(String, String)> {
    static FOR: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^For ([^:\n›]+?) › ([^:\n]+?): ").unwrap());
    let c = FOR.captures(text.trim_start())?;
    folder_place("", &format!("{} › {}", &c[1], &c[2]))
}

/// "40 s", "14 min", "2 h 5 min".
pub fn span(secs: i64) -> String {
    match secs {
        s if s < 60 => format!("{s} s"),
        s if s < 3600 => format!("{} min", (s + 30) / 60),
        s => match (s + 30) / 60 % 60 {
            0 => format!("{} h", s / 3600),
            m => format!("{} h {m} min", s / 3600),
        },
    }
}

/// "900", "18k", "1.2M".
pub fn token_count(n: i64) -> String {
    match n {
        n if n < 1000 => n.to_string(),
        n if n < 1_000_000 => format!("{}k", (n + 500) / 1000),
        n => format!("{:.1}M", n as f64 / 1e6),
    }
}

fn context(event: &str, text: &str) -> Value {
    json!({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}})
}

fn task_lines(tasks: &[Value]) -> String {
    let mut lines: Vec<String> = tasks.iter().take(LIST_MAX).map(task_line).collect();
    if tasks.len() > LIST_MAX {
        lines.push(format!("  … and {} more", tasks.len() - LIST_MAX));
    }
    lines.join("\n")
}

fn task_line(t: &Value) -> String {
    let mut line = format!(
        "  {} {} ({})",
        t["id"].as_str().unwrap_or(""),
        t["title"].as_str().unwrap_or(""),
        t["status"].as_str().unwrap_or("")
    );
    if let Some(o) = t["outcome"].as_str().filter(|_| t["status"] != "open") {
        line.push_str(&format!(": {}", clip(o, 120)));
    }
    line
}

fn rule_line(r: &Value) -> String {
    format!(
        "  {} {} (owner said: \"{}\", {})",
        r["id"].as_str().unwrap_or(""),
        r["text"].as_str().unwrap_or(""),
        clip(r["quote"].as_str().unwrap_or(""), 160),
        r["created_at"]
            .as_str()
            .unwrap_or("")
            .get(..10)
            .unwrap_or("")
    )
}

/// The board as text, for a terminal.
pub fn render_board(board: &Value) -> String {
    let mut out = format!(
        "Hive tasks · {}\n",
        board["project"].as_str().unwrap_or("all projects")
    );
    let section = |out: &mut String, title: &str, key: &str| {
        let items = board[key].as_array().cloned().unwrap_or_default();
        if items.is_empty() {
            return;
        }
        out.push_str(&format!("\n{title} ({})\n", items.len()));
        for t in &items {
            let mut line = format!(
                "  {:<5} {}",
                t["id"].as_str().unwrap_or(""),
                t["title"].as_str().unwrap_or("")
            );
            if let Some(m) = t["minutes"].as_i64() {
                line.push_str(&format!(" · ~{m} min"));
            }
            if let Some(v) = t["value"].as_str() {
                line.push_str(&format!(" · {v} value"));
            }
            if t["worth_asking"] == true {
                line.push_str(" · worth asking first");
            }
            if t["repeated"] == true {
                line.push_str(" · owner had to repeat it");
            }
            if let Some(o) = t["outcome"].as_str().filter(|_| t["status"] != "open") {
                line.push_str(&format!(" · {}", clip(o, 100)));
            }
            out.push_str(&line);
            out.push('\n');
        }
    };
    section(&mut out, "Needs you", "needs_you");
    section(&mut out, "In progress", "in_progress");
    section(&mut out, "Not started", "not_started");
    section(&mut out, "Left open by an agent", "left_open");
    if let Some(ms) = board["not_split"].as_array().filter(|a| !a.is_empty()) {
        out.push_str(&format!(
            "\nMessages with no tasks registered ({})\n",
            ms.len()
        ));
        for m in ms {
            out.push_str(&format!(
                "  {:<5} \"{}\" · {}\n",
                m["id"].as_str().unwrap_or(""),
                clip(m["text"].as_str().unwrap_or(""), 90),
                m["said_at"].as_str().unwrap_or("")
            ));
        }
    }
    section(&mut out, "Done", "done");
    if let Some(rs) = board["rules"].as_array().filter(|a| !a.is_empty()) {
        out.push_str(&format!("\nRules ({})\n", rs.len()));
        for r in rs {
            let scope = r["paths"]
                .as_array()
                .filter(|a| !a.is_empty())
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_else(|| "whole project".into());
            out.push_str(&format!(
                "  {:<5} {} · {} · shown {}×\n",
                r["id"].as_str().unwrap_or(""),
                r["text"].as_str().unwrap_or(""),
                scope,
                r["shown"]
            ));
        }
    }
    out
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn clip(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        text
    } else {
        format!("{}…", text.chars().take(max).collect::<String>().trim_end())
    }
}

/// Lower-case words separated by single spaces: what "the same words" compares.
pub fn words(text: &str) -> String {
    let mut out = String::new();
    for word in text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
    {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&word.to_lowercase());
    }
    out
}

fn text_key(text: &str) -> String {
    words(text).chars().take(300).collect()
}

static SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(password|passcode|api[ _-]?key|access[ _-]?token|secret|verification code)(\s*(?:is|:|=)\s*)\S+|\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b").expect("valid pattern")
});

/// The text with anything that looks like a password, code or key replaced.
pub fn redact(text: &str) -> String {
    SECRET
        .replace_all(text, |c: &regex::Captures| match c.get(1) {
            Some(label) => format!("{}{}[withheld]", label.as_str(), &c[2]),
            None => "[withheld]".to_string(),
        })
        .into_owned()
}

fn prefixed(id: &str, letter: char) -> Result<i64, String> {
    let id = id.trim();
    id.strip_prefix(letter)
        .or_else(|| id.strip_prefix(letter.to_ascii_lowercase()))
        .unwrap_or(id)
        .parse()
        .map_err(|_| format!("{id:?} isn't {letter}<number>."))
}

fn task_id(id: &str) -> Result<i64, String> {
    prefixed(id, 'T')
}

// ---- transcripts and paths ---------------------------------------------------------------------

/// The owner's typed message on one transcript line, with its time: Claude Code's human turns,
/// Codex's user_message events.
pub fn owner_message(harness: &str, line: &str) -> Option<(String, Option<i64>)> {
    let quick = match harness {
        "codex" => line.contains("\"user_message\""),
        _ => line.contains("\"human\""),
    };
    if !quick {
        return None;
    }
    let d: Value = serde_json::from_str(line).ok()?;
    let at = d
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso_utc);
    let text = if harness == "codex" {
        if str_of(&d, "type") != "event_msg" || d["payload"]["type"] != "user_message" {
            return None;
        }
        d["payload"]["message"].as_str()?.to_string()
    } else {
        let human = d["turnOrigin"] == "human" || d["origin"]["kind"] == "human";
        if str_of(&d, "type") != "user"
            || !human
            || d["isMeta"] == true
            || d["isCompactSummary"] == true
            || d["isVisibleInTranscriptOnly"] == true
        {
            return None;
        }
        match &d["message"]["content"] {
            Value::String(s) => s.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            _ => return None,
        }
    };
    let t = text.trim();
    if t.is_empty() || t.starts_with("<command-") || t.starts_with("<local-command") {
        return None;
    }
    Some((t.to_string(), at))
}

static PATCH_FILE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$").expect("valid pattern")
});

/// The files a tool call is about to change: Claude Code's file_path / notebook_path, or the
/// files named in a Codex apply_patch.
pub fn edited_paths(tool_input: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for key in ["file_path", "notebook_path"] {
        if let Some(p) = tool_input.get(key).and_then(Value::as_str) {
            out.push(p.to_string());
        }
    }
    let mut strings: Vec<&str> = Vec::new();
    match tool_input {
        Value::String(s) => strings.push(s),
        Value::Object(map) => collect_strings(map, &mut strings),
        _ => {}
    }
    for s in strings {
        for c in PATCH_FILE.captures_iter(s) {
            out.push(c[1].to_string());
        }
    }
    out.dedup();
    out
}

fn collect_strings<'a>(map: &'a Map<String, Value>, out: &mut Vec<&'a str>) {
    for v in map.values() {
        match v {
            Value::String(s) => out.push(s),
            Value::Array(a) => out.extend(a.iter().filter_map(Value::as_str)),
            _ => {}
        }
    }
}

/// Where an agent works: `root` is the folder (the git checkout, else the working folder), and
/// `id` names the project the same way on every machine (its git remote, as
/// "github.com/owner/repo"), so a checkout on the Mac and one on the VM are one project.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Project {
    pub id: String,
    pub root: String,
}

pub fn project_of(cwd: &str) -> Project {
    if cwd.is_empty() {
        return Project::default();
    }
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let root = git(&["rev-parse", "--show-toplevel"])
        .unwrap_or_else(|| cwd.trim_end_matches('/').to_string());
    let id = git(&["config", "--get", "remote.origin.url"])
        .and_then(|u| remote_id(&u))
        .unwrap_or_else(|| root.clone());
    Project { id, root }
}

/// "git@github.com:Owner/Repo.git", "https://user@github.com/Owner/Repo" and
/// "ssh://git@github.com/Owner/Repo.git" are all "github.com/owner/repo".
pub fn remote_id(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = match url.split_once("://") {
        Some((_, rest)) => rest.to_string(),
        None => url.replacen(':', "/", 1), // scp-like: user@host:path
    };
    let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(&rest);
    let rest = rest
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_end_matches('/');
    let (host, path) = rest.split_once('/')?;
    let host = host.split(':').next().unwrap_or(host); // drop a port
    if host.is_empty() || path.is_empty() || host.starts_with('/') {
        return None;
    }
    Some(format!("{host}/{path}").to_lowercase())
}

fn relative(project: &str, path: &str) -> String {
    let p = Path::new(path);
    if p.is_absolute() {
        if let Ok(rel) = p.strip_prefix(project) {
            return rel.to_string_lossy().into_owned();
        }
        return path.to_string();
    }
    path.trim_start_matches("./").to_string()
}

/// `*` within a folder, `**` across folders, `?` one character; a glob naming a folder
/// ("docs/" or "docs") also covers everything in it.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim_start_matches("./");
    let pattern = if pattern.ends_with('/') {
        format!("{pattern}**")
    } else if !pattern.contains(['*', '?']) {
        return path == pattern || path.starts_with(&format!("{pattern}/"));
    } else {
        pattern.to_string()
    };
    let p: Vec<char> = pattern.chars().collect();
    let mut re = String::from("^");
    let mut i = 0;
    while i < p.len() {
        match p[i] {
            '*' if p.get(i + 1) == Some(&'*') => {
                if p.get(i + 2) == Some(&'/') {
                    re.push_str("(?:.*/)?");
                    i += 3;
                } else {
                    re.push_str(".*");
                    i += 2;
                }
                continue;
            }
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    re.push('$');
    Regex::new(&re).is_ok_and(|r| r.is_match(path))
}

// ---- time and files ----------------------------------------------------------------------------

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// "2026-11-14T00:31:05", local time.
pub fn iso(secs: i64) -> String {
    let t = secs as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::localtime_r(&t, &mut tm);
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

/// Seconds since 1970 for "2026-11-11T05:58:37.754Z" (UTC).
pub fn parse_iso_utc(s: &str) -> Option<i64> {
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (
        num(0, 4)?,
        num(5, 7)?,
        num(8, 10)?,
        num(11, 13)?,
        num(14, 16)?,
        num(17, 19)?,
    );
    // Days from 1970-01-01 to y-mo-d (Howard Hinnant's days_from_civil).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3_600 + mi * 60 + se)
}

fn private(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

/// The hook events Hive uses, with the tool matcher for PreToolUse. Codex gets no matcher: its
/// patches can arrive through more than one tool, and the hook ignores any call that edits nothing.
fn hook_events(harness: &str) -> Vec<(&'static str, Option<&'static str>, u64)> {
    let edit = if harness == "claude" {
        Some("Edit|Write|MultiEdit|NotebookEdit|Bash|Agent|Task")
    } else {
        None
    };
    vec![
        ("SessionStart", None, 10),
        ("UserPromptSubmit", None, 10),
        ("PreToolUse", edit, 10),
        ("Stop", None, 10),
    ]
}

/// A harness's hook settings (Claude Code's settings.json, Codex's hooks.json: the same shape)
/// with Hive's hooks put in (`command` given) or taken out (None). Hooks that aren't Hive's stay
/// as they are, and putting them in twice changes nothing.
pub fn merge_hooks(mut settings: Value, harness: &str, command: Option<&str>) -> Value {
    if !settings.is_object() {
        settings = json!({});
    }
    let ours = |h: &Value| {
        h["command"]
            .as_str()
            .is_some_and(|c| c.contains("hive-tasks") && c.contains(" hook "))
    };
    if !settings["hooks"].is_object() {
        settings["hooks"] = json!({});
    }
    let hooks = settings["hooks"].as_object_mut().expect("an object");
    // Out with any of ours, dropping entries and events left empty.
    for entries in hooks.values_mut() {
        if let Some(list) = entries.as_array_mut() {
            for entry in list.iter_mut() {
                if let Some(inner) = entry.get_mut("hooks").and_then(Value::as_array_mut) {
                    inner.retain(|h| !ours(h));
                }
            }
            list.retain(|e| e["hooks"].as_array().is_none_or(|a| !a.is_empty()));
        }
    }
    hooks.retain(|_, v| v.as_array().is_none_or(|a| !a.is_empty()));
    if let Some(command) = command {
        for (event, matcher, timeout) in hook_events(harness) {
            let mut entry =
                json!({"hooks": [{"type": "command", "command": command, "timeout": timeout}]});
            if let Some(m) = matcher {
                entry["matcher"] = json!(m);
            }
            let list = hooks.entry(event).or_insert_with(|| json!([]));
            if let Some(a) = list.as_array_mut() {
                a.push(entry);
            }
        }
    }
    if hooks.is_empty() {
        settings.as_object_mut().expect("an object").remove("hooks");
    }
    settings
}

/// `HIVE_TASKS_COMMAND`, else this program's path (quoted if it needs it).
fn command_name() -> String {
    if let Some(c) = std::env::var("HIVE_TASKS_COMMAND")
        .ok()
        .filter(|c| !c.is_empty())
    {
        return c;
    }
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "hive-tasks".into());
    if exe.contains(|c: char| c.is_whitespace() || "'\"$`\\".contains(c)) {
        format!("'{}'", exe.replace('\'', r"'\''"))
    } else {
        exe
    }
}
