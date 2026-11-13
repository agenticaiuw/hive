//! Failure signatures: the same failure, with its ids, numbers, paths, quotes and times taken out,
//! so the 16 different "The iPhone didn't answer in time" lines become one cluster. Also the
//! classifiers that put a message in a category, and the slug a cluster's branch is named after.

use regex::Regex;
use std::sync::LazyLock;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("normalize pattern")
}

/// Replacements in order: each later one sees the earlier placeholders.
static REPLACE: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        // "🎞  Recording 2026-11-11 15.16.38 Open Safari: upload failed" names the task.
        (
            re(r"Recording .+?: (upload|uploaded)"),
            "Recording <name>: $1",
        ),
        (re(r"https?://\S+"), "<url>"),
        (re(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "<email>"),
        (
            re(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"),
            "<id>",
        ),
        (
            re(r"\d{4}-\d{2}-\d{2}[T ]\d{2}[:.]\d{2}(?:[:.]\d{2})?(?:\.\d+)?"),
            "<time>",
        ),
        (re(r"\b\d{1,2}:\d{2}(?::\d{2})?\b"), "<time>"),
        (re(r"\b\d{4}-\d{2}-\d{2}\b"), "<date>"),
        // Quoted text: 'x', "x", “x”, ‘x’. An apostrophe inside a word ("didn't") isn't a quote.
        (
            re(r#"(^|[\s(\[:=,{])'[^'\n]{1,300}'($|[\s)\]},.;:!?])"#),
            "$1<q>$2",
        ),
        (re(r#""(?:[^"\\\n]|\\.){0,300}""#), "<q>"),
        (re(r"“[^”\n]{0,300}”"), "<q>"),
        (re(r"‘[^’\n]{0,300}’"), "<q>"),
        (
            re(
                r"(?:~|/(?:Users|private|var|tmp|Applications|Library|opt|usr|Volumes|System|dev))(?:/[^\s'),;]*)?",
            ),
            "<path>",
        ),
    ]
});

static AFTER_IDS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (re(r"-?\d+(?:\.\d+)?"), "<n>"),
        // Which input the user touched doesn't change the failure.
        (
            re(r"\((?:keyboard|trackpad|mouse|engage[ _]cancelled[ _]by[ _]\w+)\)"),
            "(<input>)",
        ),
        (re(r"\s+"), " "),
    ]
});

static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^(?:[\s→✗❌✋⚠️️📱🎞⏸▶]+|Step <n> \(\w+\) failed:\s*|Step \d+ \(\w+\) failed:\s*)+")
});

/// The signature text of one message: its first line with everything that varies between two
/// occurrences of the same failure replaced by a placeholder, cut at the end of the first
/// sentence (or 120 characters).
pub fn signature_text(raw: &str) -> String {
    let first = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let mut s = first.trim().to_string();
    for (pattern, with) in REPLACE.iter() {
        s = pattern.replace_all(&s, *with).into_owned();
    }
    // Hex ids (commit hashes, trace ids): 7+ hex digits with at least one digit and one letter.
    static HEX: LazyLock<Regex> = LazyLock::new(|| re(r"\b[0-9a-fA-F]{7,}\b"));
    s = HEX
        .replace_all(&s, |c: &regex::Captures| {
            let m = &c[0];
            let digit = m.chars().any(|ch| ch.is_ascii_digit());
            let letter = m.chars().any(|ch| ch.is_ascii_alphabetic());
            if digit && letter {
                "<id>".to_string()
            } else {
                m.to_string()
            }
        })
        .into_owned();
    for (pattern, with) in AFTER_IDS.iter() {
        s = pattern.replace_all(&s, *with).into_owned();
    }
    let s = PREFIX.replace(&s, "").trim().to_string();
    cut(&first_sentence(&s), 120)
}

fn first_sentence(s: &str) -> String {
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    for (i, &(at, c)) in chars.iter().enumerate() {
        if at >= 20 && matches!(c, '.' | '?' | '!') {
            let next = chars.get(i + 1).map(|&(_, n)| n);
            if next.is_none() || next == Some(' ') {
                return s[..at + c.len_utf8()].to_string();
            }
        }
    }
    s.to_string()
}

/// At most `max` characters, on a character boundary.
pub fn cut(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", s[..at].trim_end()),
        None => s.to_string(),
    }
}

/// FNV-1a, 64-bit: a stable hash for ids and slugs (std's hasher isn't stable across releases).
pub fn fnv64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// A cluster's short name, for its branch (`dream/<date>-<slug>`) and folder: the category,
/// the first words of the signature, and 6 hex digits of its hash so two never collide.
pub fn slug(signature: &str) -> String {
    let mut words = String::new();
    let mut dash = false;
    for c in signature.chars() {
        if c.is_ascii_alphanumeric() {
            if dash && !words.is_empty() {
                words.push('-');
            }
            words.push(c.to_ascii_lowercase());
            dash = false;
        } else if c != '\'' && c != '\u{2019}' {
            dash = true;
        }
        if words.len() >= 40 {
            break;
        }
    }
    let words = words.trim_end_matches('-');
    format!("{words}-{:06x}", fnv64(signature) & 0xff_ffff)
}

/// A tool call without its `step="..."` description, so two identical calls compare equal
/// (the model rewords the step each time).
pub fn call_text(text: &str) -> String {
    static STEP: LazyLock<Regex> =
        LazyLock::new(|| re(r#",?\s*"?step"?\s*[=:]\s*"(?:[^"\\]|\\.)*""#));
    let t = text.trim().trim_start_matches('→').trim();
    let t = t.trim_start_matches("📱").trim();
    let t = STEP.replace_all(t, "");
    t.replace("(, ", "(").trim().to_string()
}

/// The tool's name: `phone.elements` for `phone.elements()`.
pub fn tool_name(call: &str) -> String {
    call.split('(').next().unwrap_or(call).trim().to_string()
}

/// Calls that aren't the model's choice of action (or don't say which), never a "repeat".
pub fn ignorable_call(text: &str) -> bool {
    text.contains("Running a local command")
        || text.contains("attached to the request")
        || text.contains("as you started talking")
        || text.contains("compacting the conversation")
        || text.starts_with("web search")
}

/// The category of an error message Hive gave a tool call (journal `error`, recording `✗`).
pub fn error_category(text: &str) -> &'static str {
    let t = text;
    if t.contains("hasn't handed the screen back") || t.contains("hasn't handed control back") {
        "wait_for_control"
    } else if t.contains("took over")
        || t.contains("is using them")
        || t.contains("engage cancelled")
    {
        "takeover"
    } else if t.contains("iPhone didn't answer")
        || t.contains("isn't connected to its relay")
        || t.contains("WDA unavailable")
        || t.contains("relay said HTTP")
        || t.contains("Phone authentication was not confirmed")
        || t.contains("press_home refused")
    {
        "phone"
    } else if provider_error(t) {
        "provider"
    } else {
        "tool_error"
    }
}

pub fn provider_error(t: &str) -> bool {
    static P: LazyLock<Regex> = LazyLock::new(|| {
        re(
            r"(?i)invalid_request_error|Codex stopped|routing discovery|Provider recovery|Temporary provider failure|model_not_found|approval policy is never|stream disconnected|rate limit|HTTP 5\d\d from",
        )
    });
    P.is_match(t)
}

/// Why a task ended without finishing, from what the model said (journal `failed`, recording
/// ✋/❌): coarse classes, because the model words it differently every time.
pub fn unfinished_class(text: &str) -> &'static str {
    static CLASSES: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
        vec![
            (
                "provider or Codex error",
                re(
                    r"(?i)invalid_request_error|Codex stopped|routing discovery|Provider recovery|Goal stopped|model_not_found|approval policy",
                ),
            ),
            (
                "reported failed though the work was done",
                re(
                    r"(?i)no further action|no blocker|check is complete|sent and confirmed|already submitted|submission is confirmed|already in the queue|eventually displayed",
                ),
            ),
            (
                "asked what the user meant (speech fragment)",
                re(
                    r"(?i)incomplete|please (finish|tell me)|what would you like|need the rest|mistranscribed|doesn.t identify an action|^paused|mid-sentence",
                ),
            ),
            (
                "iPhone locked, asleep or unreachable",
                re(r"(?i)iphone|phone|relay|sleep ?lock|webdriveragent"),
            ),
            (
                "needs the screen back from the user",
                re(
                    r"(?i)hand it back|hand back|screen control|control hasn|under your control|mouse and keyboard|have the screen",
                ),
            ),
            (
                "virtual monitor or workspace not showing the app",
                re(
                    r"(?i)virtual monitor|workspace|isolation|display|safety circuit|windowserver|accessibility window",
                ),
            ),
            (
                "sign-in, password or approval prompt",
                re(r"(?i)passwords|autofill|authenticat|password|sign-in|sign in|log in|duo"),
            ),
        ]
    });
    for (name, pattern) in CLASSES.iter() {
        if pattern.is_match(text) {
            return name;
        }
    }
    "other"
}

/// Words in a request that say something came back: "again", "still", "I thought we changed".
pub fn regression_words(request: &str) -> Option<String> {
    static R: LazyLock<Regex> = LazyLock::new(|| {
        re(
            r"(?i)\b(i thought we (?:changed|fixed|said|already)|we already (?:changed|fixed)|didn'?t we (?:change|fix)|same (?:issue|problem|bug)|again|still)\b",
        )
    });
    R.captures(request)
        .map(|c| c[1].to_lowercase().replace('\u{2019}', "'"))
}

/// A request another agent sent (Claude Code's briefs), not the user's own words.
pub fn agent_brief(request: &str) -> bool {
    let t = request.trim_start_matches('🗣').trim();
    t.starts_with("From Claude Code") || t.starts_with("Before you start") || t.len() > 600
}

/// Replaces every private term (a whole word, any case) with `<private>`.
pub fn redact(text: &str, terms: &[String]) -> String {
    let mut out = text.to_string();
    for term in terms {
        if let Some(pattern) = term_pattern(term) {
            // Twice: a separator taken by one match can be the next match's edge ("a a").
            for _ in 0..2 {
                out = pattern.replace_all(&out, "${1}<private>${2}").into_owned();
            }
        }
    }
    out
}

/// A private term as a case-insensitive pattern that matches it as a whole word, where `_` and
/// punctuation separate words too (so it is found in `term_value` and `term.json`, not in
/// `terminal`). Groups 1 and 2 are the characters around it.
pub fn term_pattern(term: &str) -> Option<Regex> {
    let t = term.trim();
    if t.is_empty() || t.starts_with('#') {
        return None;
    }
    let edge = r"[^\p{L}\p{N}]";
    Regex::new(&format!("(?i)(^|{edge}){}($|{edge})", regex::escape(t))).ok()
}
