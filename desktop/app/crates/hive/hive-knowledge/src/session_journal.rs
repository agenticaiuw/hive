//! The session journal: everything said in one run of the voice agent, saved as it happens
//! (python/session_journal.py, with agent-journal-reader's rendering and file work done here
//! instead of in a helper process).
//!
//! Each run is a session, in `<state>/sessions/<started>-<pid>/`: `journal.jsonl` (one JSON object
//! per line, appended and synced line by line), `manifest.json` (when it started, the backend and
//! model, the code's git commit, every Codex thread with its rollout file), `index.html` (the same,
//! readable) and `panel.json` (what the Agent Context panel shows, see [`crate::context_panel`]).

use crate::context_panel;
use crate::pyjson;
use crate::util::{self, Local};
use serde_json::{Map, Value};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// `session_journal.py`'s docstring, printed for an unknown command.
pub const USAGE: &str = r#"The session journal: everything said in one run of the voice agent, saved as it happens, for
reviewing and improving the agent later (a self-evolving harness reads these).

Each run of the voice agent (from opening Agent.app to quitting it) is a session, in
    ~/Library/Application Support/Personal Agent/sessions/<started>-<pid>/
  journal.jsonl   one JSON object per line, in order: every transcript of what you said and what
                  became of it (a request, "stop", a filler, its own voice, ...), each request with
                  its device and Codex thread, everything the agent did, said and showed, errors,
                  and how each task ended. Appended and flushed line by line, so a crash keeps it.
  manifest.json   when it started, the backend and model, the git commit of the code, and every
                  Codex thread it used, with the path of that thread's full saved context
  index.html      the same, readable (Agent menu → Show Agent Context → Sessions)

The full model context of a Codex thread (base and developer instructions, every input with its
screenshots, tool calls and their results, the replies) is Codex's own rollout file,
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl, which the manifest points to; the
context viewer (agent_context.py) has each payload the app exchanged, tagged with the session.

    .venv/bin/python python/session_journal.py              # the sessions, newest first
    .venv/bin/python python/session_journal.py show [ID]    # one session (default: the latest), readable
    .venv/bin/python python/session_journal.py paths [ID]   # its files and its Codex rollouts

What you dictate into other apps (hold fn) is yours, not a request: only how many words is saved,
unless AGENT_JOURNAL_DICTATION=1.
"#;

/// What Python raised when the journal helper failed.
const RENDER_FAILED: &str = "Could not render session journal";

static CURRENT: Mutex<Option<Arc<SessionJournal>>> = Mutex::new(None);

/// This process's session, for the context viewer to tag records with (Python's module-level
/// `current`).
pub fn current() -> Option<Arc<SessionJournal>> {
    CURRENT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Sets (or clears) this process's session.
pub fn set_current(journal: Option<Arc<SessionJournal>>) {
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = journal;
}

/// `<state>/sessions`.
pub fn sessions_dir() -> PathBuf {
    hive_common::paths::state_dir().join("sessions")
}

/// `CODEX_HOME`, else ~/.codex.
pub fn codex_home() -> PathBuf {
    match std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        Some(home) => PathBuf::from(home),
        None => hive_common::paths::home().join(".codex"),
    }
}

/// The file Codex keeps a thread's full context in:
/// `$CODEX_HOME/sessions/*/*/*/rollout-*-<thread>.jsonl`.
pub fn rollout_for(thread: &str) -> Option<String> {
    let (prefix, suffix) = ("rollout-", format!("-{thread}.jsonl"));
    // glob's `*`: every entry of each folder, except names starting with a dot.
    let entries = |paths: Vec<PathBuf>| -> Vec<PathBuf> {
        paths
            .into_iter()
            .filter(|p| p.is_dir())
            .flat_map(|p| util::listing(&p))
            .filter(|p| !util::file_name(p).starts_with('.'))
            .collect()
    };
    let files = entries(entries(entries(entries(vec![
        codex_home().join("sessions")
    ]))));
    files
        .into_iter()
        .find(|p| {
            let name = util::file_name(p);
            name.len() >= prefix.len() + suffix.len()
                && name.starts_with(prefix)
                && name.ends_with(&suffix)
        })
        .map(|p| p.to_string_lossy().into_owned())
}

/// The code's git commit, with " (with uncommitted changes)" when the work tree differs.
pub fn git_commit() -> String {
    let root = hive_common::paths::repo_root();
    let git = |args: &[&str]| -> io::Result<String> {
        let mut command = Command::new("git");
        // No index refresh: reading the commit never writes to the work tree's .git.
        command
            .env("GIT_OPTIONAL_LOCKS", "0")
            .arg("-C")
            .arg(&root)
            .args(args);
        let out = util::run(&mut command, None, Some(Duration::from_secs(5)))?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let found = git(&["rev-parse", "--short", "HEAD"]).and_then(|commit| {
        Ok((
            commit,
            git(&["status", "--porcelain", "--untracked-files=no"])?,
        ))
    });
    match found {
        Ok((commit, dirty)) if dirty.is_empty() => commit,
        Ok((commit, _)) => commit + " (with uncommitted changes)",
        Err(_) => "unknown".into(),
    }
}

// --- the journal ------------------------------------------------------------------------------

struct Inner {
    entries: Vec<Value>,
    threads: Vec<Value>,
    manifest: Map<String, Value>,
    journal: Option<File>,
}

/// Wakes the thread that rewrites panel.json.
#[derive(Default)]
struct Panel {
    changed: Mutex<bool>,
    wake: Condvar,
    closed: AtomicBool,
    error: Mutex<Option<String>>,
}

/// One run of the agent's journal. Writing never fails: the first error is kept in [`error`].
///
/// [`error`]: SessionJournal::error
pub struct SessionJournal {
    pub id: String,
    pub dir: PathBuf,
    error: Mutex<Option<String>>,
    inner: Mutex<Inner>,
    panel: Arc<Panel>,
}

impl SessionJournal {
    /// Starts a session: its folder (private), manifest, first line ("session started" with
    /// `about`), the `latest` link and the sessions page, and the thread that keeps panel.json.
    /// `directory` replaces `<state>/sessions/<id>` (tests).
    pub fn new(
        about: Map<String, Value>,
        directory: Option<PathBuf>,
    ) -> Result<SessionJournal, String> {
        let started = util::now();
        let at = Local::at(started.floor());
        let id = format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}-{}",
            at.year,
            at.month,
            at.day,
            at.hour,
            at.minute,
            at.second,
            std::process::id()
        );
        let dir = directory.unwrap_or_else(|| sessions_dir().join(&id));
        initialize(&dir).map_err(|_| RENDER_FAILED.to_string())?;
        let mut manifest = Map::new();
        manifest.insert("session".into(), Value::from(id.clone()));
        manifest.insert("started".into(), Value::from(started));
        manifest.insert("ended".into(), Value::Null);
        manifest.insert("pid".into(), Value::from(std::process::id()));
        manifest.insert("code".into(), Value::from(git_commit()));
        for (k, v) in &about {
            manifest.insert(k.clone(), v.clone());
        }
        manifest.insert("threads".into(), Value::Array(vec![]));
        let path = dir.join("journal.jsonl");
        let journal = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .map_err(|e| util::os_error(&e, &path))?;
        let mut inner = Inner {
            entries: vec![],
            threads: vec![],
            manifest,
            journal: Some(journal),
        };
        save_manifest_of(&dir, &mut inner).map_err(|_| RENDER_FAILED.to_string())?;
        let context_dir = hive_common::paths::state_dir().join("context");
        let journal = SessionJournal {
            id,
            dir,
            error: Mutex::new(None),
            inner: Mutex::new(inner),
            panel: Arc::new(Panel::default()),
        };
        journal.add("session started", "", about);
        journal.link_latest()?;
        let (panel, session_dir) = (journal.panel.clone(), journal.dir.clone());
        std::thread::Builder::new()
            .name("session-panel".into())
            .spawn(move || keep_panel(panel, session_dir, context_dir))
            .map_err(|e| e.to_string())?;
        Ok(journal)
    }

    pub fn panel_path(&self) -> PathBuf {
        self.dir.join("panel.json")
    }

    /// The first error writing the journal, if any.
    pub fn error(&self) -> Option<String> {
        self.error.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The last error rewriting panel.json (None once a rewrite works).
    pub fn panel_error(&self) -> Option<String> {
        self.panel
            .error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The manifest as it is now.
    pub fn manifest(&self) -> Map<String, Value> {
        self.lock().manifest.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn keep_error(&self, error: String) {
        let mut kept = self.error.lock().unwrap_or_else(|e| e.into_inner());
        if kept.is_none() {
            *kept = Some(error);
        }
    }

    /// Something new to show in the Agent Context panel (a journal line, a context record).
    pub fn touch(&self) {
        *self.panel.changed.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.panel.wake.notify_all();
    }

    /// Saves one thing that happened: `{"time", "kind", "text", **fields}` (fields that are null
    /// left out). Never fails: the journal must not break the agent.
    pub fn add(&self, kind: &str, text: &str, fields: Map<String, Value>) -> Value {
        let mut entry = Map::new();
        entry.insert("time".into(), Value::from(util::now()));
        entry.insert("kind".into(), Value::from(kind));
        entry.insert("text".into(), Value::from(text));
        for (k, v) in &fields {
            if !v.is_null() {
                entry.insert(k.clone(), v.clone());
            }
        }
        let entry = Value::Object(entry);
        let result = (|| -> Result<(), String> {
            let mut inner = self.lock();
            let journal = inner
                .journal
                .as_ref()
                .ok_or_else(|| "ValueError: I/O operation on closed file".to_string())?;
            append(
                journal,
                format!("{}\n", pyjson::dumps_utf8(&entry)).as_bytes(),
            )
            .map_err(|_| "OSError: Journal append failed".to_string())?;
            inner.entries.push(entry.clone());
            if let Some(thread) = fields.get("thread").filter(|t| pyjson::truthy(Some(t))) {
                if !inner.threads.contains(thread) {
                    inner.threads.push(thread.clone());
                    save_manifest_of(&self.dir, &mut inner)
                        .map_err(|_| format!("RuntimeError: {RENDER_FAILED}"))?;
                }
            }
            let page = session_page(&inner.manifest, &inner.entries)
                .map_err(|_| format!("RuntimeError: {RENDER_FAILED}"))?;
            util::atomic_write(&self.dir.join("index.html"), &page)
                .map_err(|e| format!("OSError: {e}"))?;
            Ok(())
        })();
        match result {
            Ok(()) => self.touch(),
            Err(error) => self.keep_error(error), // a full disk, say: say so once, carry on
        }
        entry
    }

    /// The last line ("session ended"), the manifest's end time, and the journal closed.
    pub fn end(&self) {
        self.add("session ended", "", Map::new());
        let mut inner = self.lock();
        inner
            .manifest
            .insert("ended".into(), Value::from(util::now()));
        match save_manifest_of(&self.dir, &mut inner) {
            Ok(()) => {
                inner.journal = None;
                drop(inner);
                self.touch();
            }
            Err(_) => {
                drop(inner);
                self.keep_error(RENDER_FAILED.into());
            }
        }
    }

    fn link_latest(&self) -> Result<(), String> {
        let parent = self.dir.parent().map(Path::to_path_buf).unwrap_or_default();
        let latest = parent.join("latest");
        if latest.symlink_metadata().is_ok() {
            let _ = std::fs::remove_file(&latest);
        }
        let _ = std::os::unix::fs::symlink(util::file_name(&self.dir), &latest);
        write_sessions_page(&parent).map(drop)
    }
}

impl Drop for SessionJournal {
    fn drop(&mut self) {
        self.panel.closed.store(true, Ordering::SeqCst);
        self.panel.wake.notify_all();
    }
}

/// Rewrites panel.json at most twice a second, while there's something new.
fn keep_panel(panel: Arc<Panel>, session_dir: PathBuf, context_dir: PathBuf) {
    let mut builder: Option<context_panel::Builder> = None;
    loop {
        {
            let mut changed = panel.changed.lock().unwrap_or_else(|e| e.into_inner());
            while !*changed && !panel.closed.load(Ordering::SeqCst) {
                changed = panel.wake.wait(changed).unwrap_or_else(|e| e.into_inner());
            }
            if !*changed {
                return; // the journal is gone
            }
        }
        std::thread::sleep(Duration::from_millis(500)); // let a burst of events land first
        *panel.changed.lock().unwrap_or_else(|e| e.into_inner()) = false;
        let builder = builder.get_or_insert_with(|| {
            context_panel::Builder::new(session_dir.clone(), Some(context_dir.clone()))
        });
        let result = builder.write();
        *panel.error.lock().unwrap_or_else(|e| e.into_inner()) = result.err(); // the panel must never break the agent
    }
}

fn save_manifest_of(dir: &Path, inner: &mut Inner) -> Result<(), String> {
    let threads: Vec<Value> = inner
        .threads
        .iter()
        .map(|t| {
            let mut entry = Map::new();
            entry.insert("thread".into(), t.clone());
            entry.insert(
                "rollout".into(),
                rollout_for(&pyjson::str_of(t))
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
            Value::Object(entry)
        })
        .collect();
    inner
        .manifest
        .insert("threads".into(), Value::Array(threads));
    save_manifest(dir, &inner.manifest)
}

// --- the files (agent-journal-reader's work) ---------------------------------------------------

/// Makes the session's folder (and its parent) private and its journal.jsonl (0600), keeping
/// what a journal already has.
pub fn initialize(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let parent = dir
        .parent()
        .ok_or_else(|| io::Error::other("missing parent"))?;
    util::chmod(parent, 0o700)?;
    let journal = dir.join("journal.jsonl");
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&journal)?;
    util::chmod(&journal, 0o600)
}

/// Writes manifest.json (pretty JSON, 0600, atomically).
pub fn save_manifest(dir: &Path, manifest: &Map<String, Value>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    hive_core::thread_identity::atomic_write_standard(&dir.join("manifest.json"), &bytes)
        .map_err(|e| e.to_string())
}

/// Appends one line to the journal and syncs it to disk.
fn append(journal: &File, data: &[u8]) -> io::Result<()> {
    let mut file = journal;
    file.write_all(data)?;
    file.sync_all()
}

/// A session's journal entries, in order; lines cut short by a crash are skipped.
pub fn read(session: &Path) -> io::Result<Vec<Value>> {
    let file = File::open(session.join("journal.jsonl"))?;
    let mut entries = Vec::new();
    for line in BufReader::new(file).lines() {
        if let Ok(entry) = serde_json::from_str(&line?) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

/// A value as the journal reader shows it: `{"key": value, ...}` with compact scalars.
fn display_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(display_json)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}: {}", Value::from(k.as_str()), display_json(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        other => other.to_string(),
    }
}

/// One entry as a readable line: `HH:MM:SS  🗣 you said: text  {extra}`.
pub fn line(entry: &Value) -> Result<String, String> {
    let fail = || RENDER_FAILED.to_string();
    let obj = entry.as_object().ok_or_else(fail)?;
    let time = obj.get("time").and_then(Value::as_f64).ok_or_else(fail)?;
    let at = Local::at(time.floor());
    let kind = obj.get("kind").and_then(Value::as_str).ok_or_else(fail)?;
    let text = obj.get("text").and_then(Value::as_str).unwrap_or("");
    let label = match kind {
        "you said" => "🗣",
        "agent said" => "💬",
        "agent spoke" => "🔊",
        "action" => "→",
        "error" => "✗",
        "done" => "✅",
        "failed" => "❌",
        "request" => "▶",
        "dictation" => "✍️",
        _ => "·",
    };
    let extra: Map<String, Value> = obj
        .iter()
        .filter(|(k, _)| !["time", "kind", "text"].contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let detail = if extra.is_empty() {
        String::new()
    } else {
        format!("  {}", display_json(&Value::Object(extra)))
    };
    Ok(format!("{}  {label} {kind}: {text}{detail}", at.time()))
}

const STYLE: &str = "body{font:15px system-ui;margin:32px;max-width:1100px}li{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}code{background:#eee;color:#111;padding:1px 4px}a{color:#1466ba}";

fn page(title: &str, body: &str) -> String {
    let title = util::escape(title);
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><meta http-equiv=\"refresh\" content=\"5\"><title>{title}</title><style>{STYLE}</style></head><body><h1>{title}</h1>{body}</body></html>"
    )
}

/// The session's index.html.
pub fn session_page(manifest: &Map<String, Value>, entries: &[Value]) -> Result<String, String> {
    let fail = || RENDER_FAILED.to_string();
    let id = manifest
        .get("session")
        .and_then(Value::as_str)
        .ok_or_else(fail)?;
    let mut threads = String::new();
    if let Some(list) = manifest.get("threads").and_then(Value::as_array) {
        for thread in list {
            let id = thread
                .get("thread")
                .and_then(Value::as_str)
                .ok_or_else(fail)?;
            let rollout = thread
                .get("rollout")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("(not saved yet)");
            threads.push_str(&format!(
                "<li>Codex thread <code>{}</code>: full context in <code>{}</code></li>",
                util::escape(id),
                util::escape(rollout)
            ));
        }
    }
    let code = match manifest.get("code") {
        None | Some(Value::Null) => "None".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => display_json(v),
    };
    let mut body = format!(
        "<p><a href=\"../index.html\">All sessions</a> · <a href=\"journal.jsonl\">journal.jsonl</a> · <a href=\"manifest.json\">manifest.json</a> · <a href=\"../../context/index.html\">Every payload (context viewer)</a></p><p>Code: <code>{}</code></p><ul>{threads}</ul><ol>",
        util::escape(&code)
    );
    for entry in entries {
        body.push_str(&format!("<li>{}</li>", util::escape(&line(entry)?)));
    }
    body.push_str("</ol>");
    Ok(page(&format!("Session {id}"), &body))
}

/// The sessions folder's index.html: every session (newest first) with its backend.
pub fn sessions_page(directory: &Path) -> io::Result<String> {
    let mut sessions = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let Ok(data) = std::fs::read(entry.path().join("manifest.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<Value>(&data) else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let backend = match manifest.get("backend") {
            None => String::new(),
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) => "None".into(),
            Some(v) => display_json(v),
        };
        sessions.push((name, backend));
    }
    sessions.sort_by(|a, b| b.0.cmp(&a.0));
    let items: String = sessions
        .into_iter()
        .map(|(name, backend)| {
            let name = util::escape(&name);
            format!(
                "<li><a href=\"{name}/index.html\">{name}</a> · {}</li>",
                util::escape(&backend)
            )
        })
        .collect();
    Ok(page("Agent sessions", &format!("<ol>{items}</ol>")))
}

/// Writes the sessions folder's index.html.
pub fn write_sessions_page(directory: &Path) -> Result<String, String> {
    let page = sessions_page(directory).map_err(|_| format!("RuntimeError: {RENDER_FAILED}"))?;
    util::atomic_write(&directory.join("index.html"), &page).map_err(|e| e.to_string())?;
    Ok(page)
}

// --- the command line ---------------------------------------------------------------------------

/// The session whose id starts with `session_id` (the latest of them), or the latest session.
pub fn find(session_id: Option<&str>) -> Result<PathBuf, String> {
    let base = sessions_dir();
    let Some(id) = session_id.filter(|s| !s.is_empty()) else {
        let latest = base.join("latest");
        return Ok(std::fs::canonicalize(&latest).unwrap_or(latest));
    };
    let matches: Vec<PathBuf> = util::listing(&base)
        .into_iter()
        .filter(|p| util::file_name(p).starts_with(id) && p.is_dir())
        .collect();
    matches
        .last()
        .cloned()
        .ok_or_else(|| format!("No session {} in {}", pyjson::repr_str(id), base.display()))
}

/// `session_journal.py [list | show [ID] | paths [ID]]`. Returns the exit code.
pub fn main(argv: &[String], out: &mut dyn Write) -> i32 {
    match run(argv, out) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

fn run(argv: &[String], out: &mut dyn Write) -> Result<i32, String> {
    let io = |e: io::Error| e.to_string();
    let unreadable = |_| "OSError: Could not read session journal".to_string();
    let command = argv.first().map(String::as_str).unwrap_or("list");
    if command == "list" {
        let mut sessions: Vec<PathBuf> = util::listing(&sessions_dir())
            .into_iter()
            .filter(|p| {
                p.is_dir()
                    && !p
                        .symlink_metadata()
                        .map(|m| m.file_type().is_symlink())
                        .unwrap_or(false)
            })
            .collect();
        sessions.reverse();
        for session in sessions {
            let entries = read(&session).map_err(unreadable)?;
            let said = entries
                .iter()
                .filter(|e| e.get("kind").and_then(Value::as_str) == Some("you said"))
                .count();
            writeln!(
                out,
                "{}  {said} things you said, {} entries",
                util::file_name(&session),
                entries.len()
            )
            .map_err(io)?;
        }
        return Ok(0);
    }
    let session = find(argv.get(1).map(String::as_str))?;
    if command == "show" {
        for entry in read(&session).map_err(unreadable)? {
            writeln!(
                out,
                "{}",
                line(&entry).map_err(|e| format!("RuntimeError: {e}"))?
            )
            .map_err(io)?;
        }
        return Ok(0);
    }
    if command == "paths" {
        let path = session.join("manifest.json");
        let text = std::fs::read_to_string(&path).map_err(|e| util::os_error(&e, &path))?;
        let manifest: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let context = hive_common::paths::state_dir().join("context/index.html");
        writeln!(
            out,
            "journal:  {}\nmanifest: {}\npage:     {}\ncontext:  {}",
            session.join("journal.jsonl").display(),
            path.display(),
            session.join("index.html").display(),
            context.display()
        )
        .map_err(io)?;
        for t in manifest
            .get("threads")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let thread = pyjson::str_opt(t.get("thread"));
            let rollout = rollout_for(&thread).unwrap_or_else(|| "(no rollout found)".into());
            writeln!(out, "codex thread {thread}: {rollout}").map_err(io)?;
        }
        return Ok(0);
    }
    writeln!(out, "{USAGE}").map_err(io)?;
    Ok(2)
}
