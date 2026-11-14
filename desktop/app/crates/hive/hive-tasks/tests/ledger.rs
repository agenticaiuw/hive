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
        "Edit|Write|MultiEdit|NotebookEdit|Bash"
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

#[test]
fn the_hook_does_an_agents_board_commands_itself() {
    let dir = tempfile::tempdir().unwrap();
    let ledger = Ledger::open(&dir.path().join("t.sqlite3")).unwrap();
    let (m, _) = ledger
        .save_message(
            "codex",
            "s1",
            "p",
            "Fix the login page and don't touch the API",
            1,
            false,
        )
        .unwrap();
    let hook = |command: &str| {
        ledger
            .hook(
                "codex",
                &json!({"hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/tmp",
                        "tool_name": "Bash", "tool_input": {"command": command}}),
            )
            .unwrap()
    };
    let added = hook(&format!(
        "/root/.local/bin/hive-tasks add M{m} <<'EOF'\n[{{\"quote\": \"Fix the login page\", \"title\": \"Fix login\"}},\n {{\"quote\": \"don't touch the API\", \"title\": \"API stays\", \"kind\": \"rule\"}}]\nEOF"
    ));
    let out = &added["hookSpecificOutput"];
    assert_eq!(out["permissionDecision"], "deny");
    assert!(
        out["permissionDecisionReason"]
            .as_str()
            .unwrap()
            .contains("T1 Fix login"),
        "{out}"
    );
    let reported = hook(
        r#"echo '[{"id": "T1", "status": "done", "outcome": "It'\''s fixed"}]' | hive-tasks report"#,
    );
    assert!(reported.to_string().contains("T1 done"), "{reported}");
    assert_eq!(ledger.show("T1").unwrap()["outcome"], "It's fixed");
    let bad = hook("hive-tasks report <<'EOF'\nnot json\nEOF");
    assert!(bad.to_string().contains("couldn't"), "{bad}");
    // Other commands run as usual.
    assert!(hook("cargo test").is_null());
    assert!(hive_tasks::agent_command(
        &json!({"command": ["bash", "-lc", "hive-tasks done T1 shipped it"]})
    )
    .is_some_and(|(c, id, body)| c == "done" && id == "T1" && body == "shipped it"));
}

#[test]
fn only_a_real_board_command_is_taken_over() {
    use hive_tasks::agent_command;
    let cmd = |c: &str| agent_command(&json!({"command": c}));
    assert!(cmd("git commit -m \"an agent's hive-tasks add/report could fail\"").is_none());
    assert!(cmd("grep -n 'hive-tasks add M3' notes.md").is_none());
    assert!(
        cmd("hive-tasks add <<'EOF'\n[]\nEOF").is_none(),
        "no message id"
    );
    assert!(cmd("cd /x && ~/.local/bin/hive-tasks add M3 <<'EOF'\n[]\nEOF").is_some());
    assert!(cmd("echo '[]' | hive-tasks report").is_some());
    // Chained with other work: left to run as it is.
    assert!(cmd("cargo test && hive-tasks done T1 tests pass").is_none());
    assert!(cmd("sed -i '' s/a/b/ f; echo '[]' | ~/.local/bin/hive-tasks report").is_none());
    // Codex may hand over the whole shell invocation.
    assert!(cmd("/bin/bash -lc 'hive-tasks done T2 shipped it'")
        .is_some_and(|(_, id, body)| id == "T2" && body == "shipped it"));
}

#[test]
fn harness_notices_are_not_the_owners_messages() {
    use hive_tasks::from_the_owner;
    assert!(from_the_owner("fix the login page"));
    assert!(from_the_owner("  <b>bold</b> is fine in a real message"));
    assert!(!from_the_owner(
        "<task-notification>\n<task-id>b1</task-id>\n</task-notification>"
    ));
    assert!(!from_the_owner(
        "<cross-session-message from=\"x\">hi</cross-session-message>"
    ));
    assert!(!from_the_owner(
        "\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated event"
    ));
    assert!(!from_the_owner(
        "<side-sessions-event>done</side-sessions-event>"
    ));
}

/// "2026-11-14T11:30:00.000Z" for a time, as the agents' transcripts write it.
fn utc(secs: i64) -> String {
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

#[test]
fn closing_tasks_are_charged_the_agents_time_and_tokens_shared_by_estimate() {
    let f = fixture();
    f.prompt("fix the login button and also update the footer");
    f.ledger
        .add(1, &json!([
            {"quote": "fix the login button", "title": "Login", "minutes": 10},
            {"quote": "update the footer", "title": "Footer", "minutes": 30, "part": "site footer"}
        ]))
        .unwrap();
    let at = utc(hive_tasks::now());
    let reply = json!({"type": "assistant", "timestamp": at, "message": {"id": "r1", "usage": {
        "input_tokens": 0, "output_tokens": 0,
        "iterations": [{"input_tokens": 100, "cache_read_input_tokens": 300, "output_tokens": 40}]}}});
    f.append(reply.clone());
    f.append(reply); // the same reply on a second line counts once
    f.append(
        json!({"type": "assistant", "timestamp": at, "message": {"id": "r2", "usage": {
        "input_tokens": 200, "cache_creation_input_tokens": 200, "output_tokens": 40}}}),
    );
    f.ledger
        .report(&json!([
            {"id": "T1", "status": "done", "outcome": "Fixed"},
            {"id": "T2", "status": "done", "outcome": "Updated"}
        ]))
        .unwrap();
    let task = |id: &str| -> Value {
        let board = f.ledger.board(None).unwrap();
        board["done"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .unwrap()
            .clone()
    };
    // 800 in and 80 out in all, shared 1:3 by the estimates.
    assert_eq!(
        (
            task("T1")["tokens_in"].clone(),
            task("T1")["tokens_out"].clone()
        ),
        (json!(200), json!(20))
    );
    assert_eq!(
        (
            task("T2")["tokens_in"].clone(),
            task("T2")["tokens_out"].clone()
        ),
        (json!(600), json!(60))
    );
    assert_eq!(task("T2")["part"], "site footer");
    assert!(task("T1")["work_seconds"].as_i64().unwrap() >= 0);
    // Reporting a done task again charges nothing more.
    f.ledger
        .report(&json!([{"id": "T1", "status": "done", "outcome": "Fixed, checked"}]))
        .unwrap();
    assert_eq!(task("T1")["tokens_in"], 200);
}

#[test]
fn codex_tokens_are_the_running_total_across_the_stretch_and_long_gaps_are_not_work() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollout.jsonl");
    let total = |at: i64, i: i64, o: i64| {
        json!({"timestamp": utc(at), "type": "event_msg", "payload": {"type": "token_count",
            "info": {"total_token_usage": {"input_tokens": i, "output_tokens": o}}}})
        .to_string()
    };
    let t = 1_794_660_000;
    let lines = [
        total(t - 100, 1_000, 100), // before the stretch
        total(t + 60, 1_500, 150),
        total(t + 120, 2_000, 180), // then the agent sits idle for an hour
        total(t + 120 + 3_600, 2_600, 200),
        total(t + 99_999, 9_000, 900), // after it
    ];
    std::fs::write(&path, lines.join("\n")).unwrap();
    let spent = hive_tasks::usage::spent(&path, t, t + 3_800).unwrap();
    assert_eq!((spent.tokens_in, spent.tokens_out), (1_600, 100));
    // 0→60→120 is work, the hour's gap isn't, then 3720→3800 is.
    assert_eq!(spent.busy_seconds, 60 + 60 + 80);
}
