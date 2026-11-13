//! What the nightly run does with a fix the gate passed: lands it on main in ~/hive (`land`),
//! builds Hive there, pushes, and restarts Hive with the new build when nobody is using it. A
//! build that fails takes the landing back (`git reset --keep`, which never touches other
//! uncommitted work). Only a fix whose test failed on an assertion lands by itself; one whose test
//! only failed to compile waits for a person. HIVE_DREAM_AUTOLAND=0 turns all of this off.

use std::path::Path;
use std::time::Duration;

use crate::fix::FixResult;
use crate::register::{Register, Status};
use crate::{git, land, paths, proc, schedule, time};

pub const BUILD_TIMEOUT_SECS: u64 = 40 * 60;
pub const RESTART_TIMEOUT_SECS: u64 = 15 * 60;

pub fn autoland() -> bool {
    std::env::var("HIVE_DREAM_AUTOLAND").as_deref() != Ok("0")
}

/// Why a fix doesn't land by itself, if it doesn't.
pub fn hold_reason(r: &FixResult, autoland: bool) -> Option<String> {
    if r.outcome != "proposed" {
        return Some(format!("it was {}", r.outcome));
    }
    if !autoland {
        return Some("HIVE_DREAM_AUTOLAND=0".into());
    }
    if r.red != "assertion" {
        return Some(
            "its test only failed to compile on the old code, so it doesn't prove the problem; land it by hand after a look"
                .into(),
        );
    }
    None
}

/// Lands, builds, pushes and (when nobody is using Hive) restarts it. What happened, or why not.
pub fn run(r: &FixResult, run_dir: &Path) -> Result<String, String> {
    let branch = r.branch.clone().ok_or("no branch")?;
    let repo = paths::repo();
    // Bring main up to date first when it can simply move forward (it can't when it has commits
    // of its own or a dirty file is in the way; then the cherry-pick goes on top of what it has).
    let _ = git::git(&repo, &["fetch", "--quiet", "origin", "main"]);
    let _ = git::git(&repo, &["merge", "--ff-only", "--quiet", "origin/main"]);
    let before = git::rev(&repo, "HEAD")?;
    let landed = land::run(&land::Options {
        branch: branch.clone(),
        dry_run: false,
    })?;
    let app = repo.join("desktop/app");
    let built = proc::run(
        &["make".to_string()],
        &app,
        &[],
        None,
        &run_dir.join("build.log"),
        Duration::from_secs(BUILD_TIMEOUT_SECS),
    )?;
    if !built.ok {
        let undo = git::git(&repo, &["reset", "--keep", &before]);
        let path = paths::register(&paths::dream_dir());
        if let Ok(mut register) = Register::load(&path) {
            let _ = register.set(
                &r.signature,
                Status::Rejected,
                "landed, but Hive didn't build with it; taken back",
                time::now(),
            );
            let _ = register.save(&path);
        }
        return Err(match undo {
            Ok(_) => "landed, but `make` failed (build.log); taken back off main".into(),
            Err(e) => {
                format!("landed, but `make` failed (build.log), and taking it back failed: {e}")
            }
        });
    }
    let mut said = vec![landed];
    match git::git(&repo, &["push", "--quiet", "origin", "main"]) {
        Ok(_) => said.push("pushed".into()),
        Err(e) => said.push(format!(
            "not pushed ({}); the next push from ~/hive takes it",
            e.lines().next().unwrap_or("")
        )),
    }
    said.push(restart(&app, run_dir));
    Ok(said.join("; "))
}

/// Restarts Hive with the new build (tools/update-app.sh) unless it's mid-task or the user is
/// at the Mac.
fn restart(app: &Path, run_dir: &Path) -> String {
    if let Some(why) = schedule::postpone_now() {
        return format!(
            "Hive not restarted ({why}); the new build is in build/ for its next start"
        );
    }
    let script = app.join("tools/update-app.sh");
    match proc::run(
        &[script.to_string_lossy().into_owned()],
        app,
        &[("HIVE_ASK_WORK_SCREEN".into(), "0".into())],
        None,
        &run_dir.join("restart.log"),
        Duration::from_secs(RESTART_TIMEOUT_SECS),
    ) {
        Ok(ran) if ran.ok => "Hive restarted with it".into(),
        Ok(ran) => format!("Hive's restart failed (exit {:?}, restart.log)", ran.code),
        Err(e) => format!("Hive's restart failed: {e}"),
    }
}
