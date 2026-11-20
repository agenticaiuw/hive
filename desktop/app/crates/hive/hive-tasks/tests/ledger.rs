use hive_tasks::{addressed_folder, agent_command, commits_in, edited_paths, folder_place, glob_match, owner_message, parse_iso_utc, redact, words, Ledger};
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
    /// Claude Code's sandbox on or off for the project (its .claude/settings.json).
    fn claude_sandbox(&self, on: bool) {
        let dir = std::path::Path::new(&self.cwd).join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), json!({"sandbox": {"enabled": on}}).to_string()).unwrap();
    }
    fn append(&self, line: Value) {
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&self.transcript)
            .unwrap();
        writeln!(f, "{line}").unwrap();
    }
}

/// Runs the command a PreToolUse hook put in place of the agent's (Claude Code in its sandbox):
/// what it printed (stdout, else stderr) and whether it exited 0.
fn run_shown(out: &Value) -> (String, bool) {
    let hook = &out["hookSpecificOutput"];
    assert_eq!(hook["permissionDecision"], "allow", "{out}");
    let command = hook["updatedInput"]["command"].as_str().expect("a command in place of the agent's");
    let ran = std::process::Command::new("sh").args(["-c", command]).output().unwrap();
    let said = if ran.stdout.is_empty() { ran.stderr } else { ran.stdout };
    (String::from_utf8_lossy(&said).trim_end().to_string(), ran.status.success())
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
            "T1 registered: Fix the mobile login button",
            "T2 registered: Fix the footer",
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
    // A task doesn't wait for the owner to try it: built and tested is done.
    let refused = f
        .ledger
        .report(&json!([{"id": "T1", "status": "waiting", "why": "Button is 44pt now", "need": "Waiting on the owner to try it."}]))
        .unwrap_err();
    assert!(refused.contains("report it done"), "{refused}");
    // Waiting needs the exact reason and the exact ask; without them the agent keeps going.
    let vague = f
        .ledger
        .report(&json!([{"id": "T2", "status": "waiting", "outcome": "Need input from the owner"}]))
        .unwrap_err();
    assert!(vague.contains("\"why\"") && vague.contains("keep going"), "{vague}");
    assert!(hive_tasks::waits_for_a_try("Waiting on the owner to test the keyboard's --test mode on the webcam"));
    assert!(!hive_tasks::waits_for_a_try("Needs the owner's yes to install it on the iPhone"));
    assert!(!hive_tasks::waits_for_a_try("Needs the owner to check their email for the sign-in code"));
    f.ledger
        .report(&json!([
            {"id": "T1", "status": "done", "outcome": "Button now 44pt and tappable", "evidence": "commit abc123"},
            {"id": "T2", "status": "waiting", "why": "The page has three footer links and the ask names none", "need": "Say which footer link is wrong"}
        ]))
        .unwrap();
    assert!(
        f.stop(true).is_null(),
        "everything accounted for: the agent may stop"
    );

    let board = f.ledger.board(None).unwrap();
    assert_eq!(board["needs_you"][0]["id"], "T2");
    assert_eq!(
        board["needs_you"][0]["outcome"],
        "Stopped because The page has three footer links and the ask names none. Needs from you: Say which footer link is wrong"
    );
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
fn a_message_never_split_becomes_one_task_in_the_owners_words() {
    let f = fixture();
    // The agent stops twice without splitting it: the third stop goes through, and the message is
    // kept as one task, quoted whole, shown as left open.
    f.prompt("hold right, short pause\nthese are way too many shortcuts to remember");
    assert_eq!(f.stop(false)["decision"], "block");
    assert_eq!(f.stop(true)["decision"], "block");
    assert!(f.stop(true).is_null());
    let board = f.ledger.board(None).unwrap();
    assert!(board["not_split"].as_array().unwrap().is_empty());
    let task = &board["left_open"][0];
    assert_eq!(task["title"], "hold right, short pause");
    assert_eq!(task["quote"], "hold right, short pause\nthese are way too many shortcuts to remember");
    assert_eq!(task["outcome"], hive_tasks::SPLIT_LEFT);
    // A message from a session that ended without a stop waits until it is older than
    // SPLIT_WITHIN; the sweep (run at every sync) then does the same; a split one is left alone.
    let g = fixture();
    g.prompt("login");
    g.prompt("rename the settings tab");
    g.ledger.add(2, &json!([])).unwrap();
    assert!(g.ledger.split_left(hive_tasks::now() - hive_tasks::SPLIT_WITHIN, None).unwrap().is_empty(), "too new");
    assert_eq!(g.ledger.split_left(hive_tasks::now() + 1, None).unwrap(), vec!["T1 login".to_string()]);
    assert!(g.ledger.split_left(hive_tasks::now() + 1, None).unwrap().is_empty(), "once");
    let board = g.ledger.board(None).unwrap();
    assert!(board["not_split"].as_array().unwrap().is_empty());
    assert_eq!(board["left_open"].as_array().unwrap().len(), 1);
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
    // The owner turns it off from a dashboard: the cloud's sync answer names it, every time.
    assert_eq!(f.ledger.take_rules_off(&json!([1])).unwrap(), 1);
    assert_eq!(f.ledger.take_rules_off(&json!([1])).unwrap(), 0, "already off: nothing to change or push");
    assert_eq!(f.ledger.rule_list(None).unwrap()[0]["active"], false);
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
        "Edit|Write|MultiEdit|NotebookEdit|Bash|Agent|Task"
    );
    assert!(
        merge_hooks(json!({}), "codex", Some(cmd))["hooks"]["PreToolUse"][0]
            .get("matcher")
            .is_none()
    );
    // After every tool call: the session's steps go to the board live (live.rs).
    assert!(once["hooks"]["PostToolUse"][0].get("matcher").is_none());
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
    // It resumes on its own after the restart, so it's not on the owner's list.
    assert_eq!(ledger.show(&other).unwrap()["status"], "open");
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
fn in_a_codex_sandbox_the_hook_does_an_agents_board_commands_itself() {
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
            .contains("T1 registered: Fix login"),
        "{out}"
    );
    let reported = hook(
        r#"echo '[{"id": "T1", "status": "done", "outcome": "It'\''s fixed"}]' | hive-tasks report"#,
    );
    assert!(reported.to_string().contains("T1 done"), "{reported}");
    assert_eq!(ledger.show("T1").unwrap()["outcome"], "It's fixed");
    let bad = hook("hive-tasks report <<'EOF'\nnot json\nEOF");
    assert!(bad.to_string().contains("it failed: That isn't JSON"), "{bad}");
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
    assert!(!from_the_owner("[Hive, not the owner] This task is stuck, and Hive continues it"));
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
    assert_eq!(task("T2")["folder"], "site footer"); // "part" is the old name for "folder"
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

#[test]
fn a_folder_keeps_its_memories_and_every_agent_put_on_it_gets_all_of_them() {
    let f = fixture();
    f.prompt("make memory retrieval faster and write down how ranking works");
    let added = f
        .ledger
        .add(1, &json!([{"quote": "make memory retrieval faster", "title": "Faster retrieval", "folder": "Memory retrieval"}]))
        .unwrap();
    assert_eq!(added[0], "T1 registered: Faster retrieval");
    assert!(added[1].contains("\"project › Memory retrieval\": no memories yet"), "{added:?}");
    f.ledger.remember("project", "memory retrieval", "spec", "# Ranking\nRecent facts first, then by match.").unwrap();
    f.ledger.remember("project", "Memory Retrieval", "decision", "No embeddings on the Mac").unwrap();
    assert!(f.ledger.remember("project", "memory retrieval", "gossip", "x").is_err());

    // Registering a task in the folder loads every memory, and says how many.
    f.prompt("also cache the retrieval results");
    let added = f
        .ledger
        .add(2, &json!([{"quote": "cache the retrieval results", "title": "Cache", "folder": "memory retrieval"}]))
        .unwrap();
    let brief = &added[1];
    assert!(brief.contains("all 2 of its memories, in full"), "{brief}");
    assert!(brief.contains("--- 1/2 · spec · Ranking ·") && brief.contains("Recent facts first, then by match."));
    assert!(brief.contains("--- 2/2 · decision · No embeddings on the Mac ·"));
    assert!(brief.contains("(2 of 2) ---"));
    // Same folder whatever the case; the name stays as first written.
    let folders = f.ledger.folders(Some("project")).unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0]["name"], "Memory retrieval");
    assert_eq!(folders[0]["memories"], 2);

    // A subagent handed work in the folder gets them in its prompt.
    let out = f.hook(
        "PreToolUse",
        json!({"tool_name": "Agent", "tool_input": {"description": "cache", "prompt": "Add a cache.\nHive folder: project › memory retrieval"}}),
    );
    let prompt = out["hookSpecificOutput"]["updatedInput"]["prompt"].as_str().unwrap();
    assert!(prompt.starts_with("Add a cache.\nHive folder:"));
    assert!(prompt.contains("Recent facts first") && prompt.contains("No embeddings on the Mac"));
    assert_eq!(out["hookSpecificOutput"]["updatedInput"]["description"], "cache");
    // One without a folder line is left alone.
    let out = f.hook("PreToolUse", json!({"tool_name": "Agent", "tool_input": {"prompt": "Look around."}}));
    assert!(out.is_null());

    // A done task's report goes on the task and into the folder's memories, once.
    f.ledger
        .report(&json!([{"id": "T1", "status": "done", "outcome": "Retrieval is 3× faster.", "report": "Indexed facts by project; queries take 40 ms now. Left: the VM copy."}]))
        .unwrap();
    f.ledger.report(&json!([{"id": "T1", "status": "done", "outcome": "Retrieval is 3× faster."}])).unwrap();
    let t1 = f.ledger.show("T1").unwrap();
    assert!(t1["report"].as_str().unwrap().starts_with("Retrieval is 3× faster."), "{t1}");
    let memories = f.ledger.memories("project", "memory retrieval").unwrap();
    let reports: Vec<_> = memories.iter().filter(|m| m["kind"] == "report").collect();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0]["title"], "T1 Faster retrieval");
    assert_eq!(reports[0]["task"], "T1");
    // A report without a folder stays on the task.
    f.prompt("rename the settings tab");
    f.ledger.add(3, &json!([{"quote": "rename the settings tab", "title": "Rename"}])).unwrap();
    f.ledger.report(&json!([{"id": "T3", "status": "done", "outcome": "Renamed it Preferences."}])).unwrap();
    assert_eq!(f.ledger.show("T3").unwrap()["report"], "Renamed it Preferences.");
    // Reporting with a folder files the task there first, another project's folder too.
    f.ledger
        .report(&json!([{"id": "T3", "status": "done", "outcome": "Renamed it Preferences.", "folder": "hive › Settings"}]))
        .unwrap();
    assert_eq!(f.ledger.show("T3").unwrap()["folder"], "hive › Settings");
    let filed = f.ledger.memories("hive", "settings").unwrap();
    assert_eq!(filed.len(), 1);
    assert_eq!(filed[0]["title"], "T3 Rename");
}

#[test]
fn a_message_from_the_dashboard_names_its_folder_and_gets_the_folders_memories() {
    let f = fixture();
    f.ledger.remember("bucky match", "major requirements validation", "spec", "Rules\nA major needs 3 electives.").unwrap();
    assert_eq!(
        addressed_folder("For Bucky Match › Major requirements validation: check the CS major"),
        Some(("bucky match".into(), "Major requirements validation".into()))
    );
    assert_eq!(addressed_folder("For hive: do it"), None);
    let context = f.prompt("For Bucky Match › Major requirements validation: check the CS major");
    assert!(context.contains("for the folder \"bucky match › major requirements validation\""), "{context}");
    assert!(context.contains("A major needs 3 electives."));
    // The project's folders are listed for the agent to file tasks in.
    f.ledger.ensure_folder("project", "Footer").unwrap();
    let context = f.prompt("change the footer links");
    assert!(context.contains("Folders in project: Footer."), "{context}");
    // Another project's folder, named in full, is kept that way on the task.
    f.ledger
        .add(2, &json!([{"quote": "change the footer links", "title": "Links", "folder": "hive › Dashboard"}]))
        .unwrap();
    assert_eq!(f.ledger.show("T1").unwrap()["folder"], "hive › Dashboard");
    assert_eq!(folder_place("/x/project", "Footer"), Some(("project".into(), "Footer".into())));
    assert_eq!(folder_place("/x/project", "  "), None);
    // Hive's own agent: a dashboard send goes in its folder, and its turn gets the memories.
    let t = f.ledger.hive_request("For Bucky Match › Major requirements validation: check minors too").unwrap();
    assert_eq!(f.ledger.show(&t).unwrap()["folder"], "bucky match › major requirements validation");
    let context = f.ledger.folder_context("For bucky match › major requirements validation: x").unwrap();
    assert!(context.contains("its 1 memory, in full") && context.contains("A major needs 3 electives."), "{context}");
}

#[test]
fn folders_and_memories_go_to_the_cloud_and_those_made_elsewhere_come_back_once() {
    let f = fixture();
    f.ledger.remember("hive", "Voice", "note", "Parakeet\nRuns in the sidecar.").unwrap();
    f.prompt("say hello");
    f.ledger.add(1, &json!([{"quote": "say hello", "title": "Hello"}])).unwrap();
    f.ledger.report(&json!([{"id": "T1", "status": "done", "outcome": "Said it."}])).unwrap();
    let (batch, keys) = f.ledger.sync_batch(200).unwrap();
    // Each task's history goes too: nothing stays only on this machine.
    let events: Vec<_> = batch["events"].as_array().unwrap().iter().map(|e| e["status"].as_str().unwrap().to_string()).collect();
    assert_eq!(events, ["open", "done"]);
    assert_eq!(batch["events"][1]["note"], "Said it.");
    assert_eq!(batch["folders"][0]["name"], "Voice");
    assert_eq!(batch["memories"][0]["title"], "Parakeet");
    f.ledger.sync_sent(&keys).unwrap();
    let taken = f
        .ledger
        .take_folders(&json!({
            "folders": [{"project": "hive", "key": "voice", "name": "Voice", "about": "Speech in and out", "created_at": 1, "updated_at": 4102444800i64}],
            "memories": [{"machine": "web", "id": 1, "project": "hive", "folder": "voice", "kind": "spec", "title": "Wake word", "body": "Hey Hive", "created_at": 2}]
        }))
        .unwrap();
    assert_eq!(taken, 2);
    // Taking the same again changes nothing, and none of it is pushed back.
    f.ledger
        .take_folders(&json!({"memories": [{"machine": "web", "id": 1, "project": "hive", "folder": "voice", "kind": "spec", "title": "Wake word", "body": "Hey Hive", "created_at": 2}]}))
        .unwrap();
    let (batch, _) = f.ledger.sync_batch(200).unwrap();
    assert_eq!(batch["folders"].as_array().unwrap().len(), 0, "{batch}");
    assert_eq!(batch["memories"].as_array().unwrap().len(), 0, "{batch}");
    let brief = f.ledger.folder_brief("hive", "voice").unwrap();
    assert!(brief.contains("all 2 of its memories") && brief.contains("What it's for: Speech in and out"), "{brief}");
    let memories = f.ledger.memories("hive", "voice").unwrap();
    assert_eq!(memories[0]["from"], "web"); // oldest first
    assert_eq!(memories[1]["from"], Value::Null); // made here
}

#[test]
fn a_long_folder_is_written_to_a_file_the_agent_reads_whole() {
    let f = fixture();
    for i in 0..30 {
        f.ledger.remember("hive", "Dream", "note", &format!("Night {i}\n{}", "x".repeat(1000))).unwrap();
    }
    let brief = f.ledger.folder_brief("hive", "dream").unwrap();
    assert!(brief.contains("all 30 of its memories") && brief.contains("Read that whole file"), "{brief}");
    let path = brief.split(" are in ").nth(1).unwrap().split(". Read").next().unwrap();
    let file = std::fs::read_to_string(path).unwrap();
    assert!(file.contains("--- 30/30 · note · Night 29") && file.contains("(30 of 30)"));
}

#[test]
fn an_agents_folder_commands_are_done_by_the_hook() {
    let cmd = |c: &str| agent_command(&json!({"command": c}));
    assert_eq!(
        cmd("hive-tasks folder \"hive › Voice\""),
        Some(("folder".into(), "hive › Voice".into(), String::new()))
    );
    assert_eq!(
        cmd("hive-tasks remember 'hive › Voice' spec <<'EOF'\nWake word\nHey Hive\nEOF"),
        Some(("remember:spec".into(), "hive › Voice".into(), "Wake word\nHey Hive".into()))
    );
    assert_eq!(
        cmd("hive-tasks remember \"Voice\" <<EOF\nA note\nEOF"),
        Some(("remember:note".into(), "Voice".into(), "A note".into()))
    );
    assert_eq!(cmd("hive-tasks folder Voice && rm -rf x"), None);
    let f = fixture();
    f.claude_sandbox(true);
    let out = f.hook(
        "PreToolUse",
        json!({"tool_name": "Bash", "tool_input": {"command": "hive-tasks remember \"Voice\" decision <<'EOF'\nOn device\nKeep it local.\nEOF"}}),
    );
    let (said, ok) = run_shown(&out);
    assert!(ok && said.contains("Saved to project › Voice as a decision: On device"), "{said}");
    let out = f.hook("PreToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "hive-tasks folder Voice"}}));
    let (said, ok) = run_shown(&out);
    assert!(ok && said.contains("Keep it local."), "{said}");
}

#[test]
fn a_task_keeps_the_files_its_agent_edited_and_the_commits_it_made() {
    let f = fixture();
    f.prompt("fix the login page and the signup page");
    f.ledger
        .add(1, &json!([{"quote": "fix the login page", "title": "Fix login"}, {"quote": "the signup page", "title": "Fix signup"}]))
        .unwrap();
    // Nothing is kept for a task that isn't active.
    let edit = |path: &str| f.hook("PreToolUse", json!({"tool_name": "Edit", "tool_input": {"file_path": path}}));
    edit(&format!("{}/src/login.ts", f.cwd));
    assert_eq!(f.ledger.show("T1").unwrap()["files"], json!([]));

    f.ledger.report(&json!([{"id": "T1", "status": "active"}])).unwrap();
    edit(&format!("{}/src/login.ts", f.cwd));
    edit(&format!("{}/src/login.ts", f.cwd)); // once, however often it's edited
    edit(&format!("{}/src/auth.ts", f.cwd));
    let commit = |command: Value, stdout: &str| {
        f.hook(
            "PostToolUse",
            json!({"tool_name": "Bash", "tool_input": {"command": command}, "tool_response": {"stdout": stdout, "stderr": ""}}),
        )
    };
    assert!(commit(json!("git commit -m 'Fix login'"), "[main e9256e3] Fix the login page\n 2 files changed").is_null());
    commit(json!("git log -1"), "[main 1234567] not made by this command");
    commit(json!(["bash", "-lc", "git commit --amend"]), "[main 0abcdef1] Fix the login page, really");
    let t1 = f.ledger.show("T1").unwrap();
    assert_eq!(t1["files"], json!(["src/login.ts", "src/auth.ts"]));
    let hashes: Vec<&str> = t1["commits"].as_array().unwrap().iter().map(|c| c["hash"].as_str().unwrap()).collect();
    assert_eq!(hashes, ["e9256e3", "0abcdef1"]);
    assert_eq!(t1["commits"][0]["title"], "Fix the login page");
    assert_eq!(f.ledger.show("T2").unwrap()["files"], json!([]));

    // They go to the cloud with the task.
    let (batch, _) = f.ledger.sync_batch(100).unwrap();
    let synced = batch["tasks"].as_array().unwrap().iter().find(|t| t["id"] == 1).unwrap().clone();
    assert!(synced["files"].as_str().unwrap().contains("src/auth.ts"), "{synced}");
    assert!(synced["commits"].as_str().unwrap().contains("e9256e3"));
}

#[test]
fn git_commit_output_is_read_for_its_commits() {
    let made = commits_in("[main (root-commit) 1a2b3c4] First\n[detached HEAD 89abcdef] Second\nnoise [x 1234567] no");
    assert_eq!(made.len(), 2);
    assert_eq!(made[0]["hash"], "1a2b3c4");
    assert_eq!(made[0]["branch"], "main");
    assert_eq!(made[1]["branch"], "detached HEAD");
    assert_eq!(made[1]["title"], "Second");
}

#[test]
fn codex_plan_limits_are_read_from_its_newest_session() {
    let home = tempfile::tempdir().unwrap();
    let day = home.path().join("sessions/2026/11/14");
    std::fs::create_dir_all(&day).unwrap();
    let count = |at: &str, used: f64| {
        format!(
            r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":null,"rate_limits":{{"primary":{{"used_percent":{used},"window_minutes":300,"resets_at":1795000000}},"secondary":{{"used_percent":40.0,"window_minutes":10080,"resets_at":1795500000}},"plan_type":"pro"}}}}}}"#
        )
    };
    let lines = [count("2026-11-14T10:00:00.000Z", 10.0), count("2026-11-14T10:05:00.000Z", 12.5), r#"{"timestamp":"2026-11-14T10:06:00.000Z","type":"response_item"}"#.to_string()];
    std::fs::write(day.join("rollout-a.jsonl"), lines.join("\n")).unwrap();
    let limits = hive_tasks::usage::codex_limits(home.path()).unwrap();
    assert_eq!(limits["plan"], "pro");
    assert_eq!(limits["windows"][0]["used"], 12.5);
    assert_eq!(limits["windows"][0]["minutes"], 300);
    assert_eq!(limits["windows"][1]["minutes"], 10080);
    assert_eq!(limits["windows"][1]["resets_at"], 1795500000);
    assert!(limits["at"].as_i64().unwrap() > 0);
    assert!(hive_tasks::usage::codex_limits(&home.path().join("nowhere")).is_none());
}

#[test]
fn a_session_that_starts_another_sessions_task_takes_it_over_and_a_dashboard_cancel_drops_it() {
    let f = fixture();
    f.prompt(MESSAGE);
    f.ledger
        .add(1, &json!([
            {"quote": "fix the login button on mobile", "title": "Fix the login button", "minutes": 10, "value": "high"},
            {"quote": "the footer is wrong", "title": "Fix the footer", "minutes": 10, "value": "low"}
        ]))
        .unwrap();

    // Another session reports T1 active: it's that session's now, and s1's Stop no longer asks about it.
    // (`hive-tasks report` run in a session reports as that session: hive_tasks::session_from_env.)
    let report = |session: &str, body: Value| f.ledger.report_by(&body, Some(("claude", session))).unwrap();
    report("s2", json!([{"id": "T1", "status": "active"}]));
    let (batch, _) = f.ledger.sync_batch(200).unwrap();
    let t1 = batch["tasks"].as_array().unwrap().iter().find(|t| t["id"] == 1).unwrap().clone();
    assert_eq!((t1["claimed_harness"].as_str(), t1["claimed_session"].as_str()), (Some("claude"), Some("s2")));
    let stop = f.stop(false);
    let reason = stop["reason"].as_str().unwrap_or("");
    assert!(!reason.contains("T1 "), "{reason}");
    assert!(reason.contains("T2"), "{reason}");

    // Handing a task over by name.
    report("s1", json!([{"id": "T2", "status": "blocked", "outcome": "Handed to s3", "agent": "codex:s3"}]));
    let (batch, _) = f.ledger.sync_batch(200).unwrap();
    let t2 = batch["tasks"].as_array().unwrap().iter().find(|t| t["id"] == 2).unwrap().clone();
    assert_eq!(t2["claimed_session"], "s3");

    // The owner cancels T1 from a dashboard: the next sync answer drops it here.
    assert_eq!(f.ledger.take_cancelled(&json!([1, 99])).unwrap(), 1);
    assert_eq!(f.ledger.take_cancelled(&json!([1])).unwrap(), 0);
    let (batch, _) = f.ledger.sync_batch(200).unwrap();
    let t1 = batch["tasks"].as_array().unwrap().iter().find(|t| t["id"] == 1).unwrap().clone();
    assert_eq!(t1["status"], "dropped");
    assert_eq!(t1["outcome"], "Cancelled by the owner from the dashboard.");
}

#[test]
fn limits_from_a_signed_out_account_are_dropped_and_claude_reports_its_own() {
    use hive_tasks::usage::{codex_signed_in_plan, SignedIn};
    let home = tempfile::tempdir().unwrap();
    assert_eq!(codex_signed_in_plan(home.path()), SignedIn::Out);
    // An ID token's middle part is URL-safe base64 of its claims (unpadded).
    let claims = r#"{"https://api.openai.com/auth":{"chatgpt_plan_type":"prolite"},"sub":"x"}"#;
    let table = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut b64 = String::new();
    for chunk in claims.as_bytes().chunks(3) {
        let n = chunk.iter().fold(0u32, |a, &b| (a << 8) | b as u32) << (8 * (3 - chunk.len()));
        for i in 0..=chunk.len() {
            b64.push(table[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    let auth = json!({"tokens": {"id_token": format!("e30.{b64}.sig")}});
    std::fs::write(home.path().join("auth.json"), auth.to_string()).unwrap();
    assert_eq!(codex_signed_in_plan(home.path()), SignedIn::Plan("prolite".into()));
    std::fs::write(home.path().join("auth.json"), r#"{"OPENAI_API_KEY":"k"}"#).unwrap();
    assert_eq!(codex_signed_in_plan(home.path()), SignedIn::Unknown);

    // A home's readings show while their plan is the one signed in there, and go once it isn't.
    use hive_tasks::{codex_reading, CodexReading};
    assert_eq!(codex_reading(home.path()), CodexReading::Nothing, "no session logs: nothing to say");
    let day = home.path().join("sessions/2026/11/14");
    std::fs::create_dir_all(&day).unwrap();
    let reading = |plan: &str| {
        format!(r#"{{"timestamp":"2026-11-14T10:00:00.000Z","type":"event_msg","payload":{{"type":"token_count","rate_limits":{{"primary":{{"used_percent":94.0,"window_minutes":43200,"resets_at":1795000000}},"plan_type":"{plan}"}}}}}}"#)
    };
    std::fs::write(day.join("rollout-a.jsonl"), reading("free")).unwrap();
    std::fs::write(home.path().join("auth.json"), auth.to_string()).unwrap();
    assert_eq!(codex_reading(home.path()), CodexReading::Gone, "the free account's readings, Pro signed in now");
    std::fs::write(day.join("rollout-a.jsonl"), reading("prolite")).unwrap();
    assert!(matches!(codex_reading(home.path()), CodexReading::Shown(l) if l["plan"] == "prolite"));
    std::fs::remove_file(home.path().join("auth.json")).unwrap();
    assert_eq!(codex_reading(home.path()), CodexReading::Gone, "signed out");

    // Claude Code's windows, as the board keeps them, and the plan's name.
    let windows = hive_tasks::claude_windows(&json!([
        {"kind": "five_hour", "percentUsed": 23.5, "resetsAt": "2026-11-17T08:00:00Z"},
        {"kind": "seven_day", "percentUsed": 7, "resetsAt": "2026-11-20T02:00:00.000-06:00"},
        {"kind": "spend_limit", "percentUsed": 1}
    ]))
    .unwrap();
    assert_eq!(windows, vec![
        json!({"minutes": 300, "used": 23.5, "resets_at": 1_794_902_400}),
        json!({"minutes": 10080, "used": 7.0, "resets_at": 1_795_161_600}),
    ]);
    assert_eq!(hive_tasks::epoch_of("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(hive_tasks::claude_plan(Some("default_claude_max_5x"), Some("claude_max")).as_deref(), Some("Max 5x"));
    assert_eq!(hive_tasks::claude_plan(Some("default_claude_max_20x"), None).as_deref(), Some("Max 20x"));
    assert_eq!(hive_tasks::claude_plan(None, Some("claude_pro")).as_deref(), Some("Pro"));
}

#[test]
fn a_board_command_runs_itself_unless_claude_codes_sandbox_is_on() {
    let f = fixture();
    f.prompt(MESSAGE);
    let bash = |tool_input: Value| f.hook("PreToolUse", json!({"tool_name": "Bash", "tool_input": tool_input}));
    let add = "hive-tasks add M1 <<'EOF'\n[{\"quote\": \"fix the login button on mobile\", \"title\": \"Fix the login button\"}]\nEOF";
    // Sandbox off: the hook leaves the call alone (no block, no hook error) and does nothing itself;
    // the command registers the task and prints what happened.
    f.claude_sandbox(false);
    assert!(bash(json!({"command": add, "description": "Register tasks"})).is_null());
    assert!(f.ledger.show("T1").is_err(), "the hook must not have done it too");
    // A call that asks to skip the sandbox runs itself too.
    f.claude_sandbox(true);
    assert!(bash(json!({"command": add, "dangerouslyDisableSandbox": true})).is_null());
    assert!(f.ledger.show("T1").is_err());

    // In the sandbox the hook does it, and the call runs a command that prints what happened,
    // exiting 0 (allowed, not denied: nothing shows as a hook error).
    let out = bash(json!({"command": add, "description": "Register tasks"}));
    assert_eq!(out["hookSpecificOutput"]["updatedInput"]["description"], "Register tasks");
    let (said, ok) = run_shown(&out);
    assert!(ok && said == "T1 registered: Fix the login button", "{said}");
    assert_eq!(f.ledger.show("T1").unwrap()["title"], "Fix the login button");
    // The owner's words survive the shell, quotes and all.
    let out = bash(json!({"command": "hive-tasks remember \"Voice\" <<'EOF'\nDon't use 'red' text\nEOF"}));
    let (said, ok) = run_shown(&out);
    assert!(ok && said.contains("Don't use 'red' text"), "{said}");
    // A mistake is an ordinary failed command: the reason on stderr, exit 1.
    let out = bash(json!({"command": "echo 'not json' | hive-tasks report"}));
    let (said, ok) = run_shown(&out);
    assert!(!ok && said.starts_with("That isn't JSON"), "{said}");
    let out = bash(json!({"command": "hive-tasks add M1 <<'EOF'\n[{\"quote\": \"words never said\", \"title\": \"X\"}]\nEOF"}));
    let (said, ok) = run_shown(&out);
    assert!(!ok && said.contains("quote isn't in M1"), "{said}");
}

#[test]
fn codex_in_full_access_runs_board_commands_itself() {
    use hive_tasks::{codex_sandbox, runs_sandboxed};
    let dir = tempfile::tempdir().unwrap();
    let ledger = Ledger::open(&dir.path().join("t.sqlite3")).unwrap();
    let (m, _) = ledger.save_message("codex", "s1", "p", "Fix the login page", 1, false).unwrap();
    let rollout = dir.path().join("rollout.jsonl");
    let turn = |sandbox: &str| {
        json!({"timestamp": "2026-11-20T00:00:00.000Z", "type": "turn_context",
               "payload": {"cwd": "/tmp", "approval_policy": "never", "sandbox_policy": {"type": sandbox}}})
        .to_string()
    };
    let said = |text: &str| json!({"type": "response_item", "payload": {"type": "message", "content": [{"text": text}]}}).to_string();
    let input = |command: &str, transcript: &std::path::Path| {
        json!({"hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/tmp", "transcript_path": transcript,
               "tool_name": "Bash", "tool_input": {"command": command}})
    };
    let add = format!("hive-tasks add M{m} <<'EOF'\n[{{\"quote\": \"Fix the login page\", \"title\": \"Fix login\"}}]\nEOF");

    // The newest turn is in full access: the command runs itself.
    std::fs::write(&rollout, format!("{}\n{}\n{}\n", turn("workspace-write"), turn("danger-full-access"),
        said("a message quoting \"type\":\"turn_context\" isn't one"))).unwrap();
    assert_eq!(codex_sandbox(rollout.to_str().unwrap()).as_deref(), Some("danger-full-access"));
    assert!(!runs_sandboxed("codex", &input(&add, &rollout)));
    assert!(ledger.hook("codex", &input(&add, &rollout)).unwrap().is_null());
    assert!(ledger.show("T1").is_err());

    // Back in the sandbox (a later turn): the hook does it and tells Codex the result.
    let mut f = std::fs::OpenOptions::new().append(true).open(&rollout).unwrap();
    writeln!(f, "{}", turn("workspace-write")).unwrap();
    let out = ledger.hook("codex", &input(&add, &rollout)).unwrap();
    assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "deny");
    let reason = out["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap();
    assert!(reason.contains("sandbox") && reason.contains("T1 registered: Fix login"), "{reason}");

    // A rollout with no turn in its last 4 MB is read whole.
    let long = dir.path().join("long.jsonl");
    let filler = said(&"x".repeat(1000));
    let mut text = turn("danger-full-access") + "\n";
    for _ in 0..5000 {
        text.push_str(&filler);
        text.push('\n');
    }
    std::fs::write(&long, text).unwrap();
    assert_eq!(codex_sandbox(long.to_str().unwrap()).as_deref(), Some("danger-full-access"));
    // No rollout to read: sandboxed, as Codex is by default.
    assert!(runs_sandboxed("codex", &input(&add, &dir.path().join("missing.jsonl"))));
}

#[test]
fn claude_codes_sandbox_setting_is_read_strongest_first() {
    use hive_tasks::claude_sandbox_on;
    let dir = tempfile::tempdir().unwrap();
    let (user, managed, repo) = (dir.path().join("user"), dir.path().join("managed"), dir.path().join("repo"));
    let cwd = repo.join("src");
    for d in [&user, &managed, &cwd, &repo.join(".claude")] {
        std::fs::create_dir_all(d).unwrap();
    }
    let set = |file: std::path::PathBuf, on: bool| {
        std::fs::write(file, json!({"permissions": {}, "sandbox": {"enabled": on}}).to_string()).unwrap()
    };
    assert!(!claude_sandbox_on(&cwd, &user, &managed), "off when nothing says");
    set(user.join("settings.json"), true);
    assert!(claude_sandbox_on(&cwd, &user, &managed));
    set(repo.join(".claude/settings.json"), false);
    assert!(!claude_sandbox_on(&cwd, &user, &managed), "the project's beats the user's");
    set(repo.join(".claude/settings.local.json"), true);
    assert!(claude_sandbox_on(&cwd, &user, &managed), "the local file beats the project's");
    set(managed.join("managed-settings.json"), false);
    assert!(!claude_sandbox_on(&cwd, &user, &managed), "managed settings beat all");
}

#[test]
fn a_command_knows_its_session_from_its_harness() {
    use hive_tasks::session_from_env;
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        move |k: &str| pairs.iter().find(|(name, _)| *name == k).map(|(_, v)| v.to_string())
    };
    assert_eq!(session_from_env(env(&[("CLAUDE_CODE_SESSION_ID", "abc")])), Some(("claude", "abc".into())));
    assert_eq!(session_from_env(env(&[("CODEX_THREAD_ID", "t-1")])), Some(("codex", "t-1".into())));
    // Codex started from a Claude Code session: its commands are Codex's.
    assert_eq!(
        session_from_env(env(&[("CLAUDE_CODE_SESSION_ID", "abc"), ("CODEX_THREAD_ID", "t-1")])),
        Some(("codex", "t-1".into()))
    );
    assert_eq!(session_from_env(env(&[("CLAUDE_CODE_SESSION_ID", " ")])), None);
    assert_eq!(session_from_env(env(&[])), None);
}

/// The installed command, run the way an agent runs it: it says what happened on stdout and exits
/// 0, or says why on stderr and exits 1; a report from a session takes over the task it starts.
#[test]
fn the_command_itself_says_what_happened_or_fails_with_why() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("tasks.sqlite3");
    Ledger::open(&db).unwrap().save_message("claude", "s1", "p", MESSAGE, 1, false).unwrap();
    let run = |args: &[&str], stdin: &str, session: &str| {
        use std::process::{Command, Stdio};
        let mut child = Command::new(env!("CARGO_BIN_EXE_hive-tasks"))
            .args(args)
            .current_dir(dir.path())
            // Never this machine's real board or cloud copy.
            .env("HIVE_TASKS_DB", &db)
            .env("HOME", dir.path())
            .env("HIVE_TASKS_CLOUD", dir.path().join("no-cloud.json"))
            .env("HIVE_TASKS_NO_SYNC", "1")
            .env_remove("HIVE_TASKS_OFF")
            .env_remove("CODEX_THREAD_ID")
            .env("CLAUDE_CODE_SESSION_ID", session)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        let text = |b: Vec<u8>| String::from_utf8_lossy(&b).trim_end().to_string();
        (out.status.code(), text(out.stdout), text(out.stderr))
    };
    let (code, said, _) = run(&["add", "M1"], r#"[{"quote": "fix the login button on mobile", "title": "Fix the login button"}]"#, "s1");
    assert_eq!((code, said.as_str()), (Some(0), "T1 registered: Fix the login button"));
    let (code, said, why) = run(&["add", "M1"], "not json", "s1");
    assert!(code == Some(1) && said.is_empty() && why.starts_with("Stdin isn't JSON"), "{why}");
    let (code, _, why) = run(&["add", "M1"], r#"[{"quote": "words never said", "title": "X"}]"#, "s1");
    assert!(code == Some(1) && why.contains("quote isn't in M1"), "{why}");
    let (code, said, _) = run(&["report"], r#"[{"id": "T1", "status": "active"}]"#, "s2");
    assert_eq!((code, said.as_str()), (Some(0), "T1 active"));
    let (batch, _) = Ledger::open(&db).unwrap().sync_batch(200).unwrap();
    let t1 = batch["tasks"].as_array().unwrap().iter().find(|t| t["id"] == 1).unwrap().clone();
    assert_eq!((t1["claimed_harness"].as_str(), t1["claimed_session"].as_str()), (Some("claude"), Some("s2")));
}
