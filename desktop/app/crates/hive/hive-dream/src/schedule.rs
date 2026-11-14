//! The nightly run. On Hive's cloud VM a systemd timer starts it (`cloud/dream/nightly.sh`,
//! installed by `cloud/dream/install.sh`): `hive-dream nightly` runs at most once per date,
//! collects, has Hive's VM agent try up to [`FIXES_A_NIGHT`] fixes (test first), and writes the
//! report. Each fix goes to the macOS check on GitHub Actions (`ci`), which lands it on main or
//! doesn't. Run on the Mac by hand (HIVE_DREAM_AGENT=hive), it first waits for Hive to be idle
//! and the user away.

use std::io::Write as _;
use std::path::Path;

use crate::{collect, fix, paths, report, time};

/// The user counts as present if they touched input more recently than this.
pub const IDLE_SECS: f64 = 600.0;
/// How many of the clusters that lost the most time a night tries to fix, one after another.
/// Each is small and checked on its own, so one that fails doesn't hold the others back.
pub const FIXES_A_NIGHT: usize = 3;
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

/// What the VM's timer runs. Exits cleanly (with a log line) when it postpones or has nothing to do.
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
    // On the Mac the dream waits for Hive to be idle; on the VM nothing it does touches Hive.
    if let Some(why) = postpone_now().filter(|_| cfg!(target_os = "macos")) {
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
    log_line(&format!("fix --max {FIXES_A_NIGHT}"));
    match fix::run(&fix::Options {
        max: FIXES_A_NIGHT,
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
                if let Some(done) = &r.deployed {
                    // The macOS check decided: landed on main, held for a person, or rejected.
                    log_line(done);
                    continue;
                }
                if r.outcome != "proposed" {
                    continue;
                }
                let branch = r.branch.clone().unwrap_or_default();
                let kept = format!(
                    "not landed: kept on {branch}, the macOS check being off (HIVE_DREAM_CI=0); `hive-dream land {branch}` lands it"
                );
                log_line(&kept);
                r.deployed = Some(kept);
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

/// For `hive-dream nightly` run by hand: flush stdout so the log reads in order.
pub fn flush() {
    let _ = std::io::stdout().flush();
}
