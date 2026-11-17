//! Hive on the Mac handing a task to the owner's browser agent through the board (hive_tasks::handoff).

use hive_common::tools::ToolNamespace;
use hive_tasks::handoff::{browser_machine, Board, HandOff};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

/// A board that records each call and answers GET /v1/runs with the next of `reads`.
struct FakeBoard {
    calls: Mutex<Vec<(String, String, Value)>>,
    reads: Mutex<Vec<Value>>,
    refuse_message: bool,
}

impl FakeBoard {
    fn new(reads: Vec<Value>) -> Arc<FakeBoard> {
        Arc::new(FakeBoard { calls: Mutex::new(vec![]), reads: Mutex::new(reads), refuse_message: false })
    }
}

impl Board for FakeBoard {
    fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push(("POST".into(), path.into(), body.clone()));
        match path {
            "/v1/runs/message" if self.refuse_message => Err("The cloud said 404: No such agent.".into()),
            "/v1/runs/message" => Ok(json!({"ok": true, "message": {"id": 41, "status": "queued"}})),
            _ => Ok(json!({"ok": true})),
        }
    }
    fn get(&self, path: &str) -> Result<Value, String> {
        self.calls.lock().unwrap().push(("GET".into(), path.into(), Value::Null));
        let mut reads = self.reads.lock().unwrap();
        Ok(if reads.len() > 1 { reads.remove(0) } else { reads[0].clone() })
    }
}

fn read(status: &str, message: &str, steps: &[&str]) -> Value {
    json!({
        "run": {"status": status},
        "steps": steps.iter().enumerate().map(|(i, t)| json!({"n": i + 1, "text": t})).collect::<Vec<_>>(),
        "messages": [{"id": 41, "status": message, "detail": if message == "failed" { "This browser's agent has nothing to think with." } else { "" }}],
    })
}

fn text_of(result: &Value) -> String {
    result["content"][0]["text"].as_str().unwrap_or("").to_owned()
}

#[test]
fn a_task_for_the_browser_becomes_its_run_and_comes_back_with_what_it_did() {
    let board = FakeBoard::new(vec![
        read("working", "queued", &[]),
        read("working", "delivered", &["navigate: canvas.test"]),
        read("done", "delivered", &["navigate: canvas.test", "A in CS 400."]),
    ]);
    let slept = Arc::new(Mutex::new(0));
    let naps = slept.clone();
    let tools = HandOff::with(board.clone(), "ext:mac-browser", move |_| *naps.lock().unwrap() += 1);
    let done = tools
        .call("hand_off", &json!({"step": "Asking the browser for grades", "to": "browser", "task": "Find my CS 400 grade on Canvas"}))
        .unwrap();
    assert_eq!(done["isError"], false);
    assert!(text_of(&done).starts_with("The browser agent finished (run handoff-"));
    assert!(text_of(&done).contains("- A in CS 400."));
    assert_eq!(*slept.lock().unwrap(), 2);

    let calls = board.calls.lock().unwrap();
    let (_, path, made) = &calls[0];
    assert_eq!(path, "/v1/runs");
    let run = made["run"].as_str().unwrap().to_owned();
    assert_eq!(made, &json!({"machine": "ext:mac-browser", "run": run, "agent": "browser",
                             "title": "Find my CS 400 grade on Canvas", "status": "queued"}));
    assert_eq!(calls[1], ("POST".into(), "/v1/runs/message".into(),
        json!({"machine": "ext:mac-browser", "run": run, "text": "Find my CS 400 grade on Canvas", "from": "mac"})));
    assert_eq!(calls[2].1, format!("/v1/runs?machine=ext%3Amac-browser&run={run}&tail=30"));
}

#[test]
fn a_browser_that_isnt_listening_or_cant_do_it_is_said_in_words() {
    let board = FakeBoard::new(vec![read("working", "queued", &[])]);
    let tools = HandOff::with(board, "ext:mac-browser", |_| {});
    let waiting = tools.call("hand_off", &json!({"step": "s", "task": "Open my mail", "wait_s": 0})).unwrap();
    assert_eq!(waiting["isError"], false);
    assert!(text_of(&waiting).starts_with("Not picked up yet"), "{}", text_of(&waiting));
    assert!(text_of(&waiting).contains("check_hand_off run handoff-"));

    let board = FakeBoard::new(vec![read("working", "failed", &[])]);
    let failed = HandOff::with(board, "ext:mac-browser", |_| {}).call("hand_off", &json!({"step": "s", "task": "Open my mail"})).unwrap();
    assert_eq!(failed["isError"], true);
    assert_eq!(text_of(&failed), "The browser agent couldn't take it: This browser's agent has nothing to think with.");

    let board = Arc::new(FakeBoard { calls: Mutex::new(vec![]), reads: Mutex::new(vec![Value::Null]), refuse_message: true });
    let refused = HandOff::with(board, "ext:mac-browser", |_| {}).call("hand_off", &json!({"step": "s", "task": "x"}));
    assert_eq!(refused.unwrap_err(), "The cloud said 404: No such agent.");
}

#[test]
fn checking_on_a_hand_off_reads_its_run_and_the_tools_say_their_step() {
    let board = FakeBoard::new(vec![read("working", "delivered", &["read_page: inbox"])]);
    let tools = HandOff::with(board.clone(), "ext:mac-browser", |_| {});
    let so_far = tools.call("check_hand_off", &json!({"step": "s", "run": "handoff-1", "wait_s": 0})).unwrap();
    assert!(text_of(&so_far).starts_with("Still working (run handoff-1); so far:\n- read_page: inbox"));
    assert_eq!(board.calls.lock().unwrap()[0].1, "/v1/runs?machine=ext%3Amac-browser&run=handoff-1&tail=30");

    assert_eq!(tools.namespace(), "agents");
    for tool in tools.tools() {
        assert_eq!(tool["inputSchema"]["required"][0], "step", "{}", tool["name"]);
    }
    assert_eq!(browser_machine("ext.mac-browser.abc123").as_deref(), Some("ext:mac-browser"));
    assert_eq!(browser_machine("not-a-key"), None);
}
