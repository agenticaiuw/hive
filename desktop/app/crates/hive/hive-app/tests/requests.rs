//! Requests and what becomes of them: the request socket's (tests/test_local_request.py's voice
//! cases), the request ledger's receipts (tests/test_ui_ingress.py's voice cases), the context
//! panel and the conversation (tests/test_resumption.py's VoiceContextTest), and a task's events.

mod support;

use hive_app::parts::LocalRequest;
use hive_app::real::Codex;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::{FakeTask, Harness, Isolated, Rec, Setup};

fn request(
    text: &str,
    expired: bool,
    resume_goal: bool,
    objective: Option<&str>,
) -> (LocalRequest, Arc<Rec<Value>>) {
    let replies: Arc<Rec<Value>> = Arc::default();
    let into = replies.clone();
    let deadline = if expired {
        Instant::now().checked_sub(Duration::from_secs(1)).unwrap()
    } else {
        Instant::now() + Duration::from_secs(2)
    };
    let request = LocalRequest {
        text: text.to_owned(),
        resume_goal,
        goal_objective: objective.map(str::to_owned),
        receipt_id: None,
        deadline,
        reply: Box::new(move |reply| into.push(reply)),
    };
    (request, replies)
}

fn ok(replies: &Rec<Value>) -> bool {
    assert_eq!(replies.len(), 1, "{:?}", replies.all());
    replies.all()[0]["ok"] == json!(true)
}

// -- the request socket --

#[test]
fn active_task_is_not_interrupted() {
    let h = Harness::new();
    h.agent.tasks.lock().mac = Some(FakeTask::running("work", "mac"));
    let (request, replies) = request("plan", false, false, None);
    h.agent.on_local_request(request);
    assert!(!ok(&replies));
    assert_eq!(
        replies.all()[0]["error"],
        "The personal-agent is already working."
    );
    assert!(h.backend.tasks.is_empty());
}

#[test]
fn expired_request_does_not_start() {
    let h = Harness::new();
    let (request, replies) = request("plan", true, false, None);
    h.agent.on_local_request(request);
    assert!(!ok(&replies));
    assert_eq!(
        replies.all()[0]["error"],
        "The request expired before it could start."
    );
    assert!(h.backend.tasks.is_empty());
}

#[test]
fn explicit_resume_uses_the_existing_thread() {
    let h = Harness::new();
    std::fs::write(h.state().join("codex-thread-id"), "existing-thread").unwrap();
    let (request, replies) = request("continue", false, true, None);
    h.agent.on_local_request(request);
    assert!(ok(&replies));
    assert_eq!(
        h.backend.requests.all(),
        [(
            "thread/goal/set".to_owned(),
            json!({"threadId": "existing-thread", "status": "active", "origin": "user"}),
            3.0
        )]
    );
    // on_transcript("continue", typed=True, captured=True, ingress_receipt=None)
    assert_eq!(h.backend.texts(), ["continue"]);
    assert!(h.host.admits.is_empty());
    assert_eq!(*support::lock(&h.backend.last().receipt), None);
    assert_eq!(h.captions.of("agent_request"), ["continue"]);
}

#[test]
fn explicit_goal_rewrite_updates_existing_thread() {
    let h = Harness::new();
    std::fs::write(h.state().join("codex-thread-id"), "existing-thread\n").unwrap();
    let (request, replies) = request("continue", false, true, Some("New objective"));
    h.agent.on_local_request(request);
    assert!(ok(&replies));
    assert_eq!(
        h.backend.requests.all()[0].1,
        json!({"threadId": "existing-thread", "status": "active", "origin": "user", "objective": "New objective"})
    );
}

#[test]
fn a_goal_is_not_resumed_without_codex() {
    let h = Harness::new();
    h.backend.server.store(false, Ordering::SeqCst);
    std::fs::write(h.state().join("codex-thread-id"), "existing-thread").unwrap();
    let (request, replies) = request("continue", false, true, None);
    h.agent.on_local_request(request);
    assert!(!ok(&replies));
    assert_eq!(
        replies.all()[0]["error"],
        "Codex server is not ready; goal was not resumed."
    );
    assert!(h.backend.tasks.is_empty());
}

#[test]
fn another_programs_request_shows_as_one_short_line() {
    let h = Harness::new();
    let long = format!("Summarize {}", "the meeting notes ".repeat(30));
    let (request, replies) = request(&long, false, false, None);
    h.agent.on_local_request(request);
    assert!(ok(&replies));
    let shown = h.captions.of("agent_request");
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].chars().count(), 161, "{}", shown[0]); // 160, and "…"
    assert!(shown[0].ends_with("notes the me…"));
}

// -- the request ledger --

#[test]
fn ui_admission_before_start_and_receipt_linked() {
    let h = Harness::new();
    h.agent
        .on_transcript("Do useful work", None, true, false, None);
    assert_eq!(h.trace.all(), ["admit", "start", "finish"]);
    assert_eq!(
        h.host.admits.all(),
        [("Do useful work".to_owned(), "typed".to_owned())]
    );
    assert_eq!(
        support::lock(&h.backend.last().receipt).as_deref(),
        Some("receipt-1")
    );
    assert_eq!(
        h.host.finishes.all(),
        [("receipt-1".to_owned(), "accepted".to_owned())]
    );
}

#[test]
fn store_failure_fails_closed_before_new_work() {
    let h = Harness::new();
    *support::lock(&h.host.admit_error) = Some("unavailable".into());
    h.agent
        .on_transcript("Do useful work", None, true, false, None);
    assert!(h.backend.tasks.is_empty());
    assert!(h.has_printed("Could not save the request; it was not started: unavailable"));
}

#[test]
fn stop_executes_before_failed_receipt() {
    let h = Harness::new();
    let task = FakeTask::running("work", "mac");
    h.agent.tasks.lock().mac = Some(task.clone());
    *support::lock(&h.host.admit_error) = Some("unavailable".into());
    h.agent.on_transcript("stop", None, true, false, None);
    assert_eq!(task.stop_count(), 1);
    assert!(h.agent.tasks.get().mac.is_none());
    assert_eq!(h.voice.said.all(), ["Stopped."]);
    assert!(h.has_printed("Stopped, but could not save its receipt: unavailable"));
}

#[test]
fn stop_fences_a_persisted_wait_without_an_in_memory_task() {
    // the real files (task_recovery, provider_wait) through the real Codex backend
    let env = Isolated::new();
    let state = env.path().to_path_buf();
    let identity = hive_codex::task_recovery::begin(&state, "mac", "thread", None).unwrap();
    hive_codex::provider_wait::arm(&state, &identity, None).unwrap();
    let codex = hive_codex::Agent::new(
        hive_codex::Env::default(),
        hive_codex::Config::default(),
        hive_codex::Hooks::default(),
    );
    let h = Harness::isolated(
        env,
        Setup {
            backend: Some(Arc::new(Codex(codex))),
            ..Setup::default()
        },
    );
    h.agent.on_transcript("stop", None, true, false, None);
    let saved = hive_codex::task_recovery::current(&state)
        .unwrap()
        .expect("the saved request");
    assert_eq!(saved["status"], "stopped");
    assert_eq!(
        h.host.finishes.all(),
        [("receipt-1".to_owned(), "accepted".to_owned())]
    );
}

#[test]
fn previously_captured_socket_request_is_not_recaptured() {
    let h = Harness::new();
    h.agent.on_transcript(
        "Do useful work",
        None,
        true,
        true,
        Some("socket-receipt".into()),
    );
    assert!(h.host.admits.is_empty());
    assert_eq!(
        support::lock(&h.backend.last().receipt).as_deref(),
        Some("socket-receipt")
    );
    // another program sent it, not you
    assert!(h
        .captions
        .of("activity")
        .contains(&"Request from another agent: Do useful work".to_owned()));
}

#[test]
fn short_acknowledgement_is_captured_without_starting_work() {
    let h = Harness::new();
    h.agent.on_transcript("okay", None, true, false, None);
    assert_eq!(
        h.host.admits.all(),
        [("okay".to_owned(), "typed".to_owned())]
    );
    assert_eq!(
        h.host.finishes.all(),
        [("receipt-1".to_owned(), "accepted".to_owned())]
    );
    assert!(h.backend.tasks.is_empty());
}

#[test]
fn what_you_say_is_admitted_on_the_voice_channel() {
    let h = Harness::new();
    h.agent.listening.set(true);
    h.say("Open Safari.");
    h.drain();
    assert_eq!(
        h.host.admits.all(),
        [("Open Safari.".to_owned(), "voice".to_owned())]
    );
}

// -- the context panel and the conversation --

#[test]
fn context_event_is_forwarded_even_for_an_interrupted_task() {
    let h = Harness::app();
    let interrupted = FakeTask::new("old", "mac").as_task();
    h.agent
        .on_task_event(&interrupted, "context", "/tmp/synthetic/index.html");
    assert_eq!(h.printed(), ["@@ context /tmp/synthetic/index.html"]);
}

#[test]
fn listening_toggle_preserves_session_identity() {
    let env = Isolated::new();
    let codex = hive_codex::Agent::new(
        hive_codex::Env::default(),
        hive_codex::Config::default(),
        hive_codex::Hooks::default(),
    );
    let session = codex.session();
    let h = Harness::isolated(
        env,
        Setup {
            backend: Some(Arc::new(Codex(codex.clone()))),
            ..Setup::default()
        },
    );
    h.agent.set_listening(true);
    h.agent.set_listening(false);
    h.agent.set_listening(true);
    assert!(Arc::ptr_eq(&codex.session(), &session));
    assert!(codex.running_server().is_none()); // (and no Codex was started)
}

// -- a task's events --

/// A request on the Mac, started by what you said.
fn asked(h: &Harness, text: &str) -> Arc<FakeTask> {
    h.agent.on_transcript(text, None, true, false, None);
    h.backend.last()
}

#[test]
fn its_reply_is_said_once_and_the_mac_handed_back() {
    let h = Harness::new();
    let task = asked(&h, "Open Calculator and work out 12 times 34.");
    task.emit("doing", "Looking at the screen");
    task.emit("say", "Calculator shows 408.");
    task.finish("Calculator shows 408.");
    h.drain();
    assert_eq!(h.voice.said.all(), ["Calculator shows 408."]); // once, though Codex says it twice
    assert!(
        h.printed().iter().any(|l| l.starts_with("✅ done in ")),
        "{:?}",
        h.printed()
    );
    assert!(h.has_printed("   💬 Calculator shows 408."));
    assert_eq!(h.captions.of("doing").last().map(String::as_str), Some(""));
    assert!(h
        .captions
        .of("doing")
        .contains(&"Looking at the screen".to_owned()));
    assert_eq!(h.mac.count("disengage"), 1);
    assert_eq!(
        h.host.notes.all().last().unwrap(),
        &("Calculator shows 408.".to_owned(), "Done".to_owned())
    );
    assert!(h.agent.task().is_none());
}

#[test]
fn a_one_way_step_is_said_as_it_happens_and_the_reply_still_comes() {
    let h = Harness::new();
    let task = asked(&h, "Post hello in general.");
    task.emit("announce", "Sending “hello” in #general.");
    h.drain();
    assert!(h.has_printed("   ⚠️  Sending “hello” in #general."));
    assert!(h
        .captions
        .of("activity")
        .contains(&"One-way step: Sending “hello” in #general.".to_owned()));
    let spoken = hive_app::util::spoken("Sending “hello” in #general.");
    assert_eq!(h.voice.said.all(), std::slice::from_ref(&spoken));
    task.finish("Posted it.");
    h.drain();
    assert_eq!(h.voice.said.all(), [spoken, "Posted it.".to_owned()]); // its reply too
}

#[test]
fn a_task_that_stops_on_purpose_says_why_and_isnt_an_error() {
    let h = Harness::new();
    let task = asked(&h, "Clean up my inbox.");
    let why = "Deleting those can't be undone, so I left them for you.";
    *support::lock(&task.final_text) = Some(why.into());
    task.running.store(false, Ordering::SeqCst);
    task.emit("failed", why);
    h.drain();
    assert!(h.has_printed(&format!("✋ {why}\n")), "{:?}", h.printed());
    assert!(!h.printed().iter().any(|l| l.starts_with("❌")));
    assert_eq!(h.voice.said.all(), [why]);
    assert_eq!(
        h.host.notes.all().last().unwrap(),
        &(why.to_owned(), "Needs you".to_owned())
    );
    assert_eq!(h.mac.count("disengage"), 1);
}

#[test]
fn a_task_that_failed_says_sorry() {
    let h = Harness::new();
    let task = asked(&h, "Open Safari.");
    task.running.store(false, Ordering::SeqCst);
    task.emit("failed", "Codex stopped: no network");
    h.drain();
    assert!(h.has_printed("❌ Codex stopped: no network\n"));
    assert_eq!(h.voice.said.all(), ["Sorry, that didn't work."]);
}

#[test]
fn events_of_a_replaced_task_are_kept_but_not_shown() {
    let h = Harness::new();
    h.agent.start_journal();
    let first = asked(&h, "Open Safari.");
    // right after (within FOLLOW_UP seconds), it's added to the request
    let second = asked(&h, "And look up the weather in Paris.");
    assert_eq!(first.stop_count(), 1);
    assert_eq!(
        second.text,
        "Open Safari. And look up the weather in Paris."
    );
    assert!(h.has_printed("   (adding that to what you just asked)"));
    h.drain(); // the first one's last event: it was stopped
    assert!(!h.printed().iter().any(|l| l.starts_with("❌")));
    assert!(h.voice.said.is_empty());
    let journal = h.journal();
    let old = journal
        .iter()
        .find(|e| e["kind"] == "failed")
        .expect("the old task's end is saved");
    assert_eq!(
        (&old["text"], &old["request"], &old["interrupted"]),
        (&json!("stopped"), &json!("Open Safari."), &json!(true))
    );
    second.emit("say", "Looking it up.");
    h.drain();
    assert!(h.has_printed("   💬 Looking it up."));
}
