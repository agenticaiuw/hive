//! No real app, process control, microphone, network, or user files are used.

use hive_workspace::restart::*;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    repo: PathBuf,
    app: PathBuf,
    stage: PathBuf,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let repo = root.join("repo");
    let app = root.join("Applications/Agent.app");
    let stage = root.join("agent-restart-test");
    std::fs::create_dir_all(repo.join("build")).unwrap();
    std::fs::create_dir_all(repo.join(".venv/bin")).unwrap();
    let python = repo.join(".venv/bin/python");
    std::fs::write(&python, "fixture").unwrap();
    std::os::unix::fs::PermissionsExt::set_mode(
        &mut std::fs::metadata(&python).unwrap().permissions(),
        0o700,
    );
    std::fs::set_permissions(&python, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    std::fs::create_dir_all(app.join("Contents")).unwrap();
    write_plist(
        &app.join("Contents/Info.plist"),
        &json!({"CFBundleIdentifier": IDENTIFIER, "AgentRepository": repo.display().to_string()}),
    )
    .unwrap();
    std::fs::write(app.join("old"), "old app").unwrap();
    std::fs::create_dir_all(stage.join("Agent.app")).unwrap();
    std::fs::write(stage.join("Agent.app/new"), "new app").unwrap();
    std::fs::write(stage.join("agent-vhid-captions"), "new overlay").unwrap();
    std::fs::write(repo.join("build/agent-vhid-captions"), "old overlay").unwrap();
    Fixture {
        _temp: temp,
        root,
        repo,
        app,
        stage,
    }
}

fn real_repo() -> PathBuf {
    // crates/hive/hive-workspace -> desktop/app
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

type Log = Arc<Mutex<Vec<String>>>;

#[test]
fn default_is_plan_only() {
    let output = Command::new(env!("CARGO_BIN_EXE_restart-agent-once"))
        .env("HIVE_REPO", real_repo())
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.starts_with("PLAN ONLY: compile temporary app + captions from "),
        "{text}"
    );
    assert!(text.contains("Use --prepare for compilation only, --execute to actually restart."));
    // Nothing was built: no stage folder was announced.
    assert!(!text.contains("Prepared"));
}

#[test]
fn conflicting_modes_are_refused() {
    let output = Command::new(env!("CARGO_BIN_EXE_restart-agent-once"))
        .args(["--prepare", "--execute"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn source_patch_fails_closed() {
    for text in ["missing", "anchor anchor"] {
        assert!(replace_once(text, "anchor", "new").is_err(), "{text}");
    }
    assert_eq!(
        replace_once("an anchor here", "anchor", "new").unwrap(),
        "an new here"
    );
}

#[test]
fn real_sources_patch_without_editing_them() {
    let f = fixture();
    let repo = real_repo();
    let before =
        std::fs::read_to_string(repo.join("workspace-engine/Sources/UnifiedAgent/app.swift"))
            .unwrap();
    let (app, captions) = patched_sources(&repo, &f.stage).unwrap();
    assert!(app.contains("if statusLine.title == \"Ready\", listenOnce"));
    assert!(app.contains("if !listening { toggle() }"));
    assert!(!app.contains("security find-identity"));
    assert!(!app.contains("try? manager.removeItem(at: old)"));
    assert!(app.contains(&format!("{}/listening", f.stage.display())));
    assert!(app.contains(&format!("{}/visible", f.stage.display())));
    assert!(captions.contains("self.window.isVisible"));
    assert!(captions.contains("Data(\"visible\\n\".utf8)"));
    assert_eq!(
        std::fs::read_to_string(repo.join("workspace-engine/Sources/UnifiedAgent/app.swift"))
            .unwrap(),
        before
    );
}

#[test]
fn actual_swift_parser_toggles_once_only_after_ready() {
    let f = fixture();
    let (app, _) = patched_sources(&real_repo(), &f.stage).unwrap();
    // The body of `took`, up to and including its closing brace (the next method is not needed).
    let body = app
        .split("    func took(_ data: Data) {")
        .nth(1)
        .unwrap()
        .split("\n    }\n")
        .next()
        .unwrap();
    let parser = format!("{body}\n    }}\n");
    let harness = format!(
        r#"import Foundation
enum State {{ case on, off }}
final class Line {{ var title = ""; var isEnabled = false; var state = State.off }}
final class Panel {{ var feedURL: URL?; var isVisible = false; func load(force: Bool) {{}} }}
final class Harness {{
    var output = Data()
    var listening = false, dictating = false, listenOnce = true, camera = false
    var contextURL: URL?, panelURL: URL?
    let statusLine = Line(), contextItem = Line(), clipboardItem = Line(), fileItem = Line()
    let voiceItem = Line(), lipsItem = Line(), panel = Panel()
    var toggles = 0
    func show() {{}}
    func write(_ text: String) {{}}
    func toggle() {{ toggles += 1 }}
    func feed(_ text: String) {{ took(Data(text.utf8)) }}
    func took(_ data: Data) {{{parser}
}}
let a = Harness()
a.feed("@@ listening 0\n@@ status Waiting for helper\n@@ status Re")
precondition(a.toggles == 0)
a.feed("ady\n")
precondition(a.toggles == 1)
a.feed("@@ status Ready\n@@ listening 1\n@@ status Ready\n")
precondition(a.toggles == 1 && a.listening)
let b = Harness()
b.feed("@@ listening 1\n@@ status Ready\n")
precondition(b.toggles == 0)
let c = Harness()
c.listenOnce = false
c.feed("@@ listening 0\n@@ status Ready\n")
precondition(c.toggles == 0)
print("Readiness, split lines, repeated Ready, already listening, and opt-in checks passed")
"#
    );
    let (source, binary) = (f.root.join("parser.swift"), f.root.join("parser-test"));
    std::fs::write(&source, &harness).unwrap();
    let built = Command::new("/usr/bin/swiftc")
        .args(["-module-cache-path"])
        .arg(f.root.join("cache"))
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .output()
        .unwrap();
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    let ran = Command::new(&binary).output().unwrap();
    assert!(
        ran.status.success(),
        "{}",
        String::from_utf8_lossy(&ran.stderr)
    );
}

#[test]
fn success_preserves_backups_and_orders_quit_before_launch() {
    let f = fixture();
    let log: Log = Arc::default();
    let (app, stage, record) = (f.app.clone(), f.stage.clone(), log.clone());
    let mut run = move |args: &[String], _env: &[(&str, &str)]| {
        record.lock().unwrap().push(args[1].clone());
        if args[1] == "quit" {
            assert!(app.join("old").exists());
        }
        if args[1] == "launch" {
            assert!(app.join("new").exists());
            std::fs::write(stage.join("listening"), "").unwrap();
            std::fs::write(stage.join("visible"), "").unwrap();
        }
        Ok(())
    };
    execute(
        &f.stage,
        &f.repo,
        &f.app,
        Duration::from_secs(120),
        &mut run,
    )
    .unwrap();
    assert_eq!(*log.lock().unwrap(), ["quit", "launch"]);
    let backup = f.app.with_file_name("Agent.backup-agent-restart-test.app");
    assert_eq!(
        std::fs::read_to_string(backup.join("old")).unwrap(),
        "old app"
    );
    assert_eq!(
        std::fs::read_to_string(
            f.repo
                .join("build/agent-vhid-captions.backup-agent-restart-test")
        )
        .unwrap(),
        "old overlay"
    );
    assert_eq!(
        std::fs::read_to_string(f.repo.join("build/agent-vhid-captions")).unwrap(),
        "new overlay"
    );
    assert_eq!(
        std::fs::read_to_string(f.app.join("new")).unwrap(),
        "new app"
    );
}

#[test]
fn refused_quit_does_not_replace_app() {
    let f = fixture();
    let mut run = |_: &[String], _: &[(&str, &str)]| Err("refused".to_string());
    assert_eq!(
        execute(
            &f.stage,
            &f.repo,
            &f.app,
            Duration::from_secs(120),
            &mut run
        )
        .unwrap_err(),
        "refused"
    );
    assert!(f.app.join("old").exists());
    assert!(!f.app.join("new").exists());
}

#[test]
fn missing_acknowledgement_is_failure_without_retry() {
    let f = fixture();
    let log: Log = Arc::default();
    let record = log.clone();
    let mut run = move |args: &[String], _: &[(&str, &str)]| {
        record.lock().unwrap().push(args[1].clone());
        Ok(())
    };
    let error = execute(&f.stage, &f.repo, &f.app, Duration::ZERO, &mut run).unwrap_err();
    assert!(error.contains("No listening"), "{error}");
    assert_eq!(*log.lock().unwrap(), ["quit", "launch"]);
}

#[test]
fn mismatched_install_refused_before_process_control() {
    let f = fixture();
    let mut run =
        |_: &[String], _: &[(&str, &str)]| -> Result<(), String> { panic!("process control") };
    assert!(execute(
        &f.stage,
        &f.root,
        &f.app,
        Duration::from_secs(120),
        &mut run
    )
    .is_err());
    assert!(f.app.join("old").exists());
}

#[test]
fn existing_backup_paths_are_never_overwritten() {
    let f = fixture();
    std::fs::create_dir(f.app.with_file_name("Agent.backup-agent-restart-test.app")).unwrap();
    let mut run =
        |_: &[String], _: &[(&str, &str)]| -> Result<(), String> { panic!("process control") };
    let error = execute(
        &f.stage,
        &f.repo,
        &f.app,
        Duration::from_secs(120),
        &mut run,
    )
    .unwrap_err();
    assert!(error.starts_with("Refusing to overwrite"));
}

#[test]
fn preflight_requires_the_python_environment_and_a_real_bundle() {
    let f = fixture();
    preflight(&f.repo, &f.app).unwrap();
    std::fs::remove_file(f.repo.join(".venv/bin/python")).unwrap();
    assert!(preflight(&f.repo, &f.app)
        .unwrap_err()
        .contains("Python environment"));
    assert!(preflight(&f.repo, &f.root.join("missing.app")).is_err());
}
