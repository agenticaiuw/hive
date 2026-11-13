//! The gate's static rules on synthetic diffs: a fix needs a test and a code change, may not
//! touch guarded files or items, may not be prompt or text only, may not carry a private term.

use hive_dream::gate::{check_static, glob_match, line_diff, FileChange};
use hive_dream::rustscan;

const TOOLS: &str = "desktop/app/crates/hive/hive-mac/src/example.rs";

const BEFORE: &str = r#"//! An example module.

pub const LIMIT: u64 = 30;

/// How long to wait.
pub fn wait_secs(asked: u64) -> u64 {
    asked.min(LIMIT)
}

pub fn describe() -> &'static str {
    "waits for the screen"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_the_wait() {
        assert_eq!(wait_secs(99), LIMIT);
    }
}
"#;

fn change(path: &str, old: &str, new: &str) -> FileChange {
    FileChange::from_texts(path, Some(old), Some(new))
}

fn fixed_code() -> String {
    BEFORE.replace(
        "    asked.min(LIMIT)",
        "    if asked == 0 {\n        return 1;\n    }\n    asked.min(LIMIT)",
    )
}

fn with_new_test(text: &str) -> String {
    text.replace(
        "        assert_eq!(wait_secs(99), LIMIT);\n    }\n",
        "        assert_eq!(wait_secs(99), LIMIT);\n    }\n\n    #[test]\n    fn never_waits_zero() {\n        assert_eq!(wait_secs(0), 1);\n    }\n",
    )
}

fn terms() -> Vec<String> {
    vec!["Zorblat".into()]
}

#[test]
fn a_test_and_a_code_change_pass() {
    let new = with_new_test(&fixed_code());
    let r = check_static(
        &[change(TOOLS, BEFORE, &new)],
        "Dream fix: waits",
        Some(&terms()),
    );
    assert!(r.reasons.is_empty(), "{:?}", r.reasons);
    assert!(r.test_lines >= 3);
    assert!(r.code_lines >= 3);
}

#[test]
fn a_fix_without_a_test_is_rejected() {
    let r = check_static(&[change(TOOLS, BEFORE, &fixed_code())], "m", Some(&terms()));
    assert!(
        r.reasons.iter().any(|x| x.starts_with("no test added")),
        "{:?}",
        r.reasons
    );
}

#[test]
fn a_test_without_a_code_change_is_rejected() {
    let r = check_static(
        &[change(TOOLS, BEFORE, &with_new_test(BEFORE))],
        "m",
        Some(&terms()),
    );
    assert!(
        r.reasons.iter().any(|x| x.starts_with("no code change")),
        "{:?}",
        r.reasons
    );
}

#[test]
fn a_prompt_only_change_is_rejected() {
    let prompts = "desktop/app/crates/hive/hive-codex/src/prompts.rs";
    let old = "pub const SYSTEM: &str = \"Be careful.\";\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn it() {}\n}\n";
    let new = "pub const SYSTEM: &str = \"Be careful. Never click your own window.\";\npub const MORE: &str = \"Wait for the screen.\";\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn it() {}\n    #[test]\n    fn mentions_the_window() {\n        assert!(super::SYSTEM.contains(\"window\"));\n    }\n}\n";
    let r = check_static(&[change(prompts, old, new)], "m", Some(&terms()));
    assert!(
        r.reasons.iter().any(|x| x.starts_with("no code change")),
        "{:?}",
        r.reasons
    );
}

#[test]
fn changing_only_a_string_or_a_comment_is_not_code() {
    let new = with_new_test(
        &BEFORE
            .replace(
                "\"waits for the screen\"",
                "\"waits for the screen to come back\"",
            )
            .replace("/// How long to wait.", "/// How long to wait, at most."),
    );
    let r = check_static(&[change(TOOLS, BEFORE, &new)], "m", Some(&terms()));
    assert!(
        r.reasons.iter().any(|x| x.starts_with("no code change")),
        "{:?}",
        r.reasons
    );
}

#[test]
fn guarded_files_are_rejected() {
    for path in [
        "desktop/app/crates/hive/hive-mac/src/credentials.rs",
        "desktop/app/crates/hive/hive-app/src/auth_mcp.rs",
        "desktop/app/crates/hive/hive-common/src/settings.rs",
        "desktop/app/crates/hive/hive-dream/src/gate.rs",
        "desktop/app/src/helper.cpp",
        "desktop/app/install.sh",
        "desktop/app/launchd/local.example.plist",
    ] {
        let new = with_new_test(&fixed_code());
        let r = check_static(&[change(path, BEFORE, &new)], "m", Some(&terms()));
        assert!(
            r.reasons
                .iter()
                .any(|x| x.contains("is guarded") || x.contains("outside desktop/app/crates")),
            "{path}: {:?}",
            r.reasons
        );
    }
}

#[test]
fn files_outside_the_crates_and_manifests_are_rejected() {
    let new = with_new_test(&fixed_code());
    let r = check_static(
        &[
            change(TOOLS, BEFORE, &new),
            change("desktop/app/python/example.py", "x = 1\n", "x = 2\n"),
            change(
                "desktop/app/crates/hive/hive-mac/Cargo.toml",
                "[package]\n",
                "[package]\n# x\n",
            ),
        ],
        "m",
        Some(&terms()),
    );
    assert!(
        r.reasons
            .iter()
            .any(|x| x.contains("outside desktop/app/crates")),
        "{:?}",
        r.reasons
    );
    assert!(
        r.reasons
            .iter()
            .any(|x| x.contains("crates or dependencies")),
        "{:?}",
        r.reasons
    );
}

#[test]
fn guarded_items_are_rejected_even_in_an_allowed_file() {
    let old = "pub fn check_step(step: &str) -> bool {\n    !step.is_empty()\n}\n\npub fn other() -> u8 {\n    1\n}\n";
    let new = "pub fn check_step(step: &str) -> bool {\n    true\n}\n\npub fn other() -> u8 {\n    1\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {\n        assert!(super::check_step(\"\"));\n    }\n}\n";
    let r = check_static(
        &[change(
            "desktop/app/crates/hive/hive-codex/src/mcp.rs",
            old,
            new,
        )],
        "m",
        Some(&terms()),
    );
    assert!(
        r.reasons.iter().any(|x| x.contains("changes check_step")),
        "{:?}",
        r.reasons
    );
}

#[test]
fn a_guarded_word_in_a_changed_line_is_rejected() {
    let new = with_new_test(&BEFORE.replace(
        "    asked.min(LIMIT)",
        "    let password_ok = asked > 0;\n    if password_ok { asked.min(LIMIT) } else { 1 }",
    ));
    let r = check_static(&[change(TOOLS, BEFORE, &new)], "m", Some(&terms()));
    assert!(
        r.reasons.iter().any(|x| x.contains("mentions password")),
        "{:?}",
        r.reasons
    );
}

#[test]
fn removing_or_ignoring_a_test_is_rejected() {
    let removed = fixed_code().replace(
        "    #[test]\n    fn caps_the_wait() {\n        assert_eq!(wait_secs(99), LIMIT);\n    }\n",
        "",
    );
    let r = check_static(&[change(TOOLS, BEFORE, &removed)], "m", Some(&terms()));
    assert!(
        r.reasons.iter().any(|x| x.starts_with("removes 1 test")),
        "{:?}",
        r.reasons
    );

    let ignored = with_new_test(&fixed_code()).replace(
        "    #[test]\n    fn caps_the_wait",
        "    #[test]\n    #[ignore]\n    fn caps_the_wait",
    );
    let r = check_static(&[change(TOOLS, BEFORE, &ignored)], "m", Some(&terms()));
    assert!(
        r.reasons.iter().any(|x| x.contains("#[ignore]")),
        "{:?}",
        r.reasons
    );
}

#[test]
fn a_private_term_in_the_diff_or_message_is_rejected() {
    let new =
        with_new_test(&fixed_code()).replace("fn never_waits_zero", "fn zorblat_never_waits_zero");
    let r = check_static(&[change(TOOLS, BEFORE, &new)], "m", Some(&terms()));
    assert!(
        r.reasons.iter().any(|x| x.contains("private term")),
        "{:?}",
        r.reasons
    );
    // Not a whole word: fine.
    let ok = with_new_test(&fixed_code())
        .replace("fn never_waits_zero", "fn zorblatty_never_waits_zero");
    let r = check_static(&[change(TOOLS, BEFORE, &ok)], "m", Some(&terms()));
    assert!(r.reasons.is_empty(), "{:?}", r.reasons);

    let r = check_static(
        &[change(TOOLS, BEFORE, &with_new_test(&fixed_code()))],
        "Fix for Zorblat",
        Some(&terms()),
    );
    assert!(
        r.reasons.iter().any(|x| x.contains("commit message")),
        "{:?}",
        r.reasons
    );
}

#[test]
fn a_missing_private_terms_file_is_a_warning() {
    let r = check_static(
        &[change(TOOLS, BEFORE, &with_new_test(&fixed_code()))],
        "m",
        None,
    );
    assert!(r.reasons.is_empty(), "{:?}", r.reasons);
    assert!(r.warnings.iter().any(|w| w.contains("private-terms")));
}

#[test]
fn an_empty_diff_is_rejected() {
    let r = check_static(&[], "m", Some(&terms()));
    assert_eq!(r.reasons, vec!["Codex changed nothing"]);
}

#[test]
fn a_new_test_file_counts_as_a_test() {
    let test = FileChange::from_texts(
        "desktop/app/crates/hive/hive-mac/tests/waits.rs",
        None,
        Some("#[test]\nfn waits() {\n    assert_eq!(hive_mac::example::wait_secs(0), 1);\n}\n"),
    );
    let r = check_static(
        &[change(TOOLS, BEFORE, &fixed_code()), test],
        "m",
        Some(&terms()),
    );
    assert!(r.reasons.is_empty(), "{:?}", r.reasons);
}

#[test]
fn globs() {
    assert!(glob_match("**/credentials.rs", "a/b/credentials.rs"));
    assert!(glob_match("**/credentials.rs", "credentials.rs"));
    assert!(glob_match(
        "desktop/app/src/*.cpp",
        "desktop/app/src/main.cpp"
    ));
    assert!(!glob_match(
        "desktop/app/src/*.cpp",
        "desktop/app/src/sub/main.cpp"
    ));
    assert!(glob_match(
        "desktop/app/crates/hive/hive-dream/**",
        "desktop/app/crates/hive/hive-dream/src/lib.rs"
    ));
    assert!(!glob_match("**/install.sh", "desktop/app/install.sh.bak"));
}

#[test]
fn line_diff_finds_the_changed_lines() {
    let old = ["a", "b", "c", "d"];
    let new = ["a", "x", "c", "d", "e"];
    assert_eq!(line_diff(&old, &new), (vec![1], vec![1, 4]));
    assert_eq!(line_diff(&old, &old), (vec![], vec![]));
}

#[test]
fn the_scanner_knows_test_code_strings_and_items() {
    let s = rustscan::scan(BEFORE);
    let line = |needle: &str| BEFORE.lines().position(|l| l.contains(needle)).unwrap();
    assert!(s.is_test(line("fn caps_the_wait")));
    assert!(s.is_test(line("#[cfg(test)]")));
    assert!(!s.is_test(line("asked.min(LIMIT)")));
    assert_eq!(s.stripped[line("waits for the screen")].trim(), "\"\"");
    let names: Vec<&str> = s
        .items_at(line("asked.min(LIMIT)"))
        .iter()
        .map(|i| i.name.as_str())
        .collect();
    assert_eq!(names, vec!["wait_secs"]);
    let raw = rustscan::scan(
        "const A: &str = r#\"{ not a brace\"#;\nfn after() {\n    let c = '{';\n}\n",
    );
    assert_eq!(
        raw.items
            .iter()
            .find(|i| i.name == "after")
            .map(|i| (i.start, i.end)),
        Some((1, 3))
    );
}
