//! Signature normalisation: the same failure with different ids, numbers, paths, quotes and times
//! is one signature. Synthetic messages only.

use hive_dream::normalize::{
    call_text, error_category, redact, regression_words, signature_text, slug, unfinished_class,
};

#[test]
fn numbers_ids_paths_quotes_and_times_are_placeholders() {
    let a = signature_text(
        "✗ spaceo_open_app failed: pid 4312 produced no window within 8s at 2026-01-02 03:04:05",
    );
    let b = signature_text(
        "✗ spaceo_open_app failed: pid 77 produced no window within 12s at 2025-12-31 23:59:59",
    );
    assert_eq!(a, b);
    assert!(a.contains("<n>") && a.contains("<time>"), "{a}");

    let p1 = signature_text("could not read /Users/someone/Library/Thing/file.json");
    let p2 = signature_text("could not read /private/var/folders/xy/abc.json");
    assert_eq!(p1, p2);
    assert!(p1.ends_with("<path>"), "{p1}");

    let q1 = signature_text("No open window has 'Example Docs' in its title.");
    let q2 = signature_text("No open window has \"Other App\" in its title.");
    assert_eq!(q1, q2);
    assert_eq!(q1, "No open window has <q> in its title.");

    let id1 = signature_text("session 3f9a2b7c1d belongs to a previous daemon");
    let id2 = signature_text("session 0a1b2c3d4e5f belongs to a previous daemon");
    assert_eq!(id1, id2);
}

#[test]
fn apostrophes_inside_words_are_not_quotes() {
    assert_eq!(
        signature_text("The iPhone didn't answer in time."),
        "The iPhone didn't answer in time."
    );
}

#[test]
fn urls_emails_and_uuids_are_placeholders() {
    let s = signature_text(
        "POST https://example.test/api/v1 for person@example.test with 123e4567-e89b-12d3-a456-426614174000 failed",
    );
    assert_eq!(s, "POST <url> for <email> with <id> failed");
}

#[test]
fn the_first_sentence_and_prefixes_only() {
    let s = signature_text(
        "✗ Step 3 (click) failed: The target button moved off the screen. Then 42 more words.",
    );
    assert_eq!(s, "The target button moved off the screen.");
    let multi = signature_text("first line of an error that is long enough\nsecond line");
    assert_eq!(multi, "first line of an error that is long enough");
}

#[test]
fn which_input_the_user_touched_does_not_matter() {
    assert_eq!(
        signature_text("control went back to you (keyboard)"),
        signature_text("control went back to you (trackpad)")
    );
}

#[test]
fn categories() {
    assert_eq!(
        error_category("The user hasn't handed the screen back after 300 s"),
        "wait_for_control"
    );
    assert_eq!(
        error_category("The user took over the mouse and keyboard"),
        "takeover"
    );
    assert_eq!(error_category("The iPhone didn't answer in time."), "phone");
    assert_eq!(
        error_category("stream disconnected before completion"),
        "provider"
    );
    assert_eq!(
        error_category("No open window has <q> in its title."),
        "tool_error"
    );
    assert_eq!(
        unfinished_class("I can't continue: the iPhone is locked"),
        "iPhone locked, asleep or unreachable"
    );
    assert_eq!(unfinished_class("Something else entirely"), "other");
}

#[test]
fn repeated_calls_compare_without_their_step_text() {
    assert_eq!(
        call_text(r#"→ click(x=10, y=20, step="open the menu")"#),
        call_text(r#"→ click(x=10, y=20, step="try the menu again")"#)
    );
}

#[test]
fn regression_words_in_requests() {
    assert_eq!(
        regression_words("it closed itself again").as_deref(),
        Some("again")
    );
    assert_eq!(
        regression_words("I thought we changed that").as_deref(),
        Some("i thought we changed")
    );
    assert_eq!(regression_words("open the calendar"), None);
}

#[test]
fn slugs_are_stable_and_short() {
    let a = slug("phone: The iPhone didn't answer in time.");
    assert_eq!(a, slug("phone: The iPhone didn't answer in time."));
    assert!(a.starts_with("phone-the-iphone"), "{a}");
    assert!(a.len() <= 48, "{a}");
    assert_ne!(a, slug("phone: The iPhone isn't connected to its relay."));
}

#[test]
fn private_terms_are_redacted_as_whole_words() {
    let terms = vec![
        "Zorblat".to_string(),
        "# a comment".to_string(),
        "".to_string(),
    ];
    assert_eq!(
        redact("ask zorblat about Zorblatty", &terms),
        "ask <private> about Zorblatty"
    );
}
