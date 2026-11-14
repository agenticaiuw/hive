//! MacTools against a fake helper and a fake Mac (tests/test_tools.py's MacBatchTest,
//! tests/test_selected_text.py, and the Mac half of tests/test_credentials.py).

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{keys, FakeHelper, FakeSystem, FAKE_JPEG};
use hive_common::tools::{is_error, texts, ToolNamespace};
use hive_mac::credentials::{CredentialError, Native, Secret};
use hive_mac::desktop::{BrowserWindow, Window};
use hive_mac::tools::{self, MacTools, BATCHABLE};
use serde_json::{json, Value};

const SECRET: &str = "Ab9!";

/// The credential helper, pretend: answers from memory and remembers what it was asked.
#[derive(Default)]
struct FakeNative {
    calls: Mutex<Vec<String>>,
}

impl Native for FakeNative {
    fn text(&self, args: &[&str]) -> Result<String, CredentialError> {
        self.calls.lock().unwrap().push(args[0].to_string());
        Ok(if args[0] == "keyboard-layout" {
            "com.apple.keylayout.ABC".into()
        } else {
            String::new()
        })
    }
    fn secret(&self, args: &[&str]) -> Result<Secret, CredentialError> {
        self.calls.lock().unwrap().push(args[0].to_string());
        Ok(Secret::new(SECRET.as_bytes().to_vec()))
    }
}

struct Setup {
    helper: FakeHelper,
    system: Arc<FakeSystem>,
    native: Arc<FakeNative>,
    tools: MacTools,
}

fn setup(engaged: bool) -> Setup {
    setup_with(engaged, FakeSystem::new())
}

/// Hive working on the virtual monitor, at the right of the main display.
fn setup_on_monitor() -> Setup {
    setup_with(
        true,
        Arc::new(FakeSystem {
            virtual_monitor: Some((1440.0, 0.0, 1440.0, 900.0)),
            ..FakeSystem::default()
        }),
    )
}

fn setup_with(engaged: bool, system: Arc<FakeSystem>) -> Setup {
    let helper = FakeHelper::start(engaged);
    let native = Arc::new(FakeNative::default());
    let mut tools = MacTools::with(helper.client(system.clone()), system.clone());
    tools.native = native.clone();
    let caps = helper.shared.clone();
    tools.caps_lock = Arc::new(move || caps.caps.load(Ordering::SeqCst));
    tools.selection_tool = "/nonexistent/agent-vhid-selection".into();
    Setup {
        helper,
        system,
        native,
        tools,
    }
}

fn first_text(res: &Value) -> String {
    res["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

// --- MacBatchTest ---

#[test]
fn several_actions_in_one_call() {
    let s = setup(true);
    let res = s
        .tools
        .call(
            "batch",
            &json!({"steps": [{"tool": "press_key", "keys": "cmd+l"}, {"tool": "type_text", "text": "a"}],
                    "screenshot": false}),
        )
        .unwrap();
    assert_eq!(first_text(&res), "Did 2 steps: press_key, type_text.");
    assert_eq!(
        s.helper.lines(),
        [
            keys(8, &[]),
            keys(8, &[0x0f]),
            keys(8, &[]),
            keys(0, &[]), // cmd+l
            keys(0, &[0x04]),
            keys(0, &[]), // a
        ]
    );
}

/// Two presentations open in PowerPoint, `front` in front of the other.
fn windows_with(front: &str) -> Vec<Window> {
    let mut titles = ["10-29 Club-Wide Meeting", "GSSF_Presentation_styled"];
    titles.sort_by_key(|t| *t != front);
    let mut shown: Vec<Window> = titles
        .iter()
        .map(|t| Window::new("Microsoft PowerPoint", t, true, 1))
        .collect();
    shown.push(Window::new("Safari", "New meeting", false, 2));
    shown
}

#[test]
fn switch_window_brings_an_open_document_forward() {
    let s = setup(true);
    let log = s.helper.shared.clone();
    let cmd_backtick = keys(8, &[0x35]);
    let pressed = cmd_backtick.clone();
    s.system.set_windows(move || {
        windows_with(if log.pressed(&pressed) {
            "GSSF_Presentation_styled"
        } else {
            "10-29 Club-Wide Meeting"
        })
    });
    *s.system.front_app.lock().unwrap() = "Microsoft PowerPoint".into();
    let res = s
        .tools
        .call("switch_window", &json!({"title": "gssf"}))
        .unwrap();
    assert!(!is_error(&res), "{res}");
    assert!(first_text(&res).contains(r#""GSSF_Presentation_styled" is in front"#));
    // once: PowerPoint was already the app in front
    assert_eq!(
        s.helper
            .lines()
            .iter()
            .filter(|l| **l == cmd_backtick)
            .count(),
        1
    );
    assert_eq!(
        s.helper.lines(),
        [keys(8, &[]), cmd_backtick, keys(8, &[]), keys(0, &[])]
    );
}

#[test]
fn switch_window_says_what_is_open_when_nothing_matches() {
    let s = setup(true);
    s.system
        .set_windows(|| windows_with("10-29 Club-Wide Meeting"));
    let res = s
        .tools
        .call("switch_window", &json!({"title": "budget"}))
        .unwrap();
    assert!(is_error(&res));
    assert!(first_text(&res).contains(r#"Microsoft PowerPoint: "GSSF_Presentation_styled""#));
    assert!(first_text(&res).starts_with("No open window or browser tab has 'budget' in its title.\n"));
}

/// A tab that isn't the one showing has no window title to match: switch_window finds it among the
/// browser's tabs and shows it (the Course Search tab the user asked for over and over).
#[test]
fn switch_window_shows_a_background_browser_tab() {
    let s = setup(true);
    *s.system.tabs.lock().unwrap() = vec![(
        "Safari".into(),
        vec![
            BrowserWindow { current: Some(1), tabs: vec![("Inbox".into(), "https://mail.example.com/".into())] },
            BrowserWindow {
                current: Some(1),
                tabs: vec![
                    ("Canvas".into(), "https://canvas.example.edu/".into()),
                    ("Course Search & Enroll".into(), "https://enroll.example.edu/search".into()),
                ],
            },
        ],
    )];
    let system = s.system.clone();
    s.system.set_windows(move || {
        let front = if system.shown_tabs.lock().unwrap().is_empty() { "Inbox" } else { "Course Search & Enroll" };
        vec![Window::new("Safari", front, true, 2), Window::new("Safari", "Canvas", false, 2)]
    });
    let res = s.tools.call("switch_window", &json!({"title": "course search"})).unwrap();
    assert!(!is_error(&res), "{res}");
    assert_eq!(*s.system.shown_tabs.lock().unwrap(), [("Safari".to_string(), 2, 2)]);
    assert!(first_text(&res).contains(r#"Safari's window "Course Search & Enroll" is in front"#), "{}", first_text(&res));
}

/// A browser window that's minimized or on another desktop comes forward by the browser's script.
#[test]
fn switch_window_brings_a_hidden_browser_window_by_script() {
    let s = setup(true);
    *s.system.tabs.lock().unwrap() = vec![(
        "Safari".into(),
        vec![
            BrowserWindow { current: Some(1), tabs: vec![("Inbox".into(), String::new())] },
            BrowserWindow { current: Some(2), tabs: vec![("a".into(), String::new()), ("Budget 2026".into(), String::new())] },
        ],
    )];
    let system = s.system.clone();
    s.system.set_windows(move || {
        if system.shown_tabs.lock().unwrap().is_empty() {
            vec![Window::new("Safari", "Inbox", true, 2), Window::new("Safari", "Budget 2026", false, 2)]
        } else {
            vec![Window::new("Safari", "Budget 2026", true, 2), Window::new("Safari", "Inbox", true, 2)]
        }
    });
    let res = s.tools.call("switch_window", &json!({"title": "budget"})).unwrap();
    assert!(!is_error(&res), "{res}");
    assert_eq!(*s.system.shown_tabs.lock().unwrap(), [("Safari".to_string(), 2, 2)]);
    assert!(s.helper.lines().iter().all(|l| *l != keys(8, &[0x35])), "no cmd+` needed");
}

/// A window cmd+` can't reach (minimized, another desktop) is picked from the app's Window menu.
#[test]
fn switch_window_falls_back_to_the_window_menu() {
    let s = setup(true);
    let system = s.system.clone();
    s.system.set_windows(move || {
        let raised = !system.window_menu.lock().unwrap().is_empty();
        let mut shown = windows_with("10-29 Club-Wide Meeting");
        shown.push(Window::new("Microsoft PowerPoint", "Q3 Report", raised, 1));
        if raised {
            shown.rotate_right(1);
        }
        shown
    });
    *s.system.front_app.lock().unwrap() = "Microsoft PowerPoint".into();
    let res = s.tools.call("switch_window", &json!({"title": "q3 report"})).unwrap();
    assert!(!is_error(&res), "{res}");
    assert_eq!(
        *s.system.window_menu.lock().unwrap(),
        [("Microsoft PowerPoint".to_string(), "Q3 Report".to_string())]
    );
    assert!(first_text(&res).contains(r#""Q3 Report" is in front"#), "{}", first_text(&res));
}

#[test]
fn stops_at_a_step_it_cant_do() {
    let s = setup(true);
    let res = s
        .tools
        .call(
            "batch",
            &json!({"steps": [{"tool": "press_key", "keys": "escape"}, {"tool": "screenshot"},
                              {"tool": "type_text", "text": "never"}], "screenshot": false}),
        )
        .unwrap();
    assert!(is_error(&res));
    assert_eq!(
        first_text(&res),
        "Step 2: 'screenshot' can't go in a batch (use one of click, move_mouse, drag, scroll, type_text, \
         press_key, open_app, wait)."
    );
    assert_eq!(s.helper.lines(), [keys(0, &[0x29]), keys(0, &[])]);
}

#[test]
fn a_failing_step_says_what_was_done() {
    let s = setup(true);
    let res = s
        .tools
        .call(
            "batch",
            &json!({"steps": [{"tool": "press_key", "keys": "escape"}, {"tool": "press_key", "keys": "cmd+nosuchkey"}],
                    "screenshot": false}),
        )
        .unwrap();
    assert_eq!(
        first_text(&res),
        "Step 2 (press_key) failed after press_key: Failed: unknown key 'nosuchkey' in 'cmd+nosuchkey'"
    );
}

// --- looking and acting ---

#[test]
fn screenshot_says_what_it_shows() {
    let s = setup(true);
    *s.system.front_app.lock().unwrap() = "Notes".into();
    s.system
        .set_windows(|| vec![Window::new("Notes", "Shopping", true, 1)]);
    let res = s.tools.call("screenshot", &json!({})).unwrap();
    assert_eq!(
        first_text(&res),
        r#"Screenshot 1440x900 px. Mouse pointer at (500, 400). Frontmost app: Notes, window "Shopping"."#
    );
    assert_eq!(res["content"][1]["type"], "image");
    assert_eq!(res["content"][1]["mimeType"], "image/jpeg");
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(res["content"][1]["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(data, FAKE_JPEG);
    assert_eq!(res["isError"], false);
}

#[test]
fn the_first_look_lists_the_windows() {
    let s = setup(true);
    s.system
        .set_windows(|| vec![Window::new("Notes", "Shopping", true, 1)]);
    let res = s.tools.look(true).unwrap();
    let said = first_text(&res);
    assert!(
        said.starts_with(
            "Screenshot 1440x900 px. Mouse pointer at (500, 400). Frontmost app: Finder.\n"
        ),
        "{said}"
    );
    assert!(said.contains("Notes: \"Shopping\""), "{said}");
}

#[test]
fn screenshot_pixels_map_to_points() {
    let mut system = FakeSystem {
        main: (0.0, 0.0, 1728.0, 1117.0),
        ..FakeSystem::default()
    };
    let g = tools::geometry(&system);
    assert_eq!((g.width, g.height), (1440, 931));
    assert_eq!(g.scale, 1.2);
    system.virtual_monitor = Some((1728.0, 0.0, 1280.0, 800.0));
    let g = tools::geometry(&system);
    assert_eq!(
        (g.width, g.height, g.scale, g.origin),
        (1280, 800, 1.0, (1728.0, 0.0))
    );
    assert_eq!(g.to_screen(10.0, 20.0), (1738.0, 20.0));
}

#[test]
fn actions_after_a_takeover_carry_on_without_the_screen() {
    let s = setup(true);
    assert_eq!(s.tools.take().unwrap(), None); // the task has had the mouse and keyboard
    s.helper.raw("human trackpad");
    let res = s
        .tools
        .call(
            "press_key",
            &json!({"keys": "return", "step": "Sending it."}),
        )
        .unwrap();
    assert!(is_error(&res));
    assert_eq!(
        first_text(&res),
        "The user took over the mouse and keyboard (trackpad), so screen actions wait until they press fn. Don't \
         stop working: carry on with everything that doesn't need the screen (the shell, files, APIs, reading what \
         you already have). Call wait_for_control only when the screen is the one way forward, then look at the \
         new screenshot before acting; things may have changed."
    );
    assert!(s.helper.lines().is_empty());
    assert_eq!(s.tools.take().unwrap().as_deref(), Some("trackpad")); // it waits for fn
                                                                      // The agent let go by itself (a shell command, a pause): its next screen action takes them again.
    s.helper.raw("engage");
    std::thread::sleep(Duration::from_millis(250));
    s.helper.raw("disengage");
    let res = s
        .tools
        .call(
            "type_text",
            &json!({"text": "x", "step": "Typing x.", "screenshot": false}),
        )
        .unwrap();
    assert_eq!(first_text(&res), "Typed.");
    assert!(s.helper.raw("status").contains("state=engaged"));
}

#[test]
fn the_mouse_and_keyboard_are_taken_only_for_a_screen_action() {
    let s = setup(false);
    s.tools.call("screenshot", &json!({})).unwrap();
    s.tools.call("windows", &json!({})).unwrap();
    assert!(s.helper.raw("status").contains("state=disengaged"));
    assert!(!s.tools.holding());
    let res = s
        .tools
        .call(
            "press_key",
            &json!({"keys": "tab", "step": "Next field.", "screenshot": false}),
        )
        .unwrap();
    assert_eq!(first_text(&res), "Pressed tab.");
    assert!(s.helper.raw("status").contains("state=engaged"));
    assert!(s.tools.holding());
    s.tools.let_go(); // a shell command started
    assert!(s
        .helper
        .raw("status")
        .contains("state=disengaged reason=released_by_agent"));
    assert!(!s.tools.holding());
    s.tools.let_go(); // only once
    s.tools.handed_back(); // fn: held as if just used, so it's let go again after a while
    assert!(s.tools.holding());
}

// --- tests/test_one_way.py ---

const ASKED: &str = r#"send the backup to the general channel saying "I decided to delete the all-members channel""#;

#[test]
fn a_one_way_step_is_refused_before_the_mouse_or_keyboard_is_touched() {
    let s = setup(false);
    ToolNamespace::set_words(&s.tools, ASKED);
    for (tool, args) in [
        (
            "press_key",
            json!({"keys": "return", "step": "One-way: sending @Badger a request."}),
        ),
        (
            "batch",
            json!({"steps": [{"tool": "press_key", "keys": "return"}],
                         "step": "One-way: asking the bot (you said: \"please export all-members\")"}),
        ),
    ] {
        let res = s.tools.call(tool, &args).unwrap();
        assert!(is_error(&res));
        assert!(first_text(&res).starts_with("Refused: a one-way step"));
    }
    assert!(s.helper.lines().is_empty());
    assert!(s
        .helper
        .raw("status")
        .contains("state=disengaged reason=startup")); // never engaged
    let asked = json!({"keys": "return", "screenshot": false,
                       "step": "One-way: posting it (you said: \"send the backup to the general channel\")."});
    assert_eq!(
        first_text(&s.tools.call("press_key", &asked).unwrap()),
        "Pressed return."
    );
}

#[test]
fn every_action_says_what_it_does() {
    for tool in tools::tools() {
        if ["click", "drag", "type_text", "press_key", "batch"]
            .contains(&tool["name"].as_str().unwrap())
        {
            assert!(
                tool["inputSchema"]["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("step")),
                "{}",
                tool["name"]
            );
            assert_eq!(tool["inputSchema"]["required"][0], "step");
        }
    }
}

#[test]
fn an_action_looks_afterwards_unless_told_not_to() {
    let s = setup(true);
    let res = s
        .tools
        .call("press_key", &json!({"keys": "tab", "repeat": 2}))
        .unwrap();
    assert!(first_text(&res).starts_with("Pressed tab.\nScreenshot 1440x900 px."));
    assert_eq!(s.system.captures.load(Ordering::SeqCst), 1);
    let res = s.tools.call(
        "scroll",
        &json!({"x": 10, "y": 20, "down": 0, "screenshot": false}),
    );
    // the fake cursor never follows, so the move to (10, 20) fails like a dry run's
    assert!(first_text(&res.unwrap()).starts_with("Failed: "));
    assert_eq!(
        s.helper
            .lines()
            .iter()
            .filter(|l| *l == &keys(0, &[0x2b]))
            .count(),
        2
    );
}

#[test]
fn wait_for_control_reports_unavailable_watcher() {
    let s = setup(false);
    s.helper.shared.watcher_unavailable();

    let res = s
        .tools
        .call("wait_for_control", &json!({"timeout_seconds": 0}))
        .unwrap();

    assert!(is_error(&res));
    assert!(first_text(&res).contains("watcher_unavailable"), "{res}");
    assert!(s.system.notifications.lock().unwrap().is_empty());
}

#[test]
fn wait_for_control_waits_for_the_hand_back() {
    let s = setup(true);
    assert_eq!(s.tools.take().unwrap(), None);
    s.helper.raw("human keyboard");
    let socket = s.helper.socket.clone();
    let giver = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        let mut c = std::os::unix::net::UnixStream::connect(socket).unwrap();
        std::io::Write::write_all(&mut c, b"engage\n").unwrap();
        let mut reply = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(c), &mut reply).unwrap();
    });
    let res = s
        .tools
        .call("wait_for_control", &json!({"timeout_seconds": 5}))
        .unwrap();
    giver.join().unwrap();
    assert!(!is_error(&res));
    assert!(first_text(&res).starts_with(
        "You have the mouse and keyboard again. The user may have changed things; check this screenshot before \
         continuing.\n"
    ));
    assert_eq!(
        *s.system.notifications.lock().unwrap(),
        ["Hive needs the screen. Press fn when it can have the mouse and keyboard."]
    );
    assert!(s.tools.holding());

    s.helper.raw("human mouse");
    let res = s
        .tools
        .call("wait_for_control", &json!({"timeout_seconds": 0.2}))
        .unwrap();
    assert!(is_error(&res));
    assert_eq!(
        first_text(&res),
        "The user hasn't handed the screen back after 0 s. Finish what you can without it, then say where you got to \
         and what needs the screen."
    );
}

#[test]
fn clipboard_and_unknown_tools() {
    let s = setup(true);
    *s.system.clipboard.lock().unwrap() = b"copied words".to_vec();
    let res = s.tools.call("read_clipboard", &json!({})).unwrap();
    assert_eq!(first_text(&res), "copied words");
    let res = s.tools.call("nope", &json!({})).unwrap();
    assert!(is_error(&res));
    assert_eq!(first_text(&res), "Unknown tool 'nope'");
    assert!(s.tools.call("wait", &json!({"seconds": -1})).is_err());
    let res = s
        .tools
        .call("wait", &json!({"seconds": 0.01, "screenshot": false}))
        .unwrap();
    assert_eq!(first_text(&res), "Waited.");
}

#[test]
fn the_namespace_is_mac() {
    let s = setup(true);
    assert_eq!(s.tools.namespace(), "mac");
    assert_eq!(
        s.tools.about(),
        "The user's Mac: see the screen and use the real mouse and keyboard."
    );
    let names: Vec<_> = s
        .tools
        .tools()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"windows".to_string()) && names.contains(&"switch_window".to_string()));
}

#[test]
fn the_mcp_server_lists_and_calls_the_tools() {
    let s = setup(true);
    let server = hive_common::mcp::Server::for_namespace(
        Arc::new(s.tools),
        tools::SERVER_NAME,
        tools::INSTRUCTIONS,
    );
    let init = server
        .handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}))
        .unwrap();
    assert_eq!(init["result"]["serverInfo"]["name"], "agent-vhid-mac");
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
    let listed = server
        .handle(&json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        .unwrap();
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 19);
    let called = server
        .handle(&json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                        "params": {"name": "press_key", "arguments": {"keys": "escape", "screenshot": false}}}))
        .unwrap();
    assert_eq!(called["result"]["content"][0]["text"], "Pressed escape.");
}

// --- read_selected_text (tests/test_selected_text.py) ---

fn script(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}

#[test]
fn whole_selection_goes_to_tool_result() {
    let mut s = setup(true);
    let dir = tempfile::tempdir().unwrap();
    let selected = "Selected words. ".repeat(10_000);
    std::fs::write(dir.path().join("selected.txt"), &selected).unwrap();
    s.tools.selection_tool = script(
        dir.path(),
        "selection",
        &format!("cat '{}'", dir.path().join("selected.txt").display()),
    );
    let res = s.tools.call("read_selected_text", &json!({})).unwrap();
    assert!(!is_error(&res));
    assert_eq!(first_text(&res), selected);
}

#[test]
fn inaccessible_selection_is_an_error() {
    let mut s = setup(true);
    let dir = tempfile::tempdir().unwrap();
    s.tools.selection_tool = script(
        dir.path(),
        "selection",
        "echo 'Selection unavailable' >&2; exit 1",
    );
    let res = s.tools.call("read_selected_text", &json!({})).unwrap();
    assert!(is_error(&res));
    assert!(first_text(&res).contains("Selection unavailable"));

    s.tools.selection_tool = script(dir.path(), "quiet", "exit 1");
    assert_eq!(
        first_text(&s.tools.call("read_selected_text", &json!({})).unwrap()),
        "The app didn't expose selected text."
    );
    s.tools.selection_tool = dir.path().join("missing");
    assert_eq!(
        first_text(&s.tools.call("read_selected_text", &json!({})).unwrap()),
        "Couldn't read the selection. Build agent-vhid-selection and check Accessibility."
    );
    let res = s
        .tools
        .call("read_selected_text", &json!({"all": true}))
        .unwrap();
    assert_eq!(first_text(&res), "This tool takes no arguments.");
}

// --- authenticate (the Mac half of tests/test_credentials.py) ---

#[test]
fn mac_respects_user_takeover() {
    let s = setup(true);
    assert_eq!(s.tools.take().unwrap(), None);
    s.helper.raw("human trackpad");
    let res = s.tools.call("authenticate", &json!({})).unwrap();
    assert!(is_error(&res));
    assert_eq!(
        first_text(&res),
        "The user has control. Wait for control before authenticating."
    );
    assert!(s.native.calls.lock().unwrap().is_empty());
}

#[test]
fn mac_password_is_typed_into_focus_then_return() {
    let s = setup(true);
    s.helper.shared.caps.store(true, Ordering::SeqCst);
    let res = s.tools.call("authenticate", &json!({})).unwrap();
    assert!(!is_error(&res), "{res}");
    assert!(s.helper.shared.caps.load(Ordering::SeqCst)); // Caps Lock turned off for typing, then restored
    let lines = s.helper.lines();
    assert_eq!(lines[..2], [keys(0, &[57]), keys(0, &[])]); // capslock first
    assert_eq!(
        lines[lines.len() - 4..],
        [keys(0, &[40]), keys(0, &[]), keys(0, &[57]), keys(0, &[])]
    ); // return, capslock
    let typed = &lines[2..lines.len() - 4];
    assert_eq!(
        typed,
        [
            keys(2, &[]),
            keys(2, &[0x04]),
            keys(0, &[]), // A
            keys(0, &[0x05]),
            keys(0, &[]), // b
            keys(0, &[0x26]),
            keys(0, &[]), // 9
            keys(2, &[]),
            keys(2, &[0x1e]),
            keys(0, &[]), // !
        ]
    );
    assert_eq!(
        typed.iter().filter(|l| l.split(' ').count() == 3).count(),
        4
    ); // one (mods, usage) press a character
    assert!(!texts(&res).contains(SECRET));
    assert_eq!(
        *s.native.calls.lock().unwrap(),
        ["keyboard-layout", "read-mac"]
    );
}

#[test]
fn authenticate_takes_no_arguments() {
    let s = setup(true);
    let res = s
        .tools
        .call("authenticate", &json!({"password": SECRET}))
        .unwrap();
    assert!(is_error(&res));
    assert_eq!(
        first_text(&res),
        "Authentication takes no arguments; never pass a password."
    );
    assert!(!res.to_string().contains(SECRET));
    assert!(s.native.calls.lock().unwrap().is_empty());
    assert!(s.helper.lines().is_empty());
}

#[test]
fn tools_take_no_secret_arguments_and_are_not_batchable() {
    let tool = tools::tools()
        .into_iter()
        .find(|t| t["name"] == "authenticate")
        .unwrap();
    assert_eq!(tool["inputSchema"]["additionalProperties"], false);
    assert_eq!(tool["inputSchema"]["properties"], json!({}));
    assert!(!BATCHABLE.contains(&"authenticate"));
}

#[test]
fn batch_runs_authenticate_only_alone_and_without_arguments() {
    let calls = Mutex::new(Vec::new());
    let mut call = |name: &str, args: &Value| {
        calls.lock().unwrap().push((name.to_string(), args.clone()));
        Ok(hive_common::tools::ok_text("filled"))
    };
    let mut look = |_: &str| -> Result<Value, String> { panic!("no look") };
    let alone = hive_common::mcp::run_batch(
        &mut call,
        &mut look,
        &json!({"steps": [{"tool": "authenticate"}]}),
        &BATCHABLE,
    )
    .unwrap();
    assert!(!is_error(&alone));
    assert_eq!(
        *calls.lock().unwrap(),
        [("authenticate".to_string(), json!({}))]
    );
    calls.lock().unwrap().clear();
    for steps in [
        json!([{"tool": "authenticate"}, {"tool": "click", "x": 1, "y": 2}]),
        json!([{"tool": "authenticate", "password": SECRET}]),
    ] {
        let refused =
            hive_common::mcp::run_batch(&mut call, &mut look, &json!({"steps": steps}), &BATCHABLE)
                .unwrap();
        assert!(is_error(&refused));
        assert!(!refused.to_string().contains(SECRET));
    }
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn authentication_tools_call_the_mac() {
    let s = setup(true);
    assert_eq!(s.tools.take().unwrap(), None);
    s.helper.raw("human trackpad");
    let (mac, selected) = tools::authentication_tools();
    assert_eq!(mac["name"], "authenticate_mac");
    assert_eq!(selected["name"], "read_selected_text");
    let res = tools::call_authentication(&s.tools, "authenticate_mac", &json!({})).unwrap();
    assert_eq!(
        first_text(&res),
        "The user has control. Wait for control before authenticating."
    );
    let res = tools::call_authentication(&s.tools, "unlock_everything", &json!({})).unwrap();
    assert_eq!(first_text(&res), "Unknown authentication tool.");
}

/// The agent never clicks Hive's own floating window: in four tasks it clicked the card's x and so
/// stopped itself. The click is refused before the mouse moves; anywhere else it clicks.
#[test]
fn a_click_on_hives_own_window_is_refused() {
    let s = setup(true);
    *s.system.own_window.lock().unwrap() = Some((0.0, 0.0, 1440.0, 900.0));
    let res = s
        .tools
        .call("click", &json!({"x": 700, "y": 20, "screenshot": false}))
        .unwrap();
    assert!(is_error(&res));
    assert!(
        first_text(&res).contains("Hive's own floating window"),
        "{}",
        first_text(&res)
    );
    assert!(s.helper.lines().is_empty(), "the mouse never moved");

    *s.system.own_window.lock().unwrap() = Some((5000.0, 5000.0, 300.0, 200.0));
    let res = s
        .tools
        .call("click", &json!({"x": 700, "y": 20, "screenshot": false}))
        .unwrap();
    // (the fake cursor doesn't follow the mouse, so the click itself fails here; it was tried)
    assert!(
        !first_text(&res).contains("Hive's own floating window"),
        "{}",
        first_text(&res)
    );
    assert!(!s.helper.lines().is_empty(), "the mouse moved");
}

/// On an empty virtual monitor the agent once asked the user to "make a window available" instead
/// of opening one: a look at an empty monitor now says what brings a window there.
#[test]
fn an_empty_virtual_monitor_says_how_to_get_a_window_there() {
    let s = setup_on_monitor();
    *s.system.monitor_windows.lock().unwrap() = Some(0);
    let res = s.tools.call("screenshot", &json!({})).unwrap();
    assert!(!is_error(&res), "{res}");
    let said = first_text(&res);
    assert!(
        said.starts_with("Screenshot of the virtual monitor"),
        "{said}"
    );
    assert!(
        said.contains(hive_mac::tools::EMPTY_MONITOR.trim()),
        "{said}"
    );

    *s.system.monitor_windows.lock().unwrap() = Some(2);
    let res = s.tools.call("screenshot", &json!({})).unwrap();
    assert!(!first_text(&res).contains("No app's window"));

    let off = setup(true); // the user's screen: no such note
    let res = off.tools.call("screenshot", &json!({})).unwrap();
    assert!(!first_text(&res).contains("No app's window"));
}

/// switch_window on the virtual monitor brings the window it found over from the user's screen.
#[test]
fn switch_window_moves_the_window_onto_the_virtual_monitor() {
    let s = setup_on_monitor();
    let log = s.helper.shared.clone();
    let pressed = keys(8, &[0x35]);
    s.system.set_windows(move || {
        windows_with(if log.pressed(&pressed) {
            "GSSF_Presentation_styled"
        } else {
            "10-29 Club-Wide Meeting"
        })
    });
    *s.system.front_app.lock().unwrap() = "Microsoft PowerPoint".into();
    let res = s
        .tools
        .call("switch_window", &json!({"title": "gssf"}))
        .unwrap();
    assert!(!is_error(&res), "{res}");
    assert!(
        first_text(&res).contains("is in front, moved onto the virtual monitor"),
        "{}",
        first_text(&res)
    );
    assert_eq!(*s.system.placed.lock().unwrap(), [1]);
}

/// On the virtual monitor (hive-mac's take()): the user touching the mouse or keyboard doesn't
/// stop the agent. Their cursor and app come back to their screen; the agent's next step waits
/// until their hands are still, then takes the mouse and keyboard and puts its own back.
#[test]
fn on_the_virtual_monitor_a_takeover_doesnt_stop_the_agent() {
    let s = setup_with(
        false,
        Arc::new(FakeSystem {
            virtual_monitor: Some((1440.0, 0.0, 1440.0, 900.0)),
            ..FakeSystem::default()
        }),
    );
    *s.system.front_pid.lock().unwrap() = Some(7); // the user's app
    let typed = |text: &str| {
        let res = s
            .tools
            .call(
                "type_text",
                &json!({"text": text, "step": "Typing.", "screenshot": false}),
            )
            .unwrap();
        first_text(&res)
    };
    assert_eq!(typed("a"), "Typed.");
    assert_eq!(*s.system.cursor.lock().unwrap(), (2160.0, 450.0)); // over to the virtual monitor
    *s.system.front_pid.lock().unwrap() = Some(9); // the app the agent works in
    *s.system.cursor.lock().unwrap() = (2000.0, 300.0);

    s.helper.raw("human trackpad"); // the user touches the trackpad
    s.tools.took_over(); // the shell, told by the helper
    assert_eq!(*s.system.cursor.lock().unwrap(), (500.0, 400.0)); // back where the user left it
    assert_eq!(*s.system.activated.lock().unwrap(), vec![7]);

    // The user keeps going for a moment; the agent's next step waits for them, not for fn.
    *s.system.idle.lock().unwrap() = 0.0;
    let system = s.system.clone();
    let still = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        *system.idle.lock().unwrap() = f64::INFINITY;
    });
    let started = std::time::Instant::now();
    assert_eq!(typed("b"), "Typed.");
    assert!(started.elapsed() >= Duration::from_millis(500));
    still.join().unwrap();
    assert!(s.helper.raw("status").contains("state=engaged"));
    assert_eq!(*s.system.cursor.lock().unwrap(), (2000.0, 300.0)); // the agent's cursor again
    assert_eq!(*s.system.activated.lock().unwrap(), vec![7, 9]); // and its app

    // Letting go after the step gives the user their cursor and app once more.
    s.tools.let_go();
    assert_eq!(*s.system.cursor.lock().unwrap(), (500.0, 400.0));
    assert_eq!(*s.system.activated.lock().unwrap(), vec![7, 9, 7]);
}

/// On the virtual monitor, a touch in the middle of a step says so, without waiting for fn.
#[test]
fn on_the_virtual_monitor_a_touch_mid_step_says_to_look_and_go_on() {
    let s = setup_on_monitor();
    let res = s
        .tools
        .call("wait_for_control", &json!({"timeout_seconds": 1}))
        .unwrap();
    assert!(texts(&res).starts_with("You have the mouse and keyboard."));
    assert!(MacTools::not_yours("trackpad")
        .to_string()
        .contains("press fn"));
    assert!(!s.tools.not_now("busy").to_string().contains("press fn"));
}
