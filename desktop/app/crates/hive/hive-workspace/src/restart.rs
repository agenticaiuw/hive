//! One-off Agent restart (scripts/restart-agent-once.py). Default: plan only. `--prepare` builds
//! without launching.
//!
//! `--execute` is deliberately required to quit/install/launch. No sudo, synthetic keys, UI
//! scripting, data cleanup, or installer. All backups are retained.

use crate::recovery::run_command;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const IDENTIFIER: &str = "local.personal-agent.Agent";

pub const CONTROL: &str = r##"
import AppKit
let mode = CommandLine.arguments[1]
let url = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "local.personal-agent.Agent")
guard apps.allSatisfy({ $0.bundleURL?.standardizedFileURL == url }) else {
    fputs("Another Agent bundle is running; refusing to touch it.\n", stderr); exit(1)
}
if mode == "quit" {
    for app in apps {
        guard app.terminate() else { fputs("Agent refused graceful quit.\n", stderr); exit(1) }
    }
    let deadline = Date().addingTimeInterval(15)
    while apps.contains(where: { !$0.isTerminated }) && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    guard apps.allSatisfy({ $0.isTerminated }) else {
        fputs("Agent did not quit; no force kill or replacement performed.\n", stderr); exit(1)
    }
} else if mode == "launch" {
    guard apps.isEmpty else { fputs("Agent is already running.\n", stderr); exit(1) }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = false
    config.arguments = ["--listen-once"]
    var finished = false
    var failed = false
    NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
        failed = error != nil
        if let error { fputs("Launch failed: \(error)\n", stderr) }
        finished = true
    }
    let deadline = Date().addingTimeInterval(20)
    while !finished && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    if !finished || failed { exit(1) }
} else { exit(2) }
"##;

/// Runs one command to completion (program first) with extra environment; an error when it fails.
pub type Runner<'a> = &'a mut dyn FnMut(&[String], &[(&str, &str)]) -> Result<(), String>;

/// `subprocess.run(args, check=True)`: inherits stdio, fails on a non-zero status.
pub fn system_run(args: &[String], env: &[(&str, &str)]) -> Result<(), String> {
    let status = std::process::Command::new(&args[0])
        .args(&args[1..])
        .envs(env.iter().copied())
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Command '{:?}' returned non-zero exit status {}.",
            args,
            status.code().unwrap_or(-1)
        ))
    }
}

pub fn default_app() -> PathBuf {
    hive_common::paths::home().join("Applications/Hive.app")
}

/// The source must contain `old` exactly once.
pub fn replace_once(text: &str, old: &str, new: &str) -> Result<String, String> {
    if text.matches(old).count() != 1 {
        let head: String = old.chars().take(70).collect();
        return Err(format!(
            "Source changed; refusing an ambiguous one-off patch: {head}"
        ));
    }
    Ok(text.replacen(old, new, 1))
}

/// The app and captions Swift sources with the one-off patches applied (the repo is not edited).
pub fn patched_sources(repo: &Path, stage: &Path) -> Result<(String, String), String> {
    let stage = stage.display();
    let read = |relative: &str| {
        std::fs::read_to_string(repo.join(relative)).map_err(|e| format!("{relative}: {e}"))
    };
    let mut app = read("workspace-engine/Sources/UnifiedAgent/app.swift")?;
    app = replace_once(
        &app,
        "    var quitting = false",
        "    var quitting = false\n    var listenOnce = CommandLine.arguments.contains(\"--listen-once\")",
    )?;
    app = replace_once(
        &app,
        r#"                statusLine.title = String(line.dropFirst("@@ status ".count))"#,
        concat!(
            r#"                statusLine.title = String(line.dropFirst("@@ status ".count))"#,
            "\n",
            r#"                if statusLine.title == "Ready", listenOnce {"#,
            "\n                    listenOnce = false\n                    if !listening { toggle() }\n                }"
        ),
    )?;
    app = replace_once(
        &app,
        r#"                listening = line.hasSuffix("1")"#,
        &format!(
            "                listening = line.hasSuffix(\"1\")\n                if listening {{ try? Data(\"listening\\n\".utf8).write(to: URL(fileURLWithPath: \"{stage}/listening\"), options: .atomic) }}"
        ),
    )?;
    app = replace_once(
        &app,
        "        process.environment = environment",
        &format!(
            "        environment[\"CAPTIONS\"] = \"1\"\n        environment[\"AGENT_ONCE_VISIBLE\"] = \"{stage}/visible\"\n        process.environment = environment"
        ),
    )?;
    // A one-off restart must not change login preferences or discard rotated logs.
    app = replace_once(
        &app,
        r#"        if !UserDefaults.standard.bool(forKey: "loginItemSet") {"#,
        "        if false { // leave login registration untouched in this build",
    )?;
    app = replace_once(
        &app,
        "            try? manager.removeItem(at: old)",
        "            // Preserve any old log; a failed move leaves the current log in place.",
    )?;
    let mut captions = read("tools/captions.swift")?;
    captions = replace_once(
        &captions,
        "        window.orderFrontRegardless()",
        r#"        window.orderFrontRegardless()
        if listening, let path = ProcessInfo.processInfo.environment["AGENT_ONCE_VISIBLE"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                if let self, self.listening, self.window.isVisible, self.window.alphaValue > 0 {
                    try? Data("visible\n".utf8).write(to: URL(fileURLWithPath: path), options: .atomic)
                }
            }
        }"#,
    )?;
    Ok((app, captions))
}

/// A property list as JSON (via `plutil`), so only simple property lists are supported.
pub fn read_plist(path: &Path) -> Result<Value, String> {
    let (code, out, err) = run_command(
        &[
            "/usr/bin/plutil",
            "-convert",
            "json",
            "-o",
            "-",
            &path.to_string_lossy(),
        ],
        15,
    );
    if code != 0 {
        return Err(format!("{}: {}", path.display(), err.trim()));
    }
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

/// Writes `value` as an XML property list.
pub fn write_plist(path: &Path, value: &Value) -> Result<(), String> {
    std::fs::write(path, serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let (code, _, err) = run_command(
        &[
            "/usr/bin/plutil",
            "-convert",
            "xml1",
            &path.to_string_lossy(),
        ],
        15,
    );
    if code != 0 {
        return Err(format!("{}: {}", path.display(), err.trim()));
    }
    Ok(())
}

pub fn prepare(repo: &Path, run: Runner) -> Result<PathBuf, String> {
    // Generated paths are controlled here and contain no Swift string metacharacters.
    let stage = tempfile::Builder::new()
        .prefix("agent-restart-")
        .tempdir_in("/private/tmp")
        .map_err(|e| e.to_string())?
        .keep();
    let (app_source, captions_source) = patched_sources(repo, &stage)?;
    let bundle = stage.join("Agent.app");
    let binary = bundle.join("Contents/MacOS/Agent");
    std::fs::create_dir_all(binary.parent().unwrap()).map_err(|e| e.to_string())?;
    for (name, source) in [
        ("app", app_source.as_str()),
        ("captions", captions_source.as_str()),
        ("control", CONTROL),
    ] {
        std::fs::write(stage.join(format!("{name}.swift")), source).map_err(|e| e.to_string())?;
    }
    let mut info = read_plist(&repo.join("tools/Agent-Info.plist"))?;
    info.as_object_mut()
        .ok_or("Agent-Info.plist is not a dictionary")?
        .insert(
            "AgentRepository".into(),
            Value::String(repo.display().to_string()),
        );
    write_plist(&bundle.join("Contents/Info.plist"), &info)?;
    let cache = stage.join("module-cache");
    for (source, target) in [
        ("app", binary.clone()),
        ("captions", stage.join("agent-vhid-captions")),
        ("control", stage.join("control")),
    ] {
        run(
            &[
                "/usr/bin/swiftc".into(),
                "-O".into(),
                "-module-cache-path".into(),
                cache.display().to_string(),
                stage.join(format!("{source}.swift")).display().to_string(),
                "-o".into(),
                target.display().to_string(),
            ],
            &[],
        )?;
    }
    // Signed like make signs it (your Apple Development certificate), so macOS keeps Agent's
    // permissions; it refuses to fall back to ad hoc, which would make them all be asked again.
    run(
        &[
            repo.join("tools/sign.sh").display().to_string(),
            bundle.display().to_string(),
            IDENTIFIER.into(),
        ],
        &[("SIGN_REQUIRED", "1")],
    )?;
    run(
        &[
            "/usr/bin/codesign".into(),
            "--verify".into(),
            "--strict".into(),
            bundle.display().to_string(),
        ],
        &[],
    )?;
    println!("Prepared (nothing launched): {}", stage.display());
    Ok(stage)
}

pub fn preflight(repo: &Path, app: &Path) -> Result<(), String> {
    let is_link = app
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if is_link || !app.is_dir() {
        return Err(format!(
            "Expected an installed, non-symlink app: {}",
            app.display()
        ));
    }
    let info = read_plist(&app.join("Contents/Info.plist"))?;
    if info.get("CFBundleIdentifier").and_then(Value::as_str) != Some(IDENTIFIER)
        || info.get("AgentRepository").and_then(Value::as_str) != Some(&repo.display().to_string())
    {
        return Err("Installed bundle identity/repository does not match".into());
    }
    let python = repo.join(".venv/bin/python");
    let executable = std::fs::metadata(&python)
        .map(|m| {
            m.is_file() && std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0
        })
        .unwrap_or(false);
    if !executable {
        return Err(
            "Existing Python environment is missing; no setup/download will be attempted".into(),
        );
    }
    Ok(())
}

/// `shutil.copytree`: directories recursively, permissions and symlinks preserved.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let (source, target) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            std::os::unix::fs::symlink(std::fs::read_link(&source)?, &target)?;
        } else if kind.is_dir() {
            copy_tree(&source, &target)?;
        } else {
            std::fs::copy(&source, &target)?;
        }
    }
    std::fs::set_permissions(to, std::fs::metadata(from)?.permissions())
}

fn exists(path: &Path) -> bool {
    path.exists()
}

fn with_name(path: &Path, name: String) -> PathBuf {
    path.with_file_name(name)
}

pub fn execute(
    stage: &Path,
    repo: &Path,
    app: &Path,
    timeout: Duration,
    run: Runner,
) -> Result<(), String> {
    preflight(repo, app)?;
    // Stage installation on the destination filesystem BEFORE disturbing the running app.
    let suffix = stage
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let incoming = with_name(app, format!("Agent.incoming-{suffix}.app"));
    let backup = with_name(app, format!("Agent.backup-{suffix}.app"));
    let overlay = repo.join("build/agent-vhid-captions");
    let overlay_backup = with_name(&overlay, format!("agent-vhid-captions.backup-{suffix}"));
    let overlay_incoming = with_name(&overlay, format!("agent-vhid-captions.incoming-{suffix}"));
    for path in [&incoming, &backup, &overlay_backup, &overlay_incoming] {
        if exists(path) || path.symlink_metadata().is_ok() {
            return Err(format!("Refusing to overwrite {}", path.display()));
        }
    }
    copy_tree(&stage.join("Agent.app"), &incoming).map_err(|e| e.to_string())?;
    std::fs::copy(stage.join("agent-vhid-captions"), &overlay_incoming)
        .map_err(|e| e.to_string())?;
    let control = stage.join("control").display().to_string();
    let app_text = app.display().to_string();
    run(&[control.clone(), "quit".into(), app_text.clone()], &[])?;
    std::fs::rename(app, &backup).map_err(|e| e.to_string())?;
    let installed = (|| -> std::io::Result<()> {
        std::fs::rename(&incoming, app)?;
        if overlay.exists() {
            std::fs::rename(&overlay, &overlay_backup)?;
        }
        std::fs::rename(&overlay_incoming, &overlay)
    })();
    if let Err(error) = installed {
        // Preserve every artifact; restore the previous app if installation failed.
        if app.exists() {
            let _ = std::fs::rename(app, &incoming);
        }
        std::fs::rename(&backup, app).map_err(|e| e.to_string())?;
        if overlay_backup.exists() && !overlay.exists() {
            let _ = std::fs::rename(&overlay_backup, &overlay);
        }
        return Err(error.to_string());
    }
    println!("Previous app retained: {}", backup.display());
    println!(
        "Previous overlay retained if present: {}",
        overlay_backup.display()
    );
    run(&[control, "launch".into(), app_text], &[])?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if stage.join("listening").exists() && stage.join("visible").exists() {
            println!("Agent acknowledged listening; captions reported a visible window.");
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!(
        "No listening + visible acknowledgement within 120 seconds. App left running; no automatic retry/toggle/rollback. Artifacts: {}. Check Agent permissions/helper manually.",
        stage.display()
    ))
}

pub const PLAN: &str = "PLAN ONLY: compile temporary app + captions from {REPO}; ad-hoc sign; gracefully quit {APP}; preserve old bundle/overlay; install; launch without activation; wait for Ready; send one toggle; verify listening + visible acknowledgements. Use --prepare for compilation only, --execute to actually restart.";

pub fn main(args: &[String]) -> i32 {
    let (mut prepare_only, mut run_it) = (false, false);
    for arg in args {
        match arg.as_str() {
            "--prepare" => prepare_only = true,
            "--execute" => run_it = true,
            "-h" | "--help" => {
                println!("usage: restart-agent-once [-h] [--prepare | --execute]\n\nOne-off Agent restart. Default: plan only. --prepare builds without launching.\n\n--execute is deliberately required to quit/install/launch. No sudo,\nsynthetic keys, UI scripting, data cleanup, or installer. All backups are retained.");
                return 0;
            }
            _ => {
                eprintln!("usage: restart-agent-once [-h] [--prepare | --execute]\nrestart-agent-once: error: unrecognized arguments: {arg}");
                return 2;
            }
        }
    }
    if prepare_only && run_it {
        eprintln!("usage: restart-agent-once [-h] [--prepare | --execute]\nrestart-agent-once: error: argument --execute: not allowed with argument --prepare");
        return 2;
    }
    let repo = hive_common::paths::repo_root();
    let app = default_app();
    if !(prepare_only || run_it) {
        println!(
            "{}",
            PLAN.replace("{REPO}", &repo.display().to_string())
                .replace("{APP}", &app.display().to_string())
        );
        return 0;
    }
    let mut run = system_run;
    let result = (|| {
        if run_it {
            preflight(&repo, &app)?;
        }
        let stage = prepare(&repo, &mut run)?;
        if run_it {
            execute(&stage, &repo, &app, Duration::from_secs(120), &mut run)?;
        }
        Ok::<(), String>(())
    })();
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("RuntimeError: {error}");
            1
        }
    }
}
