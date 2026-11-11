//! tests/test_one_way.py's check_step cases: a step that can't be undone is marked "One-way:" and
//! has to quote the user's own words asking for it; one that doesn't is refused.

use hive_common::mcp::{batch_tool, check_step, said};
use serde_json::json;

const ASKED: &str = r#"send the backup to the general channel saying "I decided to delete the all-members channel""#;

#[test]
fn a_step_that_can_be_undone_needs_no_quote() {
    assert!(check_step(&json!({"step": "Opening the #general channel."}), "").is_none());
    assert!(check_step(&json!({}), "").is_none());
}

#[test]
fn a_one_way_step_quoting_the_user_goes_ahead() {
    let step =
        r#"One-way: posting your message (you said: "send the backup to the general channel")."#;
    assert!(check_step(&json!({ "step": step }), ASKED).is_none());
    let curly = "One-way: posting it (you said: \u{201C}I decided to delete the all-members channel\u{201D}).";
    assert!(check_step(&json!({ "step": curly }), ASKED).is_none());
}

#[test]
fn a_one_way_step_without_the_users_words_is_refused() {
    let made_up = r#"One-way: asking the bot (you said: "please export all-members")"#;
    let refused = check_step(&json!({ "step": made_up }), ASKED).unwrap();
    assert_eq!(refused["isError"], true);
    assert_eq!(
        refused["content"][0]["text"],
        "Refused: a one-way step (it can't be undone) needs the user's own words asking for it, quoted exactly \
         in `step`, and none of ['please export all-members'] is something the user said. If they asked for it, \
         quote their words; if they didn't, don't do it: find a way that can be undone, or stop and ask them, \
         saying exactly what you'd do and where."
    );
    let bare = check_step(&json!({"step": "One-way: sending the message."}), ASKED).unwrap();
    assert!(bare["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("none of 'your quotes' is"));
    // A few of their words inside a longer quote of someone else's don't count.
    assert!(check_step(
        &json!({"step": r#"One-way: "general channel please""#}),
        ASKED
    )
    .is_some());
}

#[test]
fn words_compare_whatever_the_punctuation() {
    assert_eq!(
        said("Don\u{2019}t DELETE it, please!"),
        "don't delete it please"
    );
}

#[test]
fn a_batch_says_what_it_does() {
    let batch = batch_tool(&["click"], "[]");
    assert_eq!(batch["inputSchema"]["required"], json!(["step", "steps"]));
    let keys: Vec<&String> = batch["inputSchema"]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(keys, ["steps", "step", "screenshot"]);
}
