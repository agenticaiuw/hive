//! tests/test_fn_stop.py: turning listening off with fn quiets the voice but leaves the agent
//! working; the floating window's x stops both devices. Neither turns unfinished speech into a
//! task. fn while you have control of a running task hands control back.

mod support;

use hive_app::util::{now, setting, FLOATING_WINDOW, SPEAK_ALOUD, TOOK_OVER};
use hive_app::Event;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use support::{FakeTask, Harness};

/// test_fn_stop.py's make_agent: listening, with a task running on the Mac and on the phone.
fn make_agent() -> (Harness, Arc<FakeTask>, Arc<FakeTask>) {
    let h = Harness::new();
    h.agent.listening.set(true);
    let (mac, phone) = (
        FakeTask::running("work", "mac"),
        FakeTask::running("work on my phone", "phone"),
    );
    {
        let mut tasks = h.agent.tasks.lock();
        tasks.mac = Some(mac.clone());
        tasks.phone = Some(phone.clone());
    }
    h.agent.doing.lock().push(("mac".into(), "Working".into()));
    (h, mac, phone)
}

/// Nothing you said became a request (Python: `on_transcript.assert_not_called()`).
fn no_request(h: &Harness) {
    assert!(h.backend.tasks.is_empty());
    assert!(
        !h.printed().iter().any(|l| l.starts_with("🗣")),
        "{:?}",
        h.printed()
    );
}

#[test]
fn fn_off_quiets_but_keeps_tasks() {
    let (h, mac, phone) = make_agent();
    h.agent.set_listening(false);
    assert_eq!(mac.stop_count(), 0);
    assert_eq!(phone.stop_count(), 0);
    assert_eq!(h.voice.calls.all(), ["stop"]);
    assert_eq!(h.captions.of("listening"), ["false"]);
    h.agent.on_heard("unfinished request", true, None);
    no_request(&h);
}

#[test]
fn window_x_stops_all_tasks_and_speech() {
    let (h, mac, phone) = make_agent();
    h.agent.on_overlay("close", None);
    assert_eq!(mac.stop_count(), 1);
    assert_eq!(phone.stop_count(), 1);
    assert_eq!(h.voice.calls.all(), ["stop"]);
    assert_eq!(h.mac.count("disengage"), 1);
    let tasks = h.agent.tasks.get();
    assert!(tasks.mac.is_none() && tasks.phone.is_none());
    assert!(h.has_printed("✋ stopped from the window's x"));
}

#[test]
fn fn_tap_after_takeover_resumes() {
    let (h, mac, _) = make_agent();
    h.agent.paused_since.set(now() - 5.0);
    h.agent
        .on_helper(&[("fn".to_owned(), "tap".to_owned())].into());
    assert_eq!(h.mac.count("engage"), 1); // take_control
    assert_eq!(mac.handed_back.load(Ordering::SeqCst), 1);
    assert!(h.agent.listening.get()); // not set_listening
    assert!(h.captions.of("listening").is_empty());
}

#[test]
fn touching_just_as_it_takes_control_pauses_and_fn_resumes() {
    let (h, _, _) = make_agent();
    h.agent.on_helper(
        &[
            ("state".to_owned(), "disengaged".to_owned()),
            (
                "reason".to_owned(),
                "engage_cancelled_by_trackpad".to_owned(),
            ),
        ]
        .into(),
    );
    assert_ne!(h.agent.paused_since.get(), 0.0);
    assert_eq!(h.captions.of("paused"), [TOOK_OVER]);
    *h.agent.paused_since.lock() -= 5.0;
    h.agent
        .on_helper(&[("fn".to_owned(), "tap".to_owned())].into());
    assert_eq!(h.mac.count("engage"), 1);
    assert!(h.agent.listening.get());
}

#[test]
fn fn_opening_the_card_puts_typing_in_its_text_box() {
    let (h, _, _) = make_agent();
    h.agent.listening.set(false);
    h.mac.engaged.store(false, Ordering::SeqCst);
    h.agent.set_listening(true);
    assert_eq!(h.ears.calls.last().as_deref(), Some("listen true")); // the microphone is on
    assert_eq!(h.captions.of("focus"), ["true"]);
    h.agent.set_listening(false);
    assert_eq!(
        h.captions.of("focus").last().map(String::as_str),
        Some("false")
    );
}

#[test]
fn the_text_box_never_takes_the_agents_typing() {
    let (h, _, _) = make_agent();
    h.agent.listening.set(false);
    h.mac.engaged.store(true, Ordering::SeqCst); // e.g. Start Listening from the menu mid-task
    h.agent.set_listening(true);
    assert_eq!(h.captions.of("focus"), ["false"]);
    h.agent
        .on_helper(&[("state".to_owned(), "engaged".to_owned())].into());
    assert_eq!(h.captions.of("focus"), ["false", "false"]);
}

#[test]
fn fn_never_says_it_stops_the_agent() {
    let swift = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../tools/captions.swift"
    ))
    .expect("tools/captions.swift");
    assert!(!swift.contains("tap fn to stop"));
    for source in [
        include_str!("../src/shell.rs"),
        include_str!("../src/app.rs"),
    ] {
        assert!(!source.contains("tap fn to stop"));
    }
}

#[test]
fn fn_tap_that_itself_took_over_toggles_listening() {
    let (h, _, _) = make_agent();
    h.agent.paused_since.set(now()); // this very fn press disengaged it
    h.agent
        .on_helper(&[("fn".to_owned(), "tap".to_owned())].into());
    assert_eq!(h.mac.count("engage"), 0);
    assert!(!h.agent.listening.get()); // set_listening(False)
    assert_eq!(h.captions.of("listening"), ["false"]);
}

#[test]
fn window_hide_button_hides_it_and_the_work_goes_on() {
    let h = Harness::app();
    let mac = FakeTask::running("work", "mac");
    h.agent.tasks.lock().mac = Some(mac.clone());
    h.agent.start_journal();
    h.agent.on_overlay("hidden", Some(true)); // the card's –
    assert_eq!(mac.stop_count(), 0);
    assert!(h.voice.calls.is_empty());
    assert_eq!(h.mac.count("disengage"), 0);
    assert_eq!(h.captions.of("hidden"), ["true"]);
    // the menu's Show Floating Window goes off with it, and stays off at the next launch
    assert!(h.has_printed("@@ window 0"));
    assert!(!setting(FLOATING_WINDOW));
    // the menu shows it again, as it is now
    h.agent.dispatch(Event::Window(true));
    assert_eq!(h.captions.of("hidden"), ["true", "false"]);
    assert!(h.has_printed("@@ window 1"));
    assert!(setting(FLOATING_WINDOW));
    let kinds = h.journal_kinds();
    assert!(
        kinds.contains(&("floating window".into(), "hidden".into())),
        "{kinds:?}"
    );
    assert!(
        kinds.contains(&("floating window".into(), "shown".into())),
        "{kinds:?}"
    );
    assert!(h.printed_with("floating window hidden (the card's –)"));
    assert!(h.printed_with("floating window shown (the menu)"));
}

#[test]
fn speak_aloud_off_silences_it_but_still_shows_and_saves_what_it_says() {
    let h = Harness::app();
    h.agent.start_journal();
    h.voice.playing.store(true, Ordering::SeqCst);
    h.agent.say("Opening Calculator now.", None, None);
    assert_eq!(h.voice.said.all(), ["Opening Calculator now."]);
    let microphone = h.ears.calls.all();
    h.agent.set_speaking(false);
    // what it was saying stops at once, and all of it goes on the card (which showed each
    // sentence as it was spoken)
    assert_eq!(h.voice.calls.all(), ["stop"]);
    assert_eq!(
        h.captions.of("say"),
        ["Opening Calculator now.", "Opening Calculator now."]
    );
    assert!(h.has_printed("@@ speak 0"));
    assert!(!setting(SPEAK_ALOUD)); // kept for the next launch
    h.agent.say("Calculator is open.", None, None);
    assert_eq!(h.voice.said.len(), 1); // nothing more is spoken
    assert_eq!(h.captions.of("say").last().unwrap(), "Calculator is open.");
    h.agent.set_speaking(true); // no restart
    assert_eq!(h.ears.calls.all(), microphone); // the microphone is left as it was
    h.agent.say("Done.", None, None);
    assert_eq!(h.voice.said.all(), ["Opening Calculator now.", "Done."]);
    assert!(h.has_printed("@@ speak 1"));
    let kinds = h.journal_kinds();
    for entry in [
        ("speak aloud", "off"),
        ("agent said", "Calculator is open."),
        ("speak aloud", "on"),
    ] {
        assert!(
            kinds.contains(&(entry.0.into(), entry.1.into())),
            "{kinds:?}"
        );
    }
}

#[test]
fn mute_keeps_microphone_off() {
    let (h, _, _) = make_agent();
    h.agent.on_overlay("mute", Some(true));
    assert_eq!(h.ears.calls.last().as_deref(), Some("listen false"));
    assert!(h.has_printed("🔇 transcription muted; the agent keeps working"));
    h.agent.on_overlay("mute", Some(false));
    assert_eq!(h.ears.calls.last().as_deref(), Some("listen true"));
    assert_eq!(h.captions.of("muted"), ["true", "false"]);
}

#[test]
fn late_transcript_is_discarded_even_if_reopened() {
    let (h, _, _) = make_agent();
    h.ears.hold_thens.store(true, Ordering::SeqCst);
    h.agent.set_listening(false);
    h.agent.set_listening(true);
    h.agent.on_heard("late final", true, None);
    no_request(&h);
    h.ears.run_thens(); // cut's then, once what was said before is written down
    match h.agent.next_event() {
        Some(Event::HeardBarrier(barrier)) => assert_eq!(barrier, h.agent.heard_barrier.get()),
        other => panic!("expected heard_barrier, got {:?}", other.map(|e| e.kind())),
    }
}
