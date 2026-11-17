//! Hive's runs on this Mac, from its session journal to the board (POST /v1/runs).

use hive_tasks::runs::{RunStream, Runs};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn sender(posts: &Arc<Mutex<Vec<Value>>>) -> impl FnMut(&Value) -> Result<(), String> {
    let posts = posts.clone();
    move |body: &Value| {
        posts.lock().unwrap().push(body.clone());
        Ok(())
    }
}

#[test]
fn a_request_is_a_run_its_lines_are_steps_and_done_ends_it() {
    let posts = Arc::new(Mutex::new(vec![]));
    let mut post = sender(&posts);
    let mut runs = Runs::new("20261116-204103-1", "studio-mac");
    assert!(!runs.note("you said", "open notes", "", 1));
    assert!(!runs.note("request", "Open Notes", "", 1));
    runs.send(&mut post);
    assert!(!runs.note("action", "screenshot (attached to the request)", "Open Notes", 2));
    assert!(!runs.note("think", "**Opening Notes**", "Open Notes", 3));
    assert!(!runs.note("listening", "", "", 3));
    assert!(runs.note("done", "Notes is open.", "Open Notes", 4));
    runs.send(&mut post);
    runs.send(&mut post); // nothing new: nothing sent
    let posts = posts.lock().unwrap();
    assert_eq!(posts.len(), 2);
    assert_eq!(
        posts[0],
        json!({"machine": "studio-mac", "run": "20261116-204103-1-1", "agent": "mac",
               "title": "Open Notes", "steps": []})
    );
    assert_eq!(posts[1]["status"], "done");
    let steps: Vec<(u64, &str, &str)> = posts[1]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["n"].as_u64().unwrap(), s["kind"].as_str().unwrap(), s["text"].as_str().unwrap()))
        .collect();
    assert_eq!(
        steps,
        [
            (1, "action", "screenshot (attached to the request)"),
            (2, "think", "**Opening Notes**"),
            (3, "done", "Notes is open."),
        ]
    );
}

#[test]
fn a_cloud_that_is_away_gets_the_steps_later_and_fn_stops_the_run() {
    let mut refuse = true;
    let mut got: Vec<Value> = vec![];
    let mut runs = Runs::new("s", "studio-mac");
    runs.note("request", "Play focus music", "", 1);
    runs.note("action", "open_app(name=\"Spotify\")", "Play focus music", 2);
    runs.send(&mut |_: &Value| Err("Couldn't reach the cloud".to_string()));
    runs.note("say", "Playing.", "Play focus music", 3);
    assert!(runs.note("stopped by fn", "", "", 4));
    runs.send(&mut |body: &Value| {
        if refuse {
            refuse = false;
            return Err("once more".into());
        }
        got.push(body.clone());
        Ok(())
    });
    runs.send(&mut |body: &Value| {
        got.push(body.clone());
        Ok(())
    });
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["status"], "stopped");
    let texts: Vec<&str> = got[0]["steps"].as_array().unwrap().iter().map(|s| s["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["open_app(name=\"Spotify\")", "Playing."]);
}

#[test]
fn the_stream_sends_what_is_left_when_hive_closes() {
    let posts = Arc::new(Mutex::new(vec![]));
    let stream = RunStream::start_with("s", "studio-mac", sender(&posts));
    stream.note("request", "Check my email", &json!({"device": "mac"}));
    stream.note("action", "screenshot()", &json!({"request": "Check my email"}));
    stream.note("failed", "Mail wouldn't open.", &json!({"request": "Check my email"}));
    drop(stream);
    let posts = posts.lock().unwrap();
    let last = posts.last().unwrap();
    assert_eq!(last["status"], "failed");
    let all: Vec<&str> = posts
        .iter()
        .flat_map(|p| p["steps"].as_array().unwrap().iter().map(|s| s["text"].as_str().unwrap()))
        .collect();
    assert_eq!(all, ["screenshot()", "Mail wouldn't open."]);
}
