//! The few git commands hive-dream needs. Nothing here pushes, merges or deletes.

use std::path::Path;
use std::process::Command;

use crate::gate::FileChange;

/// Runs git in `dir` and returns its stdout, or its stderr as the error.
pub fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

pub fn ok(dir: &Path, args: &[&str]) -> bool {
    git(dir, args).is_ok()
}

pub fn rev(dir: &Path, name: &str) -> Result<String, String> {
    Ok(git(
        dir,
        &["rev-parse", "--verify", &format!("{name}^{{commit}}")],
    )?
    .trim()
    .to_string())
}

pub fn branch_exists(dir: &Path, branch: &str) -> bool {
    ok(
        dir,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
}

/// Paths that differ between two commits (renames as delete + add).
pub fn changed_files(dir: &Path, base: &str, head: &str) -> Result<Vec<(char, String)>, String> {
    let out = git(
        dir,
        &["diff", "--name-status", "--no-renames", "-z", base, head],
    )?;
    let parts: Vec<&str> = out.split('\0').filter(|s| !s.is_empty()).collect();
    Ok(parts
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| (c[0].chars().next().unwrap_or('M'), c[1].to_string()))
        .collect())
}

fn show(dir: &Path, commit: &str, path: &str) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["show", &format!("{commit}:{path}")])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Every changed file with its old and new text and changed lines.
pub fn changes(dir: &Path, base: &str, head: &str) -> Result<Vec<FileChange>, String> {
    Ok(changed_files(dir, base, head)?
        .into_iter()
        .map(|(status, path)| {
            let old = if status == 'A' {
                None
            } else {
                show(dir, base, &path)
            };
            let new = if status == 'D' {
                None
            } else {
                show(dir, head, &path)
            };
            FileChange::from_texts(&path, old.as_deref(), new.as_deref())
        })
        .collect())
}

/// Paths with uncommitted changes in a working tree: modified, staged, untracked (`git status
/// --porcelain -z`; for renames both names).
pub fn dirty(dir: &Path) -> Result<Vec<String>, String> {
    let out = git(
        dir,
        &["status", "--porcelain", "-z", "--untracked-files=all"],
    )?;
    let mut files = Vec::new();
    let mut parts = out.split('\0').filter(|s| !s.is_empty());
    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            continue;
        }
        let code = &entry[..2];
        files.push(entry[3..].to_string());
        if code.starts_with('R') || code.starts_with('C') {
            if let Some(from) = parts.next() {
                files.push(from.to_string());
            }
        }
    }
    Ok(files)
}
