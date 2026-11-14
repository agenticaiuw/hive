//! Starting and stopping: the loop starts without waiting for speech
//! (tests/test_nonblocking_startup.py), a prepared update is handed off outside the agent
//! (tests/test_self_update.py), speech follows the workspace viewer (tests/test_workspace_voice.py),
//! and what run() sets up and shutdown() takes down.

mod support;

use hive_app::util::workspace_voice_allowed;
use hive_app::Event;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use support::{wait_for, FakeEars, FakeTask, Gate, Harness, Isolated, Setup};

// -- speech isn't waited for --

#[test]
fn the_loop_runs_without_waiting_for_speech() {
    let ears = FakeEars {
        loading: Gate::new(false),
        ..FakeEars::default()
    };
    let h = Harness::with(Setup {
        app: true,
        ears,
        ..Setup::default()
    });
    h.start();
    h.agent.put(Event::Toggle); // tapping fn works while Parakeet loads
    h.wait_printed("@@ listening 1");
    wait_for("describe to be waiting", 5.0, || {
        h.ears.loading.waiting.load(Ordering::SeqCst) == 1
    });
    h.agent.put(Event::TypedRequest("What time is it?".into())); // and so do typed requests
    wait_for("the typed request", 5.0, || {
        h.backend.texts() == ["What time is it?"]
    });
    assert!(!h.has_printed("@@ status Ready"));
    h.ears.loading.open();
    h.wait_printed("@@ status Ready");
    let printed = h.printed();
    let ready = printed
        .iter()
        .find(|l| l.starts_with("Hears you with: "))
        .expect("what hears you");
    assert!(
        ready.starts_with("Hears you with: Parakeet (fake), microphone: "),
        "{ready}"
    );
    assert!(
        ready.ends_with(", echo cancellation: None.\nOnly listening to you: None."),
        "{ready}"
    );
}

#[test]
fn failed_speech_announces_typed_fallback() {
    let ears = FakeEars::default();
    ears.model.store(false, Ordering::SeqCst);
    *support::lock(&ears.description) = "nothing (Parakeet: missing model)".into();
    let h = Harness::with(Setup {
        app: true,
        ears,
        ..Setup::default()
    });
    h.agent.announce_audio();
    assert_eq!(
        h.printed(),
        [
            "Voice input unavailable: nothing (Parakeet: missing model). Typed requests remain available.",
            "@@ status Voice input unavailable; typed requests are ready"
        ]
    );
}

// -- what run() sets up, and shutdown() takes down --

#[test]
fn the_app_is_told_how_things_are_at_start() {
    let h = Harness::app();
    h.start();
    h.wait_printed("@@ status Ready");
    let printed = h.printed();
    let journal = h.agent.journal.get().expect("the session journal");
    for line in [
        "Ready. Tap fn and say what you want done; the floating window's mic button mutes it.\n",
        "@@ listening 0",
        "@@ status Typed requests ready; voice input is loading",
        &format!("@@ panel {}", journal.panel_path().display()),
        "@@ input voice",
        "Working on your screen, with your mouse and keyboard.",
    ] {
        assert!(
            printed.iter().any(|l| l == line),
            "{line:?} not in {printed:?}"
        );
    }
    assert!(!printed.iter().any(|l| l.starts_with("Agent context: "))); // (that's for the terminal)
    assert_eq!(h.host.asked_screen.load(Ordering::SeqCst), 1); // where should Hive work?
    assert_eq!(h.host.vm_off.load(Ordering::SeqCst), 1);
    assert!(support::lock(&h.host.requests).is_some()); // the request socket
    h.stop();
    assert_eq!(h.host.request_socket.closed.load(Ordering::SeqCst), 1);
    let entries = hive_knowledge::session_journal::read(&journal.dir).unwrap();
    assert_eq!(entries.last().unwrap()["kind"], "session ended");
    assert!(h.captions.count("close") >= 1);
}

#[test]
fn in_a_terminal_it_says_where_the_session_is_saved() {
    let h = Harness::new();
    h.start();
    h.wait_printed("Ready. Tap fn and say what you want done; the floating window's mic button mutes it. Ctrl-C to quit.\n");
    let context = h.state().join("context/index.html");
    h.wait_printed(&format!("Agent context: {}", context.display()));
    let journal = h.agent.journal.get().unwrap();
    h.wait_printed(&format!(
        "This session is saved in {}",
        journal.dir.display()
    ));
    assert!(!h.printed().iter().any(|l| l.starts_with("@@")));
    assert!(support::lock(&h.host.requests).is_none()); // only the app has the request socket
}

#[test]
fn a_request_from_the_socket_starts_work() {
    let h = Harness::app();
    h.start();
    wait_for("the request socket", 5.0, || {
        support::lock(&h.host.requests).is_some()
    });
    let on_request = support::lock(&h.host.requests).clone().unwrap();
    let replies: Arc<support::Rec<serde_json::Value>> = Arc::default();
    let into = replies.clone();
    on_request(hive_app::parts::LocalRequest {
        text: "Make the project plan".into(),
        resume_goal: false,
        goal_objective: None,
        receipt_id: Some("socket-receipt".into()),
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(2),
        reply: Box::new(move |reply| into.push(reply)),
    });
    wait_for("the reply", 5.0, || !replies.is_empty());
    assert_eq!(replies.all(), [json!({"ok": true})]);
    assert_eq!(h.backend.texts(), ["Make the project plan"]);
    assert!(h.host.admits.is_empty()); // the socket saved it already
}

#[test]
fn lip_reading_chosen_before_is_ready_at_start() {
    let h = Harness::app();
    *support::lock(&h.host.lips_mode) = "lips".into();
    h.start();
    h.wait_printed("@@ input lips");
    assert_eq!(h.host.lips.opened.load(Ordering::SeqCst), 1); // the model warms, the camera stays off
    assert_eq!(h.host.lips.starts.load(Ordering::SeqCst), 0);
    h.stop();
    assert_eq!(h.host.lips.closed.load(Ordering::SeqCst), 1);
}

#[test]
fn speak_aloud_and_the_floating_window_left_off_stay_off_from_the_start() {
    let env = Isolated::new();
    std::fs::write(env.path().join("speak-aloud"), "off\n").unwrap();
    std::fs::write(env.path().join("floating-window"), "off\n").unwrap();
    let h = Harness::isolated(
        env,
        Setup {
            app: true,
            ..Setup::default()
        },
    );
    assert!(!h.agent.speaking.get()); // before its first words
    h.start();
    h.wait_printed("@@ speak 0");
    assert!(h.has_printed("@@ window 0"));
    assert_eq!(h.captions.of("hidden"), ["true"]);
    h.agent.say("Done.", None, None);
    assert!(h.voice.said.is_empty());
    assert_eq!(h.captions.of("say"), ["Done."]);
}

#[test]
fn speak_aloud_and_the_floating_window_are_on_by_default() {
    let h = Harness::app();
    h.start();
    h.wait_printed("@@ speak 1");
    assert!(h.has_printed("@@ window 1"));
    assert!(h.captions.of("hidden").is_empty());
}

#[test]
fn quitting_from_the_menu_is_in_the_log_and_the_journal() {
    let h = Harness::app();
    h.agent.start_journal();
    h.agent.note_menu_stop("quit from the menu");
    assert!(h.has_printed("⏏  quit from the menu"));
    let kinds = h.journal_kinds();
    assert!(
        kinds.contains(&("app".into(), "quit from the menu".into())),
        "{kinds:?}"
    );
}

#[test]
fn shutdown_stops_tasks_and_hands_back_the_mac() {
    let h = Harness::new();
    let (mac, phone) = (
        FakeTask::running("work", "mac"),
        FakeTask::running("work on my phone", "phone"),
    );
    h.agent.tasks.lock().mac = Some(mac.clone());
    h.agent.tasks.lock().phone = Some(phone.clone());
    h.agent.cursor_home.set(Some((10.0, 20.0)));
    h.host.on_vm.store(true, Ordering::SeqCst);
    h.agent.shutdown();
    assert_eq!((mac.stop_count(), phone.stop_count()), (1, 1));
    assert_eq!(h.mac.calls.all(), ["disengage", "release_all"]);
    assert_eq!(h.host.warps.all(), [(10.0, 20.0)]); // your cursor comes back from the virtual monitor
    assert_eq!(h.voice.calls.all(), ["stop"]);
}

#[test]
fn an_update_restart_stops_tasks_for_maintenance() {
    let h = Harness::new();
    std::fs::create_dir_all(h.state().join("updates")).unwrap();
    std::fs::write(h.state().join("updates/update-applying"), "").unwrap();
    let mac = FakeTask::running("work", "mac");
    h.agent.tasks.lock().mac = Some(mac.clone());
    h.agent.shutdown();
    assert_eq!(
        (
            mac.stop_count(),
            mac.maintenance_stops.load(Ordering::SeqCst)
        ),
        (0, 1)
    );
}

// -- picking up where it left off --

const RESUMED: &str = "The agent update has been installed and restarted.";

#[test]
fn after_an_update_the_request_carries_on() {
    let h = Harness::app();
    std::fs::create_dir_all(h.state().join("updates")).unwrap();
    std::fs::write(h.state().join("updates/update-resume"), "").unwrap();
    *support::lock(&h.backend.recovery) = Some(json!({"id": "r1", "status": "active"}));
    h.start();
    wait_for("the request to carry on", 5.0, || {
        !h.backend.tasks.is_empty()
    });
    assert!(
        h.backend.texts()[0].starts_with(RESUMED),
        "{:?}",
        h.backend.texts()
    );
    assert!(h.state().join("updates/update-resumed").exists());
    assert!(!h.state().join("updates/update-resume").exists());
}

#[test]
fn after_an_update_a_paused_request_stays_paused() {
    let h = Harness::app();
    std::fs::write(h.state().join("update-resume"), "").unwrap(); // from an older version
    *support::lock(&h.backend.recovery) = Some(json!({"id": "r1", "status": "paused"}));
    h.start();
    wait_for("the handoff", 5.0, || {
        h.state().join("update-resumed").exists()
    });
    h.wait_printed("@@ status Ready");
    assert!(h.backend.tasks.is_empty());
}

#[test]
fn unfinished_work_is_restored_at_start() {
    let h = Harness::app();
    let saved = FakeTask::new("Continue the previously authorized work", "mac");
    *support::lock(&h.backend.restored) = Some(saved.clone());
    h.start();
    h.wait_printed("Restoring the saved conversation and checking unfinished work.");
    assert_eq!(saved.starts.all(), [false]);
    assert!(Arc::ptr_eq(&h.agent.task().unwrap(), &saved.as_task()));
    saved.emit("say", "Picking up where I left off.");
    h.wait_printed("   💬 Picking up where I left off.");
}

// -- the workspace --

#[test]
fn the_embedded_workspace_starts_and_its_activity_shows() {
    let mut env = Isolated::new();
    env.set("AGENT_WORKSPACE_ENGINE", "/test/engine");
    let h = Harness::isolated(
        env,
        Setup {
            app: true,
            ..Setup::default()
        },
    );
    *support::lock(&h.host.latch) = Ok(("cleared".into(), "an idle latch".into()));
    h.start();
    wait_for("the workspace", 5.0, || {
        h.host.workspace_started.load(Ordering::SeqCst) == 1
    });
    h.wait_printed("Virtual workspace safety latch cleared: an idle latch");
    assert_eq!(h.host.asked_screen.load(Ordering::SeqCst), 0); // the workspace, not the monitor
    let task = FakeTask::running("work", "mac");
    h.agent.tasks.lock().mac = Some(task);
    let activity = support::lock(&h.host.activity).clone().unwrap();
    activity("doing", "Typing in Notes");
    wait_for("the activity", 5.0, || {
        h.captions
            .of("doing")
            .contains(&"Typing in Notes".to_owned())
    });
    h.agent.put(Event::Toggle);
    h.wait_printed("@@ workspace-resume 1");
    h.stop();
    assert_eq!(h.host.workspace.closed.load(Ordering::SeqCst), 1);
}

#[test]
fn a_workspace_that_wont_start_says_so() {
    let mut env = Isolated::new();
    env.set("AGENT_WORKSPACE_ENGINE", "/test/engine");
    let h = Harness::isolated(
        env,
        Setup {
            app: true,
            ..Setup::default()
        },
    );
    *support::lock(&h.host.workspace_error) = Some("no display".into());
    h.start();
    h.wait_printed("Virtual workspace unavailable: no display");
    assert_eq!(
        h.host.workspace_errors.all(),
        ["Could not start the virtual workspace: no display"]
    );
}

#[test]
fn the_window_x_pauses_the_workspace_input() {
    let mut env = Isolated::new();
    env.set("AGENT_WORKSPACE_ENGINE", "/test/engine");
    let h = Harness::isolated(env, Setup::default());
    h.agent.tasks.lock().mac = Some(FakeTask::running("work", "mac"));
    h.host
        .pause_ok
        .store(false, std::sync::atomic::Ordering::SeqCst);
    h.agent.on_overlay("close", None);
    assert_eq!(h.host.paused.all(), ["/test/engine"]);
    assert!(h.has_printed("   ✗ Could not confirm the workspace input was paused."));
}

#[test]
fn speech_follows_workspace_visibility() {
    let mut env = Isolated::new();
    env.set("AGENT_WORKSPACE_ENGINE", "/test");
    assert!(!workspace_voice_allowed());
    let state = env.path().join("workspace-viewer-visible");
    std::fs::write(&state, "1\n").unwrap();
    assert!(workspace_voice_allowed());
    std::fs::write(&state, "0\n").unwrap();
    assert!(!workspace_voice_allowed());
}

#[test]
fn non_workspace_mode_keeps_voice() {
    let _env = Isolated::new();
    assert!(workspace_voice_allowed());
}

#[test]
fn hiding_the_workspace_viewer_quiets_the_voice_and_its_words_show_instead() {
    let mut env = Isolated::new();
    env.set("AGENT_WORKSPACE_ENGINE", "/test");
    let h = Harness::isolated(env, Setup::default());
    h.agent.tick();
    h.agent.tick();
    assert_eq!(h.voice.calls.all(), ["stop"]); // once, as it went out of view
    h.agent.say("It's three o'clock.", None, None);
    assert!(h.voice.said.is_empty());
    assert_eq!(
        h.captions.of("say").last().map(String::as_str),
        Some("It's three o'clock.")
    );
}

#[test]
fn a_workspace_error_shows_once() {
    let mut env = Isolated::new();
    env.set("AGENT_WORKSPACE_ENGINE", "/test");
    let h = Harness::isolated(
        env,
        Setup {
            app: true,
            ..Setup::default()
        },
    );
    std::fs::write(
        h.state().join("workspace-status.json"),
        r#"{"state": "error", "message": "display lost"}"#,
    )
    .unwrap();
    h.agent.tick();
    h.agent.tick();
    assert_eq!(
        h.printed(),
        [
            "@@ status Workspace unavailable: display lost",
            "   ✗ Workspace unavailable: display lost"
        ]
    );
}

// -- a prepared update --

#[test]
fn claims_pending_update_and_detaches() {
    let h = Harness::new();
    let marker = h.state().join("update-pending");
    std::fs::write(&marker, "ready\n").unwrap();
    h.agent.apply_scheduled_update();
    assert!(!marker.exists());
    assert!(h.state().join("update-applying").exists());
    assert_eq!(h.host.updates.all(), [h.state().join("update.log")]);
    assert!(h.has_printed(
        "Installing the prepared update; the conversation will be available after restart."
    ));
}

#[test]
fn failed_handoff_restores_pending() {
    let h = Harness::new();
    let marker = h.state().join("update-pending");
    std::fs::write(&marker, "ready\n").unwrap();
    *support::lock(&h.host.update_error) = Some("failed".into());
    h.agent.apply_scheduled_update();
    assert!(marker.exists());
    assert!(!h.state().join("update-applying").exists());
    assert!(h.has_printed("Could not start the update: failed"));
}

#[test]
fn claims_handoff_in_writable_updates_directory() {
    let h = Harness::new();
    let updates = h.state().join("updates");
    std::fs::create_dir(&updates).unwrap();
    std::fs::write(updates.join("update-pending"), "ready\n").unwrap();
    h.agent.apply_scheduled_update();
    assert!(updates.join("update-applying").exists());
    assert_eq!(h.host.updates.len(), 1);
}

#[test]
fn the_update_waits_for_the_last_task_to_end() {
    let h = Harness::new();
    std::fs::write(h.state().join("update-pending"), "ready\n").unwrap();
    let (mac, phone) = (
        FakeTask::running("work", "mac"),
        FakeTask::running("work on my phone", "phone"),
    );
    h.agent.tasks.lock().mac = Some(mac.clone());
    h.agent.tasks.lock().phone = Some(phone.clone());
    h.agent.on_task_event(&mac.as_task(), "done", "Done.");
    assert!(h.host.updates.is_empty()); // the phone is still working
    h.agent.on_task_event(&phone.as_task(), "done", "Done too.");
    assert_eq!(h.host.updates.len(), 1);
}

#[test]
fn the_real_update_runs_in_a_session_of_its_own() {
    // tools/update-app.sh in a pretend repo (HIVE_REPO): it writes its pid and process group
    let mut env = Isolated::new();
    let repo = env.path().join("repo");
    std::fs::create_dir_all(repo.join("tools")).unwrap();
    let out = env.path().join("ids");
    std::fs::write(
        repo.join("tools/update-app.sh"),
        format!(
            "echo updating\necho \"$$ $(ps -o pgid= -p $$)\" > '{}.tmp'\nmv '{0}.tmp' '{0}'\n",
            out.display()
        ),
    )
    .unwrap();
    env.set("HIVE_REPO", &repo);
    let log = env.path().join("update.log");
    std::fs::write(&log, "earlier\n").unwrap();
    hive_app::real::start_update(&log).expect("it starts");
    wait_for("the update script", 10.0, || out.exists());
    let ids = std::fs::read_to_string(&out).unwrap();
    let ids: Vec<&str> = ids.split_whitespace().collect();
    assert_eq!(ids.len(), 2, "{ids:?}");
    assert_eq!(ids[0], ids[1]); // its own process group: setsid (start_new_session)
    wait_for("the log", 5.0, || {
        std::fs::read_to_string(&log).unwrap().contains("updating")
    });
    assert!(std::fs::read_to_string(&log)
        .unwrap()
        .starts_with("earlier\n")); // appended
}
