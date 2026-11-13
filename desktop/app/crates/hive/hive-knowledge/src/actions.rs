//! Hive's action memory: every tool step its agent takes, recorded by Hive itself (not by the
//! model), kept in the cloud next to the owner's facts (D1 "hive-knowledge", tables `actions` and
//! `action_runs`: cloud/knowledge/migrations/0002_actions.sql), and handed back before the next
//! request on the same site, app or codebase.
//!
//! While a task runs, each step goes to a [`Recorder`], which passes it to a thread of its own and
//! returns at once: nothing here sits on the action path, and nothing touches the network until the
//! task is over. That thread notes where the Mac was when the step began (the app in front, its
//! window, the page showing: a snapshot taken right after the step before), filters the step, and
//! appends it to the task's file in `<state>/knowledge/actions-open/`. When the task ends, its run
//! goes to `actions-pending.jsonl` and up to D1 in the background. A step already stored (same
//! place, tool and normalized element or reason) is counted, not stored again; so is a run with
//! the same request, steps and outcome. Each upload reads the latest runs back into
//! `actions-cache.json`, which [`context`] answers from before each request, with no network.
//!
//! Never recorded: what was typed (only a web address typed into an address bar is kept), the
//! sign-in tool's details, and any field [`unsafe_text`] flags (passwords, codes, keys, tokens,
//! card and bank numbers): that field is dropped whole, not redacted.
//!
//! `HIVE_ACTION_MEMORY=0` turns the recording and the attached steps off.

use crate::knowledge::{self, casefold, norm, Error, KnowledgeBase, NOTICE};
use crate::pyjson::{self, str_of, truthy};
use crate::util;
use crate::Report;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, LazyLock, Mutex};
use std::time::Duration;

/// The most steps a run keeps (after repeats in a row are merged).
pub const MAX_RUN_STEPS: usize = 60;
/// The most runs the Mac's copy keeps.
pub const CACHE_RUNS: usize = 300;
/// The most characters attached to a request.
pub const CONTEXT_LIMIT: usize = 1500;
/// The most facts attached to a request.
pub const CONTEXT_FACTS: usize = 6;
/// The most steps of a past run attached to a request.
pub const CONTEXT_STEPS: usize = 12;

/// Whether the action memory is on (`HIVE_ACTION_MEMORY` isn't "0").
pub fn enabled() -> bool {
    std::env::var("HIVE_ACTION_MEMORY").map_or(true, |v| v.trim() != "0")
}

/// `<state>/knowledge`, where the Mac's copies live.
pub fn folder() -> PathBuf {
    hive_common::state_dir().join("knowledge")
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid pattern")
}

// --- what a step is -------------------------------------------------------------------------

/// Where the Mac was: the app in front, its front window's title, and the page showing when the
/// app is a browser.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Place {
    pub app: Option<String>,
    pub window: Option<String>,
    pub url: Option<String>,
}

/// Gives the Mac's [`Place`] now (hive-mac's `desktop::front`); tests give a fixed one.
pub type PlaceFn = Arc<dyn Fn() -> Place + Send + Sync>;

/// The task a step belongs to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskInfo {
    /// Unique to this run of the task.
    pub run: String,
    /// What the user asked for.
    pub request: String,
    /// "mac" or "phone".
    pub device: String,
    /// The ingress receipt the request came with.
    pub receipt: Option<String>,
}

/// One tool step as the driver saw it. `namespace` "mac" or "phone" with the tool's arguments;
/// "shell" with tool "command" (`{"command", "cwd", "paths"}`) or "file_change"
/// (`{"paths", "kinds"}`).
#[derive(Clone, Debug, PartialEq)]
pub struct StepInput {
    pub namespace: String,
    pub tool: String,
    pub arguments: Value,
    pub ok: bool,
}

// --- what is never recorded -----------------------------------------------------------------

/// A code-like run of 5 to 8 digits (one-time codes), standing alone.
static CODE_DIGITS: LazyLock<Regex> = LazyLock::new(|| re(r"\b\d{5,8}\b"));
/// "code" followed by something with a digit in it: "the code 4F7K2Q".
static CODE_VALUE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\bcodes?\b[\s:=#-]*[A-Za-z0-9-]*\d[A-Za-z0-9-]*"));
static EXTRA_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)\b(?:bearer|authorization|cookies?|session[ _-]?(?:ids?|keys?)|passkeys?)\b")
});

/// Whether a piece of text must not be recorded: what [`knowledge::secret`] refuses (read as both
/// a name and a value), anything the personal memory search treats as sensitive, and, stricter,
/// one-time codes and session or authorization words.
pub fn unsafe_text(text: &str) -> bool {
    knowledge::secret(text, text).is_some()
        || crate::memory_search::SENSITIVE.is_match(text)
        || CODE_DIGITS.is_match(text)
        || CODE_VALUE.is_match(text)
        || EXTRA_SECRET.is_match(text)
}

/// `text` squashed and cut to `limit` characters, or None when it is empty or unsafe.
pub fn clean(text: &str, limit: usize) -> Option<String> {
    let text = pyjson::squash(text);
    if text.is_empty() || unsafe_text(&text) {
        return None;
    }
    Some(short(&text, limit))
}

fn short(text: &str, limit: usize) -> String {
    if pyjson::len(text) <= limit {
        text.to_string()
    } else {
        format!("{}…", pyjson::head(text, limit.saturating_sub(1)))
    }
}

// --- pages and sites ------------------------------------------------------------------------

static ALNUM_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"[A-Za-z0-9]+"));

/// A path segment that may be a token or a private link's key: a long run of letters and digits,
/// or anything [`knowledge::secret`] refuses.
fn token_like(segment: &str) -> bool {
    if knowledge::secret(segment, segment).is_some()
        || crate::memory_search::SENSITIVE.is_match(segment)
    {
        return true;
    }
    ALNUM_RUN.find_iter(segment).any(|run| {
        let run = run.as_str();
        let digits = run.chars().filter(char::is_ascii_digit).count();
        (run.len() >= 16 && digits >= 2 && run.len() - digits >= 2) || digits >= 12
    })
}

/// A web address as stored: (page, host, site). http(s) only; no user, port, ?query or
/// #fragment; a segment that may be a token becomes "…".
pub fn web_page(url: &str) -> Option<(String, String, String)> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = rest[..end].rsplit('@').next().unwrap_or("");
    let host = authority
        .split(':')
        .next()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    let tail = &rest[end..];
    let path = &tail[..tail.find(['?', '#']).unwrap_or(tail.len())];
    let segments: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .take(8)
        .map(|s| {
            if token_like(s) {
                "…".to_string()
            } else {
                s.to_string()
            }
        })
        .collect();
    let page = if segments.is_empty() {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}/{}", segments.join("/"))
    };
    let site = registrable(&host);
    Some((short(&page, 200), host, site))
}

const SECOND_LEVEL: &[&str] = &[
    "co", "com", "ac", "edu", "gov", "org", "net", "ne", "or", "go",
];

/// The registrable domain of a host, without the public suffix list: the last two labels, or
/// three under a country's second level ("example.co.uk").
pub fn registrable(host: &str) -> String {
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    let n = labels.len();
    if n <= 2 || host.parse::<std::net::Ipv4Addr>().is_ok() {
        return labels.join(".");
    }
    let country = labels[n - 1].len() == 2 && SECOND_LEVEL.contains(&labels[n - 2]);
    labels[n - if country { 3 } else { 2 }..].join(".")
}

static ADDRESS: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\A(?:https?://)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:/\S*)?\z"));

/// What type_text typed, when it is a web address (typed into an address bar): the page without
/// its query. Anything else typed is never recorded.
fn typed_address(text: &str) -> Option<String> {
    let typed = text.trim();
    if typed.contains('@') || !ADDRESS.is_match(typed) {
        return None;
    }
    let full = if typed.contains("://") {
        typed.to_string()
    } else {
        format!("https://{typed}")
    };
    let (page, _, _) = web_page(&full)?;
    Some(if typed.contains("://") {
        page
    } else {
        page.trim_start_matches("https://").to_string()
    })
}

// --- files and codebases --------------------------------------------------------------------

/// The path with the home folder written "~".
fn home_short(path: &str) -> String {
    let home = hive_common::paths::home();
    let home = home.to_string_lossy();
    if home.len() > 1 {
        if let Some(rest) = path.strip_prefix(home.as_ref()) {
            if rest.is_empty() || rest.starts_with('/') {
                return format!("~{rest}");
            }
        }
    }
    path.to_string()
}

fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => hive_common::paths::home().join(rest),
        None if path == "~" => hive_common::paths::home(),
        None => PathBuf::from(path),
    }
}

/// The git toplevel a path is in (the nearest folder above it with a `.git`), if any. Only
/// looks at the disk: no process is started.
pub fn codebase_of(path: &str) -> Option<String> {
    let path = expand(path);
    if !path.is_absolute() {
        return None;
    }
    let mut at = Some(path.as_path());
    for _ in 0..40 {
        let dir = at?;
        if dir.join(".git").exists() {
            dir.parent()?; // never the whole disk
            return Some(home_short(&dir.to_string_lossy()));
        }
        at = dir.parent();
    }
    None
}

static PATH_IN_COMMAND: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?:^|[\s'"=(])((?:~|/)[^\s'"|;&<>()`$]*)"#));
const SYSTEM_PATHS: &[&str] = &[
    "/bin/",
    "/usr/",
    "/dev/",
    "/sbin/",
    "/System/",
    "/opt/homebrew/bin/",
    "/etc/",
    "/private/var/",
];

/// The files and folders a shell command names (absolute or ~/), without the system's programs.
pub fn command_paths(command: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for c in PATH_IN_COMMAND.captures_iter(command) {
        let p = c[1].trim_end_matches([',', '.', ':']).to_string();
        if p.len() < 2 || p == "~" || SYSTEM_PATHS.iter().any(|s| p.starts_with(s)) {
            continue;
        }
        if !found.contains(&p) {
            found.push(p);
        }
    }
    found
}

static SHELL_WRAPPER: LazyLock<Regex> = LazyLock::new(|| {
    re(r#"(?s)\A\s*(?:/usr)?(?:/bin/)?(?:ba|z)?sh\s+-l?c\s+(?:'(.*)'|"(.*)"|(.*))\s*\z"#)
});
static SUBCOMMAND: LazyLock<Regex> = LazyLock::new(|| re(r"\A[a-z][a-z0-9-]{0,20}\z"));
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| re(r"\A[A-Za-z_][A-Za-z0-9_]*="));

/// The programs a shell command runs, with their subcommand: "git status; cargo test". No
/// arguments, so nothing typed into a command (a token, a password) is kept.
pub fn command_heads(command: &str) -> Vec<String> {
    let inner = SHELL_WRAPPER
        .captures(command)
        .and_then(|c| c.get(1).or(c.get(2)).or(c.get(3)))
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| command.to_string());
    let mut heads: Vec<String> = Vec::new();
    for part in inner.split(['\n', ';', '|', '&']) {
        let mut words = part
            .split_whitespace()
            .map(|w| w.trim_matches(['(', ')', '{', '}']))
            .filter(|w| !w.is_empty())
            .skip_while(|w| ASSIGNMENT.is_match(w) || *w == "sudo" || *w == "env");
        let Some(program) = words.next() else {
            continue;
        };
        let program = program.rsplit('/').next().unwrap_or(program);
        if program == "cd" || !SUBCOMMAND.is_match(program) {
            continue;
        }
        let head = match words.next() {
            Some(sub) if SUBCOMMAND.is_match(sub) => format!("{program} {sub}"),
            _ => program.to_string(),
        };
        if !heads.contains(&head) {
            heads.push(head);
        }
        if heads.len() == 4 {
            break;
        }
    }
    heads
}

// --- keys -----------------------------------------------------------------------------------

static WORD: LazyLock<Regex> = LazyLock::new(|| re(r"[\p{L}\p{N}]+"));

/// The request, normalized: its words in lower case, one space apart (at most 300 characters).
pub fn task_key(request: &str) -> String {
    let folded = norm(request);
    let words: Vec<&str> = WORD.find_iter(&folded).map(|m| m.as_str()).collect();
    pyjson::head(&words.join(" "), 300).to_string()
}

const KEY_STOP: &[&str] = &[
    "the", "a", "an", "to", "on", "in", "of", "for", "at", "into", "and", "button", "link",
    "field", "tab", "icon", "menu", "item", "it", "its", "this", "that", "now", "again", "then",
];

/// What a step acted on, normalized for telling repeats apart: lower-case words without the
/// filler ("Clicking the Sign in button." and "clicking Sign in" are one).
pub fn what_key(text: &str) -> String {
    let folded = norm(text);
    let words: Vec<String> = WORD
        .find_iter(&folded)
        .map(|m| m.as_str())
        .filter(|w| !KEY_STOP.contains(w))
        .map(|w| {
            // "clicking", "clicks" and "click" are the same act
            let stem = w
                .strip_suffix("ing")
                .filter(|s| s.len() >= 3)
                .or_else(|| w.strip_suffix('s').filter(|s| s.len() >= 3))
                .unwrap_or(w);
            stem.to_string()
        })
        .collect();
    pyjson::head(&words.join(" "), 160).to_string()
}

/// device|place|tool|what: the same step is one key wherever and whenever it's taken.
pub fn step_key(device: &str, place: &str, tool: &str, what: &str) -> String {
    format!(
        "{device}|{}|{tool}|{}",
        casefold(place.trim()),
        what_key(what)
    )
}

/// FNV-1a, 64 bits, as hex: a short, stable name for a run.
fn fnv(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

// --- one step, as recorded ------------------------------------------------------------------

const NO_DETAILS: &[&str] = &["authenticate", "read_selected_text", "read_clipboard"];

/// What a mac or phone step acted on, when its arguments say it safely.
fn element_of(tool: &str, args: &Value) -> Option<String> {
    let s = |k: &str| args.get(k).and_then(Value::as_str);
    match tool {
        "open_app" => s("name").or(s("bundle_id")).and_then(|t| clean(t, 80)),
        "switch_window" => s("title").and_then(|t| clean(t, 100)),
        "press_key" => s("keys").and_then(|k| clean(k, 40)),
        "tap_element" => s("label").and_then(|t| clean(t, 80)),
        "find_text" => s("text").and_then(|t| clean(t, 80)),
        "type_text" => s("text").and_then(typed_address),
        "batch" => {
            let steps = args.get("steps").and_then(Value::as_array)?;
            let parts: Vec<String> = steps
                .iter()
                .take(10)
                .filter_map(|step| {
                    let tool = step.get("tool").and_then(Value::as_str)?;
                    if tool.starts_with("knowledge_") || tool == "batch" {
                        return None;
                    }
                    Some(match element_of(tool, step) {
                        Some(what) => format!("{tool} {what}"),
                        None => tool.to_string(),
                    })
                })
                .collect();
            (!parts.is_empty()).then(|| short(&parts.join(", "), 160))
        }
        _ => None,
    }
}

/// The step as stored (a line of the run's file), or None for one that isn't recorded at all
/// (the knowledge tools, the workspace's encoded calls). Everything in it is filtered here.
pub fn record(
    step: &StepInput,
    place: Option<&Place>,
    phone_app: Option<&str>,
    at: &str,
) -> Option<Value> {
    let tool = step.tool.as_str();
    let args = &step.arguments;
    if step.namespace == "knowledge" || tool.is_empty() {
        return None;
    }
    // the workspace's and the memory's calls, encoded in a mac tool's text or id
    let encoded = ["text", "id"].iter().any(|k| {
        args.get(*k)
            .and_then(Value::as_str)
            .is_some_and(|t| t.starts_with("workspace:") || t.starts_with("memory:"))
    });
    // a batch of the knowledge base's steps is the knowledge base's
    let knowledge_batch = tool == "batch"
        && args
            .get("steps")
            .and_then(Value::as_array)
            .is_some_and(|steps| {
                !steps.is_empty()
                    && steps.iter().all(|s| {
                        s.get("tool")
                            .and_then(Value::as_str)
                            .is_some_and(|t| t.starts_with("knowledge_"))
                    })
            });
    if encoded || knowledge_batch {
        return None;
    }
    let mut out = Map::new();
    let (mut app, mut window, mut page, mut host, mut site) = (None, None, None, None, None);
    let (mut element, mut reason, mut paths, mut codebase) = (None, None, Vec::new(), None);
    match step.namespace.as_str() {
        "shell" => {
            let mut named: Vec<String> = Vec::new();
            if tool == "command" {
                let command = args.get("command").and_then(Value::as_str).unwrap_or("");
                let heads = command_heads(command);
                element = clean(&heads.join("; "), 120);
                named.extend(command_paths(command));
            } else {
                let kinds: Vec<String> = args
                    .get("kinds")
                    .and_then(Value::as_array)
                    .map(|k| {
                        k.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                let mut counted: Vec<(String, usize)> = Vec::new();
                for kind in kinds {
                    match counted.iter_mut().find(|(k, _)| *k == kind) {
                        Some((_, n)) => *n += 1,
                        None => counted.push((kind, 1)),
                    }
                }
                let said: Vec<String> = counted
                    .iter()
                    .map(|(k, n)| format!("{k} {n} file{}", if *n == 1 { "" } else { "s" }))
                    .collect();
                element = clean(&said.join(", "), 80);
            }
            if let Some(list) = args.get("paths").and_then(Value::as_array) {
                named.extend(list.iter().filter_map(Value::as_str).map(str::to_string));
            }
            let cwd = args
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty());
            for p in &named {
                let shown = home_short(p);
                if let Some(shown) = clean(&shown, 160) {
                    if !paths.contains(&shown) && paths.len() < 6 {
                        paths.push(shown);
                    }
                }
            }
            codebase = cwd
                .and_then(codebase_of)
                .or_else(|| named.iter().find_map(|p| codebase_of(p)))
                .and_then(|c| clean(&c, 160));
            app = Some("shell".to_string());
            if let Some(cwd) = cwd.and_then(|c| clean(&home_short(c), 160)) {
                if paths.is_empty() {
                    paths.push(cwd);
                }
            }
        }
        namespace => {
            if namespace == "mac" {
                if let Some(place) = place {
                    app = place.app.as_deref().and_then(|a| clean(a, 60));
                    window = place.window.as_deref().and_then(|w| clean(w, 120));
                    if let Some((p, h, s)) = place.url.as_deref().and_then(web_page) {
                        page = Some(p);
                        host = Some(h);
                        site = Some(s);
                    }
                }
            } else {
                app = phone_app.and_then(|a| clean(a, 80));
            }
            if !NO_DETAILS.contains(&tool) {
                element = element_of(tool, args);
                reason = args
                    .get("step")
                    .and_then(Value::as_str)
                    .and_then(|r| clean(r, 160));
            }
        }
    }
    let place_name = host
        .clone()
        .or_else(|| app.clone().filter(|a| a != "shell"))
        .or_else(|| codebase.clone())
        .unwrap_or_default();
    let what = element
        .clone()
        .or_else(|| reason.clone())
        .unwrap_or_default();
    let key = step_key(&step.namespace, &place_name, tool, &what);
    let opt = |v: Option<String>| v.map(Value::String).unwrap_or(Value::Null);
    out.insert("at".into(), json!(at));
    out.insert("device".into(), json!(step.namespace));
    out.insert("tool".into(), json!(tool));
    out.insert("app".into(), opt(app));
    out.insert("window".into(), opt(window));
    out.insert("page".into(), opt(page));
    out.insert("host".into(), opt(host));
    out.insert("site".into(), opt(site));
    out.insert("codebase".into(), opt(codebase));
    out.insert("paths".into(), json!(paths));
    out.insert("element".into(), opt(element));
    out.insert("reason".into(), opt(reason));
    out.insert("ok".into(), json!(step.ok));
    out.insert("key".into(), json!(key));
    Some(Value::Object(out))
}

fn text_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Where a recorded step was, for showing: the page's host, the app, or the codebase's folder.
fn where_of(rec: &Value) -> String {
    text_of(rec, "host")
        .or_else(|| text_of(rec, "app").filter(|a| *a != "shell"))
        .map(str::to_string)
        .or_else(|| text_of(rec, "codebase").map(|c| c.rsplit('/').next().unwrap_or(c).to_string()))
        .or_else(|| text_of(rec, "app").map(str::to_string))
        .unwrap_or_default()
}

// --- a run, ready to go up ------------------------------------------------------------------

fn push_unique(list: &mut Vec<String>, value: Option<&str>) {
    if let Some(v) = value.filter(|v| !v.is_empty()) {
        if !list.iter().any(|x| x == v) {
            list.push(v.to_string());
        }
    }
}

/// A finished run as it waits in actions-pending.jsonl: `{"row": <action_runs row>, "actions":
/// [<one per distinct step, with ok_count, error_count, first_seen>]}`. None when it has no step.
pub fn finished_run(
    header: &Value,
    records: &[Value],
    outcome: &str,
    ended_at: &str,
    last: Option<&Place>,
) -> Option<Value> {
    if records.is_empty() {
        return None;
    }
    let request = text_of(header, "request").unwrap_or("");
    let (request, key) = match clean(request, 300) {
        Some(r) => (r, task_key(request)),
        None => (String::new(), String::new()), // a request with a secret in it isn't kept
    };
    let mut steps: Vec<Value> = Vec::new();
    let (mut sites, mut hosts, mut apps, mut codebases) = (vec![], vec![], vec![], vec![]);
    let mut actions: Vec<Value> = Vec::new();
    for rec in records {
        push_unique(&mut sites, text_of(rec, "site"));
        push_unique(&mut hosts, text_of(rec, "host"));
        push_unique(&mut apps, text_of(rec, "app").filter(|a| *a != "shell"));
        push_unique(&mut codebases, text_of(rec, "codebase"));
        let k = text_of(rec, "key").unwrap_or("").to_string();
        let ok = rec.get("ok") == Some(&Value::Bool(true));
        match actions.iter_mut().find(|a| a["key"] == json!(k)) {
            Some(a) => {
                let first = a["first_seen"].clone();
                let (oks, errors) = (
                    a["ok_count"].as_i64().unwrap_or(0),
                    a["error_count"].as_i64().unwrap_or(0),
                );
                *a = rec.clone();
                a["first_seen"] = first;
                a["ok_count"] = json!(oks + i64::from(ok));
                a["error_count"] = json!(errors + i64::from(!ok));
            }
            None => {
                let mut a = rec.clone();
                a["first_seen"] = rec.get("at").cloned().unwrap_or(Value::Null);
                a["ok_count"] = json!(i64::from(ok));
                a["error_count"] = json!(i64::from(!ok));
                actions.push(a);
            }
        }
        let tool = text_of(rec, "tool").unwrap_or("");
        if NOISE_TOOLS.contains(&tool) {
            continue; // looking around: counted in the steps above, not one to repeat
        }
        let what = text_of(rec, "element")
            .or_else(|| text_of(rec, "reason"))
            .unwrap_or("");
        if let Some(previous) = steps.last_mut() {
            if previous["k"] == json!(k) {
                previous["ok"] = json!(ok);
                previous["n"] = json!(previous["n"].as_i64().unwrap_or(1) + 1);
                continue;
            }
        }
        if steps.len() < MAX_RUN_STEPS {
            steps.push(
                json!({"k": k, "tool": rec.get("tool").cloned().unwrap_or(Value::Null),
                              "where": where_of(rec), "what": what, "ok": ok, "n": 1}),
            );
        }
    }
    if let Some(last) = last {
        push_unique(
            &mut apps,
            last.app.as_deref().and_then(|a| clean(a, 60)).as_deref(),
        );
        if let Some((_, h, s)) = last.url.as_deref().and_then(web_page) {
            push_unique(&mut hosts, Some(&h));
            push_unique(&mut sites, Some(&s));
        }
    }
    let keys: Vec<&str> = steps.iter().filter_map(|s| s["k"].as_str()).collect();
    let run_key = fnv(&format!("{key}\n{outcome}\n{}", keys.join("\n")));
    let started = text_of(header, "started_at").unwrap_or(ended_at);
    for a in &mut actions {
        a["task_key"] = json!(key);
    }
    Some(json!({
        "row": {
            "run_key": run_key, "task_key": key, "request": request,
            "receipt": header.get("receipt").cloned().unwrap_or(Value::Null),
            "device": header.get("device").cloned().unwrap_or(Value::Null),
            "outcome": outcome, "sites": sites, "hosts": hosts, "apps": apps, "codebases": codebases,
            "steps": steps, "seen_count": 1, "started_at": started, "ended_at": ended_at,
            "last_seen": ended_at,
        },
        "actions": actions,
    }))
}

const ACTION_SQL: &str = concat!(
    "INSERT INTO actions (step_key, device, tool, app, window_title, site, host, page, codebase, paths, ",
    "element, reason, ok_count, error_count, first_seen, last_seen, last_task_key) ",
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17) ",
    "ON CONFLICT (step_key) DO UPDATE SET ok_count = ok_count + excluded.ok_count, ",
    "error_count = error_count + excluded.error_count, last_seen = excluded.last_seen, ",
    "app = COALESCE(excluded.app, app), window_title = COALESCE(excluded.window_title, window_title), ",
    "page = COALESCE(excluded.page, page), paths = COALESCE(excluded.paths, paths), ",
    "element = COALESCE(excluded.element, element), reason = COALESCE(excluded.reason, reason), ",
    "last_task_key = COALESCE(excluded.last_task_key, last_task_key)"
);

const RUN_SQL: &str = concat!(
    "INSERT INTO action_runs (run_key, task_key, request, receipt, device, outcome, sites, hosts, apps, ",
    "codebases, steps, seen_count, started_at, ended_at, last_seen) ",
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?13, ?14) ",
    "ON CONFLICT (run_key) DO UPDATE SET seen_count = seen_count + 1, last_seen = excluded.last_seen, ",
    "ended_at = excluded.ended_at, receipt = COALESCE(excluded.receipt, receipt)"
);

/// The latest runs, for the Mac's copy.
pub fn recent_runs_sql() -> String {
    format!(
        "SELECT run_key, task_key, request, receipt, device, outcome, sites, hosts, apps, codebases, \
         steps, seen_count, started_at, ended_at, last_seen FROM action_runs \
         ORDER BY last_seen DESC, id DESC LIMIT {CACHE_RUNS}"
    )
}

/// The statements that store one pending run: an upsert for each distinct step (counted when it
/// is already stored), then one for the run.
pub fn statements(pending: &Value) -> Vec<(String, Vec<Value>)> {
    let null = Value::Null;
    let field = |v: &Value, k: &str| v.get(k).cloned().unwrap_or(Value::Null);
    let text = |v: &Value, k: &str| match v.get(k) {
        Some(Value::Array(list)) => json!(pyjson::dumps_utf8(&Value::Array(list.clone()))),
        Some(Value::String(s)) => json!(s),
        _ => Value::Null,
    };
    let mut out = Vec::new();
    let row = pending.get("row").unwrap_or(&null);
    for a in pending
        .get("actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let paths = match a.get("paths") {
            Some(Value::Array(list)) if !list.is_empty() => text(a, "paths"),
            _ => Value::Null,
        };
        let task = match a.get("task_key") {
            Some(Value::String(s)) if !s.is_empty() => json!(s),
            _ => Value::Null,
        };
        out.push((
            ACTION_SQL.to_string(),
            vec![
                field(a, "key"),
                field(a, "device"),
                field(a, "tool"),
                field(a, "app"),
                field(a, "window"),
                field(a, "site"),
                field(a, "host"),
                field(a, "page"),
                field(a, "codebase"),
                paths,
                field(a, "element"),
                field(a, "reason"),
                field(a, "ok_count"),
                field(a, "error_count"),
                field(a, "first_seen"),
                field(a, "at"),
                task,
            ],
        ));
    }
    out.push((
        RUN_SQL.to_string(),
        vec![
            field(row, "run_key"),
            field(row, "task_key"),
            field(row, "request"),
            field(row, "receipt"),
            field(row, "device"),
            field(row, "outcome"),
            text(row, "sites"),
            text(row, "hosts"),
            text(row, "apps"),
            text(row, "codebases"),
            text(row, "steps"),
            field(row, "started_at"),
            field(row, "ended_at"),
            field(row, "last_seen"),
        ],
    ));
    out
}

// --- the Mac's files ------------------------------------------------------------------------

static FILES: Mutex<()> = Mutex::new(());
static UPLOAD: Mutex<()> = Mutex::new(());

fn open_dir(folder: &Path) -> PathBuf {
    folder.join("actions-open")
}

fn open_file(folder: &Path, run: &str) -> PathBuf {
    let name: String = run
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(80)
        .collect();
    open_dir(folder).join(format!("{name}.jsonl"))
}

fn append_line(path: &Path, value: &Value) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)?;
    file.write_all((pyjson::dumps_utf8(value) + "\n").as_bytes())
}

fn read_lines(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Runs waiting to go up.
pub fn pending(folder: &Path) -> Vec<Value> {
    read_lines(&folder.join("actions-pending.jsonl"))
}

/// The most runs that wait on the Mac (the oldest go first): a run the database keeps refusing
/// can't make the list grow forever.
pub const MOST_PENDING: usize = 500;

fn add_pending(folder: &Path, run: &Value) -> std::io::Result<()> {
    let _held = FILES.lock().unwrap_or_else(|e| e.into_inner());
    util::make_private_dir(folder)?;
    let path = folder.join("actions-pending.jsonl");
    append_line(&path, run)?;
    let lines = read_lines(&path);
    if lines.len() > MOST_PENDING {
        let kept = &lines[lines.len() - MOST_PENDING..];
        let text: String = kept.iter().map(|r| pyjson::dumps_utf8(r) + "\n").collect();
        util::atomic_write(&path, &text)?;
        util::chmod(&path, 0o600)?;
    }
    Ok(())
}

/// Takes the runs named out of the waiting list (the rest stay, including any added meanwhile).
fn drop_pending(folder: &Path, done: &HashSet<String>) -> std::io::Result<()> {
    let _held = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let path = folder.join("actions-pending.jsonl");
    let left: Vec<Value> = read_lines(&path)
        .into_iter()
        .filter(|r| !done.contains(&str_of(&r["row"]["run_key"])))
        .collect();
    if left.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    let text: String = left.iter().map(|r| pyjson::dumps_utf8(r) + "\n").collect();
    util::atomic_write(&path, &text)?;
    util::chmod(&path, 0o600)
}

/// The Mac's copy of the latest runs: (runs, when it was made).
pub fn cached_runs(folder: &Path) -> (Vec<Value>, Option<String>) {
    let data = read_small(&folder.join("actions-cache.json"));
    (
        data.get("runs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        data.get("copied")
            .and_then(Value::as_str)
            .map(str::to_string),
    )
}

fn write_cache(folder: &Path, runs: &[Value]) -> std::io::Result<()> {
    let path = folder.join("actions-cache.json");
    let data = json!({"copied": knowledge::now(), "runs": runs});
    util::atomic_write(&path, &pyjson::dumps_utf8(&data))?;
    util::chmod(&path, 0o600)
}

/// A JSON file under 8 MB, else nothing (never a long read on the request path).
fn read_small(path: &Path) -> Value {
    match std::fs::metadata(path) {
        Ok(m) if m.len() <= 8 << 20 => std::fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

// --- uploading ------------------------------------------------------------------------------

/// What an upload did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Uploaded {
    pub runs: usize,
    /// Runs in the Mac's copy afterwards.
    pub cached: usize,
    /// Why the cloud couldn't be reached (the runs stay waiting).
    pub offline: Option<String>,
}

fn missing_table(error: &Error) -> bool {
    error
        .to_string()
        .to_ascii_lowercase()
        .contains("no such table")
}

/// Uploads the waiting runs, one D1 batch each, then refreshes the Mac's copy of the latest runs.
/// A database made before the action tables gets them first (its migrations are applied).
pub fn upload(base: &KnowledgeBase) -> Result<Uploaded, Error> {
    let _held = UPLOAD.lock().unwrap_or_else(|e| e.into_inner());
    let folder = base.folder.clone();
    let mut report = Uploaded::default();
    let mut migrated = false;
    let mut done = HashSet::new();
    let mut run_query = |statements: &[(String, Vec<Value>)]| -> Result<Vec<Vec<Value>>, Error> {
        match base.query(statements) {
            Err(e) if !migrated && missing_table(&e) => {
                migrated = true;
                base.apply_migrations()?;
                base.query(statements)
            }
            other => other,
        }
    };
    let attempt = (|| -> Result<(), Error> {
        for run in pending(&folder) {
            run_query(&statements(&run))?;
            done.insert(str_of(&run["row"]["run_key"]));
            report.runs += 1;
        }
        let runs = run_query(&[(recent_runs_sql(), vec![])])?
            .into_iter()
            .next()
            .unwrap_or_default();
        write_cache(&folder, &runs).map_err(|e| Error::Failed(e.to_string()))?;
        report.cached = runs.len();
        Ok(())
    })();
    if !done.is_empty() {
        drop_pending(&folder, &done).map_err(|e| Error::Failed(e.to_string()))?;
    }
    match attempt {
        Ok(()) => Ok(report),
        Err(Error::Offline(why)) => {
            report.offline = Some(why);
            Ok(report)
        }
        Err(other) => Err(other),
    }
}

/// [`upload`], saying what went wrong (if anything) through `report`.
fn upload_and_report(base: &KnowledgeBase, report: Option<Report>) {
    let said = match upload(base) {
        Ok(Uploaded {
            offline: Some(why), ..
        }) => Some(format!(
            "Action memory: cloud unreachable ({})",
            pyjson::head(&why, 120)
        )),
        Ok(_) => None,
        Err(e) => Some(format!("Action memory upload failed: {e}")),
    };
    if let (Some(report), Some(said)) = (report, said) {
        report(&said);
    }
}

/// [`upload`] on a thread of its own ("knowledge-actions"); None if it couldn't be started.
pub fn upload_in_background(
    base: KnowledgeBase,
    report: Option<Report>,
) -> Option<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("knowledge-actions".into())
        .spawn(move || upload_and_report(&base, report))
        .ok()
}

/// At Hive's start, on a thread of its own: a run Hive quit during (its file unchanged for half
/// an hour) is closed as "unknown", the waiting runs go up, and the Mac's copy is refreshed.
pub fn sync_in_background(report: Option<Report>) -> Option<std::thread::JoinHandle<()>> {
    if !enabled() {
        return None;
    }
    std::thread::Builder::new()
        .name("knowledge-actions".into())
        .spawn(move || {
            let base = KnowledgeBase::new();
            let _ = close_orphans(&base.folder, Duration::from_secs(1800));
            upload_and_report(&base, report);
        })
        .ok()
}

/// Closes the runs whose file hasn't changed for `older_than` (Hive quit during them).
pub fn close_orphans(folder: &Path, older_than: Duration) -> std::io::Result<usize> {
    let mut closed = 0;
    for path in util::listing(&open_dir(folder)) {
        let old = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age >= older_than);
        if !old || path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let lines = read_lines(&path);
        if let Some((header, records)) = lines.split_first() {
            let ended = records
                .last()
                .and_then(|r| r.get("at"))
                .map(str_of)
                .unwrap_or_else(knowledge::now);
            if let Some(run) = finished_run(&header["header"], records, "unknown", &ended, None) {
                add_pending(folder, &run)?;
                closed += 1;
            }
        }
        std::fs::remove_file(&path)?;
    }
    Ok(closed)
}

// --- the recorder ---------------------------------------------------------------------------

enum Msg {
    Begin(TaskInfo),
    Step(TaskInfo, StepInput),
    End(TaskInfo, String),
    Flush(mpsc::Sender<()>),
}

struct Open {
    /// Where the Mac was after the latest step (the next step began there).
    place: Option<Place>,
    /// The app the phone opened last.
    phone_app: Option<String>,
    has_file: bool,
}

/// Records a task's steps on a thread of its own; every call returns at once.
pub struct Recorder {
    base: KnowledgeBase,
    place: PlaceFn,
    /// Upload each run when it ends (tests upload by hand).
    pub upload: bool,
    report: Option<Report>,
    tx: Mutex<Option<mpsc::Sender<Msg>>>,
}

impl Recorder {
    pub fn new(base: KnowledgeBase, place: PlaceFn, report: Option<Report>) -> Arc<Recorder> {
        Arc::new(Recorder {
            base,
            place,
            upload: true,
            report,
            tx: Mutex::new(None),
        })
    }

    /// A recorder that never uploads by itself (tests call [`upload`]).
    pub fn without_upload(base: KnowledgeBase, place: PlaceFn) -> Arc<Recorder> {
        Arc::new(Recorder {
            base,
            place,
            upload: false,
            report: None,
            tx: Mutex::new(None),
        })
    }

    pub fn folder(&self) -> &Path {
        &self.base.folder
    }

    fn send(self: &Arc<Self>, msg: Msg) {
        if !enabled() {
            if let Msg::Flush(done) = msg {
                let _ = done.send(());
            }
            return;
        }
        let mut tx = self.tx.lock().unwrap_or_else(|e| e.into_inner());
        if tx.is_none() {
            let (sender, receiver) = mpsc::channel();
            let me = self.clone();
            let started = std::thread::Builder::new()
                .name("action-memory".into())
                .spawn(move || me.work(receiver));
            if started.is_err() {
                return;
            }
            *tx = Some(sender);
        }
        if let Some(sender) = tx.as_ref() {
            if sender.send(msg).is_err() {
                *tx = None; // the thread is gone: the next call starts another
            }
        }
    }

    /// A task began: notes where the Mac is (its first step begins there).
    pub fn begin(self: &Arc<Self>, task: &TaskInfo) {
        self.send(Msg::Begin(task.clone()));
    }

    /// A step finished.
    pub fn step(self: &Arc<Self>, task: &TaskInfo, step: StepInput) {
        self.send(Msg::Step(task.clone(), step));
    }

    /// The task ended: "done", "failed", "stopped" or "interrupted".
    pub fn end(self: &Arc<Self>, task: &TaskInfo, outcome: &str) {
        self.send(Msg::End(task.clone(), outcome.to_string()));
    }

    /// Waits (up to `timeout`) until everything sent so far has been handled.
    pub fn flush(self: &Arc<Self>, timeout: Duration) -> bool {
        let (done, wait) = mpsc::channel();
        self.send(Msg::Flush(done));
        wait.recv_timeout(timeout).is_ok()
    }

    fn snapshot(&self) -> Place {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.place)()))
            .unwrap_or_default()
    }

    fn work(&self, receiver: mpsc::Receiver<Msg>) {
        let mut open: HashMap<String, Open> = HashMap::new();
        for msg in receiver {
            let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.handle(&mut open, msg)
            }));
            if handled.is_err() {
                open.clear(); // their files stay; they're closed as "unknown" at the next start
            }
        }
    }

    fn handle(&self, open: &mut HashMap<String, Open>, msg: Msg) {
        let folder = self.base.folder.clone();
        match msg {
            Msg::Flush(done) => {
                let _ = done.send(());
            }
            Msg::Begin(task) => {
                let place = (task.device == "mac").then(|| self.snapshot());
                open.insert(
                    task.run.clone(),
                    Open {
                        place,
                        phone_app: None,
                        has_file: false,
                    },
                );
            }
            Msg::Step(task, step) => {
                let entry = open.entry(task.run.clone()).or_insert(Open {
                    place: None,
                    phone_app: None,
                    has_file: false,
                });
                let place = if step.namespace == "mac" {
                    Some(entry.place.take().unwrap_or_else(|| self.snapshot()))
                } else {
                    None
                };
                let at = knowledge::now();
                let rec = record(&step, place.as_ref(), entry.phone_app.as_deref(), &at);
                if step.namespace == "phone" && step.tool == "open_app" && step.ok {
                    entry.phone_app = step
                        .arguments
                        .get("bundle_id")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                if let Some(rec) = rec {
                    let path = open_file(&folder, &task.run);
                    let written = (|| -> std::io::Result<()> {
                        if !entry.has_file {
                            util::make_private_dir(&folder)?;
                            util::make_private_dir(&open_dir(&folder))?;
                            let header = json!({"header": {
                                "run": task.run, "request": clean(&task.request, 2000).unwrap_or_default(),
                                "device": task.device,
                                "receipt": task.receipt, "started_at": at}});
                            if !path.exists() {
                                append_line(&path, &header)?;
                            }
                            entry.has_file = true;
                        }
                        append_line(&path, &rec)
                    })();
                    if written.is_err() {
                        entry.has_file = false;
                    }
                }
                if step.namespace == "mac" {
                    entry.place = Some(self.snapshot()); // where the next step begins
                }
            }
            Msg::End(task, outcome) => {
                let entry = open.remove(&task.run);
                let path = open_file(&folder, &task.run);
                let lines = read_lines(&path);
                let Some((header, records)) = lines.split_first() else {
                    return;
                };
                let last = entry.and_then(|e| e.place);
                let run = finished_run(
                    &header["header"],
                    records,
                    &outcome,
                    &knowledge::now(),
                    last.as_ref(),
                );
                let stored = match &run {
                    Some(run) => add_pending(&folder, run).is_ok(),
                    None => true,
                };
                if stored {
                    let _ = std::fs::remove_file(&path);
                }
                // a run whose end never came (a crash) is closed after six hours
                let _ = close_orphans(&folder, Duration::from_secs(6 * 3600));
                if self.upload && run.is_some() {
                    upload_in_background(self.base.clone(), self.report.clone());
                }
            }
        }
    }
}

// --- before each request: what the knowledge base has for it -------------------------------

const MATCH_STOP: &[&str] = &[
    "the", "and", "for", "from", "with", "this", "that", "your", "their", "user", "users", "task",
    "tasks", "request", "about", "into", "using", "use", "what", "when", "where", "how", "have",
    "has", "had", "can", "could", "should", "would", "please", "continue", "work", "working",
    "open", "get", "make", "find", "show", "tell", "let", "know", "want", "need", "also", "then",
    "now", "just", "there", "here", "some", "all", "any", "out", "off", "new", "you", "are", "was",
    "were", "will", "its", "it's", "not", "but", "check", "look", "see", "give", "take", "put",
    "one", "two", "today", "again", "him", "her", "them", "they", "our", "his", "hers", "mine",
    "myself", "via", "page", "site", "website", "app",
];
const OWNER_WORDS: &[&str] = &["my", "me", "mine", "myself"];
const GENERIC_LABELS: &[&str] = &[
    "www", "www2", "com", "org", "net", "edu", "gov", "io", "co", "us", "uk", "app", "apps", "web",
    "m", "login", "auth", "accounts", "account", "my", "api", "cdn", "static", "home", "portal",
];
const GENERIC_APPS: &[&str] = &[
    "safari",
    "google chrome",
    "chrome",
    "arc",
    "firefox",
    "brave browser",
    "microsoft edge",
    "finder",
    "terminal",
    "iterm2",
    "shell",
    "hive",
    "agent-vhid-captions",
];
const NOISE_TOOLS: &[&str] = &[
    "screenshot",
    "wait",
    "read_screen",
    "windows",
    "find_text",
    "read_clipboard",
    "read_ingested",
    "read_selected_text",
    "elements",
    "move_mouse",
    "wait_for_control",
];
const GENERIC_SUBJECT: &[&str] = &[
    "university",
    "school",
    "club",
    "team",
    "office",
    "department",
    "company",
    "inc",
    "group",
    "the",
    "of",
    "and",
    "center",
    "service",
    "services",
];

fn words_of(text: &str) -> Vec<String> {
    let folded = casefold(text);
    WORD.find_iter(&folded)
        .map(|m| m.as_str().to_string())
        .collect()
}

/// The request's words that can tell one thing from another (3+ characters, no filler).
fn match_words(text: &str) -> HashSet<String> {
    words_of(text)
        .into_iter()
        .filter(|w| pyjson::len(w) >= 3 && !MATCH_STOP.contains(&w.as_str()))
        .collect()
}

fn list_of(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(list)) => list.clone(),
        Some(Value::String(text)) => serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn strings_of(value: Option<&Value>) -> Vec<String> {
    list_of(value)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

/// The facts of the Mac's copy that bear on the request: about someone or something it names,
/// or about the owner ("my ...") with a word of the request in the fact, or with two of its words
/// in the fact. Best first, at most `most`.
pub fn matching_facts(rows: &[Value], request: &str, most: usize) -> Vec<Value> {
    let all = words_of(request);
    let owner = all.iter().any(|w| OWNER_WORDS.contains(&w.as_str()));
    let words = match_words(request);
    let mut scored: Vec<(usize, String, &Value)> = Vec::new();
    for row in rows {
        if truthy(row.get("outdated_at")) {
            continue;
        }
        let (subject, attribute, value) = (
            text_of(row, "subject").unwrap_or(""),
            text_of(row, "attribute").unwrap_or(""),
            text_of(row, "value").unwrap_or(""),
        );
        if knowledge::secret(attribute, value).is_some() {
            continue;
        }
        let subject_key = knowledge::subject_key(subject);
        let named = subject_key != "owner"
            && words_of(&subject_key)
                .iter()
                .filter(|w| pyjson::len(w) >= 3 && !GENERIC_SUBJECT.contains(&w.as_str()))
                .any(|w| words.contains(w));
        let about_owner = subject_key == "owner" && owner;
        let fact_words: HashSet<String> = words_of(&format!("{attribute} {value}"))
            .into_iter()
            .collect();
        let other = words.iter().filter(|w| fact_words.contains(*w)).count();
        if !(named || (about_owner && other >= 1) || other >= 2) {
            continue;
        }
        let score = 2 * usize::from(named) + usize::from(about_owner) + other;
        let when = text_of(row, "confirmed_at")
            .or_else(|| text_of(row, "learned_at"))
            .unwrap_or("")
            .to_string();
        scored.push((score, when, row));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    scored
        .into_iter()
        .take(most)
        .map(|(_, _, r)| r.clone())
        .collect()
}

fn fact_line(row: &Value) -> String {
    let get = |k: &str| text_of(row, k).unwrap_or("");
    let when = text_of(row, "confirmed_at")
        .or_else(|| text_of(row, "learned_at"))
        .unwrap_or("");
    short(
        &format!(
            "- {} · {}: {} (from {}, {})",
            get("subject"),
            get("attribute"),
            get("value"),
            get("source"),
            pyjson::head(when, 10)
        ),
        200,
    )
}

/// How a past run bears on the request: 3 the same request, 2 a place it names and a similar
/// request, 1 either, 0 none.
fn tier(run: &Value, words: &HashSet<String>, key: &str, request: &str) -> u8 {
    let exact = !key.is_empty() && text_of(run, "task_key") == Some(key);
    if exact {
        return 3;
    }
    let lower = casefold(request);
    let host_named = strings_of(run.get("hosts"))
        .iter()
        .chain(strings_of(run.get("sites")).iter())
        .any(|h| {
            lower.contains(h.as_str())
                || h.split('.')
                    .filter(|l| l.len() >= 3 && !GENERIC_LABELS.contains(l))
                    .any(|l| words.contains(l))
        });
    let app_named = strings_of(run.get("apps")).iter().any(|a| {
        let a = casefold(a);
        let parts: Vec<String> = words_of(&a);
        !GENERIC_APPS.contains(&a.as_str())
            && !parts.is_empty()
            && parts
                .iter()
                .all(|p| words.contains(p) || pyjson::len(p) < 3)
            && parts.iter().any(|p| words.contains(p))
    });
    let codebase_named = strings_of(run.get("codebases")).iter().any(|c| {
        let name = casefold(c.rsplit('/').next().unwrap_or(c));
        pyjson::len(&name) >= 3 && (words.contains(&name) || lower.contains(&name))
    });
    let named = host_named || app_named || codebase_named;
    let theirs = match_words(text_of(run, "request").unwrap_or(""));
    let shared = words.intersection(&theirs).count();
    let union = words.union(&theirs).count().max(1);
    let similar = shared >= 2 && shared * 3 >= union;
    match (named, similar) {
        (true, true) => 2,
        (false, false) => 0,
        _ => 1,
    }
}

/// The steps of a run worth repeating: the ones that went through, without the looking around.
fn useful_steps(run: &Value) -> Vec<Value> {
    list_of(run.get("steps"))
        .into_iter()
        .filter(|s| s.get("ok") == Some(&Value::Bool(true)))
        .filter(|s| !NOISE_TOOLS.contains(&s.get("tool").and_then(Value::as_str).unwrap_or("")))
        .collect()
}

fn step_line(n: usize, step: &Value, previous_where: &str) -> String {
    let tool = text_of(step, "tool").unwrap_or("step");
    let place = text_of(step, "where").unwrap_or("");
    let what = text_of(step, "what").unwrap_or("");
    let mut line = format!("{n}. ");
    if !place.is_empty() && place != previous_where {
        line.push_str(&format!("[{place}] "));
    }
    line.push_str(tool);
    if !what.is_empty() {
        line.push_str(&format!(": {what}"));
    }
    let times = step.get("n").and_then(Value::as_i64).unwrap_or(1);
    if times > 1 {
        line.push_str(&format!(" (×{times})"));
    }
    short(&line, 130)
}

/// The runs that bear on the request, best first: the same request, then a place it names
/// together with a similar request, then either; the ones that were done before the ones that
/// weren't; the most recent first. Only runs with a step worth repeating.
pub fn matching_runs<'a>(runs: &'a [Value], request: &str) -> Vec<&'a Value> {
    let words = match_words(request);
    let key = task_key(request);
    let mut found: Vec<(u8, bool, String, &Value)> = runs
        .iter()
        .filter(|r| !useful_steps(r).is_empty())
        .filter_map(|r| {
            let t = tier(r, &words, &key, request);
            (t > 0).then(|| {
                let done = text_of(r, "outcome") == Some("done");
                let seen = text_of(r, "last_seen").unwrap_or("").to_string();
                (t, done, seen, r)
            })
        })
        .collect();
    found.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| b.2.cmp(&a.2))
    });
    let mut seen_tasks = HashSet::new();
    found
        .into_iter()
        .map(|(_, _, _, r)| r)
        .filter(|r| seen_tasks.insert(text_of(r, "task_key").unwrap_or("").to_string()))
        .collect()
}

/// What goes with a request, at most [`CONTEXT_LIMIT`] characters: the facts that bear on it and
/// the steps of the most recent matching past task. None when there is nothing.
pub fn context_from(request: &str, facts: &[Value], runs: &[Value]) -> Option<String> {
    let mut lines: Vec<String> = vec![format!("Knowledge base, attached automatically. {NOTICE}")];
    let mut used = pyjson::len(&lines[0]) + 1;
    let mut fits = |lines: &mut Vec<String>, line: String| -> bool {
        let n = pyjson::len(&line) + 1;
        if used + n > CONTEXT_LIMIT {
            return false;
        }
        used += n;
        lines.push(line);
        true
    };
    let found = matching_facts(facts, request, CONTEXT_FACTS);
    let mut facts_shown = 0;
    if !found.is_empty() && fits(&mut lines, "Facts that may bear on this request:".into()) {
        for fact in &found {
            if !fits(&mut lines, fact_line(fact)) {
                break;
            }
            facts_shown += 1;
        }
    }
    let mut steps_shown = 0;
    if let Some(run) = matching_runs(runs, request).first() {
        let steps = useful_steps(run);
        let when = text_of(run, "last_seen").unwrap_or("");
        let asked = text_of(run, "request").unwrap_or("");
        let asked = if asked.is_empty() {
            String::new()
        } else {
            format!("\"{}\", ", short(asked, 80))
        };
        let head = format!(
            "Steps that went through in an earlier task like this ({asked}{}, {}):",
            pyjson::head(when, 10),
            text_of(run, "outcome").unwrap_or("unknown")
        );
        if fits(&mut lines, head) {
            let mut previous = String::new();
            for (i, step) in steps.iter().take(CONTEXT_STEPS).enumerate() {
                if !fits(&mut lines, step_line(i + 1, step, &previous)) {
                    break;
                }
                previous = text_of(step, "where").unwrap_or("").to_string();
                steps_shown += 1;
            }
            if steps.len() > steps_shown && steps_shown > 0 {
                fits(
                    &mut lines,
                    format!("… and {} more steps.", steps.len() - steps_shown),
                );
            }
            if steps_shown == 0 {
                lines.pop();
            }
        }
    }
    (facts_shown + steps_shown > 0).then(|| lines.join("\n"))
}

/// [`context_from`] with the Mac's copies in `folder` (knowledge/cache.json, actions-cache.json
/// and the runs waiting to go up). No network; None on any failure, for a request that opts out
/// of memory, or one about a password, key or the like.
pub fn context(request: &str, folder: &Path) -> Option<String> {
    if crate::memory_search::AUTO_OPTOUT.is_match(request)
        || knowledge::secret(request, request).is_some()
        || crate::memory_search::SENSITIVE.is_match(request)
    {
        return None;
    }
    let facts = read_small(&folder.join("cache.json"))
        .get("facts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut runs: Vec<Value> = if enabled() {
        pending(folder)
            .into_iter()
            .filter_map(|p| p.get("row").cloned())
            .collect()
    } else {
        Vec::new()
    };
    if enabled() {
        runs.extend(cached_runs(folder).0);
    }
    context_from(request, &facts, &runs)
}
