//! The helper client against a fake helper (tests/test_dry_run.py's client-side cases, and the
//! `hive-vhid` command line). Nothing here reaches the real helper.

mod common;

use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{keys, FakeHelper, FakeSystem};
use hive_mac::VhidError;

fn setup() -> (FakeHelper, Arc<FakeSystem>, hive_mac::AgentVHID) {
    let helper = FakeHelper::start(true);
    let system = FakeSystem::new();
    let mac = helper.client(system.clone());
    (helper, system, mac)
}

#[test]
fn status() {
    let (_helper, _, mac) = setup();
    let status = mac.status().unwrap();
    assert_eq!(status.get("state"), Some("engaged"));
    assert_eq!(status.get("dry_run"), Some("1"));
    assert_eq!(status.get("vhid"), Some("dry_run"));
    assert_eq!(status.get("fn"), Some("1"));
}

#[test]
fn shortcut_presses_modifier_then_key() {
    let (helper, _, mac) = setup();
    mac.key("cmd+s").unwrap();
    assert_eq!(
        helper.lines(),
        [keys(8, &[]), keys(8, &[0x16]), keys(8, &[]), keys(0, &[])]
    );
}

#[test]
fn typing_uses_shift_for_capitals_and_symbols() {
    let (helper, _, mac) = setup();
    mac.type_text("Hi!").unwrap();
    assert_eq!(
        helper.lines(),
        [
            keys(2, &[]),
            keys(2, &[0x0b]),
            keys(2, &[]),
            keys(0, &[]), // H
            keys(0, &[0x0c]),
            keys(0, &[]), // i
            keys(2, &[]),
            keys(2, &[0x1e]),
            keys(2, &[]),
            keys(0, &[]), // !
        ]
    );
}

#[test]
fn characters_off_the_keyboard_are_pasted() {
    let (helper, system, mac) = setup();
    mac.type_text("a中文b").unwrap();
    // pasted with cmd+v, and the clipboard put back the way it was
    assert_eq!(
        *system.clipboard_writes.lock().unwrap(),
        [
            b"\xe4\xb8\xad\xe6\x96\x87".to_vec(),
            b"what was there".to_vec()
        ]
    );
    assert_eq!(
        helper.lines(),
        [
            keys(0, &[0x04]),
            keys(0, &[]),
            keys(8, &[]),
            keys(8, &[0x19]),
            keys(8, &[]),
            keys(0, &[]), // cmd+v
            keys(0, &[0x05]),
            keys(0, &[]),
        ]
    );
}

#[test]
fn scroll_direction_follows_natural_scrolling() {
    let (helper, _, mac) = setup();
    mac.set_natural_scrolling(Some(true));
    mac.scroll(2, 0, None).unwrap();
    mac.set_natural_scrolling(Some(false));
    mac.scroll(1, 0, None).unwrap();
    assert_eq!(helper.lines(), ["scroll 1 0", "scroll 1 0", "scroll -1 0"]);
}

#[test]
fn natural_scrolling_is_read_from_the_mac_once() {
    let (helper, _, mac) = setup(); // the fake Mac has natural scrolling on
    mac.scroll(-1, 1, None).unwrap();
    assert_eq!(helper.lines(), ["scroll -1 0", "scroll 0 1"]);
}

#[test]
fn drag_keeps_button_held_while_moving() {
    let (helper, _, mac) = setup();
    mac.send("buttons 1").unwrap(); // same connection: closing one releases everything
    mac.send("move 5 5").unwrap();
    assert_eq!(helper.lines(), ["buttons 1", "move 5 5"]);
}

#[test]
fn human_input_disengages_and_releases_everything() {
    let (helper, _, mac) = setup();
    mac.send("keys 8 22").unwrap();
    let released = helper
        .shared
        .released
        .load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(helper.raw("human trackpad"), "ok");
    assert_eq!(
        helper
            .shared
            .released
            .load(std::sync::atomic::Ordering::SeqCst),
        released + 1
    );
    assert!(matches!(mac.key("a"), Err(VhidError::Disengaged(_))));
    assert!(matches!(
        mac.click(None, "left", 1, None),
        Err(VhidError::Disengaged(_))
    ));
    let status = mac.status().unwrap();
    assert_eq!(
        (status.get("state"), status.get("reason")),
        (Some("disengaged"), Some("trackpad"))
    );
    mac.release_all().unwrap(); // always allowed
    match mac.key("a") {
        Err(e @ VhidError::Disengaged(_)) => {
            assert_eq!(
                e.to_string(),
                "the human has control (state=disengaged reason=trackpad)"
            )
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn engage_waits_for_quiet_period() {
    let (helper, _, mac) = setup();
    helper.raw("human keyboard");
    let mac = Arc::new(mac);
    let waiter = {
        let mac = mac.clone();
        std::thread::spawn(move || mac.wait_engaged(Some(Duration::from_secs(3)), false))
    };
    std::thread::sleep(Duration::from_millis(100));
    mac.engage().unwrap();
    assert_eq!(mac.status().unwrap().get("state"), Some("arming"));
    assert!(waiter.join().unwrap().unwrap());
    assert_eq!(mac.status().unwrap().get("reason"), Some("engaged"));
    mac.key("a").unwrap(); // works again
}

#[test]
fn touch_while_arming_cancels() {
    let (helper, _, mac) = setup();
    helper.raw("human keyboard");
    mac.engage().unwrap();
    helper.raw("human trackpad");
    std::thread::sleep(Duration::from_millis(250));
    let status = mac.status().unwrap();
    assert_eq!(
        (status.get("state"), status.get("reason")),
        (Some("disengaged"), Some("engage_cancelled_by_trackpad"))
    );
    assert!(hive_mac::vhid::took_over(status.get("reason")));
}

#[test]
fn wait_engaged_times_out() {
    let (helper, _, mac) = setup();
    helper.raw("human keyboard");
    let start = Instant::now();
    assert!(!mac
        .wait_engaged(Some(Duration::from_millis(200)), false)
        .unwrap());
    assert!(start.elapsed() < Duration::from_secs(2));
}

fn collect(
    mac: Arc<hive_mac::AgentVHID>,
    n: usize,
) -> (
    Arc<Mutex<Vec<hive_mac::Fields>>>,
    std::thread::JoinHandle<()>,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = events.clone();
    let t = std::thread::spawn(move || {
        for event in mac.watch().unwrap() {
            let mut seen = seen.lock().unwrap();
            seen.push(event.unwrap());
            if seen.len() == n {
                return;
            }
        }
    });
    (events, t)
}

#[test]
fn watch_streams_hand_overs() {
    let (helper, _, mac) = setup();
    let (events, t) = collect(Arc::new(mac), 2);
    std::thread::sleep(Duration::from_millis(100));
    helper.raw("human mouse");
    t.join().unwrap();
    let events = events.lock().unwrap();
    let states: Vec<_> = events
        .iter()
        .map(|e| e.get("state").unwrap_or("").to_string())
        .collect();
    assert_eq!(states, ["engaged", "disengaged"]);
    assert_eq!(events[1].get("reason"), Some("mouse"));
}

#[test]
fn engage_hands_over_until_you_touch_something() {
    let (helper, _, mac) = setup();
    helper.raw("human keyboard");
    mac.engage().unwrap();
    assert!(mac
        .wait_engaged(Some(Duration::from_secs(2)), false)
        .unwrap());
    helper.raw("human trackpad"); // touching anything takes it back
    let status = mac.status().unwrap();
    assert_eq!(
        (status.get("state"), status.get("reason")),
        (Some("disengaged"), Some("trackpad"))
    );
    mac.engage().unwrap(); // each task (or "continue") asks again
    assert!(mac
        .wait_engaged(Some(Duration::from_secs(2)), false)
        .unwrap());
    mac.disengage().unwrap();
    let status = mac.status().unwrap();
    assert_eq!(
        (status.get("state"), status.get("reason")),
        (Some("disengaged"), Some("released_by_agent"))
    );
}

#[test]
fn watch_streams_fn_which_leaves_control_alone() {
    let (helper, _, mac) = setup();
    let mac = Arc::new(mac);
    let (events, t) = collect(mac.clone(), 5);
    std::thread::sleep(Duration::from_millis(100));
    for what in ["down", "tap", "down", "up", "other"] {
        // a tap, a hold, a shortcut
        assert_eq!(helper.raw(&format!("fn {what}")), "ok");
    }
    t.join().unwrap();
    let fns: Vec<_> = events.lock().unwrap()[1..]
        .iter()
        .map(|e| e.to_json())
        .collect();
    assert_eq!(
        fns,
        [
            serde_json::json!({"fn": "down"}),
            serde_json::json!({"fn": "tap"}),
            serde_json::json!({"fn": "down"}),
            serde_json::json!({"fn": "up"}),
        ]
    );
    assert_eq!(mac.status().unwrap().get("state"), Some("engaged")); // talking or dictating isn't taking over
    assert!(helper.raw("fn sideways").starts_with("err"));
}

#[test]
fn helper_watcher_reports_events_and_stops() {
    let (helper, _, _mac) = setup();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut watcher = {
        let seen = seen.clone();
        hive_mac::HelperWatcher::start(helper.socket.clone(), move |e| {
            seen.lock().unwrap().push(e.to_json())
        })
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    while seen.lock().unwrap().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    helper.raw("fn tap");
    while seen.lock().unwrap().len() < 2 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    watcher.stop();
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0]["state"], "engaged");
    assert_eq!(seen[1], serde_json::json!({"fn": "tap"}));
}

#[test]
fn modifier_click_holds_the_modifier() {
    let (helper, _, mac) = setup();
    mac.click(None, "left", 1, Some("cmd")).unwrap();
    assert_eq!(
        helper.lines(),
        [
            keys(8, &[]),
            "buttons 1".into(),
            "buttons 0".into(),
            keys(0, &[])
        ]
    );
}

#[test]
fn double_and_right_clicks() {
    let (helper, _, mac) = setup();
    mac.double_click(None).unwrap();
    mac.right_click(None).unwrap();
    assert_eq!(
        helper.lines(),
        [
            "buttons 1",
            "buttons 0",
            "buttons 1",
            "buttons 0",
            "buttons 2",
            "buttons 0"
        ]
    );
}

#[test]
fn move_reports_when_cursor_does_not_follow() {
    // As in a dry run, nothing moves the (fake) cursor, so the closed loop must give up.
    let (_helper, system, mac) = setup();
    let (x, y) = mac.cursor();
    assert_eq!((x, y), *system.cursor.lock().unwrap());
    let x2 = if x > 100.0 { x - 40.0 } else { x + 40.0 };
    let start = Instant::now();
    assert!(matches!(mac.move_to(x2, y), Err(VhidError::MoveFailed(_))));
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn bad_requests() {
    let (helper, _, mac) = setup();
    assert!(helper.raw("move 1").starts_with("err bad_request"));
    assert!(helper.raw("keys 300").starts_with("err bad_request"));
    assert!(helper.raw("launch missiles").starts_with("err bad_request"));
    assert!(matches!(
        mac.key("cmd+nosuchkey"),
        Err(VhidError::Invalid(_))
    ));
    assert!(matches!(
        mac.send("launch missiles"),
        Err(VhidError::Helper(_))
    ));
}

#[test]
fn reconnects_after_the_helper_drops_the_connection() {
    let (helper, _, mac) = setup();
    mac.key("a").unwrap();
    mac.close();
    mac.key("b").unwrap();
    assert_eq!(
        helper.lines(),
        [keys(0, &[4]), keys(0, &[]), keys(0, &[5]), keys(0, &[])]
    );
}

// --- hive-vhid, the command line (agent_vhid.py's) ---

fn cli(helper: &FakeHelper, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_hive-vhid"))
        .arg("--socket")
        .arg(&helper.socket)
        .args(args)
        .output()
        .expect("run hive-vhid")
}

#[test]
fn cli_status_prints_fields() {
    let helper = FakeHelper::start(true);
    let out = cli(&helper, &["status"]);
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(
        text,
        "state=engaged\nreason=start_engaged\nvhid=dry_run\nwatch=ok\ndry_run=1\nfn=1\n"
    );
    assert!(text.lines().any(|l| l == "fn=1")); // voice.sh greps ^fn=1
}

#[test]
fn cli_keys_and_exit_codes() {
    let helper = FakeHelper::start(true);
    assert!(cli(&helper, &["--fast", "key", "cmd+s"]).status.success());
    assert_eq!(
        helper.lines(),
        [keys(8, &[]), keys(8, &[0x16]), keys(8, &[]), keys(0, &[])]
    );
    assert!(cli(&helper, &["scroll", "-2"]).status.success());
    assert_eq!(helper.since(4).len(), 2);

    helper.raw("human keyboard");
    let out = cli(&helper, &["key", "a"]);
    assert_eq!(out.status.code(), Some(3));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "disengaged: the human has control (state=disengaged reason=keyboard)\n"
    );
    assert_eq!(
        cli(&helper, &["wait", "--timeout", "0.2"]).status.code(),
        Some(4)
    );
    assert_eq!(
        cli(&helper, &["engage", "--timeout", "2"]).status.code(),
        Some(0)
    );

    let out = cli(&helper, &["key", "cmd+nosuchkey"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).starts_with("error: unknown key 'nosuchkey'"));
    assert_eq!(cli(&helper, &["fly"]).status.code(), Some(2));
    assert_eq!(cli(&helper, &["move", "1"]).status.code(), Some(2));
    assert_eq!(cli(&helper, &[]).status.code(), Some(2));
}

#[test]
fn cli_without_a_helper() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("none.sock");
    let out = Command::new(env!("CARGO_BIN_EXE_hive-vhid"))
        .arg("--socket")
        .arg(&socket)
        .arg("status")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(
        said.starts_with("error: agent-vhid-helper isn't running on "),
        "{said}"
    );
}
