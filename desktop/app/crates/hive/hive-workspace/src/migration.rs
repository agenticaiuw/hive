//! Atomic bundle moves for the Agent.app to Hive.app migration (scripts/hive_bundle_migration.py).
//!
//! All paths are supplied by the updater. Backups are retained without an .app suffix.
//!
//!   hive-bundle-migration select APPLICATIONS
//!   hive-bundle-migration commit INSTALLED TARGET STAGED BACKUP
//!   hive-bundle-migration rollback INSTALLED TARGET STAGED BACKUP PRIOR

use crate::recovery::run_command;
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum Error {
    /// python's RuntimeError.
    Runtime(String),
    /// python's OSError.
    Os(std::io::Error),
}

impl Error {
    pub fn is_os(&self) -> bool {
        matches!(self, Error::Os(_))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Runtime(text) => f.write_str(text),
            Error::Os(error) => write!(f, "{error}"),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Error {
        Error::Os(error)
    }
}

type Result<T> = std::result::Result<T, Error>;

fn fail<T>(text: &str) -> Result<T> {
    Err(Error::Runtime(text.to_string()))
}

/// Asks the app at a bundle path about its login item (`status`, `register`, `unregister`).
pub type Control<'a> = &'a mut dyn FnMut(&Path, &str) -> std::result::Result<String, String>;
/// Renames without replacing anything at the destination.
pub type Mover<'a> = &'a dyn Fn(&Path, &Path) -> std::io::Result<()>;

fn present(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

fn is_dir(path: &Path) -> bool {
    path.is_dir()
}

fn is_symlink(path: &Path) -> bool {
    path.symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Atomically renames without replacing an unexpected destination (`renamex_np`, RENAME_EXCL).
#[cfg(target_os = "macos")]
pub fn rename_exclusive(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    extern "C" {
        fn renamex_np(
            from: *const libc::c_char,
            to: *const libc::c_char,
            flags: libc::c_uint,
        ) -> libc::c_int;
    }
    const RENAME_EXCL: libc::c_uint = 0x0000_0004;
    let invalid = |_| std::io::Error::from_raw_os_error(libc::EINVAL);
    let from = CString::new(source.as_os_str().as_bytes()).map_err(invalid)?;
    let to = CString::new(target.as_os_str().as_bytes()).map_err(invalid)?;
    // SAFETY: both are valid NUL-terminated strings for the duration of the call.
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), RENAME_EXCL) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn rename_exclusive(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Exclusive bundle migration requires macOS",
    ))
}

/// The installed bundle (Agent.app or Hive.app) in the applications folder, if any.
pub fn select_installed(applications: &Path) -> Result<Option<PathBuf>> {
    let legacy = applications.join("Agent.app");
    let hive = applications.join("Hive.app");
    for path in [&legacy, &hive] {
        if is_symlink(path) || (present(path) && !is_dir(path)) {
            return Err(Error::Runtime(format!(
                "Unexpected application path: {}",
                path.display()
            )));
        }
    }
    if present(&legacy) && present(&hive) {
        return fail("Both Agent.app and Hive.app exist; refusing to choose or overwrite either");
    }
    Ok(if present(&legacy) {
        Some(legacy)
    } else if present(&hive) {
        Some(hive)
    } else {
        None
    })
}

/// Asks the signed app at this exact bundle path; never infers a preference.
pub fn login_control(bundle: &Path, operation: &str) -> std::result::Result<String, String> {
    let binary = bundle.join("Contents/MacOS/Agent");
    let flag = format!("--login-{operation}");
    let (code, out, _) = run_command(&[&binary.to_string_lossy(), &flag], 15);
    if code != 0 {
        return Err(format!(
            "Command '['{}', '{flag}']' returned non-zero exit status {code}.",
            binary.display()
        ));
    }
    let value = out.trim();
    if !["enabled", "notRegistered", "notFound", "requiresApproval"].contains(&value) {
        return Err("Login item state is unavailable".into());
    }
    Ok(value.to_string())
}

fn ask(
    control: &mut dyn FnMut(&Path, &str) -> std::result::Result<String, String>,
    bundle: &Path,
    operation: &str,
) -> Result<String> {
    control(bundle, operation).map_err(Error::Runtime)
}

#[allow(clippy::too_many_arguments)]
fn restore_legacy(
    installed: &Path,
    target: &Path,
    staged: &Path,
    backup: &Path,
    prior: Option<&str>,
    registration_may_have_changed: bool,
    control: Control,
    mv: Mover,
) -> Result<()> {
    // Restore the old URL's effective registration before restoring its signed bundle.
    // If both exist, the target appeared concurrently; it is not our candidate.
    if present(target) && !present(staged) {
        if registration_may_have_changed {
            let state = ask(control, target, "status")?;
            if state == "enabled" {
                ask(control, target, "unregister")?;
            } else if state != "notRegistered" && state != "notFound" {
                return fail("New login state is uncertain");
            }
        }
        mv(target, staged)?;
    }
    if !present(installed) && present(staged) && registration_may_have_changed {
        mv(staged, installed)?;
    }
    if present(installed) {
        if registration_may_have_changed && prior == Some("enabled") {
            let state = ask(control, installed, "status")?;
            if state != "enabled"
                && ((state != "notRegistered" && state != "notFound")
                    || ask(control, installed, "register")? != "enabled")
            {
                return fail("Could not restore the previous login item");
            }
        }
        if present(staged) {
            return fail("Cannot safely retain the staged bundle");
        }
        mv(installed, staged)?;
    }
    if !present(backup) || present(installed) {
        return fail("Cannot safely restore the previous application");
    }
    mv(backup, installed)?;
    Ok(())
}

pub fn commit(
    installed: Option<&Path>,
    target: &Path,
    staged: &Path,
    backup: &Path,
    control: Control,
) -> Result<String> {
    commit_with(
        installed,
        target,
        staged,
        backup,
        control,
        &rename_exclusive,
    )
}

pub fn commit_with(
    installed: Option<&Path>,
    target: &Path,
    staged: &Path,
    backup: &Path,
    control: Control,
    mv: Mover,
) -> Result<String> {
    let mut distinct: Vec<&Path> = Vec::new();
    for path in installed.into_iter().chain([target, staged, backup]) {
        if !distinct.contains(&path) {
            distinct.push(path);
        }
    }
    let expected = if installed.map(|i| i != target).unwrap_or(false) {
        4
    } else {
        3
    };
    if distinct.len() != expected {
        return fail("Application paths overlap");
    }
    if is_symlink(staged) || !is_dir(staged) || present(backup) {
        return fail("Staged bundle or backup path is unsafe");
    }
    match installed {
        None => {
            if present(target) {
                return fail("Destination appeared during staging");
            }
        }
        Some(installed) => {
            if is_symlink(installed) || !is_dir(installed) {
                return fail("Installed bundle changed during staging");
            }
            if installed != target && present(target) {
                return fail("Destination appeared during staging");
            }
        }
    }
    let parent = backup.parent().unwrap_or(Path::new("."));
    if is_symlink(parent) || (present(parent) && !is_dir(parent)) {
        return fail("Backup directory is unsafe");
    }
    if !parent.is_dir() {
        use std::os::unix::fs::DirBuilderExt;
        if let Some(grand) = parent.parent() {
            std::fs::create_dir_all(grand)?;
        }
        std::fs::DirBuilder::new().mode(0o700).create(parent)?;
    }
    if let Some(installed) = installed {
        mv(installed, backup)?;
    }
    if installed.is_none() || installed == Some(target) {
        if let Err(error) = mv(staged, target) {
            if let Some(installed) = installed {
                if !present(installed) {
                    mv(backup, installed)?;
                }
            }
            return Err(error.into());
        }
        return Ok("unchanged".into());
    }
    let installed = installed.unwrap();
    let mut prior: Option<String> = None;
    let mut changed = false;
    let outcome = (|| -> Result<String> {
        // Run the verified candidate at the *old bundle URL* to query its effective SMAppService
        // state, without opening its UI or relying on preferences.
        mv(staged, installed)?;
        let state = ask(control, installed, "status")?;
        prior = Some(state.clone());
        if !["enabled", "notRegistered", "notFound"].contains(&state.as_str()) {
            return fail("Existing login item requires attention; no migration performed");
        }
        if state == "enabled" {
            changed = true; // even a failed call can have changed registration
            let after = ask(control, installed, "unregister")?;
            if after != "notRegistered" && after != "notFound" {
                return fail("Could not confirm old login item removal");
            }
        }
        mv(installed, staged)?;
        mv(staged, target)?;
        if state == "enabled" && ask(control, target, "register")? != "enabled" {
            return fail("Could not confirm Hive login item registration");
        }
        Ok(state)
    })();
    match outcome {
        Ok(state) => Ok(state),
        Err(error) => {
            restore_legacy(
                installed,
                target,
                staged,
                backup,
                prior.as_deref(),
                changed,
                control,
                mv,
            )?;
            Err(error)
        }
    }
}

pub fn rollback(
    installed: Option<&Path>,
    target: &Path,
    staged: &Path,
    backup: &Path,
    prior: &str,
    control: Control,
) -> Result<()> {
    rollback_with(
        installed,
        target,
        staged,
        backup,
        prior,
        control,
        &rename_exclusive,
    )
}

pub fn rollback_with(
    installed: Option<&Path>,
    target: &Path,
    staged: &Path,
    backup: &Path,
    prior: &str,
    control: Control,
    mv: Mover,
) -> Result<()> {
    if is_symlink(target) || !is_dir(target) || present(staged) {
        return fail("Cannot safely roll back the new application");
    }
    if let Some(installed) = installed {
        if is_symlink(backup) || !is_dir(backup) || (installed != target && present(installed)) {
            return fail("Cannot safely restore the prior application");
        }
        if installed != target {
            return restore_legacy(
                installed,
                target,
                staged,
                backup,
                Some(prior),
                prior == "enabled",
                control,
                mv,
            );
        }
    }
    mv(target, staged)?;
    if let Some(installed) = installed {
        if let Err(error) = mv(backup, installed) {
            if !present(target) {
                mv(staged, target)?;
            }
            return Err(error.into());
        }
    }
    Ok(())
}

/// The command line; returns the exit code.
pub fn main(args: &[String]) -> i32 {
    let usage = || {
        eprintln!("usage: hive-bundle-migration {{select,commit,rollback}} paths [paths ...]");
        eprintln!("hive-bundle-migration: error: Invalid arguments");
        2
    };
    let Some((operation, paths)) = args.split_first() else {
        return usage();
    };
    let optional = |text: &String| {
        if text.is_empty() {
            None
        } else {
            Some(PathBuf::from(text))
        }
    };
    let result: Result<String> = match (operation.as_str(), paths) {
        ("select", [apps]) => select_installed(Path::new(apps))
            .map(|found| found.map(|p| p.display().to_string()).unwrap_or_default()),
        ("commit", [installed, target, staged, backup]) => {
            let installed = optional(installed);
            commit(
                installed.as_deref(),
                Path::new(target),
                Path::new(staged),
                Path::new(backup),
                &mut login_control,
            )
        }
        ("rollback", [installed, target, staged, backup, prior]) => {
            let installed = optional(installed);
            rollback(
                installed.as_deref(),
                Path::new(target),
                Path::new(staged),
                Path::new(backup),
                prior,
                &mut login_control,
            )
            .map(|_| String::new())
        }
        _ => return usage(),
    };
    match result {
        Ok(text) => {
            if operation != "rollback" {
                println!("{text}");
            }
            0
        }
        Err(error) => {
            eprintln!(
                "{}: {error}",
                if error.is_os() {
                    "OSError"
                } else {
                    "RuntimeError"
                }
            );
            1
        }
    }
}
