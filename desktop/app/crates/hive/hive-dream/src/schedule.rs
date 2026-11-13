//! The nightly run and its LaunchAgent. `hive-dream nightly` (what launchd starts) postpones when
//! Hive is in the middle of a task or the user touched the mouse or keyboard in the last ten
//! minutes, runs at most once per date, and otherwise collects, has Hive's agent try one fix (test
//! first), lands, builds, pushes and restarts Hive with a fix the gate passed (`deploy`), and
//! writes the report. `install-schedule` writes ~/Library/LaunchAgents/local.hive.dream.plist.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use crate::{collect, deploy, fix, paths, report, time};

pub const LABEL: &str = "local.hive.dream";
/// The user counts as present if they touched input more recently than this.
pub const IDLE_SECS: f64 = 600.0;
/// Local times launchd starts the nightly run (a run that already finished for the date, or one
/// postponed, makes the later ones a retry). launchd runs a time missed while asleep on wake.
pub const TIMES: &[(u32, u32)] = &[(3, 30), (4, 30), (5, 30), (6, 30), (7, 30)];

/// `"HIDIdleTime" = 45043833` (nanoseconds) from `ioreg -c IOHIDSystem`.
pub fn parse_hid_idle_ns(text: &str) -> Option<u64> {
    text.lines()
        .find(|l| l.contains("\"HIDIdleTime\""))
        .and_then(|l| l.split('=').nth(1))
        .and_then(|v| v.trim().parse().ok())
}

/// Why the run should wait, if it should: Hive mid-task (`task-recovery.json` status "active") or
/// the user active within [`IDLE_SECS`].
pub fn postpone_reason(task_recovery: Option<&str>, idle_ns: Option<u64>) -> Option<String> {
    if let Some(text) = task_recovery {
        let status = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(str::to_string));
        if status.as_deref() == Some("active") {
            return Some("Hive is in the middle of a task".into());
        }
    }
    if let Some(ns) = idle_ns {
        let secs = ns as f64 / 1e9;
        if secs < IDLE_SECS {
            return Some(format!(
                "the user touched the mouse or keyboard {secs:.0} s ago (under {IDLE_SECS:.0} s)"
            ));
        }
    }
    None
}

/// Why Hive shouldn't be disturbed right now, if it shouldn't (see [`postpone_reason`]).
pub fn postpone_now() -> Option<String> {
    let recovery = std::fs::read_to_string(paths::state_dir().join("task-recovery.json")).ok();
    postpone_reason(recovery.as_deref(), hid_idle_ns())
}

fn hid_idle_ns() -> Option<u64> {
    let out = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-c", "IOHIDSystem", "-d", "4"])
        .output()
        .ok()?;
    parse_hid_idle_ns(&String::from_utf8_lossy(&out.stdout))
}

fn log_line(text: &str) {
    println!("{} hive-dream: {text}", time::iso(time::now()));
}

/// An exclusive lock on `<dream>/lock` for as long as the file stays open.
fn lock(dream: &Path) -> Result<std::fs::File, String> {
    use std::os::unix::io::AsRawFd;
    std::fs::create_dir_all(dream).map_err(|e| e.to_string())?;
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dream.join("lock"))
        .map_err(|e| e.to_string())?;
    // SAFETY: flock on a descriptor we own.
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("another hive-dream run holds the lock".into());
    }
    Ok(f)
}

/// What launchd runs. Exits cleanly (with a log line) when it postpones or has nothing to do.
pub fn nightly(force: bool) -> Result<(), String> {
    let dream = paths::dream_dir();
    let _lock = match lock(&dream) {
        Ok(l) => l,
        Err(e) => {
            log_line(&format!("skipped: {e}"));
            return Ok(());
        }
    };
    let date = time::date(time::now());
    let done = paths::night(&dream, &date).join("nightly-done");
    if done.exists() && !force {
        log_line(&format!("already ran for {date}"));
        return Ok(());
    }
    if let Some(why) = postpone_now() {
        log_line(&format!("postponed: {why}"));
        return Ok(());
    }
    log_line("collect");
    let collected = collect::run(&collect::Options {
        since_hours: None,
        write: true,
    })?;
    let top: Vec<String> = collected
        .evidence
        .clusters
        .iter()
        .take(3)
        .map(|c| format!("{} ({:.0} min)", c.signature, c.minutes))
        .collect();
    log_line(&format!(
        "{} clusters; top: {}",
        collected.evidence.clusters.len(),
        top.join("; ")
    ));
    report::write(&dream, &collected.date)?;
    log_line("fix --max 1");
    match fix::run(&fix::Options {
        max: 1,
        cluster: None,
        dry_run: false,
    }) {
        Ok(results) => {
            let night = paths::night(&dream, &collected.date);
            for mut r in results {
                log_line(&format!("{} ({}): {}", r.outcome, r.agent, r.signature));
                for note in &r.notes {
                    log_line(&format!("note: {note}"));
                }
                let deployed = match deploy::hold_reason(&r, deploy::autoland()) {
                    Some(why) if r.outcome == "proposed" => format!("not landed: {why}"),
                    Some(_) => continue,
                    None => {
                        let run_dir = night.join("fixes").join(&r.run);
                        deploy::run(&r, &run_dir).unwrap_or_else(|e| format!("not landed: {e}"))
                    }
                };
                log_line(&deployed);
                r.deployed = Some(deployed);
                let _ = fix::save_result(&night, &r);
            }
        }
        Err(e) => log_line(&format!("fix failed: {e}")),
    }
    let path = report::write(&dream, &collected.date)?;
    paths::write_atomic(&done, &time::iso(time::now()))?;
    log_line(&format!("report: {}", path.display()));
    Ok(())
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The LaunchAgent: `<exe> nightly` at [`TIMES`], output to `<dream>/dream.log`, low priority.
pub fn plist(exe: &Path, dream: &Path, home: &Path) -> String {
    let log = xml(&dream.join("dream.log").to_string_lossy());
    let times: String = TIMES
        .iter()
        .map(|(h, m)| {
            format!("        <dict>\n            <key>Hour</key>\n            <integer>{h}</integer>\n            <key>Minute</key>\n            <integer>{m}</integer>\n        </dict>\n")
        })
        .collect();
    let path = format!(
        "{}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        home.to_string_lossy()
    );
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
        <string>nightly</string>
    </array>
    <key>StartCalendarInterval</key>
    <array>
{times}    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
    <key>LowPriorityIO</key>
    <true/>
    <key>Nice</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
"#,
        xml(&exe.to_string_lossy()),
        xml(&path)
    )
}

pub fn plist_path() -> PathBuf {
    paths::home()
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"))
}

/// Writes the LaunchAgent and (unless `load` is false) loads it with launchctl.
pub fn install(exe: Option<PathBuf>, print: bool, load: bool) -> Result<String, String> {
    let exe = match exe {
        Some(e) => e,
        None => std::env::current_exe().map_err(|e| e.to_string())?,
    };
    let exe = exe
        .canonicalize()
        .map_err(|e| format!("{}: {e}", exe.display()))?;
    let text = plist(&exe, &paths::dream_dir(), &paths::home());
    if print {
        return Ok(text);
    }
    let path = plist_path();
    paths::write_atomic(&path, &text)?;
    if !load {
        return Ok(format!("wrote {} (not loaded)", path.display()));
    }
    let uid = unsafe { libc::getuid() };
    let domain = format!("gui/{uid}");
    let _ = std::process::Command::new("/bin/launchctl")
        .args(["bootout", &format!("{domain}/{LABEL}")])
        .output();
    let out = std::process::Command::new("/bin/launchctl")
        .args(["bootstrap", &domain, &path.to_string_lossy()])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "launchctl bootstrap: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(format!("installed and loaded {}", path.display()))
}

pub fn uninstall() -> Result<String, String> {
    let uid = unsafe { libc::getuid() };
    let _ = std::process::Command::new("/bin/launchctl")
        .args(["bootout", &format!("gui/{uid}/{LABEL}")])
        .output();
    let path = plist_path();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(format!("removed {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("nothing installed".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// For `hive-dream nightly` run by hand: flush stdout so the log reads in order.
pub fn flush() {
    let _ = std::io::stdout().flush();
}
