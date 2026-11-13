//! `hive-dream land` on a throwaway repo: refuses when a file the branch touches is dirty in the
//! shared tree or main isn't checked out, otherwise cherry-picks onto main without pushing and
//! marks the register landed. One test in this file: it sets HIVE_DREAM_REPO and HIVE_DREAM_DIR.

use std::path::Path;
use std::process::Command;

use hive_dream::evidence::{cluster, Occurrence, Source};
use hive_dream::land::{self, conflicts};
use hive_dream::register::{Register, Status};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn land_refuses_dirty_files_and_cherry_picks_without_pushing() {
    assert_eq!(
        conflicts(
            &["a.rs".into(), "b.rs".into()],
            &["b.rs".into(), "c.rs".into()]
        ),
        vec!["b.rs".to_string()]
    );

    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let dream = tmp.path().join("dream");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "--quiet", "-b", "main"]);
    git(&repo, &["config", "user.name", "Test"]);
    git(&repo, &["config", "user.email", "test@example.test"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    std::fs::write(repo.join("b.txt"), "two\n").unwrap();
    git(&repo, &["add", "--", "a.txt", "b.txt"]);
    git(&repo, &["commit", "--quiet", "-m", "start"]);
    let branch = "dream/2030-01-15-tool-error-x-abcdef";
    git(&repo, &["checkout", "--quiet", "-b", branch]);
    std::fs::write(repo.join("a.txt"), "one, fixed\n").unwrap();
    git(&repo, &["commit", "--quiet", "-am", "Dream fix: x"]);
    git(&repo, &["checkout", "--quiet", "main"]);

    // The register knows the branch.
    let mut reg = Register::default();
    let clusters = cluster(&[Occurrence::new(
        "tool_error",
        "x",
        1.0,
        Source::Journal,
        "journal s:1".into(),
    )]);
    reg.apply(&clusters, 2.0);
    reg.entries.get_mut("tool_error: x").unwrap().branch = Some(branch.into());
    reg.set("tool_error: x", Status::Proposed, "the gate passed", 3.0)
        .unwrap();
    reg.save(&dream.join("register.json")).unwrap();

    std::env::set_var("HIVE_DREAM_REPO", &repo);
    std::env::set_var("HIVE_DREAM_DIR", &dream);
    let opts = |dry_run| land::Options {
        branch: branch.into(),
        dry_run,
    };

    // A file the branch touches has uncommitted changes: refuse, change nothing.
    std::fs::write(repo.join("a.txt"), "someone else's work\n").unwrap();
    let err = land::run(&opts(false)).unwrap_err();
    assert!(err.contains("a.txt"), "{err}");
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).unwrap(),
        "someone else's work\n"
    );
    git(&repo, &["checkout", "--quiet", "--", "a.txt"]);

    // Not on main: refuse.
    git(&repo, &["checkout", "--quiet", "-b", "elsewhere"]);
    assert!(land::run(&opts(false)).unwrap_err().contains("not main"));
    git(&repo, &["checkout", "--quiet", "main"]);

    // An unrelated dirty file is fine and stays as it was.
    std::fs::write(repo.join("b.txt"), "two, edited by hand\n").unwrap();
    assert!(land::run(&opts(true))
        .unwrap()
        .starts_with("would cherry-pick 1 commit"));
    let said = land::run(&opts(false)).unwrap();
    assert!(said.contains("not pushed"), "{said}");
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).unwrap(),
        "one, fixed\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("b.txt")).unwrap(),
        "two, edited by hand\n"
    );
    assert!(git(&repo, &["log", "-1", "--format=%B"]).contains("cherry picked from commit"));
    assert_eq!(git(&repo, &["remote"]), "");

    let reg = Register::load(&dream.join("register.json")).unwrap();
    let e = &reg.entries["tool_error: x"];
    assert_eq!(e.status, Status::Landed);
    assert_eq!(e.landed_commits.len(), 1);

    // Nothing left to land.
    assert!(land::run(&opts(false)).unwrap_err().contains("nothing"));
}
