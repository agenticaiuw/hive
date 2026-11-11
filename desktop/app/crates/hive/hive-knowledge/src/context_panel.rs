//! What the Agent Context panel (workspace-engine/Sources/UnifiedAgent/context_panel.swift) shows:
//! this session's conversation, grouped by request, with what was sent to the model under each,
//! and what's known about the model's context right now (python/context_panel.py).
//!
//! Built from two records the app keeps itself: the session's journal.jsonl
//! ([`crate::session_journal`]) and `<state>/context/*.json`, each payload exchanged with Codex
//! ([`crate::agent_context`]). The voice agent rewrites `sessions/<id>/panel.json` a moment after
//! anything is journaled or recorded; the panel reloads it. Screenshots aren't copied into
//! panel.json: it counts them and points to the exact record.

use crate::pyjson::{self, truthy};
use crate::session_journal;
use crate::util::{self, Local};
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Characters of a detail kept in panel.json; the record has every one.
pub const DETAIL: usize = 20_000;
pub const SUMMARY: usize = 240;
pub const MODEL_WINDOW: i64 = 272_000;
/// The latest requests; older ones are in the journal.
pub const GROUPS: usize = 60;
/// agent.py's COMPACT_AT: the context size past which Codex compacts.
pub const COMPACT_AT: i64 = 150_000;

pub const CONVERSATION: &[&str] = &[
    "you said",
    "agent said",
    "say",
    "done",
    "failed",
    "error",
    "action",
    "dictation",
    "ingest started",
    "ingest part",
    "ingest done",
    "voice left out",
    "lip reading",
];

pub const NOTICE: &str = "What this app sent to and got from the model, as it happened. It is not \
the model's exact current context, which Codex holds and can't be observed from here: Codex adds its own \
instructions and summarizes (compacts) the conversation as it grows, after which the model has the summary \
rather than these words.";

/// `" ".join(text.split())`, cut to `n` characters with "…".
pub fn short(text: &str, n: usize) -> String {
    let text = pyjson::squash(text);
    if pyjson::len(&text) <= n {
        return text;
    }
    format!("{}…", pyjson::head(&text, n.saturating_sub(1)))
}

/// The text, cut to [`DETAIL`] characters with a note of how many more the record has.
pub fn detail(text: &str) -> String {
    let count = pyjson::len(text);
    if count <= DETAIL {
        return text.to_string();
    }
    format!(
        "{}\n\n… {} more characters in the exact record.",
        pyjson::head(text, DETAIL),
        pyjson::commas_int((count - DETAIL) as i64)
    )
}

/// How many images a payload holds (data URLs and image items).
pub fn count_images(value: &Value) -> usize {
    match value {
        Value::String(s) => usize::from(s.starts_with("data:image/")),
        Value::Array(items) => items.iter().map(count_images).sum(),
        Value::Object(map) => {
            let kind = map.get("type").and_then(Value::as_str);
            if kind == Some("image") || kind == Some("inputImage") {
                1
            } else {
                map.values().map(count_images).sum()
            }
        }
        _ => 0,
    }
}

/// The text in a payload's content items, leaving images out.
pub fn texts(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().flat_map(texts).collect(),
        Value::Object(map) => {
            let kind = map.get("type").and_then(Value::as_str);
            if let (Some("text" | "inputText" | "outputText"), Some(Value::String(text))) =
                (kind, map.get("text"))
            {
                return vec![text.clone()];
            }
            map.iter()
                .filter(|(k, _)| !["url", "data", "image_url"].contains(&k.as_str()))
                .flat_map(|(_, v)| texts(v))
                .collect()
        }
        _ => vec![],
    }
}

/// `value or {}`.
fn or_empty(value: Option<&Value>) -> Value {
    match value {
        Some(v) if truthy(Some(v)) => v.clone(),
        _ => Value::Object(Map::new()),
    }
}

fn with(base: &Map<String, Value>, fields: Value) -> Map<String, Value> {
    let mut out = base.clone();
    if let Value::Object(fields) = fields {
        for (k, v) in fields {
            out.insert(k, v);
        }
    }
    out
}

fn screenshots(images: usize) -> String {
    match images {
        0 => String::new(),
        1 => " · 1 screenshot".into(),
        n => format!(" · {n} screenshots"),
    }
}

fn add(a: Option<&Value>, b: Option<&Value>) -> Value {
    let zero = Value::from(0);
    let (a, b) = (a.unwrap_or(&zero), b.unwrap_or(&zero));
    match (a.as_i64(), b.as_i64()) {
        (Some(x), Some(y)) => Value::from(x.saturating_add(y)),
        _ => json!(a.as_f64().unwrap_or(0.0) + b.as_f64().unwrap_or(0.0)),
    }
}

/// One recorded payload as a panel item, or None for bookkeeping the panel leaves out. Also
/// `{"tokens": n, ...}` / `{"compacted": true, ...}` for what it says about the model's context.
pub fn summarize_record(record: &Value) -> Option<Map<String, Value>> {
    let record = record.as_object()?;
    let kind_value = record.get("kind").cloned().unwrap_or_else(|| json!(""));
    let kind = kind_value.as_str().unwrap_or("");
    let payload = or_empty(record.get("payload"));
    let mut item = Map::new();
    item.insert(
        "time".into(),
        record.get("time").cloned().unwrap_or_else(|| json!(0)),
    );
    item.insert("lane".into(), json!("input"));
    item.insert("kind".into(), kind_value.clone());
    item.insert(
        "task".into(),
        record.get("task").cloned().unwrap_or(Value::Null),
    );
    match kind {
        "turn/start input" => {
            let input = payload.get("input").cloned().unwrap_or(Value::Null);
            let body = texts(&input).join("\n");
            let images = count_images(&input);
            let label = format!("Sent to the model with the request{}", screenshots(images));
            Some(with(
                &item,
                json!({"label": label, "summary": short(&body, SUMMARY), "detail": detail(&body), "images": images}),
            ))
        }
        "tool input" => {
            let args = pyjson::dumps_utf8(&or_empty(payload.get("arguments")));
            let namespace = payload
                .get("namespace")
                .filter(|v| truthy(Some(v)))
                .map(pyjson::str_of)
                .unwrap_or_default();
            let name = format!("{namespace}.{}", pyjson::str_opt(payload.get("tool")));
            let name = name.trim_matches('.');
            Some(with(
                &item,
                json!({"label": format!("Tool call · {name}"), "summary": short(&args, SUMMARY), "detail": detail(&args)}),
            ))
        }
        "tool output" => {
            let result = or_empty(payload.get("result"));
            let items = result.get("contentItems").cloned().unwrap_or(Value::Null);
            let body = texts(&items).join("\n");
            let images = count_images(&items);
            let failed = if result.get("success") == Some(&Value::Bool(false)) {
                " (failed)"
            } else {
                ""
            };
            let label = format!("Tool result{failed}{}", screenshots(images));
            let summary = Some(short(&body, SUMMARY))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "(no text)".into());
            Some(with(
                &item,
                json!({"label": label, "summary": summary, "detail": detail(&body), "images": images}),
            ))
        }
        "thread/tokenUsage/updated" => {
            let usage = or_empty(payload.get("tokenUsage"));
            let last = or_empty(usage.get("last"));
            let mut out = Map::new();
            out.insert(
                "tokens".into(),
                add(last.get("inputTokens"), last.get("outputTokens")),
            );
            out.insert(
                "window".into(),
                usage
                    .get("modelContextWindow")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            out.insert("time".into(), item["time"].clone());
            Some(out)
        }
        "item/started" | "item/completed" => {
            let it = or_empty(payload.get("item"));
            let it_type = it.get("type").and_then(Value::as_str);
            if it_type == Some("contextCompaction") {
                if kind == "item/started" {
                    return Some(with(
                        &item,
                        json!({"lane": "conversation", "label": "Codex compacted the conversation",
                               "summary": "From here the model has a summary of what came before, not the words.",
                               "compacted": true}),
                    ));
                }
                return None;
            }
            if kind == "item/completed" && it_type == Some("agentMessage") && truthy(it.get("text"))
            {
                let text = pyjson::str_of(&it["text"]);
                return Some(with(
                    &item,
                    json!({"label": "The model's reply", "summary": short(&text, SUMMARY), "detail": detail(&text)}),
                ));
            }
            None
        }
        "session connected"
        | "thread/resume output"
        | "thread/start output"
        | "thread/resume input"
        | "thread/start input" => {
            let body = pyjson::dumps_utf8(&payload);
            let body = pyjson::head(&body, 2000);
            let thread = record
                .get("threadId")
                .filter(|v| truthy(Some(v)))
                .map(pyjson::str_of)
                .unwrap_or_default();
            Some(with(
                &item,
                json!({"label": format!("Codex thread · {kind}"), "summary": short(&thread, SUMMARY), "detail": detail(body)}),
            ))
        }
        "error" => Some(with(
            &item,
            json!({"lane": "conversation", "label": "Codex error", "summary": short(&pyjson::dumps(&payload), SUMMARY)}),
        )),
        _ => None,
    }
}

fn icon(kind: &str) -> &'static str {
    match kind {
        "you said" => "🗣",
        "say" | "agent said" => "💬",
        "done" => "✅",
        "failed" => "❌",
        "error" => "⚠️",
        "action" => "→",
        "dictation" => "✍️",
        "ingest started" | "ingest part" | "ingest done" => "📥",
        "voice left out" => "🔇",
        "lip reading" => "📷",
        _ => "·",
    }
}

fn label(kind: &str) -> String {
    match kind {
        "you said" => "You said",
        "say" | "agent said" => "Agent said",
        "done" => "Done",
        "failed" => "Failed",
        "error" => "Error",
        "action" => "Did",
        "dictation" => "Dictated",
        "ingest started" => "Adding text to context",
        "ingest part" => "Part",
        "ingest done" => "Added text",
        "voice left out" => "Left out its own voice",
        "lip reading" => "Lip reading",
        other => other,
    }
    .to_string()
}

/// One journal entry as a panel item.
pub fn journal_item(entry: &Map<String, Value>) -> Value {
    let kind_value = entry.get("kind").cloned().unwrap_or_else(|| json!(""));
    let kind = kind_value.as_str().unwrap_or("");
    let mut text = entry.get("text").map(pyjson::str_of).unwrap_or_default();
    let extra: Map<String, Value> = entry
        .iter()
        .filter(|(k, _)| !["time", "kind", "text"].contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let mut name = if kind_value.is_string() {
        label(kind)
    } else {
        pyjson::str_of(&kind_value)
    };
    match entry.get("outcome") {
        None | Some(Value::Null) => {}
        Some(outcome) if outcome.as_str() == Some("request") => {}
        Some(outcome) if kind == "you said" => {
            name.push_str(&format!(" ({})", pyjson::str_of(outcome)))
        }
        Some(_) => {}
    }
    if kind == "ingest started" {
        let zero = json!(0);
        text = format!(
            "“{text}”: {} characters, about {} tokens (estimated), {} parts, {}",
            pyjson::commas(entry.get("chars").unwrap_or(&zero)),
            pyjson::commas(entry.get("tokens_estimated").unwrap_or(&zero)),
            pyjson::str_opt(entry.get("parts")),
            pyjson::str_opt(entry.get("mode"))
        );
    }
    let detail = if extra.is_empty() {
        String::new()
    } else {
        detail(&pyjson::dumps_with(&Value::Object(extra), false, Some(1)))
    };
    json!({"time": entry.get("time").cloned().unwrap_or_else(|| json!(0)), "lane": "conversation", "kind": kind_value,
           "icon": icon(kind), "label": name, "summary": short(&text, 600), "detail": detail,
           "status": entry.get("status").cloned().unwrap_or(Value::Null)})
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.0)
}

/// Python's exception text for a failed file read: `FileNotFoundError: [Errno 2] ...`.
fn read_error(error: &std::io::Error, path: &Path) -> String {
    let name = match error.kind() {
        std::io::ErrorKind::NotFound => "FileNotFoundError",
        std::io::ErrorKind::PermissionDenied => "PermissionError",
        _ => "OSError",
    };
    format!("{name}: {}", util::os_error(error, path))
}

/// Keeps record summaries between builds: a record (with its screenshots) is read once.
pub struct Builder {
    pub session_dir: PathBuf,
    pub context_dir: PathBuf,
    seen: HashMap<String, Option<Map<String, Value>>>,
}

impl Builder {
    /// `context_dir` defaults to `<state>/context`.
    pub fn new(session_dir: impl Into<PathBuf>, context_dir: Option<PathBuf>) -> Builder {
        Builder {
            session_dir: session_dir.into(),
            context_dir: context_dir
                .unwrap_or_else(|| hive_common::paths::state_dir().join("context")),
            seen: HashMap::new(),
        }
    }

    /// This session's records from shortly before `since` on, as panel items, by file name.
    pub fn records(&mut self, session_id: &Value, since: f64) -> Vec<(String, Map<String, Value>)> {
        let mut out = Vec::new();
        if !self.context_dir.exists() {
            return out;
        }
        let floor = format!("{:020}", (since * 1e9) as i64 - 5_000_000_000); // names start with the time in ns
        for path in util::listing(&self.context_dir) {
            let name = util::file_name(&path);
            if !name.starts_with(|c: char| c.is_ascii_digit())
                || !name.ends_with(".json")
                || name < floor
            {
                continue;
            }
            if !self.seen.contains_key(&name) {
                let Some(record) = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                else {
                    continue; // being written
                };
                let mut summary = if record.get("session") == Some(session_id) {
                    summarize_record(&record)
                } else {
                    None
                };
                if let Some(summary) = summary.as_mut() {
                    summary.insert(
                        "record".into(),
                        json!(path.with_extension("html").to_string_lossy()),
                    );
                }
                self.seen.insert(name.clone(), summary);
            }
            if let Some(Some(summary)) = self.seen.get(&name) {
                out.push((name, summary.clone()));
            }
        }
        out
    }

    /// The panel's data. `Err` is the Python exception's text.
    pub fn build(&mut self) -> Result<Value, String> {
        let path = self.session_dir.join("manifest.json");
        let text = std::fs::read_to_string(&path).map_err(|e| read_error(&e, &path))?;
        let manifest: Value =
            serde_json::from_str(&text).map_err(|e| format!("JSONDecodeError: {e}"))?;
        let entries = session_journal::read(&self.session_dir)
            .map_err(|_| "OSError: Could not read session journal".to_string())?;
        let session = manifest
            .get("session")
            .cloned()
            .ok_or_else(|| "KeyError: 'session'".to_string())?;
        let started = manifest.get("started").cloned().unwrap_or_else(|| json!(0));

        // Every group, in the order made; `groups` below is the order shown.
        let mut arena: Vec<Map<String, Value>> = vec![group(
            json!({"title": "Session started", "time": started,
                                                                  "kind": "session", "items": []}),
        )];
        let mut by_task: HashMap<String, usize> = HashMap::new();
        let key = |v: &Value| pyjson::dumps(v);
        for entry in entries.iter().filter_map(Value::as_object) {
            let kind = entry
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let text = entry.get("text").cloned().unwrap_or_else(|| json!(""));
            let time = entry.get("time").cloned().unwrap_or(Value::Null);
            if entry.get("kind").and_then(Value::as_str) == Some("request") {
                arena.push(group(json!({"title": text, "time": time, "kind": "request",
                                        "device": entry.get("device").cloned().unwrap_or(Value::Null),
                                        "status": "running", "items": []})));
                by_task.insert(key(&text), arena.len() - 1);
                continue;
            }
            if kind == "ingest started" {
                arena.push(group(
                    json!({"title": format!("Added: {}", pyjson::str_of(&text)), "time": time,
                                        "kind": "ingest", "status": "running", "items": []}),
                ));
            }
            if !entry
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(|k| CONVERSATION.contains(&k))
            {
                continue;
            }
            let mut target = entry
                .get("request")
                .filter(|r| truthy(Some(r)))
                .and_then(|r| by_task.get(&key(r)).copied());
            if target.is_none() {
                if kind == "you said"
                    && entry.get("outcome").and_then(Value::as_str) == Some("request")
                {
                    arena.push(group(
                        json!({"title": text, "time": time, "kind": "pending", "items": []}),
                    ));
                }
                target = Some(arena.len() - 1); // a new pending group's "request" entry comes next and takes its place
            }
            let mut target = target.unwrap_or(0);
            if kind_of(&arena[target]) == "pending" && kind != "you said" {
                target = arena.len() - 1;
            }
            items(&mut arena[target]).push(journal_item(entry));
            if (kind == "done" || kind == "failed") && kind_of(&arena[target]) == "request" {
                arena[target].insert("status".into(), json!(kind));
            }
            if kind == "ingest done" {
                arena[target].insert(
                    "status".into(),
                    entry.get("status").cloned().unwrap_or(Value::Null),
                );
            }
        }
        // A "you said … request" placeholder followed by its request: fold the words into the request.
        let mut folded: Vec<usize> = Vec::new();
        for index in 0..arena.len() {
            if let Some(&last) = folded.last() {
                if kind_of(&arena[last]) == "pending" && kind_of(&arena[index]) == "request" {
                    folded.pop();
                    let mut words = std::mem::take(items(&mut arena[last]));
                    words.append(items(&mut arena[index]));
                    *items(&mut arena[index]) = words;
                }
            }
            folded.push(index);
        }
        let mut groups: Vec<usize> = folded
            .into_iter()
            .filter(|&g| kind_of(&arena[g]) != "pending" || !items(&mut arena[g]).is_empty())
            .collect();

        let mut model = Map::new();
        model.insert("tokens".into(), Value::Null);
        model.insert("window".into(), json!(MODEL_WINDOW));
        model.insert("measured_at".into(), Value::Null);
        model.insert("compacted_at".into(), Value::Null);
        model.insert("compact_at".into(), json!(COMPACT_AT));
        let requests: Vec<usize> = groups
            .iter()
            .copied()
            .filter(|&g| matches!(kind_of(&arena[g]), "request" | "ingest"))
            .collect();
        for (_, mut item) in self.records(&session, number(Some(&started))) {
            if item.contains_key("tokens") && !item.contains_key("lane") {
                let window = item
                    .get("window")
                    .filter(|w| truthy(Some(w)))
                    .cloned()
                    .unwrap_or_else(|| model["window"].clone());
                model.insert("tokens".into(), item["tokens"].clone());
                model.insert("measured_at".into(), item["time"].clone());
                model.insert("window".into(), window);
                continue;
            }
            if truthy(item.get("compacted")) {
                model.insert("compacted_at".into(), item["time"].clone());
            }
            let by_task_target = item
                .get("task")
                .filter(|t| truthy(Some(t)))
                .and_then(|t| by_task.get(&key(t)).copied());
            let target = by_task_target.unwrap_or_else(|| {
                // By time: the last request that had started by then.
                let at = number(item.get("time"));
                requests
                    .iter()
                    .rev()
                    .copied()
                    .find(|&g| number(arena[g].get("time")) <= at + 1.0)
                    .unwrap_or(groups[0])
            });
            item.shift_remove("task");
            items(&mut arena[target]).push(Value::Object(item));
        }
        for &g in &groups {
            let list = items(&mut arena[g]);
            list.sort_by(|a, b| {
                number(a.get("time"))
                    .partial_cmp(&number(b.get("time")))
                    .unwrap_or(Ordering::Equal)
            });
            let inputs = list
                .iter()
                .filter(|i| i.get("lane").and_then(Value::as_str) == Some("input"))
                .count();
            arena[g].insert("inputs".into(), json!(inputs));
        }
        if groups.len() > GROUPS + 1 {
            groups.drain(1..groups.len() - GROUPS);
        }
        let threads = manifest
            .get("threads")
            .filter(|t| truthy(Some(t)))
            .cloned()
            .unwrap_or_else(|| json!([]));
        let note = Builder::model_note(
            &model,
            threads.as_array().map(Vec::as_slice).unwrap_or_default(),
        );
        let mut model_context = model;
        model_context.insert("threads".into(), threads);
        model_context.insert("note".into(), json!(note));
        let field = |k: &str| manifest.get(k).cloned().unwrap_or(Value::Null);
        Ok(json!({
            "version": 1, "session": session, "started": field("started"), "updated": util::now(),
            "ended": field("ended"), "code": field("code"), "backend": field("backend"),
            "notice": NOTICE, "model_context": model_context,
            "groups": groups.iter().map(|&g| Value::Object(arena[g].clone())).collect::<Vec<_>>(),
            "journal": self.session_dir.join("journal.jsonl").to_string_lossy(),
            "context_index": self.context_dir.join("index.html").to_string_lossy(),
        }))
    }

    /// One line on the model's context: its last size, the last compaction, Codex's own record.
    pub fn model_note(model: &Map<String, Value>, threads: &[Value]) -> String {
        let mut parts = Vec::new();
        let get = |k: &str| model.get(k).cloned().unwrap_or(Value::Null);
        if truthy(model.get("tokens")) {
            parts.push(format!(
                "Codex last reported {} tokens in the model's context (of {}); it compacts past about {}.",
                pyjson::commas(&get("tokens")),
                pyjson::commas(&get("window")),
                pyjson::commas(&get("compact_at"))
            ));
        } else {
            parts.push("Codex hasn't reported the context size in this session yet.".into());
        }
        if truthy(model.get("compacted_at")) {
            let at = Local::at(number(model.get("compacted_at")).floor());
            parts.push(format!(
                "It compacted at {}: what came before is a summary to the model now.",
                at.time()
            ));
        }
        if let Some(last) = threads.last() {
            let rollout = last
                .get("rollout")
                .filter(|r| truthy(Some(r)))
                .map(pyjson::str_of);
            parts.push(format!(
                "Codex's own full record of the thread: {}",
                rollout.unwrap_or_else(|| "(not found)".into())
            ));
        }
        parts.join(" ")
    }

    /// Writes panel.json (0600). `Err` is the Python exception's text.
    pub fn write(&mut self) -> Result<PathBuf, String> {
        let path = self.session_dir.join("panel.json");
        let panel = self.build()?;
        util::atomic_write(&path, &pyjson::dumps_utf8(&panel))
            .map_err(|e| format!("OSError: {e}"))?;
        util::chmod(&path, 0o600).map_err(|e| read_error(&e, &path))?;
        Ok(path)
    }
}

fn group(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn kind_of(group: &Map<String, Value>) -> &str {
    group.get("kind").and_then(Value::as_str).unwrap_or("")
}

fn items(group: &mut Map<String, Value>) -> &mut Vec<Value> {
    let slot = group.entry("items").or_insert_with(|| json!([]));
    if !slot.is_array() {
        *slot = json!([]);
    }
    slot.as_array_mut().expect("made an array above")
}

/// `context_panel.py [SESSION_DIR]`: prints the panel's data. Returns the exit code.
pub fn main(argv: &[String], out: &mut dyn Write) -> i32 {
    let session = match argv.first() {
        Some(dir) => PathBuf::from(dir),
        None => match session_journal::find(None) {
            Ok(dir) => dir,
            Err(message) => {
                eprintln!("{message}");
                return 1;
            }
        },
    };
    match Builder::new(session, None).build() {
        Ok(panel) => {
            let _ = writeln!(out, "{}", pyjson::dumps_with(&panel, false, Some(1)));
            0
        }
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}
