//! tests/test_task_recovery.py and tests/test_provider_wait.py: what a task does with its saved
//! request (task_recovery) and the provider wait. The state files' own tests are in
//! `task_recovery.rs` and `provider_wait.rs`.

use super::support::*;
use crate::provider_wait::{self, Reservation};
use crate::task_recovery;
use crate::util::{lock, AgentError};
use crate::{prompts, CodexTask};
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// A task with a saved request on thread-1, between turn-1 and its next turn.
fn saved(
    h: &Harness,
    text: &str,
    server: &Arc<FakeServer>,
) -> (Arc<CodexTask>, Arc<MockSession>, String) {
    let identity = task_recovery::begin(h.path(), "mac", "thread-1", None).unwrap();
    let (task, session) = h.task(text);
    {
        let mut s = task.st();
        s.recovery_id = Some(identity.clone());
        s.thread = Some("thread-1".into());
        s.turn = Some("turn-1".into());
        s.between_goal_turns = true;
        s.server = Some(server.dyn_());
    }
    (task, session, identity)
}

#[test]
fn stopped_task_refuses_continuation_admission() {
    let h = Harness::new();
    let (task, _) = h.task("task");
    let server = FakeServer::new(|_, _| Ok(json!({})));
    task.st().server = Some(server.dyn_());
    task.st().stopped = true;
    assert!(matches!(
        task.continuation_start(json!({"threadId": "thread"})),
        Err(AgentError::Resume(_))
    ));
    assert!(server.methods().is_empty());
}

#[test]
fn maintenance_interrupt_preserves_authorization_but_user_stop_fences() {
    let h = Harness::new();
    let identity = task_recovery::begin(h.path(), "mac", "thread-1", None).unwrap();
    let (task, _) = h.task("work");
    task.st().recovery_id = Some(identity.clone());
    let interrupts = Arc::new(AtomicUsize::new(0));
    let counted = interrupts.clone();
    *lock(&task.test.interrupt) = Some(Box::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    task.stop_for_maintenance();
    assert_eq!(
        task_recovery::current(h.path()).unwrap().unwrap()["status"],
        "active"
    );
    assert_eq!(interrupts.load(Ordering::SeqCst), 1);
    let (next, _) = h.task("work");
    next.st().recovery_id = Some(identity);
    next.stop();
    assert_eq!(
        task_recovery::current(h.path()).unwrap().unwrap()["status"],
        "stopped"
    );
}

#[test]
fn blocked_goal_gets_one_same_thread_reassessment() {
    let h = Harness::new();
    let server = FakeServer::new(|method, _| match method {
        "thread/goal/get" => Ok(json!({"goal": {"status": "blocked"}})),
        "thread/read" => Ok(json!({"thread": {"status": {"type": "idle"}}})),
        _ => Ok(json!({"turn": {"id": "turn-2"}})),
    });
    let (task, _, identity) = saved(&h, "two tasks", &server);
    task.await_goal_continuation(Some("turn-1"));
    assert_eq!(
        server.methods(),
        [
            "thread/goal/get",
            "thread/read",
            "thread/goal/get",
            "turn/start"
        ]
    );
    let request = server.last("turn/start").unwrap();
    assert_eq!(request["threadId"], "thread-1");
    assert!(request["input"][0]["text"]
        .as_str()
        .unwrap()
        .contains("outcome is uncertain"));
    assert!(task_recovery::reserve(h.path(), "blocked", Some(&identity))
        .unwrap()
        .is_none());
}

#[test]
fn goal_paused_during_blocked_check_never_wakes() {
    let h = Harness::new();
    let statuses = Mutex::new(VecDeque::from(["blocked", "paused", "paused"]));
    let server = FakeServer::new(move |method, _| match method {
        "thread/goal/get" => Ok(json!({"goal": {"status": lock(&statuses).pop_front().unwrap()}})),
        _ => Ok(json!({"thread": {"status": {"type": "idle"}}})),
    });
    let (task, _, _) = saved(&h, "two tasks", &server);
    task.await_goal_continuation(Some("turn-1"));
    assert_eq!(server.count("turn/start"), 0);
    assert_eq!(
        task_recovery::current(h.path()).unwrap().unwrap()["blocked_attempts"],
        0
    );
}

#[test]
fn blocked_completion_waits_for_idle_before_one_reassessment() {
    let h = Harness::new();
    let states = Mutex::new(VecDeque::from(["active", "idle"]));
    let server = FakeServer::new(move |method, _| match method {
        "thread/goal/get" => Ok(json!({"goal": {"status": "blocked"}})),
        "thread/read" => {
            Ok(json!({"thread": {"status": {"type": lock(&states).pop_front().unwrap()}}}))
        }
        _ => Ok(json!({"turn": {"id": "turn-2"}})),
    });
    let (task, _, _) = saved(&h, "two tasks", &server);
    let waits = Arc::new(Mutex::new(Vec::new()));
    let seen = waits.clone();
    *lock(&task.test.done_wait) = Some(Box::new(move |_: &CodexTask, seconds| {
        lock(&seen).push(seconds);
        false
    }));
    task.await_goal_continuation(Some("turn-1"));
    assert_eq!(server.count("turn/start"), 1);
    assert_eq!(*lock(&waits), [1.0]);
}

#[test]
fn provider_routing_failure_retries_once_without_replaying_task() {
    let h = Harness::new();
    let (task, session) = h.task("original request");
    let server = FakeServer::new(|method, _| match method {
        "thread/goal/get" => Ok(json!({"goal": null})),
        "thread/read" => Ok(json!({"thread": {"status": {"type": "idle"}}})),
        _ => Ok(json!({"turn": {"id": "turn-2"}})),
    });
    {
        let mut s = task.st();
        s.thread = Some("thread-1".into());
        s.turn = Some("turn-1".into());
        s.between_goal_turns = true;
        s.routing_failure = true;
        s.server = Some(server.dyn_());
    }
    task.await_goal_continuation(Some("turn-1"));
    let (method, request) = lock(&server.calls).last().cloned().unwrap();
    assert_eq!(method, "turn/start");
    assert_eq!(request["threadId"], "thread-1");
    let text = request["input"][0]["text"].as_str().unwrap();
    assert!(!text.contains("original request"));
    assert!(text.contains("outcome is uncertain"));
    assert!(!task.st().routing_retry_available);
    task.await_goal_continuation(Some("turn-1"));
    assert_eq!(server.count("turn/start"), 1);
    assert!(task
        .ended()
        .contains("Provider routing remained unavailable"));
    assert_eq!(session.released(), 1);
}

#[test]
fn routing_failure_classifier_is_narrow() {
    assert!(CodexTask::recoverable_goal_error(
        &json!({"message": "workspace routing discovery failed", "codexErrorInfo": "other"})
    ));
    assert!(!CodexTask::recoverable_goal_error(
        &json!({"message": "permission denied", "codexErrorInfo": "other"})
    ));
}

#[test]
fn startup_without_goal_uses_saved_thread_and_new_instruction() {
    let h = Harness::new();
    let identity = task_recovery::begin(h.path(), "mac", "thread-1", None).unwrap();
    let record = task_recovery::reserve(h.path(), "startup", None)
        .unwrap()
        .unwrap();
    let session = MockSession::with_thread("thread-1");
    let task = CodexTask::new(
        &h.agent,
        "original request",
        crate::TaskOptions {
            session: Some(session.clone()),
            ..Default::default()
        },
    );
    *lock(&task.test.spawned) = Some(Vec::new());
    task.set_startup_record(record, None);
    let server = FakeServer::new(|method, _| match method {
        "thread/goal/get" => Ok(json!({"goal": null})),
        "thread/read" => Ok(json!({"thread": {"status": {"type": "idle"}}})),
        _ => Ok(json!({"turn": {"id": "turn-2"}})),
    });
    h.serve(&server);
    task.restore_task().unwrap();
    assert_eq!(task.recovery_id(), Some(identity));
    assert_eq!(*lock(&session.expected), [Some("thread-1".to_owned())]);
    let request = server.last("turn/start").unwrap();
    assert_eq!(request["threadId"], "thread-1");
    let text = request["input"][0]["text"].as_str().unwrap();
    assert!(!text.contains("original request"));
    assert!(text.contains("uncertain outcomes"));
    assert_eq!(text, prompts::CONTINUE_RESTORED);
}

// -- tests/test_provider_wait.py -----------------------------------------------------------------

#[test]
fn user_stop_or_pause_prevents_probe_and_resume() {
    let h = Harness::new();
    let identity = task_recovery::begin(h.path(), "mac", "thread", None).unwrap();
    task_recovery::finish(h.path(), &identity, "stopped").unwrap();
    let (task, _) = h.task("work");
    task.st().recovery_id = Some(identity.clone());
    assert!(!task.wait_for_provider(true, None));
    assert_eq!(h.provider.probes.load(Ordering::SeqCst), 0);
    assert!(!provider_wait::exists(h.path(), &identity).unwrap());
    assert_eq!(
        task_recovery::current(h.path()).unwrap().unwrap()["status"],
        "stopped"
    );
}

#[test]
fn restore_waits_before_reconnecting_saved_thread() {
    let h = Harness::new();
    let identity = task_recovery::begin(h.path(), "mac", "thread", None).unwrap();
    let record = task_recovery::current(h.path()).unwrap().unwrap();
    provider_wait::reserve(h.path(), &identity, Some(100.0), true).unwrap();
    let (task, _) = h.task("work");
    task.set_startup_record(record, None);
    // (Python patched _wait_for_provider to give up; here the wait has run out.)
    lock(&h.provider.reservations).push_back(Some(Reservation::Expired));
    let started = Arc::new(AtomicUsize::new(0));
    let counted = started.clone();
    *lock(&h.agent.server_factory) = Some(Box::new(move |_: &crate::Agent| {
        counted.fetch_add(1, Ordering::SeqCst);
        Err(AgentError::Codex("not to be started".into()))
    }));
    task.restore_task().unwrap();
    assert_eq!(*lock(&h.provider.arms), [false]);
    assert_eq!(started.load(Ordering::SeqCst), 0);
}

#[test]
fn wait_resumes_only_after_proxy_probe_succeeds() {
    let h = Harness::new();
    let identity = task_recovery::begin(h.path(), "mac", "thread", None).unwrap();
    let (task, _) = h.task("work");
    task.st().recovery_id = Some(identity.clone());
    lock(&h.provider.reservations).extend([Some(Reservation::Check), Some(Reservation::Check)]);
    lock(&h.provider.reachable).extend([false, true]);
    h.provider.fake_resolve.store(true, Ordering::SeqCst);
    *lock(&task.test.done_wait) = Some(Box::new(|_: &CodexTask, _| false));
    assert!(task.wait_for_provider(true, None));
    assert_eq!(h.provider.probes.load(Ordering::SeqCst), 2);
    assert_eq!(*lock(&h.provider.resolved), [identity]);
    assert!(task.st().provider_available);
}

#[test]
fn closed_workspace_is_never_reopened_by_provider_recovery() {
    let h = Harness::with(|env, _| env.set("AGENT_WORKSPACE_ENGINE", "workspace"));
    let identity = task_recovery::begin(h.path(), "mac", "thread", None).unwrap();
    let (task, _) = h.task("work");
    task.st().recovery_id = Some(identity);
    *lock(&h.provider.repeat) = Some(Some(Reservation::Check));
    h.provider.always_reachable.store(true, Ordering::SeqCst);
    *lock(&task.test.done_wait) = Some(Box::new(|task: &CodexTask, _| {
        task.done.set();
        true
    }));
    assert!(!task.wait_for_provider(true, None));
    assert!(lock(&h.provider.resolved).is_empty());
    assert_eq!(
        task_recovery::current(h.path()).unwrap().unwrap()["status"],
        "active"
    );
}

#[test]
fn expired_wait_never_probes_or_dispatches() {
    let h = Harness::new();
    let identity = task_recovery::begin(h.path(), "mac", "thread", None).unwrap();
    let (task, session) = h.task("work");
    task.st().recovery_id = Some(identity);
    *lock(&h.provider.repeat) = Some(Some(Reservation::Expired));
    assert!(!task.wait_for_provider(true, None));
    assert_eq!(h.provider.probes.load(Ordering::SeqCst), 0);
    assert!(task.ended().contains("recovery window"));
    assert_eq!(session.released(), 1);
}
