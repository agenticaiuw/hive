//! How the agent puts what's happening into words: what a tool call does ("Opening Safari"), the
//! call itself for the activity view, where a reply's sentences end (each is said as soon as it's
//! written), and where a request's time went (the ⏱ line).

use crate::hooks::Knowledge;
use crate::py;
use serde_json::Value;

/// What a tool call does, said simply: 'Opening Safari', 'Typing "weather"', or the step the agent
/// gave for it ('Opening the #general channel.') (agent.py's `doing`).
pub fn doing(item: &Value) -> String {
    let empty = Value::Object(Default::default());
    let a = match item.get("arguments") {
        Some(v) if py::truthy(Some(v)) => v,
        _ => &empty,
    };
    let step = match a.get("step") {
        Some(v) if py::truthy(Some(v)) => py::str_of(v),
        _ => String::new(),
    };
    if !py::strip(&step).is_empty() {
        return py::chars(py::strip(&step), 200).to_owned();
    }
    let arg = |key: &str| a.get(key).map(py::str_of).unwrap_or_default();
    let quoted = |key: &str| format!("“{}”", py::strip(py::chars(&arg(key), 40)));
    let tool = item.get("tool");
    if tool.and_then(Value::as_str) == Some("click") && clicks(a.get("clicks")) == 2 {
        return "Double-clicking".into();
    }
    let phrase = match tool.and_then(Value::as_str) {
        Some("screenshot") => "Looking at the screen".into(),
        Some("click") => "Clicking".into(),
        Some("move_mouse") => "Moving the mouse".into(),
        Some("drag") => "Dragging".into(),
        Some("scroll") => "Scrolling".into(),
        Some("type_text") => format!("Typing {}", quoted("text")),
        Some("press_key") => format!("Pressing {}", arg("keys")),
        Some("open_app") => format!("Opening {}", arg("name")),
        Some("find_text") => format!("Looking for {}", quoted("text")),
        Some("read_screen") => "Reading the screen".into(),
        Some("wait") => "Waiting".into(),
        Some("wait_for_control") => "Waiting for you to hand back control".into(),
        Some("read_clipboard") => "Reading the clipboard".into(),
        Some("read_ingested") => "Reading what you added".into(),
        Some("windows") => "Checking what's open".into(),
        Some("switch_window") => format!("Switching to {}", quoted("title")),
        _ => {
            let name = match tool {
                None => "Working".to_owned(),
                Some(v) => py::str_of(v),
            };
            py::capitalize(&name.replace('_', " "))
        }
    };
    phrase
}

/// `int(a.get("clicks", 1) or 1)`.
fn clicks(value: Option<&Value>) -> i64 {
    match value {
        None => 1,
        Some(v) if !py::truthy(Some(v)) => 1,
        Some(Value::Number(n)) => n
            .as_i64()
            .unwrap_or_else(|| n.as_f64().unwrap_or(1.0).trunc() as i64),
        Some(Value::String(s)) => py::strip(s).parse().unwrap_or(1),
        Some(Value::Bool(b)) => *b as i64,
        Some(_) => 1,
    }
}

/// The call as the activity view shows it: `phone.tap(x=10, y=20)`; a knowledge-base call by
/// what it looks up or saves, never the facts' values (agent.py's `describe_call`).
pub fn describe_call(item: &Value, knowledge: &dyn Knowledge) -> String {
    let empty = Value::Object(Default::default());
    let args = match item.get("arguments") {
        Some(v) if py::truthy(Some(v)) => v,
        _ => &empty,
    };
    let namespace = item.get("namespace").and_then(Value::as_str);
    let tool = item.get("tool").and_then(Value::as_str);
    if knowledge.is_call(namespace, tool, args) {
        return knowledge.describe(namespace, tool, args);
    }
    let shown: Vec<String> = args
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, _)| k.as_str() != "screenshot")
        .map(|(k, v)| format!("{k}={}", py::chars(&py::dumps(v, true), 60)))
        .collect();
    let on = if namespace == Some("phone") {
        "phone."
    } else {
        ""
    };
    let tool = item
        .get("tool")
        .map(py::str_of)
        .unwrap_or_else(|| "None".into());
    format!("{on}{tool}({})", shown.join(", "))
}

/// Why a finished tool call failed, if it did (agent.py's `tool_error`).
pub fn tool_error(item: &Value) -> Option<String> {
    if item.get("success") != Some(&Value::Bool(false)) {
        return None;
    }
    let texts: Vec<String> = item
        .get("contentItems")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("inputText"))
        .map(|c| c.get("text").map(py::str_of).unwrap_or_default())
        .collect();
    let joined = texts.join(" ");
    Some(if joined.is_empty() {
        "failed".into()
    } else {
        joined
    })
}

/// Where each match of agent.py's `SENTENCE_END` (`(?<=[.!?])\s+|\n+`) ends in `text`, in
/// characters: after the spaces that follow a sentence's last mark, or after a run of newlines.
pub fn sentence_ends(text: &str) -> Vec<usize> {
    let chars: Vec<char> = text.chars().collect();
    let mut ends = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let after_mark = i > 0 && matches!(chars[i - 1], '.' | '!' | '?');
        if after_mark && hive_common::ingest::py_isspace(chars[i]) {
            let mut j = i;
            while j < chars.len() && hive_common::ingest::py_isspace(chars[j]) {
                j += 1;
            }
            ends.push(j);
            i = j;
        } else if chars[i] == '\n' {
            let mut j = i;
            while j < chars.len() && chars[j] == '\n' {
                j += 1;
            }
            ends.push(j);
            i = j;
        } else {
            i += 1;
        }
    }
    ends
}

/// When things happened for one request, on [`crate::monotonic`]'s clock (voice_agent.py's
/// `timing` dict): when you stopped talking, when it was decided you'd finished, when your words
/// were written down, and when the reply started to be heard (or seen).
pub struct Timing<'a> {
    pub task: &'a crate::CodexTask,
    pub stopped: Option<f64>,
    pub decided: Option<f64>,
    pub written: Option<f64>,
    pub answered: Option<f64>,
    /// The reply was spoken (else only shown).
    pub spoken: bool,
}

/// Where a request's time went, from when you stopped talking to hearing its reply: '⏱  2.9 s
/// from when you stopped talking to hearing its reply: 0.8 s to be sure you'd finished, 0.1 s
/// writing it down, screenshot ready (taken as you talked), 1.6 s for Codex's first words (1 model
/// call), 0.4 s for the voice to start' (voice_agent.py's `describe_timing`).
pub fn describe_timing(timing: &Timing) -> String {
    let task = timing.task;
    let began = task.began();
    let t = |key: &str| {
        task.times()
            .into_iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| began + v)
    };
    let (stopped, decided, written) = (timing.stopped, timing.decided, timing.written);
    // `stopped or decided or written or task.began` (a 0.0 counts as missing, as in Python).
    let start = [stopped, decided, written]
        .into_iter()
        .flatten()
        .find(|v| *v != 0.0)
        .unwrap_or(began);
    let mut parts: Vec<String> = Vec::new();
    if let (Some(s), Some(d)) = (stopped.filter(|v| *v != 0.0), decided.filter(|v| *v != 0.0)) {
        parts.push(format!("{:.1} s to be sure you'd finished", d - s));
    }
    if let (Some(d), Some(w)) = (decided.filter(|v| *v != 0.0), written.filter(|v| *v != 0.0)) {
        parts.push(format!("{:.1} s writing it down", w - d));
    }
    if let Some(w) = written.filter(|v| *v != 0.0) {
        if began - w >= 0.1 {
            parts.push(format!("{:.1} s before the task started", began - w));
        }
    }
    let mut since = began;
    if let Some(look) = t("look") {
        parts.push(if task.looked_ahead() {
            "screenshot ready (taken as you talked)".to_owned()
        } else {
            format!("{:.1} s for the screenshot", look - since)
        });
        since = look;
    }
    if let Some(codex) = t("codex") {
        if codex - since >= 0.1 {
            parts.push(format!("{:.1} s for Codex to start", codex - since));
        }
        since = codex;
    }
    if let Some(words) = t("words") {
        let calls = task.calls_to_words();
        parts.push(format!(
            "{:.1} s for Codex's first words ({calls} model call{})",
            words - since,
            if calls != 1 { "s" } else { "" }
        ));
        since = words;
    }
    let end = timing.answered.unwrap_or(since);
    if timing.spoken && end - since >= 0.05 {
        parts.push(format!("{:.1} s for the voice to start", end - since));
    }
    let heard = if timing.spoken { "hearing" } else { "seeing" };
    format!(
        "⏱  {:.1} s from when you stopped talking to {heard} its reply: {}",
        end - start,
        parts.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn says_what_a_call_does() {
        assert_eq!(
            doing(&json!({"tool": "open_app", "arguments": {"name": "Safari"}})),
            "Opening Safari"
        );
        assert_eq!(
            doing(&json!({"tool": "type_text", "arguments": {"text": " weather "}})),
            "Typing “weather”"
        );
        assert_eq!(
            doing(&json!({"tool": "click", "arguments": {"clicks": 2}})),
            "Double-clicking"
        );
        assert_eq!(
            doing(&json!({"tool": "click", "arguments": {"clicks": null}})),
            "Clicking"
        );
        assert_eq!(doing(&json!({"tool": "tap_element"})), "Tap element");
        assert_eq!(doing(&json!({})), "Working");
        // tests/test_tools.py: DesktopTest.test_codex_knows_the_new_tools
        assert_eq!(
            doing(&json!({"tool": "switch_window", "arguments": {"title": "GSSF"}})),
            "Switching to “GSSF”"
        );
    }

    #[test]
    fn describes_calls_for_the_activity_view() {
        let k = crate::hooks::NoKnowledge;
        let item = json!({"namespace": "phone", "tool": "tap", "arguments": {"x": 10, "screenshot": true, "label": "Café"}});
        assert_eq!(
            describe_call(&item, &k),
            "phone.tap(x=10, label=\"Caf\\u00e9\")"
        );
        let item = json!({"namespace": "mac", "tool": "wait", "arguments": {"seconds": 0.1, "screenshot": false}});
        assert_eq!(describe_call(&item, &k), "wait(seconds=0.1)");
        assert_eq!(
            tool_error(&json!({"success": false, "contentItems": []})).as_deref(),
            Some("failed")
        );
        assert_eq!(tool_error(&json!({"success": true})), None);
    }

    #[test]
    fn finds_sentence_ends_like_the_regex() {
        assert_eq!(sentence_ends("Opened Maps. It shows"), vec![13]);
        assert_eq!(sentence_ends("One.\n\nTwo"), vec![6]);
        assert_eq!(sentence_ends("a\n\nb"), vec![3]);
        assert_eq!(sentence_ends("No end"), Vec::<usize>::new());
        assert_eq!(sentence_ends("Yes!  "), vec![6]);
        assert_eq!(sentence_ends("3.5 km"), Vec::<usize>::new());
    }
}
