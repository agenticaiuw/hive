//! Talking to an agent on this Mac (2026-11-16).
//!
//! The owner: "click into each agent and also directly talk to each agent". What they say to one of
//! their agents, from any dashboard, goes through the cloud (POST /v1/runs/message,
//! cloud/tasks/worker.js) and waits there for the node that agent is on. This Mac takes the messages
//! for its agents (POST /v1/runs/messages/take) and hands each one over:
//!
//! - a Claude Code or Codex session in the middle of a turn gets it at its next step: the hook after
//!   its next tool call adds it to what the model reads, or its Stop hook keeps the turn going with it
//!   ([`with_messages`], from main.rs);
//! - a session that's idle is continued with it in the background, in its own folder
//!   (`claude --bg --resume <session> <words>`, `codex exec resume <session> <words>`), and streams
//!   back to the board like any session (live.rs). Claude Code says it started a copy when the
//!   session is still open somewhere;
//! - Hive on this Mac gets it as a request, through its request socket;
//! - a Claude Code session open in an app or terminal shows it as the owner's own message: Hive's
//!   mod there (desktop/claude-code/hive-board) says the session is open every few seconds and takes
//!   its messages (`hive-tasks messages`, [`for_open_session`]), and submits each as a prompt, so the
//!   owner sees their words in the chat. Its hooks and the background wake leave those messages to
//!   it while it listens (owner, 2026-11-17: "why can't i see my own prompt in claude code?").
//!
//! Then the cloud hears how that went (POST /v1/runs/messages/update), so every dashboard shows the
//! message as delivered, or why not. Taking happens in `hive-tasks deliver` ([`deliver_now`]): after a
//! session's steps are sent (live-send), every few seconds while Hive runs (hive-app), and right after
//! the owner sends one from Hive's window on this Mac. Between taking and handing over, the messages
//! wait in live.sqlite3, beside the ledger.

use crate::live::{live_path, Live};
use crate::{now, Cloud};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A session that did something this recently, and says it's working, gets a message at its next
/// step; one quiet longer than this is woken with it.
pub const BUSY_FOR: i64 = 600;
/// A session whose mod said it was open this recently takes its own messages (as prompts).
pub const LISTEN_FOR: i64 = 45;
/// How long a woken harness gets to say it couldn't start before the message counts as delivered.
const START_WAIT: Duration = Duration::from_secs(6);

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,                 -- the cloud's id for the message
  run TEXT NOT NULL,                      -- the conversation: claude:<session>, codex:<session>, a Hive run
  agent TEXT NOT NULL,
  text TEXT NOT NULL,
  wake INTEGER NOT NULL DEFAULT 1,        -- 0: only for a session that is running (a cancel)
  state TEXT NOT NULL DEFAULT 'waiting',  -- waiting, delivered, failed
  detail TEXT NOT NULL DEFAULT '',
  reported INTEGER NOT NULL DEFAULT 0,    -- the cloud knows how it went
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS listeners (
  run TEXT PRIMARY KEY,                   -- claude:<session>, open in an app or terminal
  at INTEGER NOT NULL                     -- when its mod last said so
);
";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// What to do with one waiting message.
#[derive(Debug, PartialEq)]
pub enum Handover {
    /// The session is mid-turn: its next hook gives it the message.
    Wait,
    /// The session is idle: run this in its folder to continue it with the message.
    Wake { program: &'static str, args: Vec<String>, cwd: String },
    /// Hive on this Mac takes it as a request.
    ToHive,
    /// Nothing to hand over (a cancel for a session that isn't running): settled as delivered.
    Settled(String),
    Fail(String),
}

/// A session as live.sqlite3 knows it: (status, last heard from, its folder, its transcript).
pub type Seen = (String, i64, String, String);
/// A waiting message: (id, run, agent, text, wake).
pub type Waiting = (i64, String, String, String, bool);

/// What to do with a message for `run`, given what is known of its session.
pub fn handover(agent: &str, run: &str, text: &str, wake: bool, seen: Option<&Seen>, at: i64) -> Handover {
    if run.starts_with("hive:") {
        return Handover::ToHive; // Hive's own agent on this Mac
    }
    let Some((harness, session)) = run.split_once(':') else {
        return if agent == "mac" {
            Handover::ToHive
        } else {
            Handover::Fail("This Mac doesn't run that agent.".into())
        };
    };
    if !matches!(harness, "claude" | "codex") || session.is_empty() {
        return Handover::Fail("This Mac doesn't run that agent.".into());
    }
    if let Some((status, updated, _, _)) = seen {
        if status == "working" && at - updated < BUSY_FOR {
            return Handover::Wait;
        }
    }
    if !wake {
        return Handover::Settled("Its session wasn't running, so there was nothing to stop.".into());
    }
    let cwd = seen
        .map(|(_, _, cwd, path)| if cwd.is_empty() { cwd_of_transcript(path) } else { cwd.clone() })
        .unwrap_or_default();
    if cwd.is_empty() {
        return Handover::Fail("Hive doesn't know which folder that session works in.".into());
    }
    let (program, args) = if harness == "claude" {
        ("claude", vec!["--bg".into(), "--resume".into(), session.into(), text.into()])
    } else {
        (
            "codex",
            vec![
                "exec".into(),
                "resume".into(),
                "--skip-git-repo-check".into(),
                session.into(),
                text.into(),
            ],
        )
    };
    Handover::Wake { program, args, cwd }
}

/// Where a session's transcript is: Claude Code's ~/.claude/projects/<folder>/<session>.jsonl,
/// Codex's ~/.codex/sessions/<y>/<m>/<d>/rollout-<when>-<session>.jsonl.
pub fn transcript_of(harness: &str, session: &str) -> Option<PathBuf> {
    if session.is_empty() || session.contains('/') {
        return None;
    }
    let home = hive_common::paths::home();
    let in_dir = |dir: PathBuf| std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path());
    if harness == "claude" {
        let name = format!("{session}.jsonl");
        return in_dir(home.join(".claude/projects")).map(|d| d.join(&name)).find(|p| p.is_file());
    }
    if harness != "codex" {
        return None;
    }
    let tail = format!("-{session}.jsonl");
    let codex = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex"));
    // Newest days first.
    let newest_first = |dir: PathBuf| {
        let mut all: Vec<PathBuf> = in_dir(dir).collect();
        all.sort();
        all.into_iter().rev()
    };
    for year in newest_first(codex.join("sessions")) {
        for month in newest_first(year) {
            for day in newest_first(month) {
                if let Some(found) = in_dir(day).find(|p| p.to_string_lossy().ends_with(&tail)) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// The folder a session works in, from its transcript's first lines (Claude Code writes "cwd" on
/// its lines, Codex on its session_meta line).
pub fn cwd_of_transcript(path: &str) -> String {
    let Ok(file) = std::fs::File::open(path) else {
        return String::new();
    };
    for line in BufReader::new(file.take(256 * 1024)).lines().map_while(Result::ok).take(40) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        for cwd in [&v["cwd"], &v["payload"]["cwd"]] {
            if let Some(cwd) = cwd.as_str().filter(|c| !c.is_empty()) {
                return cwd.to_string();
            }
        }
    }
    String::new()
}

/// How Hive's own messages start (the cloud's continueStuck: a stuck task continued without the
/// owner), so no board takes them for the owner's words (`from_the_owner`, [`as_said`]).
pub const FROM_HIVE: &str = "[Hive, not the owner]";

/// How the owner's words read to an agent that is mid-turn; Hive's own messages, said as Hive's.
pub fn as_said(texts: &[String]) -> String {
    let (hive, owner): (Vec<String>, Vec<String>) =
        texts.iter().map(|t| t.trim().to_string()).partition(|t| t.starts_with(FROM_HIVE));
    let mut parts = Vec::new();
    if !owner.is_empty() {
        let one = owner.len() == 1;
        parts.push(format!(
            "The owner just sent you {} from the Hive dashboard, in their own words. Read {} and act on {} now:\n{}",
            if one { "this message" } else { "these messages" },
            if one { "it" } else { "them" },
            if one { "it" } else { "them" },
            owner.join("\n---\n"),
        ));
    }
    if !hive.is_empty() {
        parts.push(format!("Hive (not the owner) sends you this; act on it now:\n{}", hive.join("\n---\n")));
    }
    parts.join("\n\n")
}

/// A hook's output with the messages waiting for its session added: to what the model reads after a
/// tool or a prompt, or, as a turn ends, as the reason it goes on.
pub fn merge(event: &str, out: Value, said: &str) -> Value {
    let mut out = if out.is_object() { out } else { json!({}) };
    if event == "Stop" {
        let reason = match (out.get("decision").and_then(Value::as_str), out.get("reason").and_then(Value::as_str)) {
            (Some("block"), Some(before)) if !before.trim().is_empty() => format!("{before}\n\n{said}"),
            _ => said.to_string(),
        };
        out["decision"] = json!("block");
        out["reason"] = json!(reason);
        return out;
    }
    let before = out["hookSpecificOutput"]["additionalContext"].as_str().unwrap_or("").to_string();
    if !out["hookSpecificOutput"].is_object() {
        out["hookSpecificOutput"] = json!({});
    }
    out["hookSpecificOutput"]["hookEventName"] = json!(event);
    out["hookSpecificOutput"]["additionalContext"] =
        json!(if before.trim().is_empty() { said.to_string() } else { format!("{before}\n\n{said}") });
    out
}

pub struct Inbox {
    db: Connection,
}

impl Inbox {
    pub fn open(path: &Path) -> Result<Inbox, String> {
        drop(Live::open(path)?); // the sessions it hands messages to
        let db = Connection::open(path).map_err(err)?;
        db.busy_timeout(Duration::from_secs(3)).map_err(err)?;
        db.execute_batch(SCHEMA).map_err(err)?;
        Ok(Inbox { db })
    }

    /// Keeps the messages the cloud handed this Mac (each once).
    pub fn keep(&self, messages: &[Value]) -> Result<usize, String> {
        let mut kept = 0;
        for m in messages {
            let (Some(id), Some(run), Some(text)) = (m["id"].as_i64(), m["run"].as_str(), m["text"].as_str()) else {
                continue;
            };
            let wake = m["wake"].as_i64().unwrap_or(1) != 0;
            kept += self
                .db
                .execute(
                    "INSERT OR IGNORE INTO inbox (id, run, agent, text, wake, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![id, run, m["agent"].as_str().unwrap_or(""), text, wake, now()],
                )
                .map_err(err)?;
        }
        Ok(kept)
    }

    /// The messages waiting for `run`, now delivered (`how` says how), oldest first.
    pub fn take_for(&self, run: &str, how: &str) -> Result<Vec<String>, String> {
        self.take_matching(run, how, false)
    }

    /// As [`Inbox::take_for`]; `cancels_only`: just the ones only for a running session (a cancel),
    /// which a session's hooks still give it while its mod takes the rest as prompts.
    fn take_matching(&self, run: &str, how: &str, cancels_only: bool) -> Result<Vec<String>, String> {
        let mut stmt = self
            .db
            .prepare("SELECT id, text FROM inbox WHERE run = ?1 AND state = 'waiting' AND (?2 = 0 OR wake = 0) ORDER BY id")
            .map_err(err)?;
        let rows: Vec<(i64, String)> = stmt
            .query_map(params![run, cancels_only], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        for (id, _) in &rows {
            self.settle(*id, "delivered", how)?;
        }
        Ok(rows.into_iter().map(|(_, t)| t).collect())
    }

    /// The session's mod says it is open, now.
    pub fn listen(&self, run: &str, at: i64) -> Result<(), String> {
        self.db
            .execute("INSERT INTO listeners (run, at) VALUES (?1, ?2) ON CONFLICT (run) DO UPDATE SET at = ?2", params![run, at])
            .map_err(err)?;
        Ok(())
    }

    /// Whether `run`'s mod said it was open within [`LISTEN_FOR`] of `at`.
    pub fn listened(&self, run: &str, at: i64) -> Result<bool, String> {
        let last: Option<i64> = self
            .db
            .query_row("SELECT at FROM listeners WHERE run = ?1", [run], |r| r.get(0))
            .optional()
            .map_err(err)?;
        Ok(last.is_some_and(|last| at - last < LISTEN_FOR))
    }

    /// The messages waiting for an open session to show as prompts: `[{id, text}]`, oldest first,
    /// still waiting until [`Inbox::shown`] says they were submitted (a cancel is left to its hooks).
    pub fn for_prompts(&self, run: &str) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .db
            .prepare("SELECT id, text FROM inbox WHERE run = ?1 AND state = 'waiting' AND wake = 1 ORDER BY id")
            .map_err(err)?;
        let rows = stmt
            .query_map([run], |r| Ok(json!({"id": r.get::<_, i64>(0)?, "text": r.get::<_, String>(1)?})))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        Ok(rows)
    }

    /// The open session submitted these of its messages as the owner's prompts.
    pub fn shown(&self, run: &str, ids: &[i64]) -> Result<usize, String> {
        let mut n = 0;
        for id in ids {
            n += self
                .db
                .execute(
                    "UPDATE inbox SET state = 'delivered', detail = ?3, reported = 0 WHERE id = ?1 AND run = ?2 AND state = 'waiting'",
                    params![id, run, SHOWN],
                )
                .map_err(err)?;
        }
        Ok(n)
    }

    /// Every waiting message: (id, run, agent, text) and what is known of its session.
    pub fn waiting(&self) -> Result<Vec<(Waiting, Option<Seen>)>, String> {
        let mut stmt = self
            .db
            .prepare("SELECT id, run, agent, text, wake FROM inbox WHERE state = 'waiting' ORDER BY id")
            .map_err(err)?;
        let rows: Vec<Waiting> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        rows.into_iter()
            .map(|row| {
                let seen = match row.1.split_once(':') {
                    Some((harness, session)) => self
                        .db
                        .query_row(
                            "SELECT status, updated_at, cwd, path FROM sessions WHERE harness = ?1 AND session = ?2",
                            params![harness, session],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                        )
                        .optional()
                        .map_err(err)?
                        // A session from before Hive streamed sessions: its transcript says where.
                        .or_else(|| {
                            transcript_of(harness, session)
                                .map(|p| ("done".to_string(), 0, String::new(), p.display().to_string()))
                        }),
                    None => None,
                };
                Ok((row, seen))
            })
            .collect()
    }

    pub fn settle(&self, id: i64, state: &str, detail: &str) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE inbox SET state = ?2, detail = ?3, reported = 0 WHERE id = ?1",
                params![id, state, detail],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Delivered or failed messages the cloud hasn't heard about: (id, state, detail).
    pub fn unreported(&self) -> Result<Vec<(i64, String, String)>, String> {
        let mut stmt = self
            .db
            .prepare("SELECT id, state, detail FROM inbox WHERE state != 'waiting' AND reported = 0 ORDER BY id")
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        Ok(rows)
    }

    pub fn reported(&self, id: i64) -> Result<(), String> {
        self.db.execute("UPDATE inbox SET reported = 1 WHERE id = ?1", [id]).map_err(err)?;
        // A week on, a settled message is forgotten here (the cloud keeps it).
        self.db
            .execute("DELETE FROM inbox WHERE reported = 1 AND at < ?1", [now() - 7 * 86400])
            .map_err(err)?;
        Ok(())
    }
}

/// From a hook (main.rs): the hook's output with the messages waiting for its session, if any, and
/// a sender started to tell the cloud they were given. Never fails the hook.
pub fn with_messages(harness: &str, input: &Value, out: Value) -> Value {
    let event = input["hook_event_name"].as_str().unwrap_or("");
    let session = input["session_id"].as_str().unwrap_or("");
    if session.is_empty() || !matches!(event, "PostToolUse" | "UserPromptSubmit" | "Stop") {
        return out;
    }
    let how = if event == "Stop" {
        "Given to the session as its turn ended; it went on with it."
    } else {
        "Given to the session at its next step."
    };
    let run = format!("{harness}:{session}");
    let taken = Inbox::open(&live_path()).and_then(|inbox| {
        // An open session's mod shows its messages as the owner's prompts; its hooks give it only a cancel.
        let cancels_only = inbox.listened(&run, now())?;
        inbox.take_matching(&run, how, cancels_only)
    });
    match taken {
        Ok(texts) if !texts.is_empty() => {
            crate::live::send_soon();
            merge(event, out, &as_said(&texts))
        }
        Ok(_) => out,
        Err(e) => {
            eprintln!("hive-tasks: inbox: {e}");
            out
        }
    }
}

/// `hive-tasks deliver`: takes this Mac's messages from the cloud, hands each over, and tells the
/// cloud how that went. One at a time (a lock beside the live sessions).
pub fn deliver_now() -> Result<String, String> {
    let Some(cloud) = Cloud::load() else {
        return Ok(String::new());
    };
    let path = live_path();
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path.with_file_name("inbox.lock"))
        .map_err(err)?;
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Ok(String::new()); // another deliverer has it
    }
    let inbox = Inbox::open(&path)?;
    let took = cloud.post("/v1/runs/messages/take", &json!({"machine": cloud.machine}))?;
    let kept = inbox.keep(took["messages"].as_array().map(Vec::as_slice).unwrap_or(&[]))?;
    let handed = hand_over(&inbox, now(), &mut wake, &mut to_hive)?;
    report(&cloud, &inbox)?;
    drop(lock);
    Ok(format!("{kept} taken, {handed} handed over"))
}

/// How a message shown in its open session reads on every dashboard.
const SHOWN: &str = "Shown in its open Claude Code session as your message.";

/// Tells the cloud how each settled message went, so every dashboard shows it.
fn report(cloud: &Cloud, inbox: &Inbox) -> Result<(), String> {
    for (id, state, detail) in inbox.unreported()? {
        let status = if state == "delivered" { "delivered" } else { "failed" };
        if cloud
            .post("/v1/runs/messages/update", &json!({"id": id, "status": status, "detail": detail}))
            .is_ok()
        {
            inbox.reported(id)?;
        }
    }
    Ok(())
}

/// `hive-tasks messages <run> [shown <id>...]`, from an open session's mod: says the session is
/// open, takes this Mac's messages from the cloud, and answers the ones for `run` as `[{id, text}]`;
/// with `shown`, those were submitted as the owner's prompts, and the cloud hears so.
pub fn for_open_session(run: &str, shown: &[i64]) -> Result<String, String> {
    if !run.starts_with("claude:") || run.len() <= "claude:".len() {
        return Err("Say which open session (claude:<session id>).".into());
    }
    let inbox = Inbox::open(&live_path())?;
    inbox.listen(run, now())?;
    if !shown.is_empty() {
        inbox.shown(run, shown)?;
        if let Some(cloud) = Cloud::load() {
            report(&cloud, &inbox)?;
        }
        return Ok("[]".into());
    }
    // Take what the cloud holds for this Mac (others' messages are handed over as usual).
    if let Err(e) = deliver_now() {
        eprintln!("hive-tasks: deliver: {e}");
    }
    serde_json::to_string(&inbox.for_prompts(run)?).map_err(err)
}

/// Hands over every waiting message that can go now; how many went.
pub fn hand_over(
    inbox: &Inbox,
    at: i64,
    wake: &mut impl FnMut(&str, &[String], &str) -> Result<String, String>,
    to_hive: &mut impl FnMut(i64, &str) -> Result<String, String>,
) -> Result<usize, String> {
    let mut handed = 0;
    for ((id, run, agent, text, wake_it), seen) in inbox.waiting()? {
        if wake_it && inbox.listened(&run, at)? {
            continue; // its open session's mod shows it as the owner's message
        }
        let (state, detail) = match handover(&agent, &run, &text, wake_it, seen.as_ref(), at) {
            Handover::Wait => continue,
            Handover::Settled(why) => ("delivered", why),
            Handover::Wake { program, args, cwd } => match wake(program, &args, &cwd) {
                Ok(said) => ("delivered", said),
                Err(e) => ("failed", e),
            },
            Handover::ToHive => match to_hive(id, &text) {
                Ok(said) => ("delivered", said),
                Err(e) => ("failed", e),
            },
            Handover::Fail(why) => ("failed", why),
        };
        inbox.settle(id, state, &detail)?;
        handed += 1;
    }
    Ok(handed)
}

/// Where a harness's program is, for a process started from an app (whose PATH is short).
fn program_path(program: &str) -> Option<PathBuf> {
    let home = hive_common::paths::home();
    let mut places: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    places.extend([
        home.join(".local/bin"),
        home.join(".claude/local"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    // npm's global programs under nvm, newest Node first.
    if let Ok(dirs) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut nodes: Vec<PathBuf> = dirs.flatten().map(|d| d.path().join("bin")).collect();
        nodes.sort();
        places.extend(nodes.into_iter().rev());
    }
    places.into_iter().map(|d| d.join(program)).find(|p| p.is_file())
}

/// Continues a session in the background: started apart from whatever runs this (so its hooks
/// stream it to the board like any session), in its own folder. Says what the harness said if it
/// couldn't start.
fn wake(program: &str, args: &[String], cwd: &str) -> Result<String, String> {
    let Some(path) = program_path(program) else {
        return Err(format!("{program} isn't installed where Hive can find it on this Mac."));
    };
    if !Path::new(cwd).is_dir() {
        return Err(format!("The session's folder ({cwd}) isn't there any more."));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let log = std::env::temp_dir().join(format!("hive-wake-{}-{stamp}.log", std::process::id()));
    let dir = path.parent().map(|d| d.display().to_string()).unwrap_or_default();
    // sh starts it in the background and leaves at once, so the harness belongs to nobody here;
    // the line it adds when the harness ends says whether it could.
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.arg("-c")
        .arg("{ \"$@\"; echo \"hive-exit:$?\"; } </dev/null >\"$HIVE_WAKE_LOG\" 2>&1 & echo $!")
        .arg("sh")
        .arg(&path)
        .args(args)
        .current_dir(cwd)
        .env("HIVE_WAKE_LOG", &log)
        .env("PATH", format!("{dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"))
        .env_remove("HIVE_TASKS_OFF");
    // Not a session inside the one whose hook this may be.
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if (key.starts_with("CLAUDE") && key != "CLAUDE_CONFIG_DIR") || key.starts_with("CODEX_THREAD") {
            cmd.env_remove(key.as_ref());
        }
    }
    let started = cmd.output().map_err(|e| format!("Couldn't start {program}: {e}"))?;
    let pid: i32 = String::from_utf8_lossy(&started.stdout).trim().parse().unwrap_or(0);
    let deadline = std::time::Instant::now() + START_WAIT;
    while pid > 0 && std::time::Instant::now() < deadline && unsafe { libc::kill(pid, 0) } == 0 {
        std::thread::sleep(Duration::from_millis(250));
    }
    let said = std::fs::read_to_string(&log).unwrap_or_default();
    let _ = std::fs::remove_file(&log);
    woke(program, &said)
}

/// What a woken harness's first seconds of output (`said`) mean.
pub fn woke(program: &str, said: &str) -> Result<String, String> {
    let exit = said
        .lines()
        .rev()
        .find_map(|l| l.trim().strip_prefix("hive-exit:"))
        .and_then(|c| c.trim().parse::<i32>().ok());
    if exit.is_some_and(|c| c != 0) {
        let first = said
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with("hive-exit:"))
            .unwrap_or("it stopped at once");
        return Err(format!("{program} couldn't continue the session: {first}"));
    }
    Ok(if program == "claude" && said.to_lowercase().contains("copy") {
        "The session is open elsewhere, so Claude Code continued a copy of it in the background.".into()
    } else {
        "The session was idle, so it was continued in the background with the message.".into()
    })
}

/// Hive on this Mac takes the message as a request (its request socket, as the dashboard window
/// sends one).
fn to_hive(id: i64, text: &str) -> Result<String, String> {
    let socket = hive_common::paths::state_dir().join("control/request.sock");
    let mut stream = std::os::unix::net::UnixStream::connect(&socket)
        .map_err(|_| "Hive isn't running on this Mac, so it can't take it yet.".to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(8))).map_err(err)?;
    let line = json!({"text": text, "sourceId": format!("dashboard-message:{id}")}).to_string();
    stream.write_all(format!("{line}\n").as_bytes()).map_err(err)?;
    let mut answer = String::new();
    let _ = BufReader::new(stream).read_line(&mut answer);
    let reply: Value = serde_json::from_str(answer.trim()).unwrap_or(Value::Null);
    if reply["ok"] == true || reply["error"] == "Request already received; no repeat was started." {
        Ok("Hive on this Mac took it as a request.".into())
    } else if reply.is_null() {
        Ok("Sent to Hive on this Mac; it didn't answer, so it may have started anyway.".into())
    } else {
        Err(reply["error"].as_str().unwrap_or("Hive didn't take it.").to_string())
    }
}
