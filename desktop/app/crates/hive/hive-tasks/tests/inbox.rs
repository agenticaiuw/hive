//! Talking to an agent on this Mac (inbox.rs): what a message from the dashboard does, depending on
//! where its agent is.
use hive_tasks::inbox::{as_said, cwd_of_transcript, hand_over, handover, merge, woke, Handover, Inbox, BUSY_FOR};
use hive_tasks::live::Live;
use serde_json::{json, Value};

fn seen(status: &str, updated: i64, cwd: &str) -> (String, i64, String, String) {
    (status.into(), updated, cwd.into(), String::new())
}

#[test]
fn a_session_mid_turn_gets_it_at_its_next_step_and_an_idle_one_is_woken_in_its_folder() {
    let now = 10_000;
    let busy = seen("working", now - 30, "/Users/me/hive");
    assert_eq!(handover("claude", "claude:abc", "hi", true, Some(&busy), now), Handover::Wait);

    // Said "working" but quiet too long (a session closed mid-turn): woken.
    let gone = seen("working", now - BUSY_FOR - 1, "/Users/me/hive");
    let Handover::Wake { program, args, cwd } = handover("claude", "claude:abc", "hi", true, Some(&gone), now) else {
        panic!("woken")
    };
    assert_eq!((program, cwd.as_str()), ("claude", "/Users/me/hive"));
    assert_eq!(args, ["--bg", "--resume", "abc", "hi"]);

    let idle = seen("done", now - 5, "/Users/me/x");
    let Handover::Wake { program, args, .. } = handover("codex", "codex:t-1", "go on", true, Some(&idle), now) else {
        panic!("woken")
    };
    assert_eq!(program, "codex");
    assert_eq!(args, ["exec", "resume", "--skip-git-repo-check", "t-1", "go on"]);
}

#[test]
fn hive_on_the_mac_takes_it_as_a_request_and_anything_else_is_refused_with_a_reason() {
    assert_eq!(handover("mac", "s1-3", "hi", true, None, 0), Handover::ToHive);
    assert!(matches!(handover("browser", "r1", "hi", true, None, 0), Handover::Fail(_)));
    assert!(matches!(handover("claude", "claude:abc", "hi", true, None, 0), Handover::Fail(why) if why.contains("folder")));
    assert_eq!(handover("hive", "hive:hive-202", "hi", true, None, 0), Handover::ToHive);
}

#[test]
fn a_cancel_reaches_only_a_session_that_is_running() {
    let now = 10_000;
    let busy = seen("working", now - 30, "/w");
    assert_eq!(handover("claude", "claude:abc", "stop", false, Some(&busy), now), Handover::Wait);
    let idle = seen("done", now - 30, "/w");
    assert!(matches!(handover("claude", "claude:abc", "stop", false, Some(&idle), now), Handover::Settled(_)));
}

#[test]
fn a_session_whose_folder_was_never_noted_is_found_from_its_transcript() {
    let dir = tempfile::tempdir().unwrap();
    let claude = dir.path().join("a.jsonl");
    std::fs::write(&claude, "{\"type\":\"summary\"}\n{\"type\":\"user\",\"cwd\":\"/Users/me/site\"}\n").unwrap();
    assert_eq!(cwd_of_transcript(claude.to_str().unwrap()), "/Users/me/site");
    let codex = dir.path().join("rollout.jsonl");
    std::fs::write(&codex, "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/Users/me/api\"}}\n").unwrap();
    assert_eq!(cwd_of_transcript(codex.to_str().unwrap()), "/Users/me/api");

    let known = (String::from("done"), 0, String::new(), claude.to_string_lossy().into_owned());
    assert!(matches!(handover("claude", "claude:a", "hi", true, Some(&known), 1), Handover::Wake { cwd, .. } if cwd == "/Users/me/site"));
}

#[test]
fn the_owners_words_reach_the_model_after_a_tool_or_keep_a_finishing_turn_going() {
    let said = as_said(&["Also check the phone".into()]);
    assert!(said.contains("in their own words") && said.ends_with("Also check the phone"));

    let after_tool = merge("PostToolUse", Value::Null, &said);
    assert_eq!(after_tool["hookSpecificOutput"]["hookEventName"], "PostToolUse");
    assert_eq!(after_tool["hookSpecificOutput"]["additionalContext"], said);

    let ledger_said = json!({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "Hive saved this as M3."}});
    let prompt = merge("UserPromptSubmit", ledger_said, &said);
    let context = prompt["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    assert!(context.starts_with("Hive saved this as M3.") && context.ends_with("Also check the phone"));

    let stop = merge("Stop", Value::Null, &said);
    assert_eq!((stop["decision"].as_str(), stop["reason"].as_str()), (Some("block"), Some(said.as_str())));
    let blocked = merge("Stop", json!({"decision": "block", "reason": "Report T4 first."}), &said);
    assert!(blocked["reason"].as_str().unwrap().starts_with("Report T4 first.\n\n"));
}

#[test]
fn messages_are_kept_once_handed_over_and_reported_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("live.sqlite3");
    let live = Live::open(&path).unwrap();
    for (session, event, cwd) in [("busy", "PostToolUse", "/w/busy"), ("idle", "Stop", "/w/idle")] {
        live.note("claude", &json!({"session_id": session, "hook_event_name": event, "cwd": cwd, "transcript_path": "/nope"})).unwrap();
    }
    let inbox = Inbox::open(&path).unwrap();
    let messages = [
        json!({"id": 1, "run": "claude:busy", "agent": "claude", "text": "one"}),
        json!({"id": 2, "run": "claude:idle", "agent": "claude", "text": "two"}),
        json!({"id": 3, "run": "s9-1", "agent": "mac", "text": "three"}),
        json!({"id": 4, "run": "r5", "agent": "cloud", "text": "four"}),
    ];
    assert_eq!(inbox.keep(&messages).unwrap(), 4);
    assert_eq!(inbox.keep(&messages).unwrap(), 0, "the same message twice is kept once");

    let (mut woken, mut asked) = (vec![], vec![]);
    let handed = hand_over(
        &inbox,
        hive_tasks::now(),
        &mut |program: &str, args: &[String], cwd: &str| {
            woken.push((program.to_string(), args.last().cloned().unwrap(), cwd.to_string()));
            Ok("woken".to_string())
        },
        &mut |id: i64, text: &str| {
            asked.push((id, text.to_string()));
            Err("Hive isn't running on this Mac, so it can't take it yet.".to_string())
        },
    )
    .unwrap();
    assert_eq!(handed, 3, "the busy session's message waits for its next step");
    assert_eq!(woken, [("claude".to_string(), "two".to_string(), "/w/idle".to_string())]);
    assert_eq!(asked, [(3, "three".to_string())]);

    // The busy session's next hook takes its message.
    assert_eq!(inbox.take_for("claude:busy", "at its next step").unwrap(), ["one"]);
    assert!(inbox.take_for("claude:busy", "at its next step").unwrap().is_empty());

    let report = inbox.unreported().unwrap();
    let states: Vec<(i64, &str)> = report.iter().map(|(id, state, _)| (*id, state.as_str())).collect();
    assert_eq!(states, [(1, "delivered"), (2, "delivered"), (3, "failed"), (4, "failed")]);
    assert!(report[3].2.contains("doesn't run that agent"));
    for (id, ..) in &report {
        inbox.reported(*id).unwrap();
    }
    assert!(inbox.unreported().unwrap().is_empty());
}

#[test]
fn an_open_session_shows_its_messages_as_the_owners_prompts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("live.sqlite3");
    let live = Live::open(&path).unwrap();
    live.note("claude", &json!({"session_id": "open", "hook_event_name": "Stop", "cwd": "/w/open", "transcript_path": "/nope"})).unwrap();
    let inbox = Inbox::open(&path).unwrap();
    let at = hive_tasks::now();
    inbox.listen("claude:open", at).unwrap();
    inbox
        .keep(&[
            json!({"id": 1, "run": "claude:open", "agent": "claude", "text": "my answer"}),
            json!({"id": 2, "run": "claude:open", "agent": "claude", "text": "stop T9", "wake": 0}),
        ])
        .unwrap();
    // No background copy is started while it listens: its mod takes the message.
    let mut woken = 0;
    let handed = hand_over(&inbox, at, &mut |_: &str, _: &[String], _: &str| { woken += 1; Ok(String::new()) }, &mut |_: i64, _: &str| Ok(String::new())).unwrap();
    assert_eq!((handed, woken), (1, 0), "only the cancel settles (nothing running to stop)");
    assert_eq!(inbox.for_prompts("claude:open").unwrap(), vec![json!({"id": 1, "text": "my answer"})]);
    assert_eq!(inbox.for_prompts("claude:open").unwrap().len(), 1, "waiting until it says it showed it");
    assert_eq!(inbox.shown("claude:open", &[1]).unwrap(), 1);
    assert!(inbox.for_prompts("claude:open").unwrap().is_empty());
    let report = inbox.unreported().unwrap();
    assert!(report.iter().any(|(id, state, detail)| *id == 1 && state == "delivered" && detail.contains("as your message")), "{report:?}");

    // Once its mod stops saying so (the app closed), a message wakes it as before.
    assert!(inbox.listened("claude:open", at).unwrap());
    assert!(!inbox.listened("claude:open", at + hive_tasks::inbox::LISTEN_FOR).unwrap());
    inbox.keep(&[json!({"id": 3, "run": "claude:open", "agent": "claude", "text": "later"})]).unwrap();
    let handed = hand_over(&inbox, at + 600, &mut |_: &str, _: &[String], _: &str| { woken += 1; Ok(String::new()) }, &mut |_: i64, _: &str| Ok(String::new())).unwrap();
    assert_eq!((handed, woken), (1, 1));
}

#[test]
fn a_harness_that_stops_at_once_says_why() {
    assert!(woke("codex", "Started\n").is_ok());
    assert!(woke("claude", "hive-exit:0\n").is_ok());
    let failed = woke("claude", "No conversation found with session ID: abc\nhive-exit:1\n").unwrap_err();
    assert!(failed.contains("No conversation found"));
    assert!(woke("claude", "Session is running; started a copy\n").unwrap().contains("copy"));
}

#[test]
fn live_sessions_kept_before_folders_were_noted_still_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("live.sqlite3");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE sessions (harness TEXT NOT NULL, session TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
           offset INTEGER NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '',
           project TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'working', version INTEGER NOT NULL DEFAULT 1,
           sent INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (harness, session));
         INSERT INTO sessions (harness, session) VALUES ('claude', 'old');",
    )
    .unwrap();
    drop(db);
    let inbox = Inbox::open(&path).unwrap();
    inbox.keep(&[json!({"id": 7, "run": "claude:old", "agent": "claude", "text": "hi"})]).unwrap();
    let waiting = inbox.waiting().unwrap();
    assert_eq!(waiting[0].1.as_ref().map(|s| s.2.as_str()), Some(""));
    assert!(waiting[0].0 .4, "a message wakes its session unless it says not to");
}
