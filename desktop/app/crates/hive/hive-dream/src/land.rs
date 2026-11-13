//! `hive-dream land <branch>`: cherry-picks a dream branch's commits onto main in the shared
//! repo, when a person runs it (a fix the macOS check held, or one from a run with the check off).
//! It refuses when main isn't checked out, when anything is staged, or
//! when a file the commits touch has uncommitted changes there. It never pushes itself.

use crate::register::{Register, Status};
use crate::{git, paths, time};

pub struct Options {
    pub branch: String,
    pub dry_run: bool,
}

/// Files both changed by the branch and dirty in the shared tree.
pub fn conflicts(branch_files: &[String], dirty: &[String]) -> Vec<String> {
    branch_files
        .iter()
        .filter(|f| {
            dirty
                .iter()
                .any(|d| d == *f || (d.ends_with('/') && f.starts_with(d.as_str())))
        })
        .cloned()
        .collect()
}

pub fn run(opts: &Options) -> Result<String, String> {
    let repo = paths::repo();
    let branch = if opts.branch.starts_with("dream/") {
        opts.branch.clone()
    } else {
        format!("dream/{}", opts.branch)
    };
    if !git::branch_exists(&repo, &branch) {
        return Err(format!("no branch {branch} in {}", repo.display()));
    }
    let current = git::git(&repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if current != "main" {
        return Err(format!(
            "{} has {current:?} checked out, not main; refusing",
            repo.display()
        ));
    }
    // The branch's commits main doesn't have yet (one already cherry-picked counts as had).
    let commits: Vec<String> = git::git(
        &repo,
        &[
            "rev-list",
            "--reverse",
            "--right-only",
            "--cherry-pick",
            "--no-merges",
            &format!("main...{branch}"),
        ],
    )?
    .lines()
    .map(str::to_string)
    .collect();
    if commits.is_empty() {
        return Err(format!("{branch} has nothing that main doesn't"));
    }
    let files: Vec<String> = git::git(
        &repo,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            &format!("main...{branch}"),
        ],
    )?
    .lines()
    .map(str::to_string)
    .collect();
    if !git::ok(&repo, &["diff", "--cached", "--quiet"]) {
        return Err(
            "something is staged in the shared tree; refusing (a cherry-pick would mix it in)"
                .into(),
        );
    }
    let dirty = git::dirty(&repo)?;
    let clash = conflicts(&files, &dirty);
    if !clash.is_empty() {
        return Err(format!(
            "these files have uncommitted changes in the shared tree; refusing: {}",
            clash.join(", ")
        ));
    }
    if opts.dry_run {
        return Ok(format!(
            "would cherry-pick {} commit(s) from {branch} onto main: {}",
            commits.len(),
            files.join(", ")
        ));
    }
    let before = git::rev(&repo, "HEAD")?;
    let mut args: Vec<&str> = vec!["cherry-pick", "-x"];
    args.extend(commits.iter().map(String::as_str));
    if let Err(e) = git::git(&repo, &args) {
        let _ = git::git(&repo, &["cherry-pick", "--abort"]);
        return Err(format!("cherry-pick failed and was aborted: {e}"));
    }
    let landed: Vec<String> = git::git(
        &repo,
        &["rev-list", "--reverse", &format!("{before}..HEAD")],
    )?
    .lines()
    .map(str::to_string)
    .collect();

    let dream = paths::dream_dir();
    let register_path = paths::register(&dream);
    let mut register = Register::load(&register_path)?;
    let key = branch.trim_start_matches("dream/");
    if let Some(sig) = register.find(&branch).or_else(|| register.find(key)) {
        let now = time::now();
        register.set(&sig, Status::Landed, &format!("landed from {branch}"), now)?;
        if let Some(e) = register.entries.get_mut(&sig) {
            e.landed_commits = landed.clone();
        }
        register.save(&register_path)?;
    }
    Ok(format!(
        "landed {} commit(s) from {branch} on main: {} (not pushed; push with git -C {} push origin main)",
        landed.len(),
        landed.iter().map(|c| &c[..c.len().min(9)]).collect::<Vec<_>>().join(" "),
        repo.display()
    ))
}
