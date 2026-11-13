//! The dream done by Hive's own agent: the two prompts it gets, what hive-ask's exit status means
//! for a step, and how step 1's test failed.

use hive_dream::evidence::Cluster;
use hive_dream::fix::{fix_prompt, hive_ask_outcome, red_kind, test_prompt, Setup};
use std::path::Path;

fn cluster() -> Cluster {
    Cluster {
        signature: "wait_for_control: the agent waited for the user to hand back the screen".into(),
        slug: "wait-for-control".into(),
        category: "wait_for_control".into(),
        fixable: true,
        count: 4,
        minutes: 12.0,
        first_seen: "2026-11-12T09:00:00".into(),
        last_seen: "2026-11-12T10:00:00".into(),
        first_t: 0.0,
        last_t: 0.0,
        refs: vec!["journal 2026-11-12/session.jsonl:14".into()],
        examples: vec!["wait_for_control: still waiting for Ada Example".into()],
        occurrences: Vec::new(),
        status: "open".into(),
    }
}

fn setup<'a>(worktree: &'a Path, dream: &'a Path) -> Setup<'a> {
    Setup {
        agent: "hive",
        worktree,
        branch: "dream/2026-11-13-wait-for-control",
        dream,
    }
}

#[test]
fn step_one_asks_hive_for_a_failing_test_only_in_the_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let worktree = dir.path().join("work tree");
    let dream = dir.path().join("dream");
    let p = test_prompt(
        &cluster(),
        &setup(&worktree, &dream),
        &["Ada Example".into()],
    );
    assert!(p.contains("nightly dream"), "{p}");
    assert!(p.contains("Step 1 of 2"));
    assert!(p.contains(&format!("cd '{}'", worktree.display())));
    assert!(p.contains("Never edit ~/hive itself"));
    assert!(p.contains(&format!(
        "CARGO_TARGET_DIR='{}'",
        dream.join("target").display()
    )));
    assert!(p.contains("Change no code outside tests"));
    assert!(p.contains("no screen"));
    assert!(p.contains("journal 2026-11-12/session.jsonl:14"));
    // Private terms are taken out before anything goes to the agent.
    assert!(!p.contains("Ada Example"));
}

#[test]
fn step_two_shows_how_the_test_failed_and_asks_for_the_fix() {
    let dir = tempfile::tempdir().unwrap();
    let s = setup(dir.path(), dir.path());
    let p = fix_prompt(
        &cluster(),
        &s,
        &[],
        &["desktop/app/crates/hive/hive-mac/src/tools.rs".into()],
        "test result: FAILED. 0 passed; 1 failed",
    );
    assert!(p.contains("Step 2 of 2"));
    assert!(p.contains("hive-mac/src/tools.rs"));
    assert!(p.contains("test result: FAILED"));
    assert!(p.contains("Keep the test as it is"));
}

#[test]
fn hive_ask_exit_status_decides_whether_the_step_counts() {
    assert_eq!(hive_ask_outcome(Some(0), false), Ok(true));
    // It ended without finishing (failed, or needs the user): the gate still judges what it did.
    assert_eq!(hive_ask_outcome(Some(1), false), Ok(false));
    assert_eq!(hive_ask_outcome(Some(3), false), Ok(false));
    // Stopped, still going, not taken: nothing to use.
    assert!(hive_ask_outcome(Some(2), false)
        .unwrap_err()
        .contains("stopped"));
    assert!(hive_ask_outcome(Some(4), false)
        .unwrap_err()
        .contains("still working"));
    assert!(hive_ask_outcome(Some(5), false)
        .unwrap_err()
        .contains("didn't take"));
    assert!(hive_ask_outcome(None, true).is_err());
}

#[test]
fn a_red_test_failed_on_an_assertion_or_on_the_build() {
    assert_eq!(
        red_kind("thread 'x' panicked at src/a.rs:3:5\ntest result: FAILED. 3 passed; 1 failed"),
        "assertion"
    );
    assert_eq!(
        red_kind("error[E0425]: cannot find function `fresh` in this scope\nerror: could not compile `hive-mac`"),
        "compile"
    );
    assert_eq!(red_kind("Killed: 9"), "");
}
