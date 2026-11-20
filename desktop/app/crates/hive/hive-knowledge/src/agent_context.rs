//! Local, durable viewer of payloads actually exchanged with the agent (python/agent_context.py).
//!
//! One JSON and HTML record per event in `<state>/context/`; the lightweight index refreshes
//! independently of an open record. No server, remote assets, JavaScript, or browser launch.

use crate::pyjson;
use crate::session_journal;
use crate::util::{self, Local};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

static LOCK: Mutex<()> = Mutex::new(());

/// How many records the index lists, newest first.
pub const INDEXED: usize = 500;

/// Each folder's newest records as the index lists them (page, label), read from disk once.
static NEWEST: LazyLock<Mutex<HashMap<PathBuf, Vec<(String, String)>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A(?:data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+)\z")
        .expect("valid pattern")
});

pub const STYLE: &str = "body{font:16px system-ui;margin:32px;max-width:1100px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:16px;color:#111}img{max-width:100%;height:auto}li{margin:12px 0}a{color:#1466ba}";

/// A self-contained HTML page (no scripts; images only as data URLs).
pub fn page(title: &str, body: &str, refresh: bool) -> String {
    let title = util::escape(title);
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">{}<title>{title}</title><style>{STYLE}</style></head><body><h1>{title}</h1>{body}</body></html>",
        if refresh { "<meta http-equiv=\"refresh\" content=\"5\">" } else { "" }
    )
}

/// A payload as readable HTML: its JSON with screenshots replaced by "[Screenshot n; ...]", then
/// each screenshot as an image.
pub fn render_payload(payload: &Value) -> String {
    let mut images = Vec::new();
    let shown = display(payload, &mut images);
    let text = util::escape(&pyjson::dumps_with(&shown, false, Some(2)));
    let mut out = format!("<pre>{text}</pre>");
    for (n, url) in images.iter().enumerate() {
        let n = n + 1;
        out.push_str(&format!(
            "<figure><figcaption>Screenshot {n}</figcaption><img alt=\"Screenshot {n}\" src=\"{}\"></figure>",
            util::escape(url)
        ));
    }
    out
}

fn display(value: &Value, images: &mut Vec<String>) -> Value {
    match value {
        Value::String(s) if IMAGE.is_match(s) => {
            images.push(s.clone());
            json!(format!(
                "[Screenshot {}; exact bytes in JSON]",
                images.len()
            ))
        }
        Value::Array(items) => Value::Array(items.iter().map(|v| display(v, images)).collect()),
        Value::Object(map) => {
            // MCP/Claude image blocks, as well as Codex data URLs.
            if map.get("type").and_then(Value::as_str) == Some("image") {
                let source = map
                    .get("source")
                    .filter(|s| pyjson::truthy(Some(s)))
                    .unwrap_or(value);
                let mime = source
                    .get("media_type")
                    .filter(|m| pyjson::truthy(Some(m)))
                    .or_else(|| source.get("mimeType"))
                    .filter(|m| pyjson::truthy(Some(m)));
                if let (Some(mime), Some(Value::String(data))) = (mime, source.get("data")) {
                    let url = format!("data:{};base64,{data}", pyjson::str_of(mime));
                    if IMAGE.is_match(&url) {
                        let preview = display(&Value::String(url), images);
                        return json!({"type": "image", "preview": preview});
                    }
                }
            }
            Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), display(v, images)))
                    .collect::<Map<_, _>>(),
            )
        }
        other => other.clone(),
    }
}

/// The context viewer's folder, `<state>/context` unless given.
/// A payload carrying a whole Codex thread (`thread/resume` and `thread/start` outputs) with its
/// past turns swapped for where they are kept in full: Codex's own session file (`thread.path`),
/// and this log's earlier records, which saved each turn as it happened. Copying every turn on
/// every resume wrote 650 MB per record and filled the owner's disk (20 GB in three days).
pub fn without_thread_history(payload: &Value) -> Value {
    let Some(turns) = payload.pointer("/thread/turns").and_then(Value::as_array) else {
        return payload.clone();
    };
    if turns.is_empty() {
        return payload.clone();
    }
    let mut kept = payload.clone();
    let path = payload.pointer("/thread/path").and_then(Value::as_str).unwrap_or("");
    let whole = if path.is_empty() {
        "Codex's own session file for this thread".to_string()
    } else {
        format!("Codex's session file {path}")
    };
    kept["thread"]["turns"] = json!(format!(
        "{} earlier turns, not copied here: every word of them is in {whole}, and each turn is in this \
         log's earlier records from when it happened.",
        turns.len()
    ));
    kept
}

pub struct ContextLog {
    pub directory: PathBuf,
    pub index: PathBuf,
}

impl Default for ContextLog {
    fn default() -> Self {
        ContextLog::new()
    }
}

impl ContextLog {
    pub fn new() -> ContextLog {
        ContextLog::with_dir(hive_common::paths::state_dir().join("context"))
    }

    pub fn with_dir(directory: impl Into<PathBuf>) -> ContextLog {
        let directory = directory.into();
        let index = directory.join("index.html");
        ContextLog { directory, index }
    }

    /// The newest records already in the folder (not `except`, the one being written), newest
    /// first: their small labels, never their payloads.
    fn newest_on_disk(&self, except: &str) -> Vec<(String, String)> {
        let mut pages: Vec<String> = util::listing(&self.directory)
            .iter()
            .map(|p| util::file_name(p))
            .filter(|n| {
                n.starts_with(|c: char| c.is_ascii_digit())
                    && n.ends_with(".html")
                    && !n.starts_with(except)
            })
            .collect();
        pages.sort_unstable_by(|a, b| b.cmp(a));
        pages.truncate(INDEXED);
        pages
            .into_iter()
            .map(|page| {
                let stem = page.trim_end_matches(".html").to_owned();
                let title = std::fs::read_to_string(self.directory.join(format!("{stem}.title")))
                    .unwrap_or(stem);
                (page, title)
            })
            .collect()
    }

    /// Saves one payload (`<time ns>-<uuid>.json`, `.html` and `.title`), tagged with this
    /// process's session, and rewrites the index. Returns the index's path.
    pub fn record(
        &self,
        kind: &str,
        payload: &Value,
        task: Option<&str>,
        thread: Option<&str>,
    ) -> Result<String, String> {
        let journal;
        {
            let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
            util::make_private_dir(&self.directory)
                .map_err(|e| util::os_error(&e, &self.directory))?;
            let name = format!("{:020}-{}", util::now_ns(), util::uuid_hex());
            journal = session_journal::current();
            let payload = &without_thread_history(payload);
            let record = json!({"time": util::now(), "kind": kind, "task": task,
                                "session": journal.as_ref().map(|j| j.id.clone()),
                                "threadId": thread, "payload": payload});
            let write = |file: String, text: &str| {
                let path = self.directory.join(file);
                util::atomic_write(&path, text).map_err(|e| e.to_string())
            };
            write(format!("{name}.json"), &pyjson::dumps_utf8(&record))?;
            let body = format!(
                "<p><a href=\"index.html\">All context</a> · <a href=\"{name}.json\">Exact JSON payload</a></p>{}",
                render_payload(&record)
            );
            write(format!("{name}.html"), &page(kind, &body, false))?;
            let now = Local::now();
            let mut title = format!("{} {} · {kind}", now.date(), now.time());
            if let Some(thread) = thread.filter(|t| !t.is_empty()) {
                title.push_str(&format!(" · {thread}"));
            }
            write(format!("{name}.title"), &title)?;
            // The newest records, kept in memory: reading every label for each record took 0.6 s
            // once the folder held 28k of them, and Codex's messages queued behind it.
            let mut newest = NEWEST.lock().unwrap_or_else(|e| e.into_inner());
            let shown = newest
                .entry(self.directory.clone())
                .or_insert_with(|| self.newest_on_disk(&name));
            shown.insert(0, (format!("{name}.html"), title));
            shown.truncate(INDEXED);
            let mut links = String::new();
            for (page, title) in shown.iter() {
                links.push_str(&format!(
                    "<li><a href=\"{page}\">{}</a></li>",
                    util::escape(title)
                ));
            }
            let body = format!(
                "<p><a href=\"../sessions/index.html\">Sessions: everything you said and the agent did, one run of the app at a time</a></p><p>Exact app-visible instructions, requests, screenshots, tool inputs/outputs and server events, newest first (the newest {INDEXED}; every record is in this folder). This is an event history, not hidden reasoning or a reconstruction of the model’s current context after compaction. The index refreshes every 5 seconds.</p><ol>{links}</ol>"
            );
            util::atomic_write(&self.index, &page("Agent context", &body, true))
                .map_err(|e| e.to_string())?;
        }
        if let Some(journal) = journal {
            journal.touch(); // the Agent Context panel shows it
        }
        Ok(self.index.to_string_lossy().into_owned())
    }
}
