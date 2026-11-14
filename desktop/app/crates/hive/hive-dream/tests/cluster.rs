//! Scanning synthetic journals and recordings, merging what both saw, and clustering.

use hive_dream::evidence::{cluster, merge, Occurrence, Source};
use hive_dream::{agentlog, journal, timeline};

const T0: f64 = 1_800_000_000.0;

fn jline(t: f64, kind: &str, text: &str, request: &str, extra: &str) -> String {
    format!(
        r#"{{"time": {t}, "kind": "{kind}", "text": {}, "request": {}{extra}}}"#,
        serde_json::to_string(text).unwrap(),
        serde_json::to_string(request).unwrap()
    )
}

fn local(t: f64) -> String {
    hive_dream::time::iso(t)
}

fn tline(t: f64, video: f64, kind: &str, text: &str) -> String {
    format!(
        r#"{{"t": "{}", "video": {video}, "kind": "{kind}", "text": {}}}"#,
        local(t),
        serde_json::to_string(text).unwrap()
    )
}

#[test]
fn the_same_failure_with_different_numbers_is_one_cluster() {
    let r = "open the example app";
    let journal = [
        jline(T0, "request", r, r, ""),
        jline(T0 + 5.0, "action", "→ phone.tap(x=1)", r, ""),
        jline(
            T0 + 65.0,
            "error",
            "The iPhone didn't answer in time.",
            r,
            "",
        ),
        jline(T0 + 70.0, "action", "→ phone.tap(x=2)", r, ""),
        jline(
            T0 + 130.0,
            "error",
            "The iPhone didn't answer in time.",
            r,
            "",
        ),
        jline(T0 + 140.0, "action", "→ open(app=\"Example 12\")", r, ""),
        jline(
            T0 + 141.0,
            "error",
            "pid 4312 produced no window within 8s",
            r,
            "",
        ),
        jline(T0 + 150.0, "action", "→ open(app=\"Example 13\")", r, ""),
        jline(
            T0 + 152.0,
            "error",
            "pid 99 produced no window within 10s",
            r,
            "",
        ),
    ]
    .join("\n");
    let scan = journal::scan_text("s1", &journal, T0 - 1.0, T0 + 1000.0);
    let clusters = cluster(&merge(scan.occurrences));
    let phone = clusters
        .iter()
        .find(|c| c.category == "phone")
        .expect("phone cluster");
    assert_eq!(phone.count, 2);
    assert!((phone.minutes - 2.0).abs() < 0.01, "{}", phone.minutes);
    assert_eq!(phone.refs, vec!["journal s1:5", "journal s1:3"]);
    let window = clusters
        .iter()
        .find(|c| c.signature.contains("produced no window"))
        .expect("window cluster");
    assert_eq!(window.count, 2);
    // Most minutes lost first.
    assert_eq!(clusters[0].category, "phone");
}

#[test]
fn a_wait_for_control_and_its_timeout_are_one_occurrence() {
    let r = "fill in the form";
    let journal = [
        jline(T0, "request", r, r, ""),
        jline(T0 + 10.0, "action", "wait_for_control(reason=\"x\")", r, ""),
        jline(
            T0 + 310.0,
            "error",
            "The user hasn't handed the screen back after 300 s.",
            r,
            "",
        ),
    ]
    .join("\n");
    let scan = journal::scan_text("s1", &journal, T0 - 1.0, T0 + 1000.0);
    let waits: Vec<&Occurrence> = scan
        .occurrences
        .iter()
        .filter(|o| o.category == "wait_for_control")
        .collect();
    assert_eq!(waits.len(), 1);
    assert!((waits[0].minutes - 5.0).abs() < 0.01);
}

#[test]
fn three_identical_calls_in_a_row_are_a_repeat() {
    let r = "look at the screen";
    let mut lines = vec![jline(T0, "request", r, r, "")];
    for i in 0..4 {
        lines.push(jline(
            T0 + 1.0 + i as f64 * 20.0,
            "action",
            &format!("→ screenshot(step=\"attempt {i}\")"),
            r,
            "",
        ));
    }
    lines.push(jline(T0 + 100.0, "done", "ok", r, ""));
    let scan = journal::scan_text("s1", &lines.join("\n"), T0 - 1.0, T0 + 1000.0);
    let rep: Vec<&Occurrence> = scan
        .occurrences
        .iter()
        .filter(|o| o.category == "repeat_calls")
        .collect();
    assert_eq!(rep.len(), 1);
    assert_eq!(
        rep[0].signature,
        "repeat_calls: screenshot called 3 or more times in a row"
    );
}

#[test]
fn journal_and_recording_see_one_failure_once() {
    let r = "send the report";
    let journal = [
        jline(T0, "request", r, r, ""),
        jline(T0 + 20.0, "action", "→ click(x=1, y=2)", r, ""),
        jline(
            T0 + 30.0,
            "error",
            "The iPhone didn't answer in time.",
            r,
            "",
        ),
        jline(
            T0 + 40.0,
            "failed",
            "stopped",
            r,
            r#", "interrupted": true"#,
        ),
    ]
    .join("\n");
    let timeline = [
        tline(T0 - 5.0, 0.0, "recording", "started"),
        tline(T0, 5.0, "hive", "🗣 send the report"),
        tline(T0 + 1.0, 6.0, "control", "agent has the mouse and keyboard"),
        tline(T0 + 20.0, 25.0, "hive", "→ click(x=1, y=2)"),
        tline(
            T0 + 31.0,
            36.0,
            "hive",
            "✗ The iPhone didn't answer in time.",
        ),
        tline(T0 + 39.0, 44.0, "hive", "→ click(x=900, y=10)"),
        tline(T0 + 40.0, 45.0, "hive", "✋ stopped from the window's x"),
    ]
    .join("\n");
    let mut all = journal::scan_text("s1", &journal, T0 - 10.0, T0 + 100.0).occurrences;
    let tl = timeline::scan_text(
        "2030-01-01 00.00.00 send the report",
        &timeline,
        T0 - 10.0,
        T0 + 100.0,
    );
    assert!(!tl.test_run);
    all.extend(tl.occurrences);
    let merged = merge(all);
    let clusters = cluster(&merged);
    let phone = clusters.iter().find(|c| c.category == "phone").unwrap();
    assert_eq!(phone.count, 1, "{clusters:#?}");
    assert!(phone.refs.iter().any(|r| r.starts_with("journal s1:")));
    assert!(phone
        .refs
        .iter()
        .any(|r| r == "recording 2030-01-01 00.00.00@36.0s"));
    // The journal says "stopped"; the recording knows the agent's own click hit the x.
    let ending = clusters
        .iter()
        .find(|c| c.category == "self_stop_x" || c.category == "interrupted")
        .unwrap();
    assert_eq!(ending.category, "self_stop_x");
    assert_eq!(ending.count, 1);
}

#[test]
fn the_user_taking_the_screen_mid_task_is_a_takeover_with_its_minutes() {
    let timeline = [
        tline(T0, 0.0, "recording", "started"),
        tline(T0 + 1.0, 1.0, "hive", "🗣 book the room"),
        tline(T0 + 2.0, 2.0, "control", "agent has the mouse and keyboard"),
        tline(
            T0 + 60.0,
            60.0,
            "control",
            "control went back to you (trackpad)",
        ),
        tline(
            T0 + 61.0,
            61.0,
            "hive",
            "✗ The user took over the mouse and keyboard.",
        ),
        tline(
            T0 + 180.0,
            180.0,
            "control",
            "agent has the mouse and keyboard",
        ),
        tline(T0 + 200.0, 200.0, "hive", "✅ done"),
    ]
    .join("\n");
    let tl = timeline::scan_text("2030-01-01 00.00.00 book", &timeline, T0 - 1.0, T0 + 1000.0);
    let takes: Vec<&Occurrence> = tl
        .occurrences
        .iter()
        .filter(|o| o.category == "takeover")
        .collect();
    assert_eq!(takes.len(), 1, "{:#?}", tl.occurrences);
    assert!((takes[0].minutes - 2.0).abs() < 0.01);
}

#[test]
fn scripted_test_runs_are_left_out() {
    let timeline = [
        tline(T0, 0.0, "recording", "started"),
        tline(T0 + 1.0, 1.0, "hive", "Hive is listening. Ctrl-C to quit."),
        tline(T0 + 2.0, 2.0, "hive", "🗣 Open Safari."),
        tline(T0 + 3.0, 3.0, "hive", "✗ something failed"),
    ]
    .join("\n");
    let tl = timeline::scan_text(
        "2030-01-01 00.00.00 Open Safari",
        &timeline,
        T0 - 1.0,
        T0 + 10.0,
    );
    assert!(tl.test_run);
    assert!(tl.occurrences.is_empty());
}

#[test]
fn agent_log_lines_count_once_per_block() {
    let log = "--- started 2030-01-15 10:00:00 +0000\n\
🎞  Recording 2030-01-15 09.00.00 Example task: upload failed: [Errno 2] No such file or directory: 'a'\n\
🎞  Recording 2030-01-15 09.10.00 Other task: upload failed: [Errno 2] No such file or directory: 'b'\n\
a line a task printed\n\
--- quit, not from the menu (macOS or another app asked) 2030-01-15 10:30:00 +0000\n\
--- started 2030-01-15 10:31:00 +0000\n\
Warning: something odd 3\n";
    let t = hive_dream::time::parse_stamp("2030-01-15 10:00:00 +0000").unwrap();
    let scan = agentlog::scan_text(log, t - 60.0, t + 7200.0, t + 3600.0);
    assert_eq!(scan.starts.len(), 2);
    let uploads: Vec<&Occurrence> = scan
        .occurrences
        .iter()
        .filter(|o| o.signature.contains("upload failed"))
        .collect();
    assert_eq!(uploads.len(), 1);
    assert!(uploads[0].example.ends_with("(2 lines)"));
    assert!(scan
        .occurrences
        .iter()
        .any(|o| o.category == "restart_storm"));
    assert!(scan
        .occurrences
        .iter()
        .any(|o| o.signature == "log_error: Warning: something odd <n>"));
    assert!(!scan
        .occurrences
        .iter()
        .any(|o| o.example.contains("a task printed")));
}

#[test]
fn clusters_sum_minutes_and_keep_first_and_last_seen() {
    let mk = |t: f64, m: f64| {
        Occurrence::new(
            "tool_error",
            "same thing",
            t,
            Source::Journal,
            format!("journal s:{t}"),
        )
        .minutes(m)
    };
    let c = cluster(&merge(vec![
        mk(T0, 1.0),
        mk(T0 + 100.0, 2.5),
        mk(T0 + 50.0, 0.5),
    ]));
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].count, 3);
    assert!((c[0].minutes - 4.0).abs() < 1e-9);
    assert_eq!(c[0].first_t, T0);
    assert_eq!(c[0].last_t, T0 + 100.0);
    assert_eq!(c[0].refs[0], format!("journal s:{}", T0 + 100.0));
}

#[test]
fn asking_again_counts_against_the_failure_before_it() {
    use hive_dream::evidence::charge_asked_again;
    let fail = |t: f64| {
        Occurrence::new(
            "tool_error",
            "No open window or browser tab has <q> in its title.",
            t,
            Source::Journal,
            format!("journal s:{t}"),
        )
        .minutes(0.01)
    };
    let again = |t: f64| {
        Occurrence::new(
            "regression_words",
            "again",
            t,
            Source::Journal,
            format!("journal s:{t}"),
        )
    };
    let mut all = vec![
        fail(T0),
        again(T0 + 20.0),
        fail(T0 + 100.0),
        again(T0 + 130.0),
        // Too long after any failure: about something else.
        again(T0 + 2000.0),
    ];
    assert_eq!(charge_asked_again(&mut all), 2);
    let clusters = cluster(&all);
    let switch = clusters
        .iter()
        .find(|c| c.category == "tool_error")
        .unwrap();
    assert_eq!(switch.minutes, 4.02);
    assert!(switch.refs.iter().any(|r| r.starts_with("asked again: ")));
    assert_eq!(clusters[0].category, "tool_error", "now ranks first");
}

#[test]
fn corrections_and_slow_tasks_are_friction() {
    let slow = "write the essay outline";
    let fix = "no, not that one, the second tab";
    let lines = [
        jline(T0, "request", slow, slow, ""),
        jline(T0 + 25.0 * 60.0, "done", "ok", slow, ""),
        jline(T0 + 26.0 * 60.0, "request", fix, fix, ""),
        jline(T0 + 27.0 * 60.0, "done", "ok", fix, ""),
        jline(T0 + 28.0 * 60.0, "request", "Nobody's home yet?", "x", ""),
    ];
    let scan = journal::scan_text("s1", &lines.join("\n"), T0 - 1.0, T0 + 3600.0);
    let of = |category: &str| -> Vec<&Occurrence> {
        scan.occurrences
            .iter()
            .filter(|o| o.category == category)
            .collect()
    };
    let corrections = of("correction");
    assert_eq!(corrections.len(), 1, "\"Nobody's\" isn't a correction");
    assert_eq!(
        corrections[0].signature,
        "correction: the user said \"no,\""
    );
    let slow_tasks = of("slow_task");
    assert_eq!(slow_tasks.len(), 1, "the one-minute task isn't slow");
    assert_eq!(slow_tasks[0].minutes, 15.0);
    assert!(slow_tasks[0].example.contains(slow));
}
