//! Hive on the Mac with its brain in the cloud (src/cloud_brain.rs): this Mac serves the cloud agent's
//! calls on its tools, and what the owner asks goes to the cloud agent and is followed to its end,
//! against a fake board.

mod support;

use hive_app::cloud_brain::{Board, CloudBackend, MacPeer, MakeTools, Pace};
use hive_app::parts::{Backend, OnEvent};
use hive_common::tools::{result, text, ToolNamespace};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use support::{FakeBackend, Rec};

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

type Answer = Box<dyn Fn(&str, &str, &Value) -> Result<Value, String> + Send + Sync>;

/// A board answering each (method, path, body) with `answer`, and keeping what it was sent.
struct FakeBoard {
    answer: Answer,
    sent: Mutex<Vec<(String, String, Value)>>,
}

impl FakeBoard {
    fn new(answer: impl Fn(&str, &str, &Value) -> Result<Value, String> + Send + Sync + 'static) -> Arc<FakeBoard> {
        Arc::new(FakeBoard { answer: Box::new(answer), sent: Mutex::new(Vec::new()) })
    }
    fn sent(&self, path: &str) -> Vec<Value> {
        let asked = format!("{path}?");
        lock(&self.sent)
            .iter()
            .filter(|(_, p, _)| p == path || p.starts_with(&asked))
            .map(|(_, _, b)| b.clone())
            .collect()
    }
}

impl Board for FakeBoard {
    fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        lock(&self.sent).push(("POST".into(), path.into(), body.clone()));
        (self.answer)("POST", path, body)
    }
    fn get(&self, path: &str, _wait_s: u64) -> Result<Value, String> {
        lock(&self.sent).push(("GET".into(), path.into(), Value::Null));
        (self.answer)("GET", path, &Value::Null)
    }
    fn machine(&self) -> String {
        "Owner-MBP".into()
    }
}

/// The Mac's tools, keeping each call and the words they were given.
#[derive(Default)]
struct FakeTools {
    calls: Mutex<Vec<(String, Value, String)>>,
    words: Mutex<String>,
    took_over: Mutex<usize>,
}

impl ToolNamespace for FakeTools {
    fn namespace(&self) -> &'static str {
        "mac"
    }
    fn about(&self) -> &'static str {
        "The user's Mac"
    }
    fn tools(&self) -> Vec<Value> {
        vec![json!({"name": "screenshot", "description": "See the screen.", "inputSchema": {"type": "object"}})]
    }
    fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
        let words = lock(&self.words).clone();
        lock(&self.calls).push((tool.into(), args.clone(), words.clone()));
        match tool {
            "boom" => Err("the helper isn't running".into()),
            "send_message" if !words.contains("send it") => Ok(result(vec![text("Refused: quote the owner.")], true)),
            _ => Ok(result(vec![text("Finder is in front.")], false)),
        }
    }
    fn look(&self, _context: bool) -> Result<Value, String> {
        Ok(json!({}))
    }
    fn set_words(&self, words: &str) {
        *lock(&self.words) = words.to_owned();
    }
    fn took_over(&self) {
        *lock(&self.took_over) += 1;
    }
}

fn quick() -> Pace {
    Pace {
        wait_s: 0,
        follow: Duration::from_millis(5),
        retry: Duration::from_millis(5),
        most_retry: Duration::from_millis(20),
        idle: Duration::from_secs(60),
        lost: Duration::from_millis(200),
        fresh: Duration::from_secs(60),
        hello_again: Duration::from_secs(600),
    }
}

fn peer(board: Arc<FakeBoard>, tools: Arc<FakeTools>) -> Arc<MacPeer> {
    let make: MakeTools = Box::new(move || tools.clone() as Arc<dyn ToolNamespace>);
    MacPeer::new(board, make, quick())
}

fn events() -> (OnEvent, Arc<Rec<(String, String)>>) {
    let seen = Arc::new(Rec::default());
    let keep = seen.clone();
    (Arc::new(move |kind: &str, text: &str| keep.push((kind.to_owned(), text.to_owned()))), seen)
}

fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn the_mac_puts_its_tools_on_the_board_and_runs_each_call_with_the_owners_words() {
    let board = FakeBoard::new(|_, path, _| match path {
        p if p.starts_with("/v1/mac/next") => Ok(json!({"call": null})),
        _ => Ok(json!({"ok": true})),
    });
    let tools = Arc::new(FakeTools::default());
    let mac = peer(board.clone(), tools.clone());
    assert!(!mac.connected(), "not until the board answers");
    mac.hello().unwrap();
    assert_eq!(
        board.sent("/v1/mac/hello"),
        vec![json!({"mac": "owner-mbp", "tools": tools.tools(), "about": "The user's Mac"})]
    );
    assert_eq!(mac.next().unwrap(), None);
    assert!(mac.connected());
    assert!(lock(&board.sent).iter().any(|(_, p, _)| p == "/v1/mac/next?mac=owner-mbp&wait=0"));

    let (on_event, seen) = events();
    mac.listen(12, on_event);
    mac.run(&json!({"id": 5, "name": "screenshot", "arguments": {"step": "Look at the Mac"}, "request": 12,
                     "words": "what's in front on my mac"}));
    assert_eq!(
        lock(&tools.calls)[0],
        ("screenshot".into(), json!({"step": "Look at the Mac"}), "what's in front on my mac".into())
    );
    assert_eq!(
        board.sent("/v1/mac/result"),
        vec![json!({"id": 5, "result": {"content": [{"type": "text", "text": "Finder is in front."}], "isError": false}})]
    );
    assert_eq!(seen.all(), vec![("action".to_owned(), "Look at the Mac".to_owned())]);
}

#[test]
fn a_one_way_step_is_said_only_when_the_tools_took_it_and_a_failure_comes_back_as_its_result() {
    let board = FakeBoard::new(|_, _, _| Ok(json!({"ok": true})));
    let tools = Arc::new(FakeTools::default());
    let mac = peer(board.clone(), tools.clone());
    let (on_event, seen) = events();
    mac.listen(7, on_event);
    let send = |id: i64, words: &str| {
        mac.run(&json!({"id": id, "name": "send_message", "request": 7, "words": words,
                         "arguments": {"step": "One-way: send \"see you at 5\" to Sam"}}));
    };
    send(1, "tell Sam see you at 5");
    assert!(seen.all().is_empty(), "refused by the tools: nothing said");
    send(2, "send it");
    assert_eq!(seen.all(), vec![("announce".to_owned(), "send \"see you at 5\" to Sam".to_owned())]);

    mac.run(&json!({"id": 3, "name": "boom", "arguments": {}}));
    assert_eq!(
        board.sent("/v1/mac/result").last().unwrap(),
        &json!({"id": 3, "result": {"content": [{"type": "text", "text": "Failed: the helper isn't running"}], "isError": true}})
    );
    // A call for a request this Mac doesn't follow (asked from the phone) runs all the same.
    assert_eq!(lock(&tools.calls).len(), 3);
}

#[test]
fn the_mac_is_quiet_only_with_no_call_running_and_none_lately() {
    // hive_tasks::update waits for this before it restarts the agent on a new release.
    let mid_call: Arc<Mutex<Option<bool>>> = Arc::default();
    let me: Arc<Mutex<Option<std::sync::Weak<MacPeer>>>> = Arc::default();
    let (seen, slot) = (mid_call.clone(), me.clone());
    let board = FakeBoard::new(move |_, path, _| {
        if path == "/v1/mac/result" {
            let mac = lock(&slot).as_ref().and_then(std::sync::Weak::upgrade);
            *lock(&seen) = mac.map(|m| m.quiet_for(Duration::ZERO));
        }
        Ok(json!({"ok": true}))
    });
    let mac = peer(board, Arc::new(FakeTools::default()));
    *lock(&me) = Some(Arc::downgrade(&mac));
    assert!(!mac.quiet_for(Duration::from_secs(3600)), "it has only just started");
    mac.run(&json!({"id": 1, "name": "screenshot", "arguments": {}}));
    assert_eq!(*lock(&mid_call), Some(false), "a call that's running isn't quiet");
    assert!(mac.quiet_for(Duration::ZERO));
    assert!(!mac.quiet_for(Duration::from_secs(60)), "a call just ended");
}

/// A board with a cloud agent on it: a request is taken, works for `polls` looks, then ends `end`.
fn cloud_agent(end: Value, steps: Vec<Value>, tasks: Vec<Value>) -> Arc<FakeBoard> {
    let looks = Mutex::new(0);
    FakeBoard::new(move |method, path, _| match (method, path) {
        ("POST", "/v1/requests") => Ok(json!({"ok": true, "id": 31, "ahead": 0})),
        ("POST", "/v1/runs/message") => Ok(json!({"ok": true, "request": 32, "ahead": 0})),
        ("POST", "/v1/requests/stop") => Ok(json!({"ok": true, "stopping": 1, "ended": 0})),
        ("GET", p) if p.starts_with("/v1/requests/state?id=") => {
            let mut looks = lock(&looks);
            *looks += 1;
            let shown = steps.iter().take(*looks).cloned().collect::<Vec<_>>();
            let request = if *looks > steps.len() { end.clone() } else { json!({"status": "working", "outcome": null}) };
            Ok(json!({"request": request, "tasks": tasks, "steps": shown}))
        }
        (_, p) if p.starts_with("/v1/mac/next") => Ok(json!({"call": null})),
        _ => Ok(json!({"ok": true})),
    })
}

fn backend(board: Arc<FakeBoard>, connected: bool) -> (CloudBackend, Arc<FakeBackend>, Arc<MacPeer>) {
    let tools = Arc::new(FakeTools::default());
    let mac = peer(board.clone(), tools);
    if connected {
        mac.next().unwrap();
    }
    let local = Arc::new(FakeBackend::new(Arc::new(Rec::default())));
    (CloudBackend::new(local.clone(), board, mac.clone(), quick()), local, mac)
}

#[test]
fn a_request_goes_to_the_cloud_agent_and_its_replies_steps_and_end_come_back() {
    let steps = vec![
        json!({"run": "3101", "n": 1, "kind": "action", "text": "→ open_app: Open Calculator"}),
        json!({"run": "3101", "n": 1, "kind": "action", "text": "→ open_app: Open Calculator"}),
        json!({"run": "3101", "n": 2, "kind": "", "text": "⏳ Waiting for the owner's Mac: «Open Notes» is using it…"}),
        json!({"run": "3101", "n": 3, "kind": "say", "text": "💬 Calculator shows 4."}),
        json!({"run": "3101", "n": 4, "kind": "done", "text": "✅ Done."}),
    ];
    let tasks = vec![json!({"key": 1, "title": "Open Calculator", "status": "done"}), json!({"key": 2, "title": "Add 2 and 2", "status": "done"})];
    let board = cloud_agent(json!({"status": "done", "outcome": "All 2 tasks done."}), steps, tasks);
    let (brain, local, _) = backend(board.clone(), true);
    let task = brain.task("open calculator and add 2 and 2", None, "mac", None);
    let (on_event, seen) = events();
    task.set_on_event(on_event);
    task.start(false);
    assert!(task.wait_done(5.0));
    assert_eq!(board.sent("/v1/requests"), vec![json!({"text": "open calculator and add 2 and 2", "from": "mac"})]);
    assert_eq!(
        seen.all(),
        vec![
            ("plan".to_owned(), "1. Open Calculator\n2. Add 2 and 2".to_owned()),
            ("doing".to_owned(), "open_app: Open Calculator".to_owned()),
            ("doing".to_owned(), "⏳ Waiting for the owner's Mac: «Open Notes» is using it…".to_owned()),
            ("say".to_owned(), "Calculator shows 4.".to_owned()),
            ("done".to_owned(), "Calculator shows 4.".to_owned()),
        ]
    );
    assert!(!task.running());
    assert_eq!(task.final_text().as_deref(), Some("Calculator shows 4."));
    assert_eq!(task.ended(), "");
    assert!(local.tasks.all()[0].starts.all().is_empty(), "the Mac's Codex never ran it");

    // The next request that interrupts it follows it, as one conversation in the cloud.
    let next = brain.task("now times 3", Some("open calculator and add 2 and 2"), "mac", None);
    next.start(false);
    assert!(next.wait_done(5.0));
    assert_eq!(board.sent("/v1/runs/message"), vec![json!({"request": 31, "text": "now times 3", "from": "mac"})]);
}

#[test]
fn a_task_that_stops_for_the_owner_says_what_it_needs_and_a_failed_one_says_why() {
    let tasks = vec![json!({"key": 1, "title": "Pay the bill", "status": "waiting"})];
    let board = cloud_agent(json!({"status": "done", "outcome": "0 of 1 done; Pay the bill (waiting)."}), vec![], tasks);
    let (brain, _, _) = backend(board, true);
    let task = brain.task("pay my phone bill", None, "mac", None);
    task.start(false);
    assert!(task.wait_done(5.0));
    assert_eq!(task.final_text().as_deref(), Some("0 of 1 done; Pay the bill (waiting)."));
    assert_eq!(task.ended(), "0 of 1 done; Pay the bill (waiting).", "the shell shows it as needing the owner");

    let board = cloud_agent(json!({"status": "failed", "outcome": "Couldn't plan it: the model timed out"}), vec![], vec![]);
    let (brain, _, _) = backend(board, true);
    let task = brain.task("do the thing", None, "phone", None);
    task.start(false);
    assert!(task.wait_done(5.0));
    assert_eq!(task.final_text(), None);
    assert_eq!(task.ended(), "Couldn't plan it: the model timed out");
}

#[test]
fn the_windows_x_stops_the_request_in_the_cloud_and_the_task_ends_at_once() {
    let board = cloud_agent(json!({"status": "working"}), (1..1000).map(|n| json!({"run": "3101", "n": n, "kind": "", "text": "working"})).collect(), vec![]);
    let (brain, _, mac) = backend(board.clone(), true);
    let task = brain.task("open notes", None, "mac", None);
    let (on_event, seen) = events();
    task.set_on_event(on_event);
    task.start(false);
    until("the request is sent", || !board.sent("/v1/requests/state").is_empty());
    task.took_over();
    task.stop();
    assert!(!task.running());
    assert_eq!(task.ended(), "stopped");
    assert_eq!(seen.all().last().unwrap(), &("failed".to_owned(), "stopped".to_owned()));
    until("the cloud is told", || board.sent("/v1/requests/stop") == vec![json!({"id": 31})]);
    drop(mac);
}

#[test]
fn the_macs_codex_takes_it_when_the_cloud_cant_or_when_it_isnt_a_request() {
    // The board out of reach: said, then the Mac's Codex does it.
    let down = FakeBoard::new(|_, _, _| Err("Couldn't reach the cloud: timed out".into()));
    let (brain, local, _) = backend(down, false);
    let phone = brain.task("text mom on my phone", None, "phone", None);
    let (on_event, seen) = events();
    phone.set_on_event(on_event);
    phone.start(true);
    until("the Mac's Codex starts", || local.tasks.all().first().is_some_and(|t| t.starts.all() == vec![true]));
    assert!(seen.all()[0].1.starts_with("Hive's cloud agent can't be reached, so this runs on the Mac"));

    // A Mac task while this Mac isn't connected to the board: the cloud agent couldn't drive it.
    let board = cloud_agent(json!({"status": "done"}), vec![], vec![]);
    let (brain, local, _) = backend(board.clone(), false);
    let mac = brain.task("open notes", None, "mac", None);
    mac.start(false);
    assert_eq!(local.last().starts.all(), vec![false]);
    assert!(board.sent("/v1/requests").is_empty());

    // A document added to the conversation is a turn of the Mac's own Codex.
    let (brain, local, _) = backend(cloud_agent(json!({"status": "done"}), vec![], vec![]), true);
    let turn = brain.task("(adding “notes.pdf” to the conversation)", None, "mac", None);
    turn.set_durable_recovery(false);
    turn.set_prompt("the chunk".into());
    turn.start(false);
    assert_eq!(local.last().starts.all(), vec![false]);
    assert_eq!(lock(&local.last().prompt).as_deref(), Some("the chunk"));
}
