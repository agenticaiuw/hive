//! tests/test_resumption.py: the goal watchdog, server recovery, the durable identity, the
//! context records and the session (Isolated, ActAndLeftoverGoalTest, IdentityTest, ContextTest,
//! SessionTest). ProcessRestartTest is in `process.rs`.

use super::support::*;
use crate::task::Job;
use crate::util::{lock, monotonic, AgentError};
use crate::{prompts, CodexTask, Session, TaskOptions, TaskSession};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};

const RECOVERY_WAIT: &str = "__recovery_wait__";

/// The task's state as the Python tests set it: `_started`, `began`, `_turn`, `_thread`,
/// `_between_goal_turns`, `_server`.
fn set_up(task: &CodexTask, turn: &str, thread: &str, between: bool, server: &Arc<FakeServer>) {
    let mut s = task.st();
    s.started = true;
    s.began = monotonic();
    s.turn = Some(turn.into());
    s.thread = Some(thread.into());
    s.between_goal_turns = between;
    s.server = Some(server.dyn_());
}

/// `task._done.wait = mock.Mock(side_effect=lambda _: setattr(task, "_between_goal_turns", False))`
fn wait_ends_the_wait(task: &CodexTask) {
    *lock(&task.test.done_wait) = Some(Box::new(|task: &CodexTask, _| {
        task.st().between_goal_turns = false;
        false
    }));
}

/// `task._done.wait = mock.Mock()`
fn wait_returns(task: &CodexTask) {
    *lock(&task.test.done_wait) = Some(Box::new(|_: &CodexTask, _| false));
}

fn spawned(task: &CodexTask) -> Vec<Job> {
    lock(&task.test.spawned).clone().unwrap_or_default()
}

/// Answers from a queue, in turn (Python's `iter([...])` side effects).
fn in_turn(replies: Vec<Result<Value, AgentError>>) -> Arc<FakeServer> {
    let replies = Mutex::new(VecDeque::from(replies));
    FakeServer::new(move |method, _| {
        lock(&replies)
            .pop_front()
            .unwrap_or_else(|| panic!("unexpected {method}"))
    })
}

#[test]
fn general_prompt_mentions_computer_input_without_personal_task_rules() {
    let h = Harness::new();
    let text = format!("{} {}", h.agent.instructions().unwrap(), prompts::RULES).to_lowercase();
    for word in ["mouse", "keyboard", "workspace"] {
        assert!(text.contains(word), "{word}");
    }
    for phrase in ["eric wait", "don't add tasks", "use safari"] {
        assert!(!text.contains(phrase), "{phrase}");
    }
}

#[test]
fn active_goal_retains_task_for_next_turn() {
    let h = Harness::new();
    let (task, _) = h.task("continue");
    let server = FakeServer::new(|_, _| Ok(json!({"goal": {"status": "active"}})));
    set_up(&task, "first", "thread", true, &server);
    wait_ends_the_wait(&task);
    task.await_goal_continuation(Some("first"));
    assert!(task.running());
    task.st().between_goal_turns = true;
    task.on_message("turn/started", &json!({"turn": {"id": "second"}}));
    assert_eq!(task.st().turn.as_deref(), Some("second"));
    assert!(task.running());
}

#[test]
fn goal_blocked_ends_task_without_retry() {
    let h = Harness::new();
    let (task, session) = h.task("continue");
    let server = FakeServer::new(|_, _| Ok(json!({"goal": {"status": "blocked"}})));
    set_up(&task, "first", "thread", true, &server);
    task.await_goal_continuation(Some("first"));
    assert!(!task.running());
    assert!(task.ended().contains("blocked"));
    assert_eq!(server.methods().len(), 1);
    assert_eq!(session.released(), 1);
}

/// A server for the watchdog tests that ends the wait when a continuation starts.
fn waking_server(task: &Arc<CodexTask>, thread_status: &'static str) -> Arc<FakeServer> {
    let me: Weak<CodexTask> = Arc::downgrade(task);
    FakeServer::new(move |method, _| match method {
        "thread/goal/get" => Ok(json!({"goal": {"status": "active"}})),
        "thread/read" => {
            Ok(json!({"thread": {"status": {"type": thread_status, "activeFlags": []}}}))
        }
        "turn/start" => {
            me.upgrade().unwrap().st().between_goal_turns = false;
            Ok(json!({"turn": {"id": "next"}}))
        }
        other => panic!("unexpected {other}"),
    })
}

#[test]
fn watchdog_continues_only_an_idle_active_thread() {
    let h = Harness::new();
    let (task, _) = h.task("continue");
    let server = waking_server(&task, "idle");
    set_up(&task, "first", "thread", true, &server);
    task.st().began = 0.0;
    wait_returns(&task);
    *lock(&task.test.clock) = Some(clock(&[0.0, 31.0, 32.0]));
    task.await_goal_continuation(Some("first"));
    assert_eq!(
        server.methods(),
        [
            "thread/goal/get",
            "thread/read",
            "thread/goal/get",
            "turn/start"
        ]
    );
    assert!(task.running());
}

#[test]
fn watchdog_never_wakes_a_running_thread() {
    let h = Harness::new();
    let (task, _) = h.task("continue");
    let server = waking_server(&task, "active");
    set_up(&task, "first", "thread", true, &server);
    task.st().began = 0.0;
    wait_ends_the_wait(&task);
    *lock(&task.test.clock) = Some(clock(&[0.0, 31.0, 32.0]));
    task.await_goal_continuation(Some("first"));
    assert_eq!(server.count("turn/start"), 0);
}

#[test]
fn provider_recovery_does_not_retry_usage_or_auth_failures() {
    let classify = CodexTask::recoverable_goal_error;
    assert!(classify(&json!({"codexErrorInfo": "serverOverloaded"})));
    assert!(classify(
        &json!({"codexErrorInfo": {"responseStreamDisconnected": {"httpStatusCode": 503}}})
    ));
    assert!(!classify(
        &json!({"codexErrorInfo": {"httpConnectionFailed": {"httpStatusCode": 429}}})
    ));
    assert!(!classify(&json!({"codexErrorInfo": "usageLimitExceeded"})));
    assert!(!classify(&json!({"codexErrorInfo": "unauthorized"})));
}

#[test]
fn watchdog_rechecks_goal_before_waking_thread() {
    let h = Harness::new();
    let (task, _) = h.task("continue");
    let server = in_turn(vec![
        Ok(json!({"goal": {"status": "active"}})),
        Ok(json!({"thread": {"status": {"type": "idle"}}})),
        Ok(json!({"goal": {"status": "paused"}})),
    ]);
    set_up(&task, "first", "thread", true, &server);
    task.st().began = 0.0;
    wait_ends_the_wait(&task);
    *lock(&task.test.clock) = Some(clock(&[0.0, 31.0, 32.0]));
    task.await_goal_continuation(Some("first"));
    assert_eq!(server.count("turn/start"), 0);
}

#[test]
fn explicit_stop_pauses_active_goal_before_interrupt() {
    let h = Harness::new();
    let (task, _) = h.task("continue");
    let server = FakeServer::new(|_, _| Ok(json!({"goal": {"status": "active"}})));
    {
        let mut s = task.st();
        s.on_thread = true;
        s.thread = Some("thread".into());
        s.turn = Some("turn".into());
        s.server = Some(server.dyn_());
    }
    task.pause_goal_and_interrupt();
    assert_eq!(
        server.methods(),
        ["thread/goal/get", "thread/goal/set", "turn/interrupt"]
    );
    assert_eq!(lock(&server.calls)[1].1["status"], "paused");
}

#[test]
fn watchdog_rechecks_after_transient_status_failure() {
    let h = Harness::new();
    let (task, _) = h.task("continue");
    let server = in_turn(vec![
        Err(AgentError::Codex("timeout".into())),
        Ok(json!({"goal": {"status": "active"}})),
    ]);
    set_up(&task, "first", "thread", true, &server);
    task.st().began = 0.0;
    let waits = Arc::new(Mutex::new(Vec::new()));
    let seen = waits.clone();
    *lock(&task.test.done_wait) = Some(Box::new(move |task: &CodexTask, seconds| {
        lock(&seen).push(seconds);
        if lock(&seen).len() == 2 {
            task.st().between_goal_turns = false;
        }
        false
    }));
    *lock(&task.test.clock) = Some(clock(&[0.0]));
    task.await_goal_continuation(Some("first"));
    assert_eq!(server.methods().len(), 2);
    assert!(task.running());
    assert_eq!(server.count("turn/start"), 0);
}

#[test]
fn stale_goal_reply_does_not_finish_new_continuation() {
    let h = Harness::new();
    let (task, session) = h.task("continue");
    let me = Arc::downgrade(&task);
    let server = FakeServer::new(move |_, _| {
        me.upgrade()
            .unwrap()
            .on_message("turn/started", &json!({"turn": {"id": "second"}}));
        Ok(json!({"goal": {"status": "blocked"}}))
    });
    set_up(&task, "first", "thread", true, &server);
    task.await_goal_continuation(Some("first"));
    assert!(task.running());
    assert_eq!(task.st().turn.as_deref(), Some("second"));
    assert_eq!(session.released(), 0);
}

#[test]
fn late_continuation_after_stop_is_interrupted() {
    let h = Harness::new();
    let (task, _) = h.task("continue");
    let server = FakeServer::new(|_, _| Ok(json!({})));
    {
        let mut s = task.st();
        s.thread = Some("thread".into());
        s.turn = Some("first".into());
        s.between_goal_turns = true;
        s.stopped = true;
        s.server = Some(server.dyn_());
    }
    task.on_message("turn/started", &json!({"turn": {"id": "second"}}));
    assert_eq!(task.st().turn.as_deref(), Some("second"));
    assert_eq!(spawned(&task), [Job::Interrupt]);
}

/// A task whose saved conversation is "saved-thread", with a session that resumes it.
fn recovering(h: &Harness, server: &Arc<FakeServer>) -> (Arc<CodexTask>, Arc<MockSession>) {
    let session = MockSession::with_thread("saved-thread");
    let task = CodexTask::new(
        &h.agent,
        "original action",
        TaskOptions {
            session: Some(session.clone()),
            ..TaskOptions::default()
        },
    );
    *lock(&task.test.spawned) = Some(Vec::new());
    {
        let mut s = task.st();
        s.started = true;
        s.on_thread = true;
        s.began = monotonic();
        s.thread = Some("saved-thread".into());
        s.turn = Some("old-turn".into());
    }
    h.serve(server);
    (task, session)
}

#[test]
fn server_recovery_resumes_saved_thread_without_replaying_request() {
    let h = Harness::new();
    let server = FakeServer::new(|method, _| match method {
        "thread/goal/get" => Ok(json!({"goal": {"status": "active"}})),
        "thread/read" => Ok(json!({"thread": {"status": {"type": "idle"}}})),
        "turn/start" => Ok(json!({"turn": {"id": "new-turn"}})),
        other => panic!("unexpected {other}"),
    });
    let (task, _) = recovering(&h, &server);
    task.recover_goal_server();
    let (method, params) = lock(&server.calls).last().cloned().unwrap();
    assert_eq!(method, "turn/start");
    assert_eq!(params["threadId"], "saved-thread");
    assert!(!params["input"][0]["text"]
        .as_str()
        .unwrap()
        .contains("original action"));
    assert!(task.running());
}

#[test]
fn recovery_start_timeout_is_monitored_without_replay() {
    let h = Harness::new();
    let server = FakeServer::new(|method, _| match method {
        "thread/goal/get" => Ok(json!({"goal": {"status": "active"}})),
        "thread/read" => Ok(json!({"thread": {"status": {"type": "idle"}}})),
        "turn/start" => Err(AgentError::Codex("response timed out".into())),
        other => panic!("unexpected {other}"),
    });
    let (task, session) = recovering(&h, &server);
    task.recover_goal_server();
    assert!(task.running());
    assert_eq!(server.count("turn/start"), 1);
    assert_eq!(
        spawned(&task).last(),
        Some(&Job::AwaitGoalContinuation(Some(RECOVERY_WAIT.into())))
    );
    assert_eq!(session.released(), 0);
}

#[test]
fn dead_server_during_goal_check_starts_only_one_recovery() {
    let h = Harness::new();
    let (task, session) = h.task("continue");
    let server = FakeServer::new(|_, _| Err(AgentError::Codex("Codex stopped".into()))).dead();
    set_up(&task, "old-turn", "saved-thread", true, &server);
    task.st().on_thread = true;
    task.await_goal_continuation(Some("old-turn"));
    task.on_message("exited", &json!({"code": 1}));
    assert!(task.running());
    assert_eq!(session.released(), 0);
    assert_eq!(spawned(&task), [Job::Recover]);
}

#[test]
fn server_recovery_never_wakes_a_paused_goal() {
    let h = Harness::new();
    let server = FakeServer::new(|_, _| Ok(json!({"goal": {"status": "paused"}})));
    let (task, _) = recovering(&h, &server);
    task.recover_goal_server();
    assert!(!task.running());
    assert_eq!(server.methods(), ["thread/goal/get"]);
}

#[test]
fn recovery_monitors_running_thread_without_start_notification() {
    let h = Harness::new();
    let server = FakeServer::new(|method, _| match method {
        "thread/goal/get" => Ok(json!({"goal": {"status": "active"}})),
        "thread/read" => Ok(json!({"thread": {"status": {"type": "active"}}})),
        other => panic!("unexpected {other}"),
    });
    let (task, _) = recovering(&h, &server);
    task.recover_goal_server();
    assert!(task.running());
    assert!(task.st().between_goal_turns);
    assert_eq!(
        spawned(&task).last(),
        Some(&Job::AwaitGoalContinuation(Some(RECOVERY_WAIT.into())))
    );
    task.on_message("turn/started", &json!({"turn": {"id": "new-turn"}}));
    assert_eq!(task.st().turn.as_deref(), Some("new-turn"));
    assert!(!task.st().between_goal_turns);
}

#[test]
fn recovery_wait_resumes_only_after_thread_becomes_idle() {
    let h = Harness::new();
    let session = Arc::new(MockSession::default());
    let task = CodexTask::new(
        &h.agent,
        "original action",
        TaskOptions {
            session: Some(session.clone()),
            ..TaskOptions::default()
        },
    );
    let me = Arc::downgrade(&task);
    let statuses = Mutex::new(VecDeque::from(["active", "idle"]));
    let server = FakeServer::new(move |method, _| match method {
        "thread/goal/get" => Ok(json!({"goal": {"status": "active"}})),
        "thread/read" => {
            Ok(json!({"thread": {"status": {"type": lock(&statuses).pop_front().unwrap()}}}))
        }
        "turn/start" => {
            me.upgrade().unwrap().st().between_goal_turns = false;
            Ok(json!({"turn": {"id": "new-turn"}}))
        }
        other => panic!("unexpected {other}"),
    });
    set_up(&task, RECOVERY_WAIT, "saved-thread", true, &server);
    task.st().on_thread = true;
    wait_returns(&task);
    *lock(&task.test.clock) = Some(clock(&[0.0, 31.0, 31.0, 92.0, 92.0]));
    task.await_goal_continuation(Some(RECOVERY_WAIT));
    assert_eq!(server.count("turn/start"), 1);
    let start = server.last("turn/start").unwrap();
    assert_eq!(start["threadId"], "saved-thread");
    assert!(!start["input"][0]["text"]
        .as_str()
        .unwrap()
        .contains("original action"));
    assert_eq!(session.released(), 0);
}

// -- ActAndLeftoverGoalTest ----------------------------------------------------------------------

fn ended_with(h: &Harness, goal: Value, before: (i64, i64)) -> (Arc<CodexTask>, Arc<FakeServer>) {
    let (task, _) = h.task("continue");
    let server = FakeServer::new(move |_, _| Ok(json!({"goal": goal})));
    set_up(&task, "first", "thread", true, &server);
    task.st().goal_before = Some((json!(before.0), json!(before.1)));
    task.await_goal_continuation(Some("first"));
    assert!(!task.running());
    (task, server)
}

#[test]
fn a_goal_left_blocked_by_an_earlier_task_does_not_fail_this_one() {
    let h = Harness::new();
    let (task, server) = ended_with(
        &h,
        json!({"status": "blocked", "createdAt": 1, "updatedAt": 2}),
        (1, 2),
    );
    assert!(!task.ended().contains("blocked"));
    assert_eq!(server.methods().len(), 1); // no "diagnose the blocker" turn
}

#[test]
fn a_goal_this_task_blocked_still_fails_it() {
    let h = Harness::new();
    let (task, _) = ended_with(
        &h,
        json!({"status": "blocked", "createdAt": 1, "updatedAt": 3}),
        (1, 2),
    );
    assert!(task.ended().contains("blocked"));
}

#[test]
fn the_agent_always_acts_rather_than_explains() {
    let rules = prompts::RULES
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(rules.contains("whenever you could either act or explain, act"));
    assert!(!prompts::RULES.contains("Explain without doing it"));
    assert!(prompts::REQUEST.contains("do it for them"));
}

// -- IdentityTest: the saved conversation (hive-core's ResumableThread, through a Session) -------

fn identity(h: &Harness) -> Arc<Session> {
    Session::new(&h.agent, Some(h.path().join("thread-id")))
}

fn connect(
    session: &Session,
    server: &Arc<FakeServer>,
    params: Value,
) -> Result<String, AgentError> {
    session.connect_now(&server.dyn_(), &params)
}

fn resume_error(result: Result<String, AgentError>) -> String {
    match result {
        Err(AgentError::Resume(message)) => message,
        other => panic!("expected a ResumeError, got {other:?}"),
    }
}

#[test]
fn start_and_resume_from_new_instance() {
    use std::os::unix::fs::PermissionsExt;
    let h = Harness::new();
    let server = FakeServer::identity(None, None);
    assert_eq!(
        connect(&identity(&h), &server, json!({"ephemeral": true})).unwrap(),
        "thread-123"
    );
    assert_eq!(lock(&server.calls)[0].1["ephemeral"], false);
    let mode = std::fs::metadata(h.path().join("thread-id"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    assert_eq!(
        connect(&identity(&h), &server, json!({})).unwrap(),
        "thread-123"
    );
    assert_eq!(
        lock(&server.calls)[1],
        (
            "thread/resume".to_owned(),
            json!({"threadId": "thread-123"})
        )
    );
}

#[test]
fn resume_error_retains_identity_and_never_starts() {
    let h = Harness::new();
    let path = h.path().join("thread-id");
    std::fs::write(&path, "thread-original\n").unwrap();
    let server = FakeServer::identity(Some("unavailable"), None);
    let session = identity(&h);
    for _ in 0..2 {
        assert!(resume_error(connect(&session, &server, json!({})))
            .contains("Conversation was not replaced"));
    }
    assert_eq!(server.methods(), ["thread/resume", "thread/resume"]);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "thread-original\n");
}

#[test]
fn mismatch_never_overwrites() {
    let h = Harness::new();
    let path = h.path().join("thread-id");
    std::fs::write(&path, "thread-original\n").unwrap();
    let server = FakeServer::identity(None, Some("thread-different"));
    assert!(resume_error(connect(&identity(&h), &server, json!({}))).contains("mismatch"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "thread-original\n");
}

#[test]
fn known_identity_cannot_be_silently_replaced_by_missing_state() {
    let h = Harness::new();
    let session = identity(&h);
    let server = FakeServer::identity(None, None);
    connect(&session, &server, json!({})).unwrap();
    std::fs::remove_file(h.path().join("thread-id")).unwrap();
    assert!(resume_error(connect(&session, &server, json!({}))).contains("changed or disappeared"));
    assert_eq!(server.methods().len(), 1);
}

#[test]
fn known_identity_cannot_be_silently_switched_by_changed_state() {
    let h = Harness::new();
    let session = identity(&h);
    let server = FakeServer::identity(None, None);
    connect(&session, &server, json!({})).unwrap();
    std::fs::write(h.path().join("thread-id"), "thread-another").unwrap();
    assert!(resume_error(connect(&session, &server, json!({}))).contains("changed or disappeared"));
    assert_eq!(server.methods().len(), 1);
}

#[test]
fn invalid_existing_state_never_contacts_server() {
    let h = Harness::new();
    let path = h.path().join("thread-id");
    for state in [
        "",
        "\n",
        "thread-one\nthread-two",
        "../other",
        "!thread-start-pending",
    ] {
        std::fs::write(&path, state).unwrap();
        let server = FakeServer::identity(None, None);
        resume_error(connect(&identity(&h), &server, json!({})));
        assert!(server.methods().is_empty(), "{state:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), state);
    }
}

#[test]
fn unreadable_state_does_not_start() {
    let h = Harness::new();
    std::fs::create_dir(h.path().join("thread-id")).unwrap();
    let server = FakeServer::identity(None, None);
    assert!(matches!(
        connect(&identity(&h), &server, json!({})),
        Err(AgentError::Os(_))
    ));
    assert!(server.methods().is_empty());
}

#[test]
fn non_utf8_state_does_not_start() {
    let h = Harness::new();
    std::fs::write(h.path().join("thread-id"), b"\xff").unwrap();
    let server = FakeServer::identity(None, None);
    resume_error(connect(&identity(&h), &server, json!({})));
    assert!(server.methods().is_empty());
}

#[test]
fn ephemeral_response_is_rejected() {
    let h = Harness::new();
    let server =
        FakeServer::new(|_, _| Ok(json!({"thread": {"id": "thread-123", "ephemeral": true}})));
    assert!(resume_error(connect(&identity(&h), &server, json!({}))).contains("ephemeral"));
}

#[test]
fn start_timeout_blocks_another_start_after_restart() {
    let h = Harness::new();
    let server = FakeServer::identity(Some("no answer"), None);
    resume_error(connect(&identity(&h), &server, json!({})));
    resume_error(connect(&identity(&h), &server, json!({})));
    assert_eq!(server.methods().len(), 1);
    assert_eq!(
        std::fs::read_to_string(h.path().join("thread-id")).unwrap(),
        "!thread-start-pending\n"
    );
}

#[test]
fn invalid_start_response_is_not_committed() {
    let h = Harness::new();
    let server = FakeServer::identity(None, Some("bad id"));
    resume_error(connect(&identity(&h), &server, json!({})));
    assert_eq!(
        std::fs::read_to_string(h.path().join("thread-id")).unwrap(),
        "!thread-start-pending\n"
    );
}

/// Makes `dir` read-only (or writable again).
fn writable(dir: &std::path::Path, yes: bool) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        dir,
        std::fs::Permissions::from_mode(if yes { 0o700 } else { 0o500 }),
    )
    .unwrap();
}

#[test]
fn failed_initial_state_write_never_contacts_server() {
    // (Python made os.replace fail; here the state folder can't be written.)
    let h = Harness::new();
    let dir = h.path().join("readonly");
    std::fs::create_dir(&dir).unwrap();
    writable(&dir, false);
    let session = Session::new(&h.agent, Some(dir.join("thread-id")));
    let server = FakeServer::identity(None, None);
    let result = connect(&session, &server, json!({}));
    writable(&dir, true);
    assert!(matches!(result, Err(AgentError::Os(_))), "{result:?}");
    assert!(server.methods().is_empty());
}

#[test]
fn failed_final_commit_blocks_replacement() {
    // (Python made the final atomic_write fail; here the folder turns read-only while Codex
    // starts the thread, after the pending marker was written.)
    let h = Harness::new();
    let dir = h.path().join("commit");
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("thread-id");
    let locked = dir.clone();
    let server = FakeServer::new(move |_, _| {
        writable(&locked, false);
        Ok(json!({"thread": {"id": "thread-123"}}))
    });
    let first = connect(
        &Session::new(&h.agent, Some(path.clone())),
        &server,
        json!({}),
    );
    let second = connect(
        &Session::new(&h.agent, Some(path.clone())),
        &server,
        json!({}),
    );
    writable(&dir, true);
    resume_error(first);
    resume_error(second);
    assert_eq!(server.methods().len(), 1);
}

#[test]
fn concurrent_connections_create_once() {
    let h = Harness::new();
    let server = FakeServer::identity(None, None);
    let ids: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| connect(&identity(&h), &server, json!({})).unwrap()))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(ids, vec!["thread-123"; 4]);
    assert_eq!(server.count("thread/start"), 1);
}

// -- ContextTest: what the context inspector is given ---------------------------------------------

fn with_tools(task: &CodexTask, tools: &[(&str, Arc<FakeTool>)]) {
    let map: HashMap<String, Arc<dyn hive_common::tools::ToolNamespace>> = tools
        .iter()
        .map(|(name, tool)| {
            (
                name.to_string(),
                tool.clone() as Arc<dyn hive_common::tools::ToolNamespace>,
            )
        })
        .collect();
    *lock(&task.tools) = map;
}

#[test]
fn tool_records_exact_arguments_result_and_call_id() {
    let h = Harness::new();
    let (task, _) = h.task("test");
    let result = json!({"content": [{"type": "text", "text": "output ".repeat(1000)},
                                    {"type": "image", "mimeType": "image/png", "data": "QUJD"}]});
    with_tools(
        &task,
        &[("mac", FakeTool::new("mac").returning(Ok(result.clone())))],
    );
    let params = json!({"callId": "call-1", "namespace": "mac", "tool": "read_screen",
                        "arguments": {"text": "input ".repeat(1000)}});
    let reply = task.call_tool(&params);
    let records = h.context.all();
    assert_eq!(records[0].payload, params);
    assert_eq!(
        records[1].payload,
        json!({"callId": "call-1", "result": reply})
    );
    assert_eq!(reply, hive_common::tools::tool_reply(&result));
}

#[test]
fn tool_exception_is_visible_in_the_exact_error_reply() {
    let h = Harness::new();
    let (task, _) = h.task("test");
    with_tools(
        &task,
        &[(
            "mac",
            FakeTool::new("mac").returning(Err("tool broke".into())),
        )],
    );
    let reply = task.call_tool(&json!({"tool": "click", "callId": "bad", "arguments": {}}));
    assert_eq!(reply["success"], false);
    let last = h.context.all().last().cloned().unwrap();
    assert!(last.payload["result"]["contentItems"][0]["text"]
        .as_str()
        .unwrap()
        .contains("tool broke"));
}

#[test]
fn workspace_command_is_visible_without_exposing_arguments() {
    let h = Harness::new();
    let events = Events::default();
    let task = CodexTask::new(
        &h.agent,
        "test",
        TaskOptions {
            on_event: Some(events.on_event()),
            ..TaskOptions::default()
        },
    );
    task.on_message(
        "item/started",
        &json!({"item": {"type": "commandExecution",
                         "command": "python scripts/workspace-tool.py call spaceo_open_url '{secret}'"}}),
    );
    task.on_message(
        "item/completed",
        &json!({"item": {"type": "commandExecution", "exitCode": 0}}),
    );
    assert!(events.has("action", "Virtual workspace: spaceo_open_url"));
    assert!(events
        .all()
        .iter()
        .any(|(kind, text)| kind == "data" && text.contains("completed")));
    assert!(!format!("{:?}", events.all()).contains("secret"));
    // The Rust controller the rules now name.
    task.on_message(
        "item/started",
        &json!({"item": {"type": "commandExecution",
                         "command": "build/workspace-tool call spaceo_session_list '{}'"}}),
    );
    assert!(events.has("action", "Virtual workspace: spaceo_session_list"));
}

#[test]
fn context_failure_warns_without_breaking_tools() {
    let h = Harness::new();
    let events = Events::default();
    let task = CodexTask::new(
        &h.agent,
        "test",
        TaskOptions {
            on_event: Some(events.on_event()),
            ..TaskOptions::default()
        },
    );
    task.st().stopped = true;
    *lock(&h.context.fail) = Some("disk full".into());
    let reply = task.call_tool(&json!({"tool": "click"}));
    assert_eq!(reply["success"], false);
    assert!(events
        .all()
        .iter()
        .any(|(_, text)| text.contains("context could not be saved")));
}

// -- SessionTest ---------------------------------------------------------------------------------

fn session_task(h: &Harness, session: &Arc<Session>, text: &str) -> Arc<CodexTask> {
    let task = CodexTask::new(
        &h.agent,
        text,
        TaskOptions {
            session: Some(session.clone()),
            ..TaskOptions::default()
        },
    );
    session.add(&task);
    task
}

#[test]
fn server_replacement_resumes_without_replaying_primary_summaries() {
    let h = Harness::new();
    let session = identity(&h);
    let (one, two) = (
        FakeServer::identity(None, None),
        FakeServer::identity(None, None),
    );
    let first = session_task(&h, &session, "first");
    let (thread, _) = session
        .thread_for(&first, &one.dyn_(), json!({}), None)
        .unwrap();
    session.release(&first);
    let second = session_task(&h, &session, "second");
    let (resumed, earlier) = session
        .thread_for(&second, &two.dyn_(), json!({}), None)
        .unwrap();
    assert_eq!(thread, resumed);
    assert_eq!(earlier, "");
    assert_eq!(
        *lock(&two.calls),
        [("thread/resume".to_owned(), json!({"threadId": thread}))]
    );
}

#[test]
fn prepare_failure_is_retried_as_resume_not_start() {
    let h = Harness::new();
    std::fs::write(h.path().join("thread-id"), "thread-existing").unwrap();
    let session = identity(&h);
    let server = FakeServer::identity(Some("offline"), None);
    h.serve(&server);
    h.agent.codex_server().unwrap(); // Codex is running
    session.prepare_now();
    let task = session_task(&h, &session, "test");
    resume_error(
        session
            .thread_for(&task, &server.dyn_(), json!({}), None)
            .map(|(t, _)| t),
    );
    assert_eq!(server.methods(), ["thread/resume", "thread/resume"]);
}

#[test]
fn closed_session_does_not_start_thread() {
    let h = Harness::new();
    let session = identity(&h);
    session.close_now();
    let server = FakeServer::identity(None, None);
    let task = session_task(&h, &session, "test");
    resume_error(
        session
            .thread_for(&task, &server.dyn_(), json!({}), None)
            .map(|(t, _)| t),
    );
    assert!(server.methods().is_empty());
}

#[test]
fn the_conversation_prepared_before_a_request_is_its_thread() {
    // (Not in the Python tests: prepare() connects the saved identity before the first request.)
    let h = Harness::new();
    let session = identity(&h);
    let server = FakeServer::identity(None, None);
    h.serve(&server);
    h.agent.codex_server().unwrap();
    session.prepare_now();
    assert_eq!(session.thread().as_deref(), Some("thread-123"));
    let task = session_task(&h, &session, "test");
    let (thread, _) = session
        .thread_for(&task, &server.dyn_(), json!({}), None)
        .unwrap();
    assert_eq!(thread, "thread-123");
    assert_eq!(server.methods(), ["thread/start"]);
    assert!(task.on_thread());
}
