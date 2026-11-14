use hive_tasks::{edited_paths, glob_match, owner_message, parse_iso_utc, redact, words, Ledger};
use serde_json::{json, Value};
use std::io::Write;

struct Fixture {
    _dir: tempfile::TempDir,
    ledger: Ledger,
    cwd: String,
    transcript: String,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let transcript = dir.path().join("session.jsonl");
    std::fs::write(&transcript, "{\"type\":\"user\",\"turnOrigin\":\"human\",\"message\":{\"content\":\"old history, before Hive\"}}\n").unwrap();
    let mut ledger = Ledger::open(&dir.path().join("tasks.sqlite3")).unwrap();
    ledger.command = "hive-tasks".into();
    Fixture {
        cwd: cwd.to_string_lossy().into_owned(),
        transcript: transcript.to_string_lossy().into_owned(),
        ledger,
        _dir: dir,
    }
}

impl Fixture {
    fn hook(&self, event: &str, extra: Value) -> Value {
        let mut input = json!({"session_id": "s1", "cwd": self.cwd, "transcript_path": self.transcript, "hook_event_name": event});
        for (k, v) in extra.as_object().unwrap() {
            input[k] = v.clone();
        }
        self.ledger.hook("claude", &input).unwrap()
    }
    fn prompt(&self, text: &str) -> String {
        self.hook("UserPromptSubmit", json!({"prompt": text}))["hookSpecificOutput"]
            ["additionalContext"]
            .as_str()
            .unwrap()
            .to_string()
    }
    fn stop(&self, active: bool) -> Value {
        self.hook("Stop", json!({"stop_hook_active": active}))
    }
    fn append(&self, line: Value) {
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&self.transcript)
            .unwrap();
        writeln!(f, "{line}").unwrap();
    }
}

const MESSAGE: &str = "fix the login button on mobile, and also the footer is wrong. never use red text anywhere in the UI";

#[test]
fn a_message_is_saved_split_reported_and_only_then_lets_the_agent_stop() {
    let f = fixture();
    let context = f.prompt(MESSAGE);
    assert!(
        context.contains("Hive saved this message as M1"),
        "{context}"
    );
    assert!(context.contains("hive-tasks add M1"), "{context}");

    // Not split yet: the stop is blocked and names the message.
    let stop = f.stop(false);
    assert_eq!(stop["decision"], "block");
    assert!(
        stop["reason"]
            .as_str()
            .unwrap()
            .contains("M1 has no tasks registered"),
        "{stop}"
    );

    // A quote that isn't the owner's words is refused.
    let invented = f.ledger.add(
        1,
        &json!([{"quote": "rewrite the whole app", "title": "Rewrite"}]),
    );
    assert!(invented.unwrap_err().contains("quote isn't in M1"));

    let added = f
        .ledger
        .add(
            1,
            &json!([
                {"quote": "fix the login button on mobile", "title": "Fix the mobile login button", "minutes": 10, "value": "high"},
                {"quote": "the footer is wrong", "title": "Fix the footer", "minutes": 45, "value": "low"},
                {"quote": "never use red text anywhere in the UI", "title": "No red text in the UI", "kind": "rule", "paths": ["web/**"]}
            ]),
        )
        .unwrap();
    assert_eq!(
        added,
        vec![
            "T1 Fix the mobile login button",
            "T2 Fix the footer",
            "R1 rule (web/**): No red text in the UI"
        ]
    );

    let stop = f.stop(true);
    assert_eq!(stop["decision"], "block");
    let reason = stop["reason"].as_str().unwrap();
    assert!(
        reason.contains("T1 Fix the mobile login button (open)")
            && reason.contains("T2 Fix the footer (open)"),
        "{reason}"
    );

    // Done needs an outcome.
    assert!(f
        .ledger
        .report(&json!([{"id": "T1", "status": "done"}]))
        .is_err());
    f.ledger
        .report(&json!([
            {"id": "T1", "status": "done", "outcome": "Button now 44pt and tappable", "evidence": "commit abc123"},
            {"id": "T2", "status": "waiting", "outcome": "Asked which footer link is wrong"}
        ]))
        .unwrap();
    assert!(
        f.stop(true).is_null(),
        "everything accounted for: the agent may stop"
    );

    let board = f.ledger.board(None).unwrap();
    assert_eq!(board["needs_you"][0]["id"], "T2");
    assert_eq!(
        board["needs_you"][0]["worth_asking"], true,
        "low value, 45 minutes"
    );
    assert_eq!(board["done"][0]["outcome"], "Button now 44pt and tappable");
    assert_eq!(board["rules"][0]["id"], "R1");
    let shown = f.ledger.show("T1").unwrap();
    assert_eq!(shown["message_text"], MESSAGE);
    assert_eq!(shown["history"].as_array().unwrap().len(), 2);
}

#[test]
fn an_unchanged_list_blocks_twice_then_lets_the_stop_through_marked_left_open() {
    let f = fixture();
    f.prompt("rename the settings tab");
    f.ledger
        .add(
            1,
            &json!([{"quote": "rename the settings tab", "title": "Rename the settings tab"}]),
        )
        .unwrap();
    assert_eq!(f.stop(false)["decision"], "block");
    assert_eq!(f.stop(true)["decision"], "block");
    assert!(f.stop(true).is_null());
    let board = f.ledger.board(None).unwrap();
    assert_eq!(board["left_open"][0]["id"], "T1");
    assert!(board["not_started"].as_array().unwrap().is_empty());
    // Any change (here, a report) starts the reminders afresh, and clears "left open".
    f.ledger
        .report(&json!([{"id": "T1", "status": "active"}]))
        .unwrap();
    assert_eq!(f.stop(false)["decision"], "block");
    assert_eq!(
        f.ledger.board(None).unwrap()["left_open"][0]["id"],
        "T1",
        "still open, still flagged"
    );
}

#[test]
fn a_message_queued_while_the_agent_worked_is_caught_from_the_transcript() {
    let f = fixture();
    f.prompt("first thing");
    f.ledger.add(1, &json!([])).unwrap();
    // Seen by the prompt hook and written to the transcript: stored once.
    f.append(json!({"type": "user", "turnOrigin": "human", "message": {"content": "first thing"}}));
    // Queued while it worked: only in the transcript.
    f.append(json!({"type": "user", "turnOrigin": "human", "timestamp": "2026-11-14T06:00:00.000Z", "message": {"content": [{"type": "text", "text": "also add dark mode"}]}}));
    // Not the owner's: a tool result, a harness note, and the summary compaction writes (which
    // Claude Code marks as a human turn).
    f.append(json!({"type": "user", "message": {"content": "tool output"}}));
    f.append(json!({"type": "user", "turnOrigin": "human", "isCompactSummary": true, "isVisibleInTranscriptOnly": true, "message": {"content": "This session is being continued"}}));
    f.append(json!({"type": "user", "turnOrigin": "task_notification", "message": {"content": "<task-notification>"}}));
    let stop = f.stop(false);
    let reason = stop["reason"].as_str().unwrap();
    assert!(
        reason.contains("M2 has no tasks registered: \"also add dark mode\""),
        "{reason}"
    );
    assert!(
        !reason.contains("old history"),
        "history from before Hive saw the session is skipped"
    );
    assert_eq!(
        f.ledger.show("M2").unwrap()["said_at"]
            .as_str()
            .unwrap()
            .len(),
        19
    );
    assert!(f.ledger.show("M3").is_err(), "nothing else was saved");
}

#[test]
fn a_repeated_message_is_flagged_and_its_open_tasks_named() {
    let f = fixture();
    f.prompt("make the header sticky");
    f.ledger
        .add(
            1,
            &json!([{"quote": "make the header sticky", "title": "Sticky header"}]),
        )
        .unwrap();
    let again = f.prompt("Make the header sticky!");
    assert!(
        again.contains("repeating themselves") && again.contains("T1 Sticky header (open)"),
        "{again}"
    );
    assert_eq!(f.ledger.show("M1").unwrap()["times"], 2);
    assert_eq!(
        f.ledger.board(None).unwrap()["not_started"][0]["repeated"],
        true
    );
}

#[test]
fn a_rule_reaches_the_agent_when_it_edits_a_matching_file_once_a_session() {
    let f = fixture();
    f.prompt("always use the shared Button component in web code");
    f.ledger
        .add(1, &json!([{"quote": "always use the shared Button component in web code", "title": "Use the shared Button component", "kind": "rule", "paths": ["web/**/*.svelte"]}]))
        .unwrap();
    let edit = |path: String| {
        f.hook(
            "PreToolUse",
            json!({"tool_name": "Edit", "tool_input": {"file_path": path}}),
        )
    };
    assert!(
        edit(format!("{}/server/main.rs", f.cwd)).is_null(),
        "not a file the rule covers"
    );
    let shown = edit(format!("{}/web/src/Nav.svelte", f.cwd));
    let text = shown["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert_eq!(shown["hookSpecificOutput"]["hookEventName"], "PreToolUse");
    assert!(
        shown["hookSpecificOutput"]
            .get("permissionDecision")
            .is_none(),
        "never touches permissions"
    );
    assert!(
        text.contains("web/src/Nav.svelte") && text.contains("R1 Use the shared Button component"),
        "{text}"
    );
    assert!(
        edit(format!("{}/web/src/Footer.svelte", f.cwd)).is_null(),
        "once a session"
    );
    // After compaction the agent has lost it, so it is shown again.
    f.hook("SessionStart", json!({"source": "compact"}));
    assert!(!edit(format!("{}/web/src/Footer.svelte", f.cwd)).is_null());
    assert_eq!(f.ledger.rule_list(None).unwrap()[0]["shown"], 2);
    f.ledger.rule_off("R1").unwrap();
    f.hook("SessionStart", json!({"source": "compact"}));
    assert!(
        edit(format!("{}/web/src/Footer.svelte", f.cwd)).is_null(),
        "a rule turned off is never shown"
    );
}

#[test]
fn compaction_puts_the_sessions_open_tasks_back_and_a_new_session_hears_of_the_projects() {
    let f = fixture();
    f.prompt("migrate the database and update the docs");
    f.ledger
        .add(1, &json!([{"quote": "migrate the database", "title": "Migrate the database"}, {"quote": "update the docs", "title": "Update the docs"}]))
        .unwrap();
    f.ledger
        .report(&json!([{"id": "T2", "status": "done", "outcome": "Docs updated"}]))
        .unwrap();
    let after = f.hook("SessionStart", json!({"source": "compact"}));
    let text = after["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert!(
        text.contains("T1 Migrate the database") && !text.contains("T2"),
        "{text}"
    );
    let other = f.ledger.hook("claude", &json!({"session_id": "s2", "cwd": f.cwd, "hook_event_name": "SessionStart", "source": "startup"})).unwrap();
    assert!(other["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap()
        .contains("T1 Migrate the database"));
}

#[test]
fn a_turn_ended_to_wait_for_background_work_is_not_blocked() {
    let f = fixture();
    f.prompt("run the full test suite");
    assert!(f
        .hook("Stop", json!({"background_tasks": [{"id": "x"}]}))
        .is_null());
    assert_eq!(f.stop(false)["decision"], "block");
}

#[test]
fn codex_messages_and_patches_are_read() {
    let line = json!({"timestamp": "2026-11-14T06:00:00.000Z", "type": "event_msg", "payload": {"type": "user_message", "message": "ship it"}}).to_string();
    assert_eq!(owner_message("codex", &line).unwrap().0, "ship it");
    assert!(owner_message("claude", &line).is_none());
    let patch = json!({"input": "*** Begin Patch\n*** Update File: web/a.ts\n@@\n*** Add File: docs/b.md\n*** End Patch"});
    assert_eq!(edited_paths(&patch), vec!["web/a.ts", "docs/b.md"]);
}

#[test]
fn helpers() {
    assert!(glob_match("web/**", "web/a/b.ts"));
    assert!(glob_match("web/", "web/a.ts"));
    assert!(glob_match("web", "web/a.ts") && !glob_match("web", "website/a.ts"));
    assert!(glob_match("**/*.rs", "src/lib.rs") && glob_match("**/*.rs", "lib.rs"));
    assert!(!glob_match("src/*.rs", "src/a/lib.rs"));
    assert_eq!(words("Fix the  login-button!"), "fix the login button");
    assert_eq!(
        redact("my password is hunter2 ok"),
        "my password is [withheld] ok"
    );
    assert_eq!(redact("key sk-abcdefghijklmnop end"), "key [withheld] end");
    assert_eq!(
        redact("change the password page layout"),
        "change the password page layout"
    );
    assert_eq!(parse_iso_utc("1970-01-02T00:00:01.5Z"), Some(86_401));
    assert_eq!(parse_iso_utc("2026-11-14T06:00:00Z"), Some(1_794_636_000));
}

#[test]
fn installing_keeps_other_hooks_and_is_undone_by_uninstalling() {
    use hive_tasks::merge_hooks;
    let theirs = json!({"model": "x", "hooks": {
        "Stop": [{"hooks": [{"type": "command", "command": "python3 other.py", "timeout": 3}]}],
        "SessionEnd": [{"hooks": [{"type": "command", "command": "cleanup.sh"}]}]
    }});
    let cmd = "/Users/me/.local/bin/hive-tasks hook claude";
    let once = merge_hooks(theirs.clone(), "claude", Some(cmd));
    assert_eq!(
        merge_hooks(once.clone(), "claude", Some(cmd)),
        once,
        "twice is the same as once"
    );
    assert_eq!(once["model"], "x");
    let stop = once["hooks"]["Stop"].as_array().unwrap();
    assert_eq!(stop.len(), 2);
    assert_eq!(stop[0]["hooks"][0]["command"], "python3 other.py");
    assert_eq!(stop[1]["hooks"][0]["command"], cmd);
    assert_eq!(
        once["hooks"]["PreToolUse"][0]["matcher"],
        "Edit|Write|MultiEdit|NotebookEdit"
    );
    assert!(
        merge_hooks(json!({}), "codex", Some(cmd))["hooks"]["PreToolUse"][0]
            .get("matcher")
            .is_none()
    );
    assert_eq!(merge_hooks(once, "claude", None), theirs);
    assert_eq!(merge_hooks(json!({}), "claude", None), json!({}));
}

#[test]
fn hive_agent_requests_go_on_the_board() {
    let dir = tempfile::tempdir().unwrap();
    let ledger = Ledger::open(&dir.path().join("t.sqlite3")).unwrap();
    let t = ledger
        .hive_request("Open Spotify and play my focus playlist")
        .unwrap();
    let board = ledger.board(Some(hive_tasks::HIVE_PROJECT)).unwrap();
    assert_eq!(board["in_progress"][0]["id"], t);
    // Said again the same day: the same task, counted twice.
    assert_eq!(
        ledger
            .hive_request("open spotify and play my focus playlist!")
            .unwrap(),
        t
    );
    ledger
        .hive_finished(&t, "done", "Playing Focus Flow on Spotify.")
        .unwrap();
    let shown = ledger.show(&t).unwrap();
    assert_eq!(shown["status"], "done");
    assert_eq!(shown["outcome"], "Playing Focus Flow on Spotify.");
    let other = ledger
        .hive_request("Send the slides to the club channel")
        .unwrap();
    ledger
        .hive_finished(&other, "interrupted", "maintenance interruption")
        .unwrap();
    assert_eq!(ledger.show(&other).unwrap()["status"], "waiting");
    // Hive's turns don't run the hooks (it records requests itself).
    assert!(ledger.board(Some("Hive")).unwrap()["not_split"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn remotes_name_the_same_project_everywhere() {
    for url in [
        "git@github.com:AgenticAIUW/hive.git",
        "https://github.com/agenticaiuw/hive",
        "https://someone@github.com/agenticaiuw/hive.git/",
        "ssh://git@github.com:22/agenticaiuw/hive.git",
    ] {
        assert_eq!(
            hive_tasks::remote_id(url).as_deref(),
            Some("github.com/agenticaiuw/hive"),
            "{url}"
        );
    }
    assert_eq!(hive_tasks::remote_id("/srv/git/hive.git"), None);
}

#[test]
fn changes_queue_for_the_cloud_and_other_machines_rules_apply_here() {
    let dir = tempfile::tempdir().unwrap();
    let ledger = Ledger::open(&dir.path().join("t.sqlite3")).unwrap();
    let t = ledger.hive_request("Water the plants at noon").unwrap();
    let (payload, keys) = ledger.sync_batch(200).unwrap();
    assert_eq!(payload["messages"].as_array().unwrap().len(), 1);
    assert_eq!(payload["tasks"][0]["status"], "active");
    ledger.sync_sent(&keys).unwrap();
    assert!(ledger.sync_batch(200).unwrap().1.is_empty());
    ledger.hive_finished(&t, "done", "Watered.").unwrap();
    let (payload, _) = ledger.sync_batch(200).unwrap();
    assert_eq!(payload["tasks"][0]["outcome"], "Watered.");

    // A rule from the VM reaches agents here, is never pushed back, and stays off once off here.
    let vm = json!([{"machine": "vm", "id": 4, "project": "github.com/o/r", "paths": "[\"docs/**\"]",
        "text": "Docs stay in plain English", "quote": "keep docs plain", "created_at": 1, "active": 1}]);
    assert_eq!(ledger.take_rules(&vm).unwrap(), 1);
    assert_eq!(ledger.take_rules(&vm).unwrap(), 1);
    let rules = ledger.rule_list(Some("github.com/o/r")).unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0]["paths"], json!(["docs/**"]));
    ledger
        .sync_sent(&ledger.sync_batch(200).unwrap().1)
        .unwrap();
    ledger.rule_off(rules[0]["id"].as_str().unwrap()).unwrap();
    assert!(ledger.sync_batch(200).unwrap().1.is_empty());
    ledger.take_rules(&vm).unwrap();
    assert_eq!(
        ledger.rule_list(Some("github.com/o/r")).unwrap()[0]["active"],
        false
    );
}
