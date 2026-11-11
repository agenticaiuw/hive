//! tests/test_voice.py's VoiceAgentTest: the voice shell with its main loop running, as you use it.
//! What you say comes from the test (on_text's `heard`, on_speech's `cut_in`), Codex is
//! [`FakeBackend`] (a task that looks at the screen and answers, as tests/fake_codex.py) and fn is
//! the helper's watch (its events, or a fake helper on a temporary socket).
//!
//! What the ears themselves do (Parakeet, pauses, noise, the voiceprint, echo) is
//! hive-sidecars' (tests/voice.rs); what Codex is asked (prompts, goals) is hive-codex's.

mod support;

use hive_app::util::{monotonic, Dictation};
use hive_app::Event;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use support::{lock, sleep, wait_for, FakeHelper, Harness, Rec, Setup};

/// test_voice.py's setUp: the loop runs, and a tap of fn has it listening.
fn listening(setup: Setup) -> Harness {
    let h = Harness::with(setup);
    h.start();
    assert!(!h.ears.listening_now()); // until you tap fn
    h.tap_fn();
    wait_for("it to listen", 5.0, || {
        h.captions.of("listening") == ["true"]
    });
    h
}

/// Codex answers each request with this.
fn answering(reply: &str) -> Harness {
    let h = listening(Setup::default());
    *lock(&h.backend.reply) = Some(reply.into());
    h
}

fn task_done(h: &Harness) -> bool {
    !h.voice.said.is_empty() && h.agent.task().is_none()
}

fn no_request(h: &Harness) {
    assert!(h.backend.tasks.is_empty(), "{:?}", h.backend.texts());
}

#[test]
fn words_show_up_as_you_talk_and_the_task_goes_to_codex() {
    let h = answering("Calculator shows 408.");
    h.agent.heard("Open calculator and work out", false);
    h.say("Open Calculator and work out 12 times 34.");
    wait_for("codex", 5.0, || !h.backend.tasks.is_empty());
    assert!(h
        .captions
        .of("hearing")
        .iter()
        .any(|t| t.contains("Open calculator")));
    assert_eq!(
        h.backend.texts(),
        ["Open Calculator and work out 12 times 34."]
    );
    wait_for("the task to finish", 5.0, || task_done(&h));
    assert_eq!(h.voice.said.all(), ["Calculator shows 408."]); // once, though Codex says it twice
                                                               // It only waited (no clicks or typing), so it never took your mouse and keyboard.
    assert_eq!(h.mac.count("engage"), 0);
}

#[test]
fn the_session_is_saved_what_you_said_and_what_it_did() {
    let h = answering("Calculator shows 408.");
    h.agent.put(Event::Heard("Um.".into(), true, None));
    h.agent.put(Event::Heard(
        "Open Calculator and work out 12 times 34.".into(),
        true,
        None,
    ));
    wait_for("the task to finish", 5.0, || task_done(&h));
    let journal = h.agent.journal.get().unwrap();
    assert!(journal.dir.starts_with(h.state())); // (the test's own state folder)
    let entries = h.journal();
    let said: Vec<(Value, Value)> = entries
        .iter()
        .filter(|e| e["kind"] == "you said")
        .map(|e| (e["text"].clone(), e["outcome"].clone()))
        .collect();
    assert_eq!(
        said,
        [
            (json!("Um."), json!("filler, ignored")),
            (
                json!("Open Calculator and work out 12 times 34."),
                json!("request")
            )
        ]
    );
    let request = entries.iter().find(|e| e["kind"] == "request").unwrap();
    assert_eq!(request["device"], "mac");
    assert!(entries
        .iter()
        .any(|e| e["kind"] == "say" && e["text"] == "Calculator shows 408."));
    let done = entries.iter().find(|e| e["kind"] == "done").unwrap();
    assert_eq!(done["thread"], "thread-1"); // which Codex thread has the full context
    assert_eq!(done["request"], "Open Calculator and work out 12 times 34.");
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(journal.dir.join("manifest.json")).unwrap())
            .unwrap();
    assert!(
        manifest["threads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["thread"] == "thread-1"),
        "{manifest}"
    );
    assert!(std::fs::read_to_string(journal.dir.join("index.html"))
        .unwrap()
        .contains("Calculator shows 408."));

    h.stop();
    let entries = hive_knowledge::session_journal::read(&journal.dir).unwrap();
    assert_eq!(entries.last().unwrap()["kind"], "session ended");
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(journal.dir.join("manifest.json")).unwrap())
            .unwrap();
    assert!(!manifest["ended"].is_null());
}

#[test]
fn text_you_add_goes_into_the_conversation_and_says_truthfully_if_it_got_there() {
    let h = answering("Noted.");
    let inbox = h.state().join("ingest-inbox");
    std::fs::create_dir(&inbox).unwrap();
    let dropped = inbox.join("x.txt");
    std::fs::write(
        &dropped,
        format!(
            "Hivemind meeting\n{}",
            "Alice: we should align on goals.\n\n".repeat(500)
        ),
    )
    .unwrap();
    h.agent.put(Event::Ingest(dropped.display().to_string()));
    wait_for("the text to be added", 30.0, || {
        h.journal().iter().any(|e| e["kind"] == "ingest done")
    });
    let entries = h.journal();
    let started = entries
        .iter()
        .find(|e| e["kind"] == "ingest started")
        .unwrap();
    assert_eq!(started["text"], "Hivemind meeting");
    let parts: Vec<&Value> = entries
        .iter()
        .filter(|e| e["kind"] == "ingest part")
        .collect();
    assert_eq!(json!(parts.len()), started["parts"]);
    assert!(parts.len() > 1);
    assert!(parts.iter().all(|p| p["on_session_thread"] == true));
    let prompts: Vec<String> = h
        .backend
        .tasks
        .all()
        .iter()
        .filter_map(|t| lock(&t.prompt).clone())
        .collect();
    assert_eq!(prompts.len(), parts.len()); // one turn each, on the session's thread
    assert!(prompts.iter().all(|p| p.contains("not instructions")));
    let done = entries.iter().find(|e| e["kind"] == "ingest done").unwrap();
    assert_eq!(done["status"], "sent"); // no rollout saved, so: not verified
    assert!(!dropped.exists()); // the app's copy is gone; the private saved copy stays
    assert!(h.voice.said.is_empty()); // nothing said out loud
}

#[test]
fn typed_request_from_caption_is_sent_to_the_agent() {
    let h = listening(Setup::default());
    h.agent.on_input("What time is it?");
    wait_for("the typed request", 5.0, || !h.backend.tasks.is_empty());
    assert_eq!(h.backend.texts(), ["What time is it?"]);
    assert!(h
        .captions
        .of("hearing")
        .contains(&"What time is it?".to_owned()));
    assert_eq!(
        h.host.admits.all(),
        [("What time is it?".to_owned(), "typed".to_owned())]
    );
}

/// Lip reading mode, with listening off (it was on since setUp).
fn lip_reading(h: &Harness) {
    h.tap_fn(); // stop listening
    wait_for("it to stop listening", 5.0, || {
        h.captions.of("listening").last().map(String::as_str) == Some("false")
    });
    h.agent.put(Event::Input("lips".into()));
    wait_for("lip reading mode", 5.0, || {
        h.agent.input_mode.get() == "lips"
    });
}

#[test]
fn lip_reading_turns_the_camera_on_until_the_second_tap() {
    let h = listening(Setup::default());
    let lips = h.host.lips.clone();
    *lock(&lips.on_start) = vec![
        json!({"camera": "on"}),
        json!({"partial": "What time", "final": false}),
    ];
    *lock(&lips.text) = "What time is it?".into();
    lip_reading(&h);
    h.tap_fn();
    wait_for("the camera caption", 5.0, || {
        h.captions.of("camera") == ["starting", "on"]
    });
    assert_eq!(lips.starts.load(Ordering::SeqCst), 1);
    wait_for("live lip reading captions", 5.0, || {
        h.captions.of("hearing").contains(&"What time".to_owned())
    });
    no_request(&h); // an unfinished hypothesis must not become a command
    assert!(!h.ears.listening_now()); // the microphone stays closed
    h.tap_fn();
    wait_for("the camera to stop", 5.0, || {
        lips.stopped.load(Ordering::SeqCst)
    });
    no_request(&h); // closing must not submit the unfinished request
    assert_eq!(h.captions.of("camera"), ["starting", "on", "off"]);
    let kinds = h.journal_kinds();
    assert!(
        kinds.contains(&("lip reading".into(), "camera on".into())),
        "{kinds:?}"
    );
    assert!(!kinds.contains(&("lip reading".into(), "What time is it?".into())));
    h.agent.put(Event::Input("voice".into()));
    wait_for("voice mode again", 5.0, || {
        h.agent.input_mode.get() == "voice"
    });
}

#[test]
fn lip_reading_empty_results_and_errors_are_visible() {
    let h = listening(Setup::default());
    for (error, expected) in [
        (None, "Couldn't read your lips"),
        (
            Some("no face was found"),
            "Lip reading failed: no face was found",
        ),
    ] {
        h.agent
            .put(Event::Lips(String::new(), error.map(str::to_owned), None));
        wait_for("visible lip reading feedback", 5.0, || {
            h.captions.of("say").iter().any(|w| w.contains(expected))
        });
        assert_eq!(
            h.captions.of("hearing").last().map(String::as_str),
            Some("")
        );
        no_request(&h);
    }
}

#[test]
fn a_camera_that_wont_open_says_so_at_once_and_isnt_shown_as_on() {
    let h = listening(Setup::default());
    *lock(&h.host.lips.on_start) = vec![
        json!({"camera": "waiting"}),
        json!({"camera": "failed", "error": "the camera couldn't be opened"}),
    ];
    lip_reading(&h);
    h.tap_fn();
    wait_for("the camera caption to go", 5.0, || {
        h.captions.of("camera").contains(&"off".to_owned())
    });
    assert_eq!(h.captions.of("camera"), ["starting", "waiting", "off"]); // never "on"
    assert!(h
        .captions
        .of("say")
        .iter()
        .any(|w| w.contains("Camera couldn't open")));
    wait_for("it to stop waiting for the second tap", 5.0, || {
        !h.agent.listening.get()
    });
}

#[test]
fn it_looks_at_the_mac_as_you_start_talking_and_says_where_the_time_went() {
    let h = answering("Calculator shows 408.");
    h.agent.cut_in(); // you started talking (on_speech)
    assert_eq!(h.backend.looks.load(Ordering::SeqCst), 1); // while you were still talking
    sleep(0.1);
    h.say("Open Calculator and work out 12 times 34."); // you stopped 0.9 s ago; 0.85 s to be sure
    wait_for("codex", 5.0, || !h.backend.tasks.is_empty());
    assert!(h.backend.last().ahead); // the task has the look
    assert_eq!(h.backend.looks.load(Ordering::SeqCst), 1);
    wait_for("the timing", 5.0, || {
        h.printed().iter().any(|l| l.starts_with('⏱'))
    });
    let timing = h
        .printed()
        .into_iter()
        .find(|l| l.starts_with('⏱'))
        .unwrap();
    for step in [
        "from when you stopped talking to hearing its reply",
        "to be sure you'd finished",
        "writing it down",
        "screenshot ready (taken as you talked)",
        "for Codex's first words (1 model call)",
    ] {
        assert!(timing.contains(step), "{step:?} not in {timing:?}");
    }
    let before = timing.split("s to be sure").next().unwrap();
    let pause: f64 = before.rsplit(' ').nth(1).unwrap().parse().unwrap();
    assert!((pause - 0.85).abs() <= 0.1, "{timing}");
}

#[test]
fn a_look_is_not_taken_while_a_task_works_on_the_mac() {
    let h = listening(Setup::default());
    h.say("Open Safari.");
    wait_for("codex", 5.0, || h.agent.task().is_some_and(|t| t.running()));
    h.agent.cut_in(); // what's on the Mac is changing: a look now would be stale
    assert_eq!(h.backend.looks.load(Ordering::SeqCst), 0);
}

#[test]
fn tapping_fn_starts_and_stops_it_listening() {
    let h = listening(Setup {
        app: true,
        ..Setup::default()
    }); // and tells Agent.app's menu bar
    h.tap_fn();
    wait_for("it to stop listening", 5.0, || {
        h.captions.of("listening") == ["true", "false"]
    });
    assert_eq!(
        h.printed()
            .iter()
            .filter(|l| *l == "@@ listening 0")
            .count(),
        2
    ); // (the first: at start)
    assert!(!h.ears.listening_now());
    h.say("Open Safari.");
    sleep(0.5);
    no_request(&h); // not listening: nothing heard
    h.tap_fn();
    wait_for("it to listen again", 5.0, || {
        h.printed()
            .iter()
            .filter(|l| *l == "@@ listening 1")
            .count()
            == 2
    });
    assert!(h.ears.listening_now());
    assert_eq!(h.captions.of("listening"), ["true", "false", "true"]);
    h.agent.heard("Open", false);
    h.say("Open Safari.");
    wait_for("codex", 5.0, || !h.backend.tasks.is_empty());
    assert_eq!(h.backend.texts(), ["Open Safari."]);
    assert!(h.captions.of("hearing").iter().any(|w| w.contains("Open")));
}

#[test]
fn tapping_fn_mid_sentence_cancels_unfinished_speech() {
    let h = listening(Setup::default());
    h.agent.heard("Open Calculator and work out", false);
    h.ears.hold_thens.store(true, Ordering::SeqCst); // the ears finish writing it down first
    h.tap_fn();
    wait_for("listening to stop", 5.0, || !h.ears.listening_now());
    h.say("Open Calculator and work out 12 times 34."); // what was cut, written down
    wait_for("the cut", 5.0, || !lock(&h.ears.thens).is_empty());
    h.ears.run_thens();
    wait_for("unfinished speech to drain", 10.0, || {
        !h.agent.discard_heard.get()
    });
    no_request(&h);
    assert!(!h.ears.listening_now());
}

/// fn is down and stays down (dictation).
fn hold_fn(h: &Harness) {
    h.helper_event(&[("fn", "down")]);
    wait_for("it to start dictating", 5.0, || {
        h.agent.dictation.lock().is_some()
    });
}

#[test]
fn holding_fn_types_what_you_say_into_the_app_in_front() {
    let h = listening(Setup {
        app: true,
        ..Setup::default()
    });
    hold_fn(&h);
    h.agent.heard("Hello there.", false);
    h.say("Hello there. See you at five.");
    h.wait_printed("@@ dictating 1"); // held longer than a tap
    h.helper_event(&[("fn", "up")]);
    wait_for("the dictation to be typed", 5.0, || {
        !h.host.pasted.is_empty()
    });
    let typed = h.host.pasted.all();
    assert!(typed[0].to_lowercase().contains("hello there"));
    assert!(typed[0].to_lowercase().contains("see you at"));
    no_request(&h); // it isn't a task
    assert!(h
        .captions
        .of("hearing")
        .iter()
        .any(|w| w.to_lowercase().contains("see you")));
    assert!(h.has_printed("@@ dictating 0"));
    assert_eq!(h.captions.of("dictating"), ["true", "false"]);
    assert!(!h
        .printed()
        .iter()
        .any(|l| l.to_lowercase().contains("see you"))); // the log doesn't keep the words
    assert!(h.has_printed("✍️  typing what you dictated (6 words)"));
    assert!(h.ears.listening_now()); // and it's listening for the agent again
    h.say("Open Safari.");
    wait_for("codex", 5.0, || !h.backend.tasks.is_empty());
    assert_eq!(h.backend.texts(), ["Open Safari."]);
    assert_eq!(h.host.pasted.len(), 1);
}

#[test]
fn letting_go_of_fn_mid_sentence_types_all_of_it() {
    let h = listening(Setup::default());
    h.tap_fn(); // it stops listening for the agent
    wait_for("it to stop listening", 5.0, || !h.ears.listening_now());
    hold_fn(&h);
    assert!(h.ears.listening_now()); // the microphone opens just for this
    h.ears.hold_thens.store(true, Ordering::SeqCst);
    h.agent.heard("Open Calculator and work out", false);
    h.helper_event(&[("fn", "up")]);
    wait_for("the cut", 5.0, || !lock(&h.ears.thens).is_empty());
    h.say("Open Calculator and work out 12 times 34."); // the rest of it, written down as it's cut
    h.ears.run_thens();
    wait_for("the dictation to be typed", 5.0, || {
        !h.host.pasted.is_empty()
    });
    assert!(h.host.pasted.all()[0].contains("12 times 34"));
    assert!(!h.ears.listening_now());
    no_request(&h);
}

#[test]
fn fn_with_another_key_is_a_shortcut_not_dictation() {
    let h = listening(Setup::default());
    hold_fn(&h);
    h.say("Open Safari.");
    h.helper_event(&[("fn", "other")]); // fn+arrow, say
    h.helper_event(&[("fn", "up")]);
    sleep(1.0);
    assert!(h.host.pasted.is_empty());
    no_request(&h);
    assert!(h.ears.listening_now());
}

#[test]
fn dictation_it_cant_type_is_left_on_the_clipboard() {
    let h = Harness::new();
    *lock(&h.host.paste_error) = Some("it isn't allowed to press keys".into());
    let dictation = Dictation::new();
    dictation.state().words.push("Hello there.".into());
    h.agent.type_dictation(&dictation);
    wait_for("the message", 5.0, || h.printed_with("couldn't type it"));
    assert!(h.printed_with("on the clipboard"), "{:?}", h.printed());
    assert_eq!(
        h.host.notes.all(),
        [(
            "Couldn't type what you dictated. It's on the clipboard: ⌘V pastes it.".to_owned(),
            "Agent".to_owned()
        )]
    );
}

#[test]
fn saying_continue_carries_on_after_you_take_over() {
    // the helper's hand-over gate, on a socket of the test's own (never the real helper)
    let helper = FakeHelper::start();
    let h = Harness::with(Setup {
        mac: Some(Arc::new(helper.client())),
        ..Setup::default()
    });
    h.start();
    wait_for("the agent to watch the helper", 5.0, || {
        helper.watchers() >= 1
    });
    helper.raw("fn down");
    helper.raw("fn tap");
    wait_for("it to listen", 5.0, || {
        h.captions.of("listening") == ["true"]
    });
    h.say("Open Safari.");
    wait_for("codex", 5.0, || h.agent.task().is_some_and(|t| t.running()));
    assert_eq!(helper.state(), "disengaged"); // it takes the mouse only for a screen action
    helper.raw("engage"); // its first screen action takes control
    wait_for("it to have control", 5.0, || helper.state() == "engaged");
    helper.raw("human trackpad"); // you took over
    wait_for("it to say how to let it carry on", 5.0, || {
        h.agent.pause_announced.get()
    });
    assert!(h.printed_with("“continue”"), "{:?}", h.printed());
    assert_eq!(
        h.captions.of("paused").last().map(String::as_str),
        Some(hive_app::util::TOOK_OVER)
    );
    assert!(h.agent.task().unwrap().running()); // the rest goes on
    h.say("Continue.");
    wait_for("it to take control again", 5.0, || {
        helper.state() == "engaged"
    });
    h.wait_printed("▶️  continuing");
    assert_eq!(h.backend.tasks.len(), 1); // the same task, not a new one
    assert!(h.agent.task().unwrap().running());
    assert_eq!(h.backend.last().handed_back.load(Ordering::SeqCst), 1);
    assert_eq!(h.captions.of("paused").last().map(String::as_str), Some(""));
}

#[test]
fn captions_show_what_its_doing() {
    let h = answering("Calculator shows 408.");
    h.say("Open Calculator.");
    wait_for("the task to finish", 5.0, || task_done(&h));
    let doings = h.captions.of("doing");
    assert!(doings.contains(&"Looking at the screen".to_owned())); // the fake Codex takes a screenshot
    assert_eq!(doings.last().map(String::as_str), Some("")); // and when it's done, nothing
    assert!(
        h.printed().iter().any(|l| l.starts_with("✅ done in ")),
        "{:?}",
        h.printed()
    );
}

#[test]
fn on_the_phone_it_works_on_the_phone_alongside_the_mac() {
    let h = listening(Setup::default());
    h.say("Open Safari.");
    wait_for("codex", 5.0, || !h.backend.tasks.is_empty());
    let mac = h.agent.task().unwrap();
    h.say("Open Maps on my phone.");
    wait_for("the phone task", 5.0, || h.backend.tasks.len() == 2);
    let phone = h.backend.last();
    assert_eq!(phone.device, "phone");
    assert!(phone.text.to_lowercase().contains("maps on my phone"));
    assert!(hive_app::shell::same(&h.agent.task().unwrap(), &mac)); // the Mac task carried on
    assert!(mac.running());
    assert!(h
        .agent
        .tasks
        .lock()
        .phone
        .as_ref()
        .is_some_and(|t| t.running()));
    h.say("Stop."); // stops both
    wait_for("both tasks to stop", 5.0, || !h.agent.tasks.lock().any());
    assert_eq!(
        h.backend
            .tasks
            .all()
            .iter()
            .map(|t| t.stop_count())
            .collect::<Vec<_>>(),
        [1, 1]
    );
    assert_eq!(h.voice.said.all(), ["Stopped."]);
}

#[test]
fn saying_more_right_after_adds_to_the_request() {
    let h = listening(Setup::default());
    h.say("Open Safari.");
    wait_for("codex", 5.0, || !h.backend.tasks.is_empty());
    h.say("And look up the weather in Paris.");
    wait_for("the second request", 5.0, || h.backend.tasks.len() == 2);
    let joined = &h.backend.texts()[1];
    assert!(
        joined.contains("Open Safari") && joined.contains("weather in Paris"),
        "{joined}"
    );
    assert!(h.has_printed("   (adding that to what you just asked)"));
}

#[test]
fn saying_stop_stops_the_task() {
    let h = listening(Setup::default());
    h.say("Open Safari.");
    wait_for("codex", 5.0, || h.agent.task().is_some_and(|t| t.running()));
    h.say("Stop.");
    wait_for("the task to stop", 5.0, || h.agent.task().is_none());
    assert_eq!(h.voice.said.all(), ["Stopped."]);
    assert_eq!(h.backend.tasks.len(), 1);
}

#[test]
fn talking_over_it_stops_its_voice() {
    let h = listening(Setup::default());
    h.voice.playing.store(true, Ordering::SeqCst);
    let requests_when_stopped: Arc<Rec<usize>> = Arc::default();
    let (stops, backend) = (requests_when_stopped.clone(), h.backend.clone());
    *lock(&h.voice.on_stop) = Some(Box::new(move || stops.push(backend.tasks.len())));
    h.agent.cut_in(); // you started talking
    h.say("Wait, open Safari instead.");
    wait_for("codex", 5.0, || !h.backend.tasks.is_empty());
    assert_eq!(requests_when_stopped.all()[0], 0); // it went quiet as you started, not once you'd finished
    assert!(h.backend.texts()[0].contains("Safari"));
}

#[test]
fn over_its_voice_its_own_words_are_ignored() {
    let h = listening(Setup::default());
    h.agent.say(
        "I typed twelve times thirty four into Calculator.",
        None,
        None,
    );
    h.voice.playing.store(true, Ordering::SeqCst);
    h.agent.cut_in();
    h.say("typed twelve times thirty four into Calculator");
    wait_for("the transcript", 5.0, || {
        h.printed_with("heard its own voice")
    });
    sleep(0.5);
    no_request(&h);
}

#[test]
fn with_your_voice_enrolled_someone_elses_isnt_a_task() {
    let h = listening(Setup::default());
    h.agent.ignored(2.04, 0.213); // the voiceprint left it out
    wait_for("the note", 5.0, || h.printed_with("not your voice"));
    assert!(
        h.has_printed("   (not your voice, ignored: 2.0 s, 0.21 like yours)"),
        "{:?}",
        h.printed()
    );
    no_request(&h);
    let left_out = h
        .journal()
        .into_iter()
        .find(|e| e["kind"] == "voice left out")
        .unwrap();
    assert_eq!(
        (
            &left_out["text"],
            &left_out["seconds"],
            &left_out["similarity"]
        ),
        (&json!("not your voice"), &json!(2.04), &json!(0.213))
    );
    h.say("Open Safari.");
    wait_for("codex", 5.0, || !h.backend.tasks.is_empty());
    assert_eq!(h.backend.texts(), ["Open Safari."]);
}

// -- the voice's callbacks never wait for the main loop --

#[test]
fn talking_over_it_stops_its_voice_while_the_agent_is_busy() {
    // All of the sidecar's callbacks run on one thread; cut-in mustn't wait for what the main loop
    // is doing with what you said before (here: saving it, which is stuck).
    let h = listening(Setup::default());
    h.host.admitting.close();
    h.say("Open Safari.");
    wait_for("the main loop to be busy", 5.0, || {
        h.host.admitting.waiting.load(Ordering::SeqCst) == 1
    });
    h.agent.say("Opening Safari now.", None, None); // (from another thread: a task's words)
    h.voice.playing.store(true, Ordering::SeqCst);
    let (agent, began) = (h.agent.clone(), monotonic());
    let callback = std::thread::spawn(move || {
        agent.heard("And then", false); // on_text, then on_speech: neither waits
        agent.cut_in();
        monotonic()
    });
    let returned = callback.join().unwrap();
    assert!(
        returned - began < 0.5,
        "the callbacks took {:.2} s",
        returned - began
    );
    assert_eq!(h.voice.calls.all(), ["stop"]);
    assert_eq!(h.captions.of("say").last().map(String::as_str), Some(""));
    assert_eq!(h.host.admitting.waiting.load(Ordering::SeqCst), 1); // still busy
    h.host.admitting.open();
    wait_for("codex", 5.0, || !h.backend.tasks.is_empty());
}
