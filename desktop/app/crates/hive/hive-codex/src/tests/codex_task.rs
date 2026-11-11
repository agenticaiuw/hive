//! tests/test_tools.py's CodexTaskTest: tasks on the stand-in app-server, started the way the app
//! starts Codex (`app_server_command` with CODEX_BIN pointing at examples/fake_codex.rs).

use super::process::fake_codex;
use super::support::*;
use crate::util::lock;
use crate::{
    focus, prompts, same_server, CodexTask, LookAhead, TaskOptions, LOOK_AHEAD_FRESH, MODEL,
};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;

struct Codex {
    h: Harness,
    events: Events,
}

impl Drop for Codex {
    fn drop(&mut self) {
        self.h.agent.stop_server();
    }
}

impl Codex {
    fn new(extra: &[(&str, &str)]) -> Codex {
        let h = Harness::with(|env, _| {
            env.set("CODEX_BIN", fake_codex().display().to_string());
            env.set("FAKE_CODEX_SECONDS", "0.3");
            env.set("FAKE_CODEX_REPLY", "Done on the phone.");
            for (key, value) in extra {
                env.set(key, *value);
            }
        });
        let log = h.path().join("codex.jsonl");
        h.agent.env.set("FAKE_CODEX_LOG", log.display().to_string());
        h.agent.new_session();
        Codex {
            h,
            events: Events::default(),
        }
    }

    fn entries(&self) -> Vec<Value> {
        std::fs::read_to_string(self.h.path().join("codex.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn turns(&self) -> Vec<Value> {
        self.entries()
            .into_iter()
            .filter(|e| e.get("prompt").is_some())
            .collect()
    }

    fn started(&self) -> Vec<Value> {
        self.entries()
            .into_iter()
            .filter_map(|e| e.get("started").cloned())
            .collect()
    }

    fn task_on(&self, request: &str, device: &str) -> Arc<CodexTask> {
        let options = TaskOptions {
            device: Some(device.into()),
            on_event: Some(self.events.on_event()),
            ..TaskOptions::default()
        };
        CodexTask::new(&self.h.agent, request, options).start(false)
    }

    fn task(&self) -> Arc<CodexTask> {
        self.task_on("open Maps", "phone")
    }

    /// Its reply, once its last event is in.
    fn wait(&self, task: &CodexTask) -> Option<String> {
        let reply = task.wait();
        until(2.0, || {
            self.events
                .all()
                .iter()
                .any(|(kind, _)| kind == "done" || kind == "failed")
        });
        reply
    }
}

#[test]
fn a_task_uses_our_instructions_and_tools() {
    let c = Codex::new(&[]);
    let task = c.task();
    assert_eq!(c.wait(&task).as_deref(), Some("Done on the phone."));
    until(2.0, || {
        c.events.last().is_some_and(|(kind, _)| kind == "done")
    });
    let run = c.turns().remove(0);
    let reply = c
        .entries()
        .into_iter()
        .find(|e| e.get("tool_reply").is_some())
        .unwrap();
    assert_eq!(run["tools"], json!(["mac", "phone", "knowledge"])); // every task can use both, and the knowledge base
    assert_eq!(run["model"], MODEL);
    assert_eq!(run["instructions"], c.h.agent.instructions().unwrap()); // in place of Codex's own
    let prompt = run["prompt"].as_str().unwrap();
    assert!(prompt.contains("This request is for the iPhone"));
    assert_eq!(run["effort"], "low");
    assert!(prompt.contains("\"open Maps\""));
    assert_eq!(
        reply["tool_reply"],
        json!({"success": true, "contentItems": [{"type": "inputText", "text": "Waited."}]})
    );
    assert!(c.events.has("action", "wait(seconds=0.1)"));
    assert_eq!(
        c.events.last(),
        Some(("done".into(), "Done on the phone.".into()))
    );
}

#[test]
fn tasks_share_one_codex() {
    let c = Codex::new(&[]);
    c.wait(&c.task());
    let server = c.h.agent.codex_server().unwrap();
    c.task().wait();
    assert!(same_server(&c.h.agent.codex_server().unwrap(), &server));
    assert_eq!(c.turns().len(), 2);
}

#[test]
fn requests_in_a_session_are_turns_on_one_thread() {
    let c = Codex::new(&[]);
    c.task().wait();
    c.task_on("No, the other one", "phone").wait();
    let turns = c.turns();
    let (first, second) = (&turns[0], &turns[1]);
    assert_eq!(second["thread"], first["thread"]); // so it has the first request in context
    assert!(second["prompt"]
        .as_str()
        .unwrap()
        .starts_with(prompts::FOCUS_PHONE)); // nothing more to tell it
    assert!(!first["prompt"].as_str().unwrap().contains("How to work"));
}

#[test]
fn tapping_fn_keeps_the_durable_session() {
    let c = Codex::new(&[]);
    c.task().wait();
    assert!(c.h.agent.new_session());
    c.task().wait();
    let turns = c.turns();
    assert_eq!(turns[1]["thread"], turns[0]["thread"]);
    assert_eq!(c.started().len(), 1);
}

#[test]
fn tapping_fn_prepares_without_replacing_a_ready_thread() {
    let c = Codex::new(&[]);
    c.task().wait(); // Codex is running
    c.h.agent.new_session();
    c.task().wait();
    assert_eq!(
        c.turns().last().unwrap()["thread"],
        *c.started().last().unwrap()
    );
    assert_eq!(c.started().len(), 1);
}

#[test]
fn the_reply_is_said_a_sentence_at_a_time_as_it_comes() {
    let c = Codex::new(&[(
        "FAKE_CODEX_REPLY",
        "Opened Maps. It shows three coffee shops nearby.",
    )]);
    let task = c.task();
    c.wait(&task);
    until(2.0, || {
        c.events.last().is_some_and(|(kind, _)| kind == "done")
    });
    let said: Vec<String> = c
        .events
        .all()
        .into_iter()
        .filter(|(k, _)| k == "say")
        .map(|(_, t)| t)
        .collect();
    assert_eq!(
        said,
        ["Opened Maps.", "It shows three coffee shops nearby."]
    );
    assert_eq!(
        c.events.last(),
        Some((
            "done".into(),
            "Opened Maps. It shows three coffee shops nearby.".into()
        ))
    );
    assert!(task.times().iter().any(|(step, _)| step == "words"));
    assert_eq!(task.calls_to_words(), 1);
}

#[test]
fn a_look_taken_as_you_started_talking_goes_with_the_request() {
    let c = Codex::new(&[]);
    let ahead = LookAhead::taking(|| {
        Some((
            "data:image/jpeg;base64,QUJD".into(),
            "Open windows: Notes \"Shopping\".".into(),
        ))
    });
    let options = TaskOptions {
        device: Some("mac".into()),
        ahead: Some(ahead),
        on_event: Some(c.events.on_event()),
        ..TaskOptions::default()
    };
    let task = CodexTask::new(&c.h.agent, "add milk to my list", options).start(true);
    task.wait();
    assert_eq!(c.h.mac.looks.load(Ordering::SeqCst), 0, "it looked again");
    let run = c.turns().remove(0);
    assert_eq!(run["images"], 1);
    assert!(run["prompt"]
        .as_str()
        .unwrap()
        .contains("Open windows: Notes \"Shopping\"."));
    assert!(c
        .events
        .has("action", "screenshot (taken as you started talking)"));
}

#[test]
fn a_stale_look_is_left_out() {
    let c = Codex::new(&[]);
    let ahead = LookAhead::taking(|| {
        Some((
            "data:image/jpeg;base64,QUJD".into(),
            "Open windows: Notes.".into(),
        ))
    });
    ahead.backdate(LOOK_AHEAD_FRESH + 1.0); // you started talking long ago
    *lock(&c.h.mac.look) = Err("no screenshot".into());
    let options = TaskOptions {
        device: Some("mac".into()),
        ahead: Some(ahead),
        ..TaskOptions::default()
    };
    let task = CodexTask::new(&c.h.agent, "add milk to my list", options).start(true);
    task.wait();
    assert_eq!(c.h.mac.looks.load(Ordering::SeqCst), 1); // it looked again, at the time of the request
    assert!(!task.looked_ahead());
    assert_eq!(c.turns()[0]["images"], 0);
}

#[test]
fn fast_tier() {
    let c = Codex::new(&[("AGENT_FAST", "1")]);
    c.task().wait();
    assert_eq!(c.turns()[0]["tier"], "priority");
    c.h.agent.env.set("AGENT_FAST", "");
    c.h.agent.new_session(); // listening keeps the saved thread and its tier
    c.task().wait();
    assert_eq!(c.turns()[1]["tier"], "priority");
}

#[test]
fn a_session_carries_on_while_a_request_is_under_way() {
    let c = Codex::new(&[("FAKE_CODEX_SECONDS", "60")]);
    let task = c.task();
    assert!(!c.h.agent.new_session());
    task.stop();
}

#[test]
fn a_request_that_replaces_a_stopped_one_waits_for_its_turn_to_end() {
    let c = Codex::new(&[("FAKE_CODEX_SECONDS", "60,0.3")]);
    let first = c.task();
    until(5.0, || c.events.has("action", "wait(seconds=0.1)"));
    first.stop();
    assert_eq!(
        c.task_on("open Maps, then search for coffee", "phone")
            .wait()
            .as_deref(),
        Some("Done on the phone.")
    );
    let turns = c.turns();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1]["thread"], turns[0]["thread"]);
}

#[test]
fn a_request_while_the_thread_is_busy_gets_its_own_and_is_told_later() {
    let c = Codex::new(&[("FAKE_CODEX_SECONDS", "60,0.3,0.3")]);
    let mac = c.task_on("open Notes", "mac");
    until(5.0, || c.turns().len() == 1);
    assert_eq!(c.task().wait().as_deref(), Some("Done on the phone.")); // the phone while the Mac works
    let turns = c.turns();
    let (on_mac, on_phone) = (&turns[0], &turns[1]);
    assert_ne!(on_phone["thread"], on_mac["thread"]);
    assert!(on_phone["prompt"]
        .as_str()
        .unwrap()
        .contains("They asked: \"open Notes\"\n  You: (still working on it)"));
    let unsubscribed = json!({"unsubscribed": on_phone["thread"]});
    until(5.0, || c.entries().contains(&unsubscribed));
    mac.stop();
    c.task_on("now do it again", "mac").wait();
    let again = c.turns().pop().unwrap();
    assert_eq!(again["thread"], on_mac["thread"]);
    let prompt = again["prompt"].as_str().unwrap();
    assert!(prompt.contains("They asked: \"open Maps\"\n  You: \"Done on the phone.\""));
    assert!(!prompt.contains("open Notes")); // it was on this thread
}

#[test]
fn stop_ends_the_turn() {
    let c = Codex::new(&[("FAKE_CODEX_SECONDS", "60")]);
    let task = c.task();
    until(5.0, || {
        c.events.all().iter().any(|(kind, _)| kind == "data")
    });
    std::thread::sleep(std::time::Duration::from_millis(200)); // the turn's events so far are in
    task.stop();
    assert_eq!(c.events.last(), Some(("failed".into(), "stopped".into())));
    assert!(!task.running());
    assert!(task.final_text().is_none());
}

#[test]
fn codex_runs_lean() {
    let c = Codex::new(&[]);
    std::fs::write(
        c.h.path().join("models_cache.json"),
        json!({"models": [{"slug": "m", "multi_agent_version": 2, "apply_patch_tool_type": "freeform"}]}).to_string(),
    )
    .unwrap();
    let cmd = c.h.agent.app_server_command().unwrap();
    assert_eq!(cmd[1], "app-server");
    let has = |o: &str| cmd.iter().any(|c| c == o);
    assert!(has("features.code_mode.direct_only_tool_namespaces=[\"mac\", \"phone\", \"knowledge\", \"spaceo\"]"));
    assert!(has("notify=[]"));
    assert!(has("include_permissions_instructions=false")); // not "the sandbox only permits reading"
    let catalog: Vec<&str> = cmd
        .iter()
        .filter_map(|c| c.strip_prefix("model_catalog_json="))
        .collect();
    assert_eq!(catalog.len(), 1);
    let path: String = serde_json::from_str(catalog[0]).unwrap();
    let models: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let models = models["models"].as_array().unwrap();
    assert!(!models.is_empty());
    assert!(models.iter().all(|m| m["tool_mode"] == "direct"
        && m.get("multi_agent_version").is_none()
        && m.get("apply_patch_tool_type").is_none()));
}

#[test]
fn tool_results_become_codex_replies() {
    use hive_common::tools::{image, result, text, tool_reply};
    let res = result(vec![text("Clicked."), image("image/jpeg", "QUJD")], false);
    assert_eq!(
        tool_reply(&res),
        json!({"success": true, "contentItems": [{"type": "inputText", "text": "Clicked."},
                                                 {"type": "inputImage", "imageUrl": "data:image/jpeg;base64,QUJD"}]})
    );
    assert_eq!(
        tool_reply(&result(vec![text("no")], true))["success"],
        false
    );
    let h = Harness::new();
    let specs = h.agent.tool_specs();
    let names: Vec<&str> = specs.iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["mac", "phone", "knowledge"]);
    let tools = |i: usize| -> Vec<String> {
        specs[i]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(tools(2), ["lookup", "save"]);
    assert!(tools(0).contains(&"batch".to_owned()));
    assert!(tools(1).contains(&"tap".to_owned()));
}

#[test]
fn a_request_that_says_phone_starts_on_the_phone() {
    assert_eq!(focus("Open Maps on my phone"), "phone");
    assert_eq!(focus("check the weather on the iPhone"), "phone");
    assert_eq!(focus("what's my phone number"), "mac");
    assert_eq!(focus("open Safari"), "mac");
    let h = Harness::new();
    assert_eq!(
        CodexTask::new(&h.agent, "open Maps on my phone", TaskOptions::default()).device(),
        "phone"
    );
}

// -- tests/test_voice.py: the request is the goal ------------------------------------------------

#[test]
fn a_request_is_the_goal_codex_keeps_working_on_until_done() {
    let c = Codex::new(&[]);
    c.wait(&c.task_on("Open Safari.", "mac"));
    let goals: Vec<Value> = c
        .entries()
        .into_iter()
        .filter_map(|e| e.get("goal").cloned())
        .collect();
    assert!(
        !goals.is_empty(),
        "no goal was set, so the first turn to end would end the task"
    );
    assert_eq!(goals[0]["status"], "active");
    assert!(goals[0]["objective"].as_str().unwrap().contains("Safari"));
}

// -- tests/test_agent_workspace_tools.py: the background workspace's tools -----------------------

/// The workspace hook, recording what it was asked.
#[derive(Default)]
struct ScriptedWorkspace {
    asked: std::sync::Mutex<Vec<Value>>,
}

impl crate::hooks::WorkspaceTools for ScriptedWorkspace {
    fn workspace(&self, request: &Value) -> Result<Value, String> {
        lock(&self.asked).push(request.clone());
        Ok(json!({"content": [{"type": "text", "text": "workspace ready"}]}))
    }
}

/// A task in workspace mode (`AGENT_SPACEO_COMMAND`), its workspace hook and its mac's tools.
fn workspace_task(h: &Harness) -> (Arc<CodexTask>, Arc<ScriptedWorkspace>, Arc<FakeTool>) {
    let workspace = Arc::new(ScriptedWorkspace::default());
    let mut hooks = h.agent.hooks.clone();
    hooks.workspace_tools = workspace.clone();
    let env = crate::Env::default();
    for key in ["AGENT_STATE_DIR", "CODEX_HOME", "AGENT_ENV_FILE"] {
        env.set(key, h.agent.env.get(key).unwrap());
    }
    env.set("AGENT_SPACEO_COMMAND", "/engine");
    let agent = crate::Agent::new(env, h.agent.config.clone(), hooks);
    let task = CodexTask::new(
        &agent,
        "test",
        TaskOptions {
            session: Some(Arc::new(MockSession::default())),
            ..TaskOptions::default()
        },
    );
    let mac = FakeTool::new("mac");
    let tools: std::collections::HashMap<String, Arc<dyn hive_common::tools::ToolNamespace>> =
        [("mac".to_owned(), mac.clone() as Arc<dyn hive_common::tools::ToolNamespace>)].into();
    *lock(&task.tools) = tools;
    (task, workspace, mac)
}

#[test]
fn physical_mouse_cannot_be_used_in_workspace_mode() {
    let h = Harness::new();
    let (task, workspace, mac) = workspace_task(&h);
    let reply =
        task.call_tool(&json!({"namespace": "mac", "tool": "click", "arguments": {"x": 1, "y": 1}}));
    assert_eq!(reply["success"], false);
    assert!(lock(&mac.calls).is_empty());
    assert!(lock(&workspace.asked).is_empty());
}

#[test]
fn workspace_request_is_dispatched_in_host_process() {
    let h = Harness::new();
    let (task, workspace, mac) = workspace_task(&h);
    let reply = task.call_tool(&json!({"namespace": "mac", "tool": "read_ingested",
                                       "arguments": {"id": "workspace:{\"name\":\"spaceo_session_list\"}"}}));
    assert_eq!(reply["success"], true);
    assert_eq!(*lock(&workspace.asked), [json!({"name": "spaceo_session_list"})]);
    assert!(lock(&mac.calls).is_empty());
}

#[test]
fn legacy_typed_tool_routes_to_workspace_without_physical_input() {
    let h = Harness::new();
    let (task, workspace, mac) = workspace_task(&h);
    let reply = task.call_tool(&json!({"namespace": "mac", "tool": "type_text",
                                       "arguments": {"text": "workspace:{\"method\":\"list\"}"}}));
    assert_eq!(reply["success"], true);
    assert_eq!(*lock(&workspace.asked), [json!({"method": "list"})]);
    assert!(lock(&mac.calls).is_empty());
}
