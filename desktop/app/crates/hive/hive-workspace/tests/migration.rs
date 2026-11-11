//! Bundle and login migration tests using only temporary fixtures.

use hive_workspace::migration::*;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Default)]
struct Login {
    path: Option<PathBuf>,
    special: Option<&'static str>,
    fail_register_target: bool,
    /// The call takes effect and then reports an error, as an ambiguous failure would.
    error_after_unregister: bool,
    error_after_register: bool,
    calls: Vec<(String, String)>,
}

impl Login {
    fn at(path: &Path) -> Login {
        Login {
            path: Some(path.to_path_buf()),
            ..Login::default()
        }
    }

    fn call(&mut self, bundle: &Path, operation: &str) -> Result<String, String> {
        let name = bundle.file_name().unwrap().to_string_lossy().into_owned();
        self.calls.push((name.clone(), operation.to_string()));
        match operation {
            "status" => Ok(self.special.map(str::to_string).unwrap_or_else(|| {
                if self.path.as_deref() == Some(bundle) {
                    "enabled"
                } else {
                    "notRegistered"
                }
                .into()
            })),
            "unregister" => {
                self.path = None;
                if self.error_after_unregister && name == "Agent.app" {
                    return Err("ambiguous unregister".into());
                }
                Ok("notRegistered".into())
            }
            "register" => {
                if self.fail_register_target && name == "Hive.app" {
                    return Err("registration failed".into());
                }
                self.path = Some(bundle.to_path_buf());
                if self.error_after_register && name == "Hive.app" {
                    return Err("ambiguous register".into());
                }
                Ok("enabled".into())
            }
            other => panic!("{other}"),
        }
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    apps: PathBuf,
    old: PathBuf,
    target: PathBuf,
    stage: PathBuf,
    backup: PathBuf,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let apps = root.join("Applications");
    std::fs::create_dir(&apps).unwrap();
    let (old, target, stage) = (
        apps.join("Agent.app"),
        apps.join("Hive.app"),
        apps.join(".Hive-stage"),
    );
    let backup = root.join("state/app-backups/previous");
    std::fs::create_dir(&old).unwrap();
    std::fs::write(old.join("old"), "preserve").unwrap();
    std::fs::create_dir(&stage).unwrap();
    std::fs::write(stage.join("new"), "candidate").unwrap();
    Fixture {
        _temp: temp,
        root,
        apps,
        old,
        target,
        stage,
        backup,
    }
}

impl Fixture {
    fn commit(&self, login: &mut Login) -> Result<String, Error> {
        commit(
            Some(&self.old),
            &self.target,
            &self.stage,
            &self.backup,
            &mut |b, o| login.call(b, o),
        )
    }
}

fn calls(login: &Login) -> Vec<(&str, &str)> {
    login
        .calls
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect()
}

#[test]
fn enabled_login_migrates_at_verified_bundle_paths() {
    let f = fixture();
    let mut login = Login::at(&f.old);
    assert_eq!(f.commit(&mut login).unwrap(), "enabled");
    assert_eq!(login.path.as_deref(), Some(f.target.as_path()));
    assert_eq!(
        calls(&login),
        [
            ("Agent.app", "status"),
            ("Agent.app", "unregister"),
            ("Hive.app", "register")
        ]
    );
    assert!(!f.old.exists());
    assert!(f.target.join("new").exists());
    assert!(f.backup.join("old").exists());
    assert_ne!(f.backup.extension().and_then(|e| e.to_str()), Some("app"));
    assert!(!f.backup.ancestors().any(|p| p == f.apps));
}

#[test]
fn disabled_login_is_not_enabled() {
    let f = fixture();
    let mut login = Login::default();
    assert_eq!(f.commit(&mut login).unwrap(), "notRegistered");
    assert!(login.path.is_none());
    assert_eq!(calls(&login), [("Agent.app", "status")]);
}

#[test]
fn failed_registration_restores_old_bundle_and_login() {
    let f = fixture();
    let mut login = Login {
        fail_register_target: true,
        ..Login::at(&f.old)
    };
    assert!(f.commit(&mut login).is_err());
    assert!(f.old.join("old").exists());
    assert!(f.stage.join("new").exists());
    assert!(!f.target.exists());
    assert_eq!(login.path.as_deref(), Some(f.old.as_path()));
}

#[test]
fn launch_failure_rolls_back_enabled_login() {
    let f = fixture();
    let mut login = Login::at(&f.old);
    let prior = f.commit(&mut login).unwrap();
    rollback(
        Some(&f.old),
        &f.target,
        &f.stage,
        &f.backup,
        &prior,
        &mut |b, o| login.call(b, o),
    )
    .unwrap();
    assert!(f.old.join("old").exists());
    assert!(f.stage.join("new").exists());
    assert!(!f.target.exists());
    assert_eq!(login.path.as_deref(), Some(f.old.as_path()));
}

#[test]
fn unregister_error_after_effect_restores_old_login() {
    let f = fixture();
    let mut login = Login {
        error_after_unregister: true,
        ..Login::at(&f.old)
    };
    assert!(f.commit(&mut login).is_err());
    assert_eq!(login.path.as_deref(), Some(f.old.as_path()));
    assert!(f.old.join("old").exists());
    assert!(f.stage.join("new").exists());
    assert!(!f.target.exists());
}

#[test]
fn register_error_after_effect_restores_old_login() {
    let f = fixture();
    let mut login = Login {
        error_after_register: true,
        ..Login::at(&f.old)
    };
    assert!(f.commit(&mut login).is_err());
    assert_eq!(login.path.as_deref(), Some(f.old.as_path()));
    assert!(f.old.join("old").exists());
    assert!(f.stage.join("new").exists());
    assert!(!f.target.exists());
}

#[test]
fn concurrent_target_appearance_is_not_overwritten() {
    let f = fixture();
    let mut login = Login::at(&f.old);
    let (stage, target) = (f.stage.clone(), f.target.clone());
    let mover = move |source: &Path, to: &Path| {
        if source == stage && to == target {
            std::fs::create_dir(&target).unwrap();
            std::fs::write(target.join("other"), "preserve").unwrap();
        }
        rename_exclusive(source, to)
    };
    let error = commit_with(
        Some(&f.old),
        &f.target,
        &f.stage,
        &f.backup,
        &mut |b, o| login.call(b, o),
        &mover,
    )
    .unwrap_err();
    assert!(error.is_os());
    assert_eq!(
        std::fs::read_to_string(f.target.join("other")).unwrap(),
        "preserve"
    );
    assert!(f.old.join("old").exists());
    assert!(f.stage.join("new").exists());
    assert_eq!(login.path.as_deref(), Some(f.old.as_path()));
}

#[test]
fn symlinked_backup_directory_is_refused() {
    let f = fixture();
    let other = f.root.join("other");
    std::fs::create_dir(&other).unwrap();
    std::fs::create_dir(f.backup.parent().unwrap().parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&other, f.backup.parent().unwrap()).unwrap();
    assert!(f.commit(&mut Login::default()).is_err());
    assert!(f.old.join("old").exists());
    assert!(f.stage.exists());
}

#[test]
fn unknown_login_status_refuses_migration() {
    let f = fixture();
    let mut login = Login {
        special: Some("requiresApproval"),
        ..Login::default()
    };
    assert!(f.commit(&mut login).is_err());
    assert!(f.old.join("old").exists());
    assert!(!f.target.exists());
    assert!(f.stage.exists());
}

#[test]
fn duplicate_and_symlink_are_never_overwritten() {
    let f = fixture();
    std::fs::create_dir(&f.target).unwrap();
    std::fs::write(f.target.join("user"), "keep").unwrap();
    assert!(select_installed(&f.apps).is_err());
    assert!(f.commit(&mut Login::default()).is_err());
    assert_eq!(
        std::fs::read_to_string(f.target.join("user")).unwrap(),
        "keep"
    );
    assert!(f.old.join("old").exists());
}

#[test]
fn select_picks_the_one_installed_bundle() {
    let f = fixture();
    assert_eq!(select_installed(&f.apps).unwrap(), Some(f.old.clone()));
    std::fs::rename(&f.old, &f.target).unwrap();
    assert_eq!(select_installed(&f.apps).unwrap(), Some(f.target.clone()));
    std::fs::remove_dir_all(&f.target).unwrap();
    assert_eq!(select_installed(&f.apps).unwrap(), None);
    let elsewhere = f.root.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, f.apps.join("Agent.app")).unwrap();
    assert!(select_installed(&f.apps).is_err());
}

#[test]
fn exclusive_rename_rejects_existing_destination() {
    let f = fixture();
    std::fs::create_dir(&f.target).unwrap();
    std::fs::write(f.target.join("user"), "keep").unwrap();
    assert!(rename_exclusive(&f.stage, &f.target).is_err());
    assert_eq!(
        std::fs::read_to_string(f.target.join("user")).unwrap(),
        "keep"
    );
    assert!(f.stage.exists());
}

#[test]
fn overlapping_paths_are_refused() {
    let f = fixture();
    let error = commit(Some(&f.old), &f.old, &f.stage, &f.stage, &mut |_, _| {
        panic!("no login call")
    })
    .unwrap_err();
    assert_eq!(error.to_string(), "Application paths overlap");
}

#[test]
fn existing_hive_update_does_not_toggle_login() {
    let f = fixture();
    std::fs::rename(&f.old, &f.target).unwrap();
    let mut login = Login::at(&f.target);
    let prior = commit(
        Some(&f.target),
        &f.target,
        &f.stage,
        &f.backup,
        &mut |b, o| login.call(b, o),
    )
    .unwrap();
    assert_eq!(prior, "unchanged");
    assert!(login.calls.is_empty());
    rollback(
        Some(&f.target),
        &f.target,
        &f.stage,
        &f.backup,
        &prior,
        &mut |b, o| login.call(b, o),
    )
    .unwrap();
    assert!(f.target.join("old").exists());
    assert!(login.calls.is_empty());
}

#[test]
fn first_install_without_a_previous_app_commits_and_rolls_back() {
    let f = fixture();
    std::fs::remove_dir_all(&f.old).unwrap();
    let mut never = |_: &Path, _: &str| -> Result<String, String> { panic!("no login call") };
    assert_eq!(
        commit(None, &f.target, &f.stage, &f.backup, &mut never).unwrap(),
        "unchanged"
    );
    assert!(f.target.join("new").exists());
    rollback(
        None,
        &f.target,
        &f.stage,
        &f.backup,
        "unchanged",
        &mut never,
    )
    .unwrap();
    assert!(f.stage.join("new").exists());
    assert!(!f.target.exists());
}

// ---- the command line

fn cli(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_hive-bundle-migration"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn command_select_prints_the_installed_path_or_nothing() {
    let f = fixture();
    let output = cli(&["select", f.apps.to_str().unwrap()]);
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{}\n", f.old.display())
    );
    std::fs::remove_dir_all(&f.old).unwrap();
    let output = cli(&["select", f.apps.to_str().unwrap()]);
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "\n");
}

#[test]
fn command_arguments_are_validated() {
    assert_eq!(cli(&[]).status.code(), Some(2));
    assert_eq!(cli(&["select"]).status.code(), Some(2));
    assert_eq!(cli(&["commit", "a", "b", "c"]).status.code(), Some(2));
    assert_eq!(
        cli(&["rollback", "a", "b", "c", "d"]).status.code(),
        Some(2)
    );
    assert_eq!(cli(&["explode", "a"]).status.code(), Some(2));
}

#[test]
fn command_commit_with_no_installed_app_prints_unchanged() {
    let f = fixture();
    std::fs::remove_dir_all(&f.old).unwrap();
    let output = cli(&[
        "commit",
        "",
        f.target.to_str().unwrap(),
        f.stage.to_str().unwrap(),
        f.backup.to_str().unwrap(),
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "unchanged\n");
    assert!(f.target.join("new").exists());
    let again = cli(&[
        "commit",
        "",
        f.target.to_str().unwrap(),
        f.stage.to_str().unwrap(),
        f.backup.to_str().unwrap(),
    ]);
    assert_eq!(again.status.code(), Some(1));
}
