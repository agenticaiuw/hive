//! One persistent SpaceO MCP session for Agent, preserved across short restarts
//! (python/spaceo_mcp_bridge.py).
//!
//! The upstream controller retains the lease and renews it. Startup claims the existing workspace
//! first; it creates one only when the daemon explicitly says it does not exist. All other
//! failures are surfaced and are never followed by a replacement session.
//!
//! Two ways to run it: embedded in the agent ([`Bridge::start_embedded`], which holds the lease
//! for the agent process and serves `workspace.sock`), or as the stdio MCP server
//! `spaceo-mcp-bridge /absolute/path/to/spaceo` that Claude's agent launches ([`Bridge::run`]).

use crate::credentials::{NativeCredentials, PasswordsFiller};
use crate::fence;
use crate::local_request::WorkspaceSocket;
use crate::pydump::dumps;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const WORKSPACE: &str = "personal-agent-workspace";
pub const INTERNAL_PREFIX: &str = "agent-workspace-internal-";
pub const ALLOWED_TOOLS: [&str; 20] = [
    "spaceo_session_list",
    "spaceo_open_app",
    "spaceo_open_url",
    "spaceo_wait_for",
    "spaceo_find",
    "spaceo_read_text",
    "spaceo_read_screen",
    "spaceo_list_targets",
    "spaceo_attach_target",
    "spaceo_screenshot",
    "spaceo_click",
    "spaceo_scroll",
    "spaceo_select_text",
    "spaceo_move",
    "spaceo_drag",
    "spaceo_type",
    "spaceo_press_key",
    "spaceo_list_windows",
    "spaceo_events",
    "workspace_authenticate_passwords",
];

/// The user permits workspace interaction despite incomplete isolation coverage. A click or key
/// can have irreversible effects: the agent must still avoid sending, submitting, purchasing,
/// publishing, and other irreversible actions.
pub const WORKSPACE_ACTIONS: [&str; 8] = [
    "spaceo_open_app",
    "spaceo_click",
    "spaceo_scroll",
    "spaceo_select_text",
    "spaceo_move",
    "spaceo_drag",
    "spaceo_type",
    "spaceo_press_key",
];

const CAPABILITY_BASE: &str = "Shell: personal-agent profile configured in workspace mode; effective file/OS grants unverified. \
Launcher: separate app instance requested; managed Chromium uses a private profile, \
not the user's signed-in session. Safari/Passwords sharing unverified.";
const ISOLATION_DIMENSIONS: [&str; 6] = [
    "menu_bar_owner",
    "window_server_front_process",
    "key_input_route",
    "text_input_route",
    "cursor_location",
    "active_space",
];

/// Reports what the workspace did: `(kind, text)` with kind "action" or "data"
/// (voice_agent.py's `workspace_activity` event).
pub type Activity = Arc<dyn Fn(&str, &str) + Send + Sync>;

// ------------------------------------------------------------------------------------ time

/// Time as the bridge's waits see it; tests drive their own.
pub trait Clock: Send + Sync {
    /// Seconds on a monotonic clock.
    fn now(&self) -> f64;
    fn sleep(&self, seconds: f64);
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> f64 {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_secs_f64()
    }
    fn sleep(&self, seconds: f64) {
        std::thread::sleep(Duration::from_secs_f64(seconds));
    }
}

/// `datetime.now(timezone.utc).isoformat(timespec="seconds")`.
fn utc_stamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rest) = (seconds.div_euclid(86400), seconds.rem_euclid(86400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}+00:00",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

// ------------------------------------------------------------------------------------ the engine

/// The engine as the bridge talks to it: MCP requests to the `spaceo mcp` process.
pub trait Engine: Send + Sync {
    /// `tools/call`: the MCP result (`{"content": [...], "isError"?}`).
    fn call(&self, name: &str, arguments: &Value) -> Result<Value, String>;
    /// Any other request: the MCP result.
    fn request(&self, method: &str, params: &Value) -> Result<Value, String>;
    /// The engine's command (the first word of its argv).
    fn command(&self) -> String;
}

/// All the text items of a result, joined by spaces (`Bridge.description`).
pub fn description(result: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(items) = result.get("content").and_then(Value::as_array) {
        for item in items.iter().filter(|c| c.is_object()) {
            parts.push(match item.get("text") {
                None => String::new(),
                Some(Value::String(s)) => s.clone(),
                Some(Value::Null) => "None".into(),
                Some(other) => other.to_string(),
            });
        }
    }
    parts.join(" ")
}

fn is_error(result: &Value) -> bool {
    match result.get("isError") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

// ------------------------------------------------------------------------------------ reports

/// A local user preference, not a default for other installations.
pub fn prefer_safari(state: &Path) -> bool {
    std::fs::read_to_string(state.join("browser-preference"))
        .map(|text| text.trim().to_lowercase() == "safari")
        .unwrap_or(false)
}

/// Resolves only a single Passwords window owned by this workspace, from the engine's session
/// listing (`session list --operator --json`), without reading secrets. Returns (pid, window id).
pub fn passwords_target(engine: &str) -> Result<(i64, i64), String> {
    let (code, out, _) =
        crate::recovery::run_command(&[engine, "session", "list", "--operator", "--json"], 5);
    if code != 0 {
        return Err(format!("Command '['{engine}', 'session', 'list', '--operator', '--json']' returned non-zero exit status {code}."));
    }
    passwords_target_in(&serde_json::from_str(&out).map_err(|e| e.to_string())?)
}

/// The checks of [`passwords_target`] on the listing.
pub fn passwords_target_in(listing: &Value) -> Result<(i64, i64), String> {
    if listing.get("ok") != Some(&Value::Bool(true)) {
        return Err("The workspace session could not be inspected.".into());
    }
    let empty = Vec::new();
    let sessions: Vec<&Value> = listing["sessions"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|s| s["id"] == WORKSPACE && s["runtimeAttached"] == Value::Bool(true))
        .collect();
    if sessions.len() != 1 {
        return Err("The workspace session is unavailable or ambiguous.".into());
    }
    let session = sessions[0];
    if session["inputPaused"] != Value::Bool(false) {
        return Err("Workspace input is paused; authentication was not attempted.".into());
    }
    let positive = |v: &Value| v.as_i64().filter(|n| *n > 0);
    let apps: Vec<i64> = session["apps"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|a| a["bundleID"] == "com.apple.Passwords")
        .filter_map(|a| positive(&a["pid"]))
        .collect();
    if apps.len() != 1 {
        return Err("Open one Passwords app in the workspace first.".into());
    }
    let pid = apps[0];
    let windows: Vec<i64> = session["windows"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|w| w["pid"].as_i64() == Some(pid) && w["onStage"] == Value::Bool(true))
        .filter_map(|w| positive(&w["windowID"]))
        .collect();
    if windows.len() != 1 {
        return Err("The workspace Passwords window is unavailable or ambiguous.".into());
    }
    Ok((pid, windows[0]))
}

/// Summarizes only recognized verification evidence; never infers missing checks.
pub fn capability_report(result: Option<&Value>) -> String {
    let Some(result) =
        result.filter(|r| r.as_object().map(|o| !o.is_empty()).unwrap_or(false) && !is_error(r))
    else {
        return format!("{CAPABILITY_BASE} Isolation: unverified (no successful current audit).");
    };
    let text = description(result);
    let verdict = Regex::new(r"(?i)\bisolation:\s*(intact|partial|breached)\b")
        .unwrap()
        .captures(&text)
        .map(|c| c[1].to_lowercase())
        .unwrap_or_else(|| "unverified".into());
    let rows: Vec<String> = ISOLATION_DIMENSIONS
        .iter()
        .map(|dimension| {
            let pattern = format!(r"(?im)^\s*-\s*{dimension}:\s*(passed|failed|unknown)\s*\[(observed|inferred|unknown)\]");
            let found = Regex::new(&pattern).unwrap().captures(&text);
            format!(
                "{dimension}={}",
                found
                    .map(|c| format!("{}/{}", c[1].to_lowercase(), c[2].to_lowercase()))
                    .unwrap_or_else(|| "unreported".into())
            )
        })
        .collect();
    format!(
        "{CAPABILITY_BASE} Latest isolation audit: {verdict}; {}. Missing or inferred evidence is not proof.",
        rows.join(", ")
    )
}

#[derive(Clone)]
struct Observation {
    display: String,
    input_state: &'static str,
    reason: &'static str,
    observed_at: String,
    monotonic: f64,
}

struct Observed {
    display: Option<String>,
    isolation: Option<(String, String)>,
    errors: Vec<(String, String)>,
    session: Option<Observation>,
    refresh: &'static str,
}

/// Only allowlisted metadata; never persists tool output, arguments, or exception text.
pub struct EnvironmentObservations {
    clock: Arc<dyn Clock>,
    inner: Mutex<Observed>,
}

impl Default for EnvironmentObservations {
    fn default() -> Self {
        EnvironmentObservations::new(Arc::new(SystemClock))
    }
}

/// Splits a session listing into blocks: a block starts at a non-indented session header.
fn session_blocks(text: &str) -> Vec<&str> {
    let header = Regex::new(r"^(\[yours\] )?session '").unwrap();
    let mut starts = vec![0];
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if offset > 0 && header.is_match(line) {
            starts.push(offset);
        }
        offset += line.len();
    }
    starts.push(text.len());
    starts.windows(2).map(|w| &text[w[0]..w[1]]).collect()
}

impl EnvironmentObservations {
    pub fn new(clock: Arc<dyn Clock>) -> EnvironmentObservations {
        EnvironmentObservations {
            clock,
            inner: Mutex::new(Observed {
                display: None,
                isolation: None,
                errors: Vec::new(),
                session: None,
                refresh: "not attempted",
            }),
        }
    }

    pub fn display_seen(&self, display: &str) {
        self.inner.lock().unwrap().display = Some(display.to_string())
            .filter(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()));
    }

    /// Reads only our owned session listing; retains strictly bounded metadata.
    pub fn refresh_session(&self, call: &dyn Fn(&str, &Value) -> Result<Value, String>) {
        let outcome = (|| -> Result<Observation, ()> {
            let result = call("spaceo_session_list", &json!({})).map_err(|_| ())?;
            if !result.is_object() || is_error(&result) {
                return Err(());
            }
            let text = description(&result);
            let own = Regex::new(&format!(
                r"^\[yours\] session '{}' on whole display (\d+)[,\n]",
                regex::escape(WORKSPACE)
            ))
            .unwrap();
            let matches: Vec<(&str, String)> = session_blocks(&text)
                .into_iter()
                .filter_map(|b| own.captures(b).map(|c| (b, c[1].to_string())))
                .collect();
            if matches.len() != 1 {
                return Err(());
            }
            let (block, display) = &matches[0];
            let lines: Vec<&str> = Regex::new(r"(?m)^  input: ([^\n]*)$")
                .unwrap()
                .captures_iter(block)
                .map(|c| c.get(1).unwrap().as_str())
                .collect();
            if lines.len() > 1 {
                return Err(());
            }
            let (mut state, mut reason) = ("unknown", "not reported");
            if let Some(line) = lines.first() {
                if Regex::new(r"^PAUSED(?: \([^\n]*\))?$")
                    .unwrap()
                    .is_match(line)
                {
                    state = "paused";
                    if *line == "PAUSED (operator has Control)" {
                        reason = "operator control reported by workspace; cause not established";
                    } else if line.starts_with("PAUSED (agent: ") {
                        reason = "agent reason reported; free text withheld for privacy";
                    }
                } else if *line == "UNPAUSED" || *line == "ACTIVE" {
                    state = "unpaused";
                } else {
                    return Err(());
                }
            }
            Ok(Observation {
                display: display.clone(),
                input_state: state,
                reason,
                observed_at: utc_stamp(),
                monotonic: self.clock.now(),
            })
        })();
        let mut inner = self.inner.lock().unwrap();
        match outcome {
            Ok(observation) => {
                inner.session = Some(observation);
                inner.refresh = "observed";
            }
            Err(()) => inner.refresh = "failed or malformed; last observation is stale",
        }
    }

    pub fn record(&self, name: &str, result: Option<&Value>, failed: bool) {
        let stamp = utc_stamp();
        let mut inner = self.inner.lock().unwrap();
        let failure = result.map(is_error).unwrap_or(false);
        if name == "spaceo_verify_isolation" {
            inner.isolation = match result {
                Some(r)
                    if r.as_object().map(|o| !o.is_empty()).unwrap_or(false) && !is_error(r) =>
                {
                    Some((stamp.clone(), capability_report(Some(r))))
                }
                _ => None,
            };
        }
        if failed || failure {
            let tool = if ALLOWED_TOOLS.contains(&name) {
                name
            } else {
                "workspace request"
            };
            inner.errors.push((tool.to_string(), stamp));
            let extra = inner.errors.len().saturating_sub(5);
            inner.errors.drain(..extra);
        }
    }

    pub fn report(&self) -> Value {
        let (display, audit, errors, current, refresh) = {
            let inner = self.inner.lock().unwrap();
            (
                inner.display.clone(),
                inner.isolation.clone(),
                inner.errors.clone(),
                inner.session.clone(),
                inner.refresh,
            )
        };
        let fresh = current
            .as_ref()
            .map(|c| refresh == "observed" && self.clock.now() - c.monotonic <= 30.0)
            .unwrap_or(false);
        let status = if fresh {
            "observed"
        } else if current.is_some() {
            "stale"
        } else {
            "unavailable"
        };
        let current_view = json!({
            "status": status,
            "display": current.as_ref().map(|c| c.display.clone()),
            "input_state": current.as_ref().map(|c| c.input_state).unwrap_or("unknown"),
            "reason": current.as_ref().map(|c| c.reason).unwrap_or("not reported"),
            "observed_at": current.as_ref().map(|c| c.observed_at.clone()),
            "refresh": refresh,
        });
        let holds = if fresh
            && current
                .as_ref()
                .unwrap()
                .reason
                .starts_with("operator control reported")
        {
            "reported by workspace; cause not established"
        } else {
            "unknown; follow any live pause/control response"
        };
        let mut allowed: Vec<&str> = ALLOWED_TOOLS.to_vec();
        allowed.sort_unstable();
        json!({
            "workspace": {
                "configured_session": WORKSPACE,
                "observed_display_at_last_bootstrap": display.unwrap_or_else(|| "unknown".into()),
                "current_session_and_display": current_view,
                "user_holds_control": holds,
            },
            "model_permissions": {
                "configured_when_spaceo_enabled": "personal-agent extends workspace; writable memory, captures and update-handoff roots and workspace socket; network proxy enabled, registry.npmjs.org allowed",
                "effective_file_network_and_os_permissions": "unknown; runtime and OS restrictions may further limit access",
            },
            "browser": "Managed Chromium launcher configures a separate private profile; exact app/session sharing and Safari/Passwords are unverified.",
            "isolation": {
                "last_audit": audit.as_ref().map(|a| a.1.clone()).unwrap_or_else(|| "unknown; no successful cached audit".into()),
                "observed_at": audit.as_ref().map(|a| a.0.clone()),
                "keyboard_text_routes": "unknown unless explicitly reported in the audit; inferred or stale evidence is not proof",
            },
            "supported_workspace_tools_allowlist": allowed,
            "recent_failures": errors.iter().map(|(tool, at)| json!({"tool": tool, "at": at})).collect::<Vec<_>>(),
            "failure_details": "Only tool names and times retained; inspect the immediate tool response for details.",
        })
    }
}

// ------------------------------------------------------------------------------------ requests

/// Serves `workspace.sock`'s requests (python `WorkspaceRequests._handle`): the status report,
/// the tool list, and calls to the allowlisted tools of the one workspace session. Use the existing
/// MCP owner's lease; never create a competing workspace.
pub struct WorkspaceHandler {
    pub engine: Arc<dyn Engine>,
    pub observations: Arc<EnvironmentObservations>,
    pub on_activity: Option<Activity>,
    pub state: PathBuf,
    pub clock: Arc<dyn Clock>,
    pub passwords: Arc<dyn PasswordsFiller>,
    /// Finds the workspace's one Passwords window from the engine command; replaceable for tests.
    pub target: Arc<dyn Fn(&str) -> Result<(i64, i64), String> + Send + Sync>,
}

impl WorkspaceHandler {
    pub fn new(
        engine: Arc<dyn Engine>,
        state: &Path,
        on_activity: Option<Activity>,
    ) -> WorkspaceHandler {
        WorkspaceHandler {
            engine,
            observations: Arc::new(EnvironmentObservations::default()),
            on_activity,
            state: state.to_path_buf(),
            clock: Arc::new(SystemClock),
            passwords: Arc::new(NativeCredentials),
            target: Arc::new(passwords_target),
        }
    }

    fn activity(&self, kind: &str, text: &str) {
        if let Some(on_activity) = &self.on_activity {
            on_activity(kind, text);
        }
    }

    /// Only the daemon's preflight receipt proves this request was not dispatched. Do not retry
    /// timeouts, generic health errors, or post-dispatch failures.
    pub fn call_with_transient_health_retry(
        &self,
        name: &str,
        arguments: &Value,
    ) -> Result<Value, String> {
        let retryable = Regex::new(
            r"^\[display_creation_failed\] could not create the agent display: pre_dispatch_transient_host_health: host health refused: (?:memory_pressure|swap_activity); ",
        )
        .unwrap();
        let deadline = self.clock.now() + 30.0;
        loop {
            let result = self.engine.call(name, arguments)?;
            let again = is_error(&result) && retryable.is_match(&description(&result));
            if !again || self.clock.now() >= deadline {
                return Ok(result);
            }
            self.activity(
                "data",
                "Workspace resources are recovering; waiting to retry the rejected action.",
            );
            self.clock.sleep(1.0);
        }
    }

    /// One request object to its reply: `{"ok": true, "result": ...}` or `{"ok": false, "error": ...}`.
    pub fn handle(&self, value: &Value) -> Value {
        match self.dispatch(value) {
            Ok(result) => json!({"ok": true, "result": result}),
            Err(error) => {
                let name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("workspace request");
                self.observations.record(name, None, true);
                json!({"ok": false, "error": error})
            }
        }
    }

    fn dispatch(&self, value: &Value) -> Result<Value, String> {
        let engine = self.engine.clone();
        let call = move |name: &str, arguments: &Value| engine.call(name, arguments);
        match value.get("method").and_then(Value::as_str) {
            Some("status") => {
                self.observations.refresh_session(&call);
                let result = json!({"content": [{"type": "text", "text": dumps(&self.observations.report(), true)}]});
                if self.on_activity.is_some() {
                    let report = self.observations.report();
                    let current = &report["workspace"]["current_session_and_display"];
                    self.activity(
                        "data",
                        &format!(
                            "Workspace: {}; display {}; input {}; {}. Keyboard isolation and Safari sharing unverified.",
                            current["status"].as_str().unwrap_or(""),
                            current["display"].as_str().unwrap_or("unknown"),
                            current["input_state"].as_str().unwrap_or(""),
                            current["reason"].as_str().unwrap_or("")
                        ),
                    );
                }
                Ok(result)
            }
            Some("list") => {
                let mut result = self.engine.request("tools/list", &json!({}))?;
                let safari = prefer_safari(&self.state);
                let mut tools: Vec<Value> = result
                    .get("tools")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|t| {
                        let name = t.get("name").and_then(Value::as_str).unwrap_or("");
                        ALLOWED_TOOLS.contains(&name) && !(safari && name == "spaceo_open_url")
                    })
                    .collect();
                tools.push(json!({
                    "name": "workspace_authenticate_passwords",
                    "description": "Unlock the workspace Passwords app using the locally saved Mac credential, without exposing it. Takes no arguments.",
                    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
                }));
                result["tools"] = Value::Array(tools);
                Ok(result)
            }
            _ => self.tool_call(value),
        }
    }

    fn tool_call(&self, value: &Value) -> Result<Value, String> {
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| ALLOWED_TOOLS.contains(n));
        let arguments = match value.get("arguments") {
            None => Some(Map::new()),
            Some(Value::Object(map)) => Some(map.clone()),
            _ => None,
        };
        let (Some(name), Some(mut arguments)) = (name, arguments) else {
            return Err("tool is not available".into());
        };
        if name == "workspace_authenticate_passwords" {
            if !arguments.is_empty() {
                return Err("Authentication takes no arguments.".into());
            }
            let (pid, window_id) = (self.target)(&self.engine.command())?;
            self.activity("action", "Unlocking workspace Passwords");
            let message = self.passwords.fill_workspace_passwords(pid, window_id)?;
            return Ok(json!({"content": [{"type": "text", "text": message}]}));
        }
        let safari = prefer_safari(&self.state);
        if safari
            && (name == "spaceo_open_url"
                || (name == "spaceo_open_app"
                    && dumps(&Value::Object(arguments.clone()), true)
                        .to_lowercase()
                        .contains("chrome")))
        {
            return Err(
                "Chrome is disabled by user preference; use Safari if workspace isolation permits"
                    .into(),
            );
        }
        if WORKSPACE_ACTIONS.contains(&name) {
            arguments.remove("strict");
            arguments.remove("require_isolation");
        }
        if arguments
            .get("session")
            .map(|s| s != WORKSPACE)
            .unwrap_or(false)
        {
            return Err("only the personal-agent workspace is available".into());
        }
        if name != "spaceo_session_list" {
            arguments.insert("session".into(), json!(WORKSPACE));
        }
        self.activity("action", &format!("Virtual workspace: {name}"));
        let result = self.call_with_transient_health_retry(name, &Value::Object(arguments))?;
        self.observations.record(name, Some(&result), false);
        if self.on_activity.is_some() {
            let text = description(&result);
            let detail = if name == "spaceo_verify_isolation" {
                capability_report(Some(&result))
            } else if ["spaceo_read_text", "spaceo_read_screen", "spaceo_find"].contains(&name) {
                if text.chars().count() > 1600 {
                    format!("{}…", text.chars().take(1600).collect::<String>())
                } else {
                    text
                }
            } else if is_error(&result) {
                "Failed".into()
            } else {
                "Completed".into()
            };
            let detail = if detail.is_empty() {
                "No text returned".to_string()
            } else {
                detail
            };
            self.activity("data", &format!("{name}: {detail}"));
        }
        Ok(result)
    }
}

// ------------------------------------------------------------------------------------ bootstrap

/// Claims the existing workspace, creating one only when the daemon explicitly says it does not
/// exist and the user has permitted it (`fence`). `publish` runs once the workspace is ours.
pub fn bootstrap(
    engine: &dyn Engine,
    state: &Path,
    clock: &dyn Clock,
    publish: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    if fence::policy(state) == "closed" {
        return Err(
            "Workspace was explicitly closed; an explicit user request is required to reopen it"
                .into(),
        );
    }
    let mut saw_existing = false;
    let deadline = clock.now() + 5.0;
    // The daemon fences records from its predecessor while its recovery janitor runs. Wait for an
    // explicit unknown-session response before creating a replacement.
    let detached_deadline = clock.now() + 45.0;
    let mut saw_detached = false;
    let mut text;
    loop {
        let claim = engine.call("spaceo_session_claim", &json!({"session": WORKSPACE}))?;
        if !is_error(&claim) {
            fence::settle_existing(state)?;
            return publish();
        }
        text = description(&claim);
        // Older daemons reported this particular detached claim as bad_request. Match the session
        // and complete fixed prefix, not arbitrary bad requests.
        let legacy = format!(
            "[bad_request] session '{WORKSPACE}' belongs to a previous daemon and is detached: "
        );
        if text.starts_with("[session_detached] ") || text.starts_with(&legacy) {
            saw_detached = true;
            if clock.now() < detached_deadline {
                clock.sleep(0.25);
                continue;
            }
            return Err(format!("Detached workspace cleanup did not finish: {text}"));
        }
        if saw_detached && text.contains("[unknown_session]") {
            break;
        }
        if !text.contains("only an abandoned session") || clock.now() >= deadline {
            break;
        }
        saw_existing = true;
        clock.sleep(0.25); // the old MCP process can take a moment to exit on restart
    }
    if saw_existing {
        return Err(format!("Existing workspace could not be recovered: {text}"));
    }
    if !text.contains("[unknown_session]") {
        return Err(format!("Could not recover the workspace: {text}"));
    }
    let created = fence::create_once(state, || {
        engine.call(
            "spaceo_session_create",
            &json!({"name": WORKSPACE, "title": "Agent workspace", "preset": "exclusive",
                    "orphan_grace_seconds": 1800, "ttl_seconds": 3600}),
        )
    })??;
    if is_error(&created) {
        return Err(format!(
            "Could not create the workspace: {}",
            description(&created)
        ));
    }
    publish()
}

/// Writes `workspace-status.json` for the app's menu (python `Bridge.status`).
pub fn write_status(state: &Path, status: &str, message: &str) -> Result<(), String> {
    let text = dumps(&json!({"state": status, "message": message}), true) + "\n";
    hive_common::atomic_write(&state.join("workspace-status.json"), text.as_bytes())
        .map_err(|e| e.to_string())
}

/// Records the workspace's display id for the viewer (`workspace-display-id`) and reports ready.
pub fn publish_display(
    engine: &dyn Engine,
    state: &Path,
    observations: &EnvironmentObservations,
) -> Result<(), String> {
    let listing = engine.call("spaceo_session_list", &json!({}))?;
    if is_error(&listing) {
        return Err(format!(
            "Could not find the workspace display: {}",
            description(&listing)
        ));
    }
    let pattern = format!(
        r"\[yours\]\s+session\s+'{}'\s+on\s+whole\s+display\s+(\d+)",
        regex::escape(WORKSPACE)
    );
    let text = description(&listing);
    let Some(found) = Regex::new(&pattern).unwrap().captures(&text) else {
        return Err("The exclusive workspace display could not be identified".into());
    };
    observations.display_seen(&found[1]);
    hive_common::atomic_write(
        &state.join("workspace-display-id"),
        format!("{}\n", &found[1]).as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    write_status(state, "ready", "Virtual workspace ready")
}

// ------------------------------------------------------------------------------------ the process

/// The `spaceo mcp` process and the MCP conversation with it.
pub struct Bridge {
    command: String,
    state: PathBuf,
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, Sender<Value>>>>,
    serial: AtomicU64,
    embedded: Arc<AtomicBool>,
    bootstrapped: AtomicBool,
    failure: Mutex<Option<String>>,
    on_activity: Option<Activity>,
    pub observations: Arc<EnvironmentObservations>,
    pub passwords: Arc<dyn PasswordsFiller>,
    endpoint: Mutex<Option<WorkspaceSocket>>,
    clock: Arc<dyn Clock>,
}

impl Bridge {
    /// Starts `<command> mcp`; the state folder is `AGENT_STATE_DIR`.
    pub fn spawn(command: &str, on_activity: Option<Activity>) -> Result<Arc<Bridge>, String> {
        Bridge::spawn_in(command, &hive_common::state_dir(), on_activity)
    }

    pub fn spawn_in(
        command: &str,
        state: &Path,
        on_activity: Option<Activity>,
    ) -> Result<Arc<Bridge>, String> {
        let mut child = Command::new(command)
            .arg("mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let pending: Arc<Mutex<HashMap<String, Sender<Value>>>> = Arc::default();
        let embedded = Arc::new(AtomicBool::new(false));
        let bridge = Arc::new(Bridge {
            command: command.to_string(),
            state: state.to_path_buf(),
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: pending.clone(),
            serial: AtomicU64::new(0),
            embedded: embedded.clone(),
            bootstrapped: AtomicBool::new(false),
            failure: Mutex::new(None),
            on_activity,
            observations: Arc::new(EnvironmentObservations::default()),
            passwords: Arc::new(NativeCredentials),
            endpoint: Mutex::new(None),
            clock: Arc::new(SystemClock),
        });
        bridge.status("starting", "Starting the virtual workspace")?;
        std::thread::Builder::new()
            .name("spaceo-bridge-reader".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let Ok(data) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    let id = data.get("id").and_then(Value::as_str).map(str::to_owned);
                    let waiting = id
                        .as_ref()
                        .and_then(|id| pending.lock().unwrap().get(id).cloned());
                    if let Some(waiting) = waiting {
                        let _ = waiting.send(data);
                    } else if !embedded.load(Ordering::Relaxed)
                        && !id.map(|i| i.starts_with(INTERNAL_PREFIX)).unwrap_or(false)
                    {
                        let mut out = std::io::stdout().lock();
                        let _ = writeln!(out, "{line}");
                        let _ = out.flush();
                    }
                }
                // The engine is gone: wake everyone still waiting for an answer.
                pending.lock().unwrap().clear();
            })
            .map_err(|e| e.to_string())?;
        Ok(bridge)
    }

    fn status(&self, state: &str, message: &str) -> Result<(), String> {
        write_status(&self.state, state, message)
    }

    fn write(&self, value: &Value) -> Result<(), String> {
        let mut guard = self.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or("the workspace engine is closed")?;
        stdin
            .write_all((dumps(value, false) + "\n").as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| e.to_string())
    }

    /// Holds the single workspace lease for the personal-agent process itself and serves
    /// `workspace.sock`.
    pub fn start_embedded(self: &Arc<Self>) -> Result<(), String> {
        self.embedded.store(true, Ordering::Relaxed);
        self.request(
            "initialize",
            &json!({"protocolVersion": "2025-03-26", "capabilities": {},
                    "clientInfo": {"name": "personal-agent", "version": "1"}}),
        )?;
        self.write(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))?;
        self.bootstrap()?;
        self.start_endpoint(self.on_activity.clone())?;
        if let Some(on_activity) = &self.on_activity {
            on_activity("data", &capability_report(None));
        }
        Ok(())
    }

    fn start_endpoint(self: &Arc<Self>, on_activity: Option<Activity>) -> Result<(), String> {
        let handler = Arc::new(WorkspaceHandler {
            engine: self.clone(),
            observations: self.observations.clone(),
            on_activity,
            state: self.state.clone(),
            clock: self.clock.clone(),
            passwords: self.passwords.clone(),
            target: Arc::new(passwords_target),
        });
        let socket = WorkspaceSocket::start(
            &self.state.join("control"),
            Arc::new(move |request| handler.handle(&request)),
        )?;
        *self.endpoint.lock().unwrap() = Some(socket);
        Ok(())
    }

    fn bootstrap(&self) -> Result<(), String> {
        self.bootstrapped.store(true, Ordering::Relaxed);
        let mut publish = || publish_display(self, &self.state, &self.observations);
        bootstrap(self, &self.state, self.clock.as_ref(), &mut publish)
    }

    /// Stops serving `workspace.sock` and the engine process.
    pub fn close(&self) {
        if let Some(endpoint) = self.endpoint.lock().unwrap().take() {
            endpoint.close();
        }
        let stdin = self.stdin.lock().unwrap().take();
        drop(stdin);
        let mut child = self.child.lock().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
    }

    /// The stdio MCP server: forwards this process's stdin to the engine and its replies to stdout,
    /// bootstrapping the workspace when the client says it is initialized.
    pub fn run(self: &Arc<Self>) {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let failure = self.failure.lock().unwrap().clone();
            if let (Some(failure), Some("tools/call"), Some(id)) = (
                failure,
                value.get("method").and_then(Value::as_str),
                value.get("id"),
            ) {
                let reply = json!({"jsonrpc": "2.0", "id": id, "result": {"isError": true, "content": [{"type": "text",
                    "text": format!("Agent workspace is unavailable: {failure}")}]}});
                let mut out = std::io::stdout().lock();
                let _ = writeln!(out, "{}", dumps(&reply, true));
                let _ = out.flush();
                continue;
            }
            let _ = self.write(&value);
            if value.get("method").and_then(Value::as_str) == Some("notifications/initialized")
                && !self.bootstrapped.load(Ordering::Relaxed)
            {
                let started = self.bootstrap().and_then(|_| self.start_endpoint(None));
                if let Err(error) = started {
                    let _ = self.status("error", &error);
                    *self.failure.lock().unwrap() = Some(error.clone());
                    eprintln!("Agent workspace unavailable: {error}");
                }
            }
        }
        self.close();
    }
}

impl Engine for Bridge {
    fn call(&self, name: &str, arguments: &Value) -> Result<Value, String> {
        self.request("tools/call", &json!({"name": name, "arguments": arguments}))
    }

    fn request(&self, method: &str, params: &Value) -> Result<Value, String> {
        let key = format!(
            "{INTERNAL_PREFIX}{}",
            self.serial.fetch_add(1, Ordering::Relaxed) + 1
        );
        let (sender, answer) = mpsc::channel();
        self.pending.lock().unwrap().insert(key.clone(), sender);
        let outcome = (|| {
            self.write(&json!({"jsonrpc": "2.0", "id": key, "method": method, "params": params}))?;
            let Ok(item) = answer.recv_timeout(Duration::from_secs(45)) else {
                return Err(format!("{method} did not answer"));
            };
            if item.get("error").is_some()
                || !item.get("result").map(Value::is_object).unwrap_or(false)
            {
                return Err(format!("{method} failed at the MCP protocol layer"));
            }
            Ok(item["result"].clone())
        })();
        self.pending.lock().unwrap().remove(&key);
        outcome
    }

    fn command(&self) -> String {
        self.command.clone()
    }
}

/// The `spaceo-mcp-bridge /absolute/path/to/spaceo` command line.
pub fn main(args: &[String]) -> i32 {
    let [command] = args else {
        eprintln!("Usage: spaceo-mcp-bridge /absolute/path/to/spaceo");
        return 1;
    };
    if !Path::new(command).is_absolute() {
        eprintln!("Usage: spaceo-mcp-bridge /absolute/path/to/spaceo");
        return 1;
    }
    match Bridge::spawn(command, None) {
        Ok(bridge) => {
            bridge.run();
            0
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}
