//! tests/test_resumption.py's ProcessRestartTest: a task on the stand-in app-server
//! (examples/fake_codex.rs), with each "worker" a new Agent (a new process, in Python) on the
//! same state folder, so the durable conversation is resumed across them.

use super::support::*;
use crate::util::lock;
use crate::{Agent, AppServer, CodexTask, Server, TaskOptions};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

/// The stand-in app-server `cargo test` builds alongside the tests.
pub fn fake_codex() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let path = exe
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/fake_codex");
    assert!(
        path.exists(),
        "{} is missing: run `cargo test`, which builds the example",
        path.display()
    );
    path
}

pub struct Outcome {
    pub thread: Option<String>,
    pub final_: Option<String>,
    pub error: String,
    pub events: Vec<(String, String)>,
}

/// Runs one request in a new agent (the WORKER script).
fn worker(base: &Harness, extra: &[(&str, &str)]) -> Outcome {
    let goal = extra.iter().any(|(k, _)| *k == "FAKE_CODEX_GOAL");
    let log = base.path().join("server.jsonl");
    let h = base.again(|env, config| {
        env.set("FAKE_CODEX_LOG", log.display().to_string());
        env.set("FAKE_CODEX_SECONDS", "0.01");
        env.set("FAKE_CODEX_REPLY", "Synthetic success");
        for (key, value) in extra {
            env.set(key, *value);
        }
        if goal {
            config.goal_watchdog_idle = 0.05;
            config.goal_watchdog_check = 0.02;
        }
    });
    let synthetic = json!({"content": [{"type": "text", "text": "synthetic tool result"},
                                       {"type": "image", "mimeType": "image/png", "data": "QUJD"}]});
    *lock(&h.mac.result) = Some(Ok(synthetic.clone()));
    *lock(&h.phone.result) = Some(Ok(synthetic));
    let fake = fake_codex().display().to_string();
    let stderr = base.path().join("fake-codex.err");
    *lock(&h.agent.server_factory) = Some(Box::new(move |agent: &Agent| {
        let log = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&stderr)?;
        let server: Arc<dyn Server> = AppServer::start(
            std::slice::from_ref(&fake),
            None,
            Some(log),
            None,
            &agent.env,
        )?;
        Ok(server)
    }));
    let prompt = extra
        .iter()
        .find(|(k, _)| *k == "TEST_PROMPT")
        .map(|(_, v)| *v)
        .unwrap_or("first request");
    let events = Events::default();
    let task = CodexTask::new(
        &h.agent,
        prompt,
        TaskOptions {
            on_event: Some(events.on_event()),
            ..TaskOptions::default()
        },
    )
    .start(true);
    assert!(task.wait_done(10.0), "task hung");
    until(2.0, || {
        events
            .all()
            .iter()
            .any(|(kind, _)| kind == "done" || kind == "failed")
    });
    if task.st().turn.is_some() {
        task.turn_over.wait(Some(3.0));
    }
    let outcome = Outcome {
        thread: task.thread_id(),
        final_: task.final_text(),
        error: task.ended(),
        events: events.all(),
    };
    h.agent.stop_server();
    outcome
}

fn entries(h: &Harness) -> Vec<Value> {
    std::fs::read_to_string(h.path().join("server.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn with(h: &Harness, key: &str) -> Vec<Value> {
    entries(h)
        .into_iter()
        .filter(|e| e.get(key).is_some())
        .collect()
}

#[test]
fn watchdog_continues_the_same_thread_and_reuses_tools() {
    let h = Harness::new();
    let result = worker(&h, &[("FAKE_CODEX_GOAL", "1")]);
    let turns = with(&h, "prompt");
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["thread"], turns[1]["thread"]);
    assert_eq!(result.thread.as_deref(), turns[0]["thread"].as_str());
    assert!(turns[1]["prompt"]
        .as_str()
        .unwrap()
        .contains("Continue the active goal"));
    assert_eq!(with(&h, "tool_reply").len(), 2);
    assert_eq!(result.final_.as_deref(), Some("Synthetic success"));
}

#[test]
fn server_crash_reconnects_the_same_thread_without_replaying_request() {
    let h = Harness::new();
    let result = worker(
        &h,
        &[
            ("FAKE_CODEX_GOAL", "1"),
            ("FAKE_CODEX_CRASH_ONCE", "1"),
            ("TEST_PROMPT", "do the original task"),
        ],
    );
    let turns = with(&h, "prompt");
    assert!(turns.len() >= 2);
    assert_eq!(with(&h, "started").len(), 1);
    let thread = json!(result.thread);
    assert_eq!(
        with(&h, "resumed")
            .iter()
            .map(|e| e["resumed"].clone())
            .collect::<Vec<_>>(),
        [thread.clone()] as [Value; 1]
    );
    assert!(turns.iter().all(|e| e["thread"] == thread));
    let replayed = turns
        .iter()
        .filter(|e| {
            e["prompt"]
                .as_str()
                .unwrap()
                .contains("do the original task")
        })
        .count();
    assert_eq!(replayed, 1);
    assert_eq!(result.final_.as_deref(), Some("Synthetic success"));
}

#[test]
fn new_application_and_server_process_resume_same_conversation() {
    let h = Harness::new();
    let first = worker(&h, &[]);
    let second = worker(&h, &[("TEST_PROMPT", "follow-up")]);
    assert_eq!(first.final_.as_deref(), Some("Synthetic success"));
    assert_eq!(second.final_.as_deref(), Some("Synthetic success"));
    assert_eq!(second.thread, first.thread);
    assert_eq!(with(&h, "started").len(), 1);
    assert_eq!(
        with(&h, "resumed")
            .iter()
            .map(|e| e["resumed"].clone())
            .collect::<Vec<_>>(),
        [json!(first.thread)]
    );
    let turns = with(&h, "prompt");
    assert!(turns[1]["prior_prompts"][0]
        .as_str()
        .unwrap()
        .contains("first request"));
    assert_eq!(turns[1]["tools"], json!(["mac", "phone", "knowledge"]));
    let records = h.context.all();
    let requests: Vec<_> = records
        .iter()
        .filter(|r| r.kind == "turn/start input")
        .collect();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].payload["input"][1]["url"],
        "data:image/png;base64,QUJD"
    );
    assert_eq!(requests[1].thread, first.thread); // the context is filed under the resumed thread
    assert!(records.iter().any(|r| r.kind == "thread/resume output"));
}

#[test]
fn workspace_mode_resumes_same_thread_without_physical_screenshot() {
    let h = Harness::new();
    let first = worker(&h, &[("AGENT_SPACEO_COMMAND", "/synthetic/spaceo")]);
    let second = worker(
        &h,
        &[
            ("AGENT_SPACEO_COMMAND", "/synthetic/spaceo"),
            ("TEST_PROMPT", "workspace follow-up"),
        ],
    );
    assert_eq!(first.thread, second.thread);
    assert_eq!(second.final_.as_deref(), Some("Synthetic success"));
    assert_eq!(with(&h, "started").len(), 1);
    assert_eq!(
        with(&h, "resumed")
            .iter()
            .map(|e| e["resumed"].clone())
            .collect::<Vec<_>>(),
        [json!(first.thread)]
    );
    let requests: Vec<_> = h
        .context
        .all()
        .into_iter()
        .filter(|r| r.kind == "turn/start input")
        .collect();
    assert!(!requests.is_empty());
    assert!(requests
        .iter()
        .all(|r| r.payload["input"].as_array().unwrap().len() == 1));
}

#[test]
fn failed_resume_is_reported_and_never_starts_or_runs_a_turn() {
    let h = Harness::new();
    let first = worker(&h, &[]);
    let failed = worker(&h, &[("FAKE_CODEX_RESUME_ERROR", "1")]);
    assert!(failed.final_.is_none());
    assert!(
        failed.error.contains("Conversation was not replaced"),
        "{}",
        failed.error
    );
    assert!(failed.events.iter().any(|(kind, _)| kind == "failed"));
    assert_eq!(with(&h, "started").len(), 1);
    assert_eq!(with(&h, "prompt").len(), 1);
    let saved = std::fs::read_to_string(h.path().join("codex-thread-id")).unwrap();
    assert_eq!(Some(saved.trim()), first.thread.as_deref());
    assert_eq!(worker(&h, &[]).thread, first.thread);
}
