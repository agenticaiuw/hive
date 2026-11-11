//! tests/test_one_way.py's driver half (bc09c57): the caption is the agent's own `step`, a one-way
//! step the user asked for is said aloud, the tools are told what the user said, the shell lets go
//! of the mouse, and Codex's shell can reach the internet.

use super::support::*;
use crate::describe::doing;
use crate::session::TaskSession;
use crate::task::{CodexTask, TaskOptions};
use crate::util::{lock, unix_time};
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::Arc;

const ASKED: &str = r#"send the backup to the general channel saying "I decided to delete the all-members channel""#;

fn task_with_events(h: &Harness, text: &str) -> (Arc<CodexTask>, Events) {
    let events = Events::default();
    let task = CodexTask::new(
        &h.agent,
        text,
        TaskOptions {
            session: Some(Arc::new(MockSession::default())),
            on_event: Some(events.on_event()),
            ..TaskOptions::default()
        },
    );
    (task, events)
}

#[test]
fn the_caption_is_the_agents_own_step() {
    let item = json!({"tool": "click", "arguments": {"x": 1, "y": 2, "step": "Opening the #general channel."}});
    assert_eq!(doing(&item), "Opening the #general channel.");
    assert_eq!(
        doing(&json!({"tool": "click", "arguments": {"x": 1, "y": 2}})),
        "Clicking"
    );
    let long = "x".repeat(300);
    assert_eq!(
        doing(&json!({"tool": "click", "arguments": {"step": format!("  {long}")}})).len(),
        200
    );
}

#[test]
fn a_one_way_step_the_user_asked_for_is_said_aloud() {
    let h = Harness::new();
    let (task, events) = task_with_events(&h, ASKED);
    let started = |step: &str| {
        task.on_message(
            "item/started",
            &json!({"item": {"type": "dynamicToolCall", "namespace": "mac", "tool": "press_key",
                             "arguments": {"keys": "return", "step": step}}}),
        )
    };
    started("One-way: posting your message in #general (you said: \"send the backup to the general channel\").");
    started("One-way: asking the bot (you said: \"please export all-members\")");
    started("Opening the #general channel.");
    let announced: Vec<String> = events
        .all()
        .into_iter()
        .filter(|(k, _)| k == "announce")
        .map(|(_, t)| t)
        .collect();
    assert_eq!(
        announced,
        ["posting your message in #general (you said: \"send the backup to the general channel\")."]
    );
    assert!(events.has("doing", "Opening the #general channel."));
}

#[test]
fn the_tools_are_told_what_the_user_said_lately() {
    let h = Harness::new();
    let session = h.agent.session();
    let make = |text: &str, started: f64| {
        let task = CodexTask::new(
            &h.agent,
            text,
            TaskOptions {
                session: Some(session.clone()),
                ..TaskOptions::default()
            },
        );
        task.st().started_at = started;
        TaskSession::add(session.as_ref(), &task);
        task
    };
    make("an old request", unix_time() - 3.0 * 3600.0);
    make("never started", 0.0);
    make("save the general channel", unix_time() - 60.0);
    let task = make(ASKED, unix_time());
    assert_eq!(task.words(), format!("save the general channel\n{ASKED}"));
    task.restore_task().ok();
    assert_eq!(*lock(&h.mac.words), task.words());
    assert_eq!(*lock(&h.phone.words), task.words());
    assert!(task.device_tool("mac").is_some());
}

#[test]
fn a_shell_command_lets_go_of_the_mouse() {
    let h = Harness::new();
    let (task, events) = task_with_events(&h, "back up the channel");
    *lock(&task.tools) = h.agent.device_tools();
    task.on_message(
        "item/started",
        &json!({"item": {"type": "commandExecution", "command": "curl -s example.com"}}),
    );
    until(2.0, || h.mac.let_go.load(Ordering::SeqCst) == 1);
    assert_eq!(h.phone.let_go.load(Ordering::SeqCst), 0);
    assert!(events.has("doing", "Running a local command"));
}

#[test]
fn codex_s_shell_can_reach_the_internet() {
    let h = Harness::new();
    let params = h.agent.thread_params().unwrap();
    assert_eq!(params["sandbox"], "workspace-write");
    assert_eq!(
        params["config"],
        json!({"sandbox_workspace_write": {"network_access": true}})
    );
    let spaceo = Harness::with(|env, _| env.set("AGENT_SPACEO_COMMAND", "true"));
    let params = spaceo.agent.thread_params().unwrap();
    assert!(params.get("config").is_none());
    assert_eq!(params["permissions"], "personal-agent");
}
