//! The SpaceO bridge: the workspace request handler, capability and environment reports, the
//! bootstrap decisions and the MCP handshake. A scripted engine stands in for SpaceO; no display,
//! daemon or real session is touched.

use hive_workspace::bridge::*;
use hive_workspace::credentials::PasswordsFiller;
use hive_workspace::fence;
use hive_workspace::local_request::WorkspaceSocket;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ------------------------------------------------------------------------------------ doubles

type Computed = Box<dyn Fn(&str, &Value) -> Result<Value, String> + Send + Sync>;

#[derive(Default)]
struct ScriptedEngine {
    script: Mutex<VecDeque<Result<Value, String>>>,
    fallback: Mutex<Option<Value>>,
    computed: Mutex<Option<Computed>>,
    calls: Mutex<Vec<(String, Value)>>,
}

impl ScriptedEngine {
    fn new(script: Vec<Result<Value, String>>) -> Arc<ScriptedEngine> {
        let engine = ScriptedEngine::default();
        *engine.script.lock().unwrap() = script.into();
        *engine.fallback.lock().unwrap() =
            Some(json!({"content": [{"type": "text", "text": "ready"}]}));
        Arc::new(engine)
    }
    fn names(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.0.clone())
            .collect()
    }
    fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

impl Engine for ScriptedEngine {
    fn call(&self, name: &str, arguments: &Value) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push((name.to_string(), arguments.clone()));
        if let Some(computed) = self.computed.lock().unwrap().as_ref() {
            return computed(name, arguments);
        }
        match self.script.lock().unwrap().pop_front() {
            Some(next) => next,
            None => Ok(self.fallback.lock().unwrap().clone().unwrap()),
        }
    }
    fn request(&self, _method: &str, _params: &Value) -> Result<Value, String> {
        Ok(json!({"tools": [{"name": "spaceo_session_list"}, {"name": "spaceo_session_destroy"}]}))
    }
    fn command(&self) -> String {
        "/agent/spaceo".into()
    }
}

/// Time that moves only when the test or a `sleep` moves it; `script` overrides the next reads.
struct FakeClock {
    now: Mutex<f64>,
    script: Mutex<VecDeque<f64>>,
}

impl FakeClock {
    fn new() -> Arc<FakeClock> {
        Arc::new(FakeClock {
            now: Mutex::new(0.0),
            script: Mutex::default(),
        })
    }
    fn scripted(values: &[f64]) -> Arc<FakeClock> {
        let clock = FakeClock::new();
        *clock.script.lock().unwrap() = values.iter().copied().collect();
        clock
    }
    fn set(&self, value: f64) {
        *self.now.lock().unwrap() = value;
    }
}

impl Clock for FakeClock {
    fn now(&self) -> f64 {
        if let Some(next) = self.script.lock().unwrap().pop_front() {
            *self.now.lock().unwrap() = next;
        }
        *self.now.lock().unwrap()
    }
    fn sleep(&self, seconds: f64) {
        *self.now.lock().unwrap() += seconds;
    }
}

fn text(t: &str) -> Value {
    json!({"content": [{"type": "text", "text": t}]})
}
fn failure(t: &str) -> Result<Value, String> {
    Ok(json!({"isError": true, "content": [{"text": t}]}))
}
fn ok(t: &str) -> Result<Value, String> {
    Ok(text(t))
}

struct Harness {
    state: tempfile::TempDir,
    engine: Arc<ScriptedEngine>,
    handler: WorkspaceHandler,
}

fn harness() -> Harness {
    let state = tempfile::tempdir().unwrap();
    let engine = ScriptedEngine::new(vec![]);
    let mut handler = WorkspaceHandler::new(engine.clone(), state.path(), None);
    handler.clock = FakeClock::new();
    Harness {
        state,
        engine,
        handler,
    }
}

type Events = Arc<Mutex<Vec<(String, String)>>>;

fn capture(handler: &mut WorkspaceHandler) -> Events {
    let events: Events = Arc::default();
    let sink = events.clone();
    handler.on_activity = Some(Arc::new(move |kind, text| {
        sink.lock().unwrap().push((kind.into(), text.into()))
    }));
    events
}

const REFUSED: &str = "[display_creation_failed] could not create the agent display: pre_dispatch_transient_host_health: host health refused: memory_pressure; inspect";

// ------------------------------------------------------------------------------------ handler

#[test]
fn retry_only_explicit_pre_dispatch_transient_health_receipt() {
    let h = harness();
    *h.engine.script.lock().unwrap() = vec![failure(REFUSED), ok("done")].into();
    let result = h
        .handler
        .call_with_transient_health_retry("spaceo_click", &json!({}))
        .unwrap();
    assert_eq!(result, text("done"));
    assert_eq!(h.engine.count(), 2);
}

#[test]
fn no_retry_for_ambiguous_or_post_dispatch_failure() {
    for body in [
        "[display_creation_failed] host health refused: memory_pressure; inspect",
        "[display_creation_failed] could not create the agent display: host health refused: swap_activity; inspect",
        "[other] pre_dispatch_transient_host_health: host health refused: memory_pressure; inspect",
    ] {
        let h = harness();
        *h.engine.script.lock().unwrap() = vec![failure(body)].into();
        let result = h.handler.call_with_transient_health_retry("spaceo_click", &json!({})).unwrap();
        assert_eq!(result["isError"], true);
        assert_eq!(h.engine.count(), 1, "{body}");
    }
}

#[test]
fn transient_health_retry_is_bounded() {
    let mut h = harness();
    h.handler.clock = FakeClock::scripted(&[0.0, 31.0]);
    *h.engine.script.lock().unwrap() = vec![failure(REFUSED)].into();
    let result = h
        .handler
        .call_with_transient_health_retry("spaceo_click", &json!({}))
        .unwrap();
    assert_eq!(result["isError"], true);
    assert_eq!(h.engine.count(), 1);
}

#[test]
fn list_only_exposes_workspace_tools() {
    let h = harness();
    let reply = h.handler.handle(&json!({"method": "list"}));
    let names: Vec<&str> = reply["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["spaceo_session_list", "workspace_authenticate_passwords"]
    );
}

#[test]
fn calls_use_existing_workspace() {
    let h = harness();
    let reply = h
        .handler
        .handle(&json!({"name": "spaceo_open_app", "arguments": {"app": "Calculator"}}));
    assert_eq!(reply["ok"], true);
    let calls = h.engine.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0],
        (
            "spaceo_open_app".to_string(),
            json!({"app": "Calculator", "session": "personal-agent-workspace"})
        )
    );
}

#[test]
fn reversible_workspace_access_does_not_require_proven_isolation() {
    let h = harness();
    let reply = h
        .handler
        .handle(&json!({"name": "spaceo_open_app", "arguments": {
        "app": "Safari", "strict": true, "require_isolation": ["key_input_route"]}}));
    assert_eq!(reply["ok"], true);
    assert_eq!(
        h.engine.calls.lock().unwrap()[0].1,
        json!({"app": "Safari", "session": "personal-agent-workspace"})
    );
}

#[test]
fn chrome_launch_is_still_disabled_by_safari_preference() {
    let h = harness();
    std::fs::write(h.state.path().join("browser-preference"), "Safari\n").unwrap();
    assert_eq!(
        h.handler
            .handle(&json!({"name": "spaceo_open_app", "arguments": {"app": "Google Chrome"}}))
            ["ok"],
        false
    );
    assert_eq!(
        h.handler
            .handle(&json!({"name": "spaceo_open_url", "arguments": {"url": "https://x"}}))["ok"],
        false
    );
    assert_eq!(h.engine.count(), 0);
    // The URL tool is also withheld from the list.
    let listed = h.handler.handle(&json!({"method": "list"}));
    assert!(listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["name"] != "spaceo_open_url"));
}

#[test]
fn browser_default_is_not_hardcoded_to_safari() {
    let h = harness();
    assert!(!prefer_safari(h.state.path()));
    assert_eq!(
        h.handler
            .handle(&json!({"name": "spaceo_open_app", "arguments": {"app": "Google Chrome"}}))
            ["ok"],
        true
    );
}

#[test]
fn refuses_foreign_session_and_destructive_tools() {
    let h = harness();
    assert_eq!(
        h.handler
            .handle(&json!({"name": "spaceo_read_screen", "arguments": {"session": "other"}}))
            ["ok"],
        false
    );
    assert_eq!(
        h.handler
            .handle(&json!({"name": "spaceo_session_destroy", "arguments": {}}))["ok"],
        false
    );
    assert_eq!(h.engine.count(), 0);
}

#[test]
fn adoption_and_placement_are_rejected_before_engine_call() {
    let h = harness();
    for name in [
        "spaceo_adopt",
        "spaceo_place",
        "spaceo_session_adopt",
        "spaceo_window_place",
    ] {
        let reply = h
            .handler
            .handle(&json!({"name": name, "arguments": {"pid": 123, "window": 456}}));
        assert_eq!(reply["ok"], false, "{name}");
    }
    assert_eq!(h.engine.count(), 0);
}

struct RecordingPasswords(Mutex<Vec<(i64, i64)>>);

impl PasswordsFiller for RecordingPasswords {
    fn fill_workspace_passwords(&self, pid: i64, window_id: i64) -> Result<String, String> {
        self.0.lock().unwrap().push((pid, window_id));
        Ok("Authentication submitted".into())
    }
}

#[test]
fn workspace_auth_uses_verified_target_without_secret_arguments() {
    let mut h = harness();
    let filler = Arc::new(RecordingPasswords(Mutex::default()));
    h.handler.passwords = filler.clone();
    h.handler.target = Arc::new(|command| {
        assert_eq!(command, "/agent/spaceo");
        Ok((123, 456))
    });
    let reply = h
        .handler
        .handle(&json!({"name": "workspace_authenticate_passwords", "arguments": {}}));
    assert_eq!(reply["ok"], true);
    assert_eq!(*filler.0.lock().unwrap(), vec![(123, 456)]);
    assert!(!reply.to_string().contains("credential-value"));
    // It takes no arguments and never reaches the engine.
    assert_eq!(
        h.handler
            .handle(&json!({"name": "workspace_authenticate_passwords", "arguments": {"x": 1}}))
            ["ok"],
        false
    );
    assert_eq!(h.engine.count(), 0);
}

#[test]
fn passwords_target_requires_one_owned_unpaused_window() {
    let mut session = json!({"id": "personal-agent-workspace", "runtimeAttached": true, "inputPaused": false,
        "apps": [{"bundleID": "com.apple.Passwords", "pid": 123}],
        "windows": [{"pid": 123, "windowID": 456, "onStage": true}]});
    assert_eq!(
        passwords_target_in(&json!({"ok": true, "sessions": [session.clone()]})),
        Ok((123, 456))
    );
    session["inputPaused"] = json!(true);
    let error =
        passwords_target_in(&json!({"ok": true, "sessions": [session.clone()]})).unwrap_err();
    assert!(error.contains("paused"));
    session["inputPaused"] = json!(false);
    session["windows"] = json!([]);
    assert!(passwords_target_in(&json!({"ok": true, "sessions": [session.clone()]})).is_err());
    assert!(passwords_target_in(&json!({"ok": true, "sessions": []})).is_err());
    assert!(passwords_target_in(&json!({"ok": false})).is_err());
}

#[test]
fn activity_reports_tool_and_loaded_text_without_input_arguments() {
    let mut h = harness();
    let events = capture(&mut h.handler);
    *h.engine.fallback.lock().unwrap() = Some(text("Page content"));
    h.handler
        .handle(&json!({"name": "spaceo_read_text", "arguments": {"secret": "do-not-display"}}));
    let events = events.lock().unwrap();
    assert_eq!(
        *events,
        vec![
            (
                "action".to_string(),
                "Virtual workspace: spaceo_read_text".to_string()
            ),
            (
                "data".to_string(),
                "spaceo_read_text: Page content".to_string()
            )
        ]
    );
    assert!(!format!("{events:?}").contains("do-not-display"));
}

#[test]
fn status_refreshes_owned_session_read_only() {
    let mut h = harness();
    let events = capture(&mut h.handler);
    let reply = h.handler.handle(&json!({"method": "status"}));
    assert_eq!(reply["ok"], true);
    assert!(events.lock().unwrap()[0].1.contains("input unknown"));
    let calls = h.engine.calls.lock().unwrap();
    assert_eq!(*calls, vec![("spaceo_session_list".to_string(), json!({}))]);
}

// ------------------------------------------------------------------------------------ reports

#[test]
fn injected_verification_activity_preserves_coverage() {
    let report = capability_report(Some(&text(
        "isolation: partial\n- key_input_route: unknown [unknown]\n- menu_bar_owner: passed [observed]\n- window_server_front_process: passed [inferred]",
    )));
    assert!(report.contains("private profile, not the user's signed-in session"));
    assert!(report.contains("key_input_route=unknown/unknown"));
    assert!(report.contains("window_server_front_process=passed/inferred"));
    assert!(report.contains("text_input_route=unreported"));
    assert!(report.contains("partial"));
    assert!(!report.contains("isolation: intact"));
}

#[test]
fn unavailable_audit_never_claims_proof() {
    assert!(capability_report(Some(
        &json!({"isError": true, "content": [{"text": "isolation: intact"}]})
    ))
    .contains("unverified"));
    assert!(capability_report(None).contains("unverified"));
}

#[test]
fn bounded_redacted_and_labelled_observations() {
    let obs = EnvironmentObservations::default();
    let initial = obs.report();
    assert_eq!(
        initial["workspace"]["user_holds_control"]
            .as_str()
            .unwrap()
            .split(';')
            .next(),
        Some("unknown")
    );
    assert!(initial["isolation"]["last_audit"]
        .as_str()
        .unwrap()
        .contains("unknown"));
    obs.display_seen("42");
    obs.record(
        "spaceo_verify_isolation",
        Some(&text(
            "isolation: partial\n- key_input_route: unknown [unknown]\nSECRET_DO_NOT_RETAIN",
        )),
        false,
    );
    for _ in 0..8 {
        obs.record(
            "spaceo_type",
            Some(&json!({"isError": true, "content": [{"text": "SECRET_DO_NOT_RETAIN"}]})),
            false,
        );
    }
    let report = obs.report();
    assert_eq!(
        report["workspace"]["observed_display_at_last_bootstrap"],
        "42"
    );
    assert!(report["isolation"]["last_audit"]
        .as_str()
        .unwrap()
        .contains("key_input_route=unknown/unknown"));
    assert_eq!(report["recent_failures"].as_array().unwrap().len(), 5);
    assert!(!report.to_string().contains("SECRET_DO_NOT_RETAIN"));
    obs.record(
        "spaceo_verify_isolation",
        Some(&json!({"isError": true})),
        false,
    );
    assert!(obs.report()["isolation"]["last_audit"]
        .as_str()
        .unwrap()
        .contains("unknown"));
}

#[test]
fn session_refresh_bounded_pause_and_staleness() {
    let header = "[yours] session 'personal-agent-workspace' on whole display 6, 1920x1080\n";
    let result = |body: String| move |_: &str, _: &Value| Ok(text(&body));
    let clock = FakeClock::new();
    clock.set(100.0);
    let obs = EnvironmentObservations::new(clock.clone());
    let view = |obs: &EnvironmentObservations| {
        obs.report()["workspace"]["current_session_and_display"].clone()
    };

    obs.refresh_session(&result(format!(
        "{header}  input: PAUSED (agent: SECRET)\n  window SECRET\n"
    )));
    let now = view(&obs);
    assert_eq!(
        (&now["status"], &now["display"], &now["input_state"]),
        (&json!("observed"), &json!("6"), &json!("paused"))
    );
    assert!(!now.to_string().contains("SECRET"));
    obs.refresh_session(&result(format!(
        "{header}  input: PAUSED (operator has Control)\n"
    )));
    assert!(view(&obs)["reason"]
        .as_str()
        .unwrap()
        .contains("operator control reported"));
    obs.refresh_session(&result(format!("{header}  input: UNPAUSED\n")));
    assert_eq!(view(&obs)["input_state"], "unpaused");
    obs.refresh_session(&result(format!("{header}  title: SECRET\n")));
    assert_eq!(view(&obs)["input_state"], "unknown");

    clock.set(131.0);
    assert_eq!(view(&obs)["status"], "stale");
    obs.refresh_session(&|_: &str, _: &Value| {
        Ok(json!({"isError": true, "content": [{"text": "SECRET"}]}))
    });
    assert_eq!(view(&obs)["status"], "stale");
    assert!(!obs.report().to_string().contains("SECRET"));

    for body in [
        "bad".to_string(),
        format!("{header}  input: PAUSED\n  input: UNPAUSED\n"),
        format!("{header}{header}"),
    ] {
        let empty = EnvironmentObservations::default();
        empty.refresh_session(&result(body.clone()));
        assert_eq!(view(&empty)["status"], "unavailable", "{body}");
    }
    let empty = EnvironmentObservations::default();
    empty.refresh_session(&|_: &str, _: &Value| Err("SECRET".to_string()));
    assert!(!empty.report().to_string().contains("SECRET"));
    assert_eq!(view(&empty)["status"], "unavailable");
}

// ------------------------------------------------------------------------------------ bootstrap

struct Boot {
    state: tempfile::TempDir,
    published: Mutex<u32>,
}

fn boot() -> Boot {
    Boot {
        state: tempfile::tempdir().unwrap(),
        published: Mutex::new(0),
    }
}

impl Boot {
    fn run(&self, engine: &ScriptedEngine, clock: &FakeClock) -> Result<(), String> {
        let mut publish = || {
            *self.published.lock().unwrap() += 1;
            Ok(())
        };
        bootstrap(engine, self.state.path(), clock, &mut publish)
    }
    fn allow_once(&self) {
        fence::set_policy(self.state.path(), "allow-once").unwrap();
    }
    fn published(&self) -> u32 {
        *self.published.lock().unwrap()
    }
}

fn unknown() -> Result<Value, String> {
    failure("[unknown_session] no session")
}

#[test]
fn claim_existing_workspace() {
    let b = boot();
    let engine = ScriptedEngine::new(vec![ok("claimed")]);
    b.run(&engine, &FakeClock::new()).unwrap();
    assert_eq!(engine.names(), ["spaceo_session_claim"]);
    assert_eq!(b.published(), 1);
}

#[test]
fn create_only_when_explicitly_unknown() {
    let b = boot();
    b.allow_once();
    let engine = ScriptedEngine::new(vec![unknown(), ok("created")]);
    b.run(&engine, &FakeClock::new()).unwrap();
    assert_eq!(
        engine.names(),
        ["spaceo_session_claim", "spaceo_session_create"]
    );
    assert_eq!(engine.calls.lock().unwrap()[1].1["preset"], "exclusive");
}

#[test]
fn explicit_closed_fence_blocks_claim_and_creation() {
    let b = boot();
    fence::set_policy(b.state.path(), "closed").unwrap();
    let engine = ScriptedEngine::new(vec![]);
    let error = b.run(&engine, &FakeClock::new()).unwrap_err();
    assert!(error.contains("explicitly closed"));
    assert_eq!(engine.count(), 0);
}

#[test]
fn missing_session_alone_never_authorizes_creation() {
    let b = boot();
    let engine = ScriptedEngine::new(vec![unknown()]);
    let error = b.run(&engine, &FakeClock::new()).unwrap_err();
    assert!(error.contains("explicit user request"));
    assert_eq!(engine.names(), ["spaceo_session_claim"]);
}

#[test]
fn claiming_existing_session_consumes_pending_creation_permit() {
    let b = boot();
    b.allow_once();
    b.run(&ScriptedEngine::new(vec![ok("claimed")]), &FakeClock::new())
        .unwrap();
    assert_eq!(fence::policy(b.state.path()), "existing-only");
    let next = ScriptedEngine::new(vec![unknown()]);
    assert!(b
        .run(&next, &FakeClock::new())
        .unwrap_err()
        .contains("explicit user request"));
    assert_eq!(next.count(), 1);
}

#[test]
fn uncertain_creation_consumes_permit_without_retry() {
    let b = boot();
    b.allow_once();
    let engine = ScriptedEngine::new(vec![unknown(), Err("ambiguous".into())]);
    assert_eq!(b.run(&engine, &FakeClock::new()).unwrap_err(), "ambiguous");
    assert_eq!(fence::policy(b.state.path()), "existing-only");
    let next = ScriptedEngine::new(vec![unknown()]);
    assert!(b
        .run(&next, &FakeClock::new())
        .unwrap_err()
        .contains("explicit user request"));
    assert_eq!(next.count(), 1);
}

#[test]
fn close_during_claim_prevents_publish() {
    let b = boot();
    let engine = ScriptedEngine::new(vec![]);
    let state = b.state.path().to_path_buf();
    *engine.computed.lock().unwrap() = Some(Box::new(move |_, _| {
        fence::set_policy(&state, "closed").unwrap();
        Ok(text("claimed"))
    }));
    assert!(b
        .run(&engine, &FakeClock::new())
        .unwrap_err()
        .contains("explicitly closed"));
    assert_eq!(b.published(), 0);
}

#[test]
fn live_owner_or_failure_never_creates_another_session() {
    for reason in [
        "[session_busy] owner is alive",
        "[unknown_error] daemon failed",
    ] {
        let b = boot();
        let engine = ScriptedEngine::new(vec![failure(reason)]);
        assert!(b.run(&engine, &FakeClock::new()).is_err());
        assert_eq!(engine.count(), 1);
    }
}

#[test]
fn detached_record_is_replaced_only_after_daemon_reports_cleanup() {
    let b = boot();
    b.allow_once();
    let detached = || failure("[session_detached] cleanup pending");
    let engine = ScriptedEngine::new(vec![detached(), detached(), unknown(), ok("created")]);
    b.run(&engine, &FakeClock::new()).unwrap();
    assert_eq!(
        engine.names(),
        [
            "spaceo_session_claim",
            "spaceo_session_claim",
            "spaceo_session_claim",
            "spaceo_session_create"
        ]
    );
    assert_eq!(b.published(), 1);
}

#[test]
fn live_legacy_detached_claim_waits_for_explicit_cleanup() {
    let b = boot();
    b.allow_once();
    let detached = failure(
        "[bad_request] session 'personal-agent-workspace' belongs to a previous daemon and is detached: no display or window handle survived the restart, so it cannot be claimed. Let recovery clean it up",
    );
    let engine = ScriptedEngine::new(vec![detached, unknown(), ok("created")]);
    b.run(&engine, &FakeClock::new()).unwrap();
    assert_eq!(
        engine.names(),
        [
            "spaceo_session_claim",
            "spaceo_session_claim",
            "spaceo_session_create"
        ]
    );
}

#[test]
fn other_bad_request_is_not_treated_as_detached() {
    let b = boot();
    let engine = ScriptedEngine::new(vec![failure(
        "[bad_request] session 'someone-else' belongs to a previous daemon and is detached: no display",
    )]);
    assert!(b.run(&engine, &FakeClock::new()).is_err());
    assert_eq!(engine.count(), 1);
}

#[test]
fn detached_cleanup_timeout_does_not_create_or_remove_session() {
    let b = boot();
    let engine = ScriptedEngine::new(vec![failure("[session_detached] cleanup blocked")]);
    let error = b
        .run(&engine, &FakeClock::scripted(&[0.0, 0.0, 46.0]))
        .unwrap_err();
    assert!(error.contains("cleanup did not finish"));
    assert_eq!(engine.names(), ["spaceo_session_claim"]);
}

#[test]
fn detached_followed_by_other_failure_does_not_create() {
    let b = boot();
    let engine = ScriptedEngine::new(vec![
        failure("[session_detached] cleanup pending"),
        failure("[session_busy] owned"),
    ]);
    assert!(b.run(&engine, &FakeClock::new()).is_err());
    assert_eq!(engine.count(), 2);
}

#[test]
fn disappearing_existing_workspace_is_not_replaced() {
    let b = boot();
    let engine = ScriptedEngine::new(vec![
        failure("only an abandoned session may be claimed"),
        unknown(),
    ]);
    let error = b.run(&engine, &FakeClock::new()).unwrap_err();
    assert!(error.contains("Existing workspace"));
    assert_eq!(
        engine.names(),
        ["spaceo_session_claim", "spaceo_session_claim"]
    );
}

#[test]
fn display_selection_rejects_other_sessions_and_nonexclusive_tiles() {
    for body in [
        "[yours] session 'someone-else' on whole display 15, 1920x1080",
        "[yours] session 'personal-agent-workspace' on tile 1 display 15",
    ] {
        let state = tempfile::tempdir().unwrap();
        let engine = ScriptedEngine::new(vec![ok(body)]);
        let error = publish_display(
            engine.as_ref(),
            state.path(),
            &EnvironmentObservations::default(),
        )
        .unwrap_err();
        assert!(error.contains("could not be identified"), "{body}");
    }
}

#[test]
fn display_selection_publishes_the_exclusive_display() {
    let state = tempfile::tempdir().unwrap();
    let engine = ScriptedEngine::new(vec![ok(
        "[yours] session 'personal-agent-workspace' on whole display 15, 1920x1080",
    )]);
    let obs = EnvironmentObservations::default();
    publish_display(engine.as_ref(), state.path(), &obs).unwrap();
    assert_eq!(
        std::fs::read_to_string(state.path().join("workspace-display-id")).unwrap(),
        "15\n"
    );
    assert_eq!(
        std::fs::read_to_string(state.path().join("workspace-status.json")).unwrap(),
        "{\"state\": \"ready\", \"message\": \"Virtual workspace ready\"}\n"
    );
    assert_eq!(
        obs.report()["workspace"]["observed_display_at_last_bootstrap"],
        "15"
    );
}

// ------------------------------------------------------------------------------------ the process

const FAKE_SPACEO: &str = r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$FAKE_EVENTS"
  case "$line" in *'"id":'*) ;; *) continue ;; esac
  id=$(printf '%s' "$line" | sed -E 's/.*"id": ?("[^"]*"|[0-9]+).*/\1/')
  case "$line" in
    *spaceo_session_claim*) result='{"isError": true, "content": [{"text": "[unknown_session] no session"}]}' ;;
    *spaceo_session_create*) result='{"content": [{"text": "created"}]}' ;;
    *spaceo_session_list*) result='{"content": [{"text": "[yours] session '"'"'personal-agent-workspace'"'"' on whole display 15, 1920x1080"}]}' ;;
    *) result='{"ok": true}' ;;
  esac
  printf '{"jsonrpc": "2.0", "id": %s, "result": %s}\n' "$id" "$result"
done
"#;

#[test]
fn mcp_handshake_bootstraps_without_leaking_internal_responses() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fence::set_policy(root, "allow-once").unwrap();
    let events = root.join("events");
    let fake = root.join("spaceo");
    std::fs::write(&fake, FAKE_SPACEO).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut process = Command::new(env!("CARGO_BIN_EXE_spaceo-mcp-bridge"))
        .arg(&fake)
        .env("FAKE_EVENTS", &events)
        .env("AGENT_STATE_DIR", root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = process.stdin.take().unwrap();
    let mut stdout = BufReader::new(process.stdout.take().unwrap());
    let mut send = |value: Value| {
        writeln!(stdin, "{value}").unwrap();
        stdin.flush().unwrap();
    };
    let read_id = |stdout: &mut BufReader<_>| {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        serde_json::from_str::<Value>(&line).unwrap()["id"].clone()
    };
    send(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}));
    assert_eq!(read_id(&mut stdout), 1);
    send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
    send(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}));
    assert_eq!(read_id(&mut stdout), 2);
    let log = std::fs::read_to_string(&events).unwrap();
    assert!(log.contains("spaceo_session_claim"));
    assert!(log.contains("spaceo_session_create"));
    assert_eq!(
        std::fs::read_to_string(root.join("workspace-display-id"))
            .unwrap()
            .trim(),
        "15"
    );
    // And the workspace socket now answers tool requests through the same session.
    let reply = request(
        &root.join("control/workspace.sock"),
        &json!({"method": "list"}),
    );
    assert_eq!(reply["ok"], true);
    drop(stdin);
    let status = process.wait().unwrap();
    assert!(status.success());
    assert!(!root.join("control/workspace.sock").exists());
}

#[test]
fn bridge_usage_error() {
    let output = Command::new(env!("CARGO_BIN_EXE_spaceo-mcp-bridge"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "Usage: spaceo-mcp-bridge /absolute/path/to/spaceo\n"
    );
}

// ------------------------------------------------------------------------------------ the socket

fn request(path: &Path, value: &Value) -> Value {
    let mut client = UnixStream::connect(path).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    client.write_all(format!("{value}\n").as_bytes()).unwrap();
    let mut data = Vec::new();
    let mut buffer = vec![0u8; 65536];
    while !data.contains(&b'\n') {
        let count = client.read(&mut buffer).unwrap();
        assert!(count > 0, "closed");
        data.extend_from_slice(&buffer[..count]);
    }
    serde_json::from_slice(data.split(|b| *b == b'\n').next().unwrap()).unwrap()
}

struct Served {
    _temp: tempfile::TempDir,
    engine: Arc<ScriptedEngine>,
    socket: WorkspaceSocket,
}

fn served() -> Served {
    let temp = tempfile::tempdir().unwrap();
    let engine = ScriptedEngine::new(vec![]);
    *engine.computed.lock().unwrap() = Some(Box::new(|_, args| {
        Ok(
            json!({"content": [{"type": "text", "text": args.get("app").and_then(Value::as_str).unwrap_or("")}]}),
        )
    }));
    let handler = Arc::new(WorkspaceHandler::new(engine.clone(), temp.path(), None));
    let socket = WorkspaceSocket::start(
        &temp.path().join("control"),
        Arc::new(move |v| handler.handle(&v)),
    )
    .unwrap();
    Served {
        _temp: temp,
        engine,
        socket,
    }
}

#[test]
fn large_request_and_response() {
    let s = served();
    let app = "a".repeat(14000);
    *s.engine.computed.lock().unwrap() = Some(Box::new(|_, _| {
        Ok(json!({"content": [{"type": "text", "text": "x".repeat(1_000_000)}]}))
    }));
    let reply = request(
        s.socket.path(),
        &json!({"name": "spaceo_open_app", "arguments": {"app": app}}),
    );
    assert_eq!(
        reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .len(),
        1_000_000
    );
    let calls = s.engine.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].1,
        json!({"app": app, "session": "personal-agent-workspace"})
    );
}

#[test]
fn utf8_request_near_limit_is_not_expanded() {
    let s = served();
    let value = json!({"name": "spaceo_open_app", "arguments": {"app": "界".repeat(4000)}});
    let raw = serde_json::to_string(&value).unwrap();
    assert!(raw.len() < 16384);
    assert_eq!(request(s.socket.path(), &value)["ok"], true);
    assert_eq!(s.engine.count(), 1);
}

#[test]
fn concurrent_responses_are_not_crossed() {
    let s = served();
    let path = s.socket.path().to_path_buf();
    let workers: Vec<_> = (0..4)
        .map(|i| {
            let path = path.clone();
            std::thread::spawn(move || {
                let reply = request(
                    &path,
                    &json!({"name": "spaceo_open_app", "arguments": {"app": i.to_string()}}),
                );
                (
                    i,
                    reply["result"]["content"][0]["text"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                )
            })
        })
        .collect();
    for worker in workers {
        let (i, got) = worker.join().unwrap();
        assert_eq!(got, i.to_string());
    }
}

#[test]
fn non_object_and_forbidden_tools_never_dispatch() {
    let s = served();
    assert_eq!(request(s.socket.path(), &json!([]))["ok"], false);
    assert_eq!(
        request(s.socket.path(), &json!({"name": "spaceo_session_destroy"}))["ok"],
        false
    );
    assert_eq!(s.engine.count(), 0);
}

#[test]
fn second_workspace_server_cannot_replace_live_socket() {
    let s = served();
    let directory = s.socket.path().parent().unwrap().to_path_buf();
    assert!(WorkspaceSocket::start(&directory, Arc::new(|_| json!({"ok": true}))).is_err());
    assert_eq!(
        request(
            s.socket.path(),
            &json!({"name": "spaceo_open_app", "arguments": {"app": "Safari"}})
        )["ok"],
        true
    );
}
