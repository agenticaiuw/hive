//! Python's text conventions, where the agent's user-visible strings depend on them: `json.dumps`
//! (", " and ": " separators, `ensure_ascii`), `str()` of a JSON value, slicing by characters,
//! `str.capitalize()` and the `{:.1f}` style used in the logs.

use serde_json::Value;

/// `json.dumps(value, ensure_ascii=...)` with Python's default separators.
pub fn dumps(value: &Value, ensure_ascii: bool) -> String {
    let mut out = String::new();
    write(&mut out, value, ensure_ascii);
    out
}

fn write(out: &mut String, value: &Value, ascii: bool) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number(n)),
        Value::String(s) => string(out, s, ascii),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write(out, item, ascii);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                string(out, key, ascii);
                out.push_str(": ");
                write(out, item, ascii);
            }
            out.push('}');
        }
    }
}

/// A number as Python prints it (`1.0`, `0.1`, `1e-07`).
fn number(n: &serde_json::Number) -> String {
    if n.is_f64() {
        let f = n.as_f64().unwrap_or(0.0);
        float(f)
    } else {
        n.to_string()
    }
}

/// `repr(float)`.
pub fn float(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    let exp = if f == 0.0 {
        0
    } else {
        f.abs().log10().floor() as i32
    };
    if (-4..16).contains(&exp) {
        let s = format!("{f}");
        if s.contains('.') || s.contains('e') {
            s
        } else {
            format!("{s}.0")
        }
    } else {
        // Python: 1e-07, 1.5e+16
        let s = format!("{f:e}");
        let (mantissa, e) = s.split_once('e').unwrap_or((&s, "0"));
        let e: i32 = e.parse().unwrap_or(0);
        format!("{mantissa}e{}{:02}", if e < 0 { '-' } else { '+' }, e.abs())
    }
}

fn string(out: &mut String, s: &str, ascii: bool) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if ascii && !(' '..='~').contains(&c) => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{:04x}", unit));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `str(value)` for a value that came from JSON: strings as they are, `True`/`False`/`None`,
/// lists and dicts as Python shows them.
pub fn str_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => repr(other),
    }
}

/// `repr(value)` for a value that came from JSON.
pub fn repr(value: &Value) -> String {
    match value {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => number(n).replace("Infinity", "inf"),
        Value::String(s) => {
            let quote = if s.contains('\'') && !s.contains('"') {
                '"'
            } else {
                '\''
            };
            let mut out = String::from(quote);
            for c in s.chars() {
                match c {
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if c == quote => {
                        out.push('\\');
                        out.push(c);
                    }
                    c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                        out.push_str(&format!("\\x{:02x}", c as u32))
                    }
                    c => out.push(c),
                }
            }
            out.push(quote);
            out
        }
        Value::Array(items) => {
            format!(
                "[{}]",
                items.iter().map(repr).collect::<Vec<_>>().join(", ")
            )
        }
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}: {}", repr(&Value::String(k.clone())), repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// Python's truthiness of a JSON value.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// `text[:n]`: the first n characters (not bytes).
pub fn chars(text: &str, n: usize) -> &str {
    match text.char_indices().nth(n) {
        Some((i, _)) => &text[..i],
        None => text,
    }
}

/// `len(text)` in characters.
pub fn len(text: &str) -> usize {
    text.chars().count()
}

/// `str.capitalize()`: the first character upper case, the rest lower case.
pub fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first
            .to_uppercase()
            .chain(chars.flat_map(char::to_lowercase))
            .collect(),
        None => String::new(),
    }
}

/// `f"{n:,}"`: an integer with thousands separators.
pub fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `text.strip()`: without the whitespace Python's `str.isspace()` sees at either end.
pub fn strip(text: &str) -> &str {
    text.trim_matches(hive_common::ingest::py_isspace)
}

/// A JSON value's text when it is a non-empty string (Python's `x or default` on a string).
pub fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dumps_like_python() {
        assert_eq!(dumps(&json!(["mac", "phone"]), true), r#"["mac", "phone"]"#);
        assert_eq!(
            dumps(&json!({"a": 1, "b": [true, null]}), true),
            r#"{"a": 1, "b": [true, null]}"#
        );
        assert_eq!(
            dumps(&json!("héllo “x”"), true),
            r#""h\u00e9llo \u201cx\u201d""#
        );
        assert_eq!(dumps(&json!("héllo"), false), "\"héllo\"");
        assert_eq!(dumps(&json!("😀"), true), r#""\ud83d\ude00""#);
        assert_eq!(dumps(&json!(0.1), true), "0.1");
        assert_eq!(dumps(&json!(1.0), true), "1.0");
        assert_eq!(dumps(&json!(1e-7), true), "1e-07");
        assert_eq!(dumps(&json!("a\"b\\\n"), true), r#""a\"b\\\n""#);
    }

    #[test]
    fn str_and_text_helpers() {
        assert_eq!(str_of(&json!(null)), "None");
        assert_eq!(str_of(&json!(["a", 1])), "['a', 1]");
        assert_eq!(str_of(&json!({"k": true})), "{'k': True}");
        assert_eq!(chars("héllo", 2), "hé");
        assert_eq!(capitalize("read screen"), "Read screen");
        assert_eq!(capitalize("moveMouse"), "Movemouse");
        assert_eq!(thousands(1234567), "1,234,567");
        assert_eq!(thousands(999), "999");
        assert_eq!(format!("{:.1}", 0.25), "0.2"); // Python's '%.1f' % 0.25
    }
}
