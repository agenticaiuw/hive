//! Python's text forms of JSON values, so files and strings come out byte for byte as the Python
//! wrote them: `json.dumps` (", " and ": " separators, `ensure_ascii`, `indent`, float `repr`),
//! `str()`/`repr()` of a value in an f-string, truthiness, `format(n, ",")`, and slicing by
//! characters (Python's `text[:n]` counts code points, not bytes).

use serde_json::{Number, Value};

/// `json.dumps(value)`: ASCII only, `", "` and `": "` between items.
pub fn dumps(value: &Value) -> String {
    dumps_with(value, true, None)
}

/// `json.dumps(value, ensure_ascii=False)`.
pub fn dumps_utf8(value: &Value) -> String {
    dumps_with(value, false, None)
}

/// `json.dumps(value, ensure_ascii=ascii, indent=indent)`. With an indent, items are separated by
/// `","` and a new line, as Python does.
pub fn dumps_with(value: &Value, ascii: bool, indent: Option<usize>) -> String {
    let mut out = String::new();
    write(&mut out, value, ascii, indent, 0);
    out
}

fn write(out: &mut String, value: &Value, ascii: bool, indent: Option<usize>, level: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number(n)),
        Value::String(s) => string(out, s, ascii),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                separator(out, i, indent, level + 1);
                write(out, item, ascii, indent, level + 1);
            }
            close(out, indent, level);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                separator(out, i, indent, level + 1);
                string(out, key, ascii);
                out.push_str(": ");
                write(out, item, ascii, indent, level + 1);
            }
            close(out, indent, level);
            out.push('}');
        }
    }
}

fn separator(out: &mut String, i: usize, indent: Option<usize>, level: usize) {
    match indent {
        None => {
            if i > 0 {
                out.push_str(", ");
            }
        }
        Some(n) => {
            if i > 0 {
                out.push(',');
            }
            out.push('\n');
            out.push_str(&" ".repeat(n * level));
        }
    }
}

fn close(out: &mut String, indent: Option<usize>, level: usize) {
    if let Some(n) = indent {
        out.push('\n');
        out.push_str(&" ".repeat(n * level));
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

/// A JSON number as Python writes it: integers as they are, floats as `repr(float)`.
pub fn number(n: &Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    float(n.as_f64().unwrap_or(0.0))
}

/// `repr(x)` of a Python float: the shortest digits that read back as `x`, in fixed notation
/// for exponents from -4 to 15 (always with a decimal point), else `1.5e+16` / `1e-05`.
pub fn float(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if x == 0.0 {
        return if x.is_sign_negative() {
            "-0.0".into()
        } else {
            "0.0".into()
        };
    }
    let sci = format!("{:e}", x); // shortest round-trip digits, e.g. "-1.2345e9"
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let negative = mantissa.starts_with('-');
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    if (-4..16).contains(&exp) {
        if exp >= 0 {
            let point = exp as usize + 1;
            if digits.len() <= point {
                out.push_str(&digits);
                out.push_str(&"0".repeat(point - digits.len()));
                out.push_str(".0");
            } else {
                out.push_str(&digits[..point]);
                out.push('.');
                out.push_str(&digits[point..]);
            }
        } else {
            out.push_str("0.");
            out.push_str(&"0".repeat((-exp - 1) as usize));
            out.push_str(&digits);
        }
    } else {
        out.push_str(&digits[..1]);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if exp < 0 { '-' } else { '+' });
        out.push_str(&format!("{:02}", exp.abs()));
    }
    out
}

/// `str(value)` of the Python object the JSON value stands for (what an f-string shows).
pub fn str_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => repr(other),
    }
}

/// `str(value)` of an optional value, `None` when it is missing.
pub fn str_opt(value: Option<&Value>) -> String {
    value.map(str_of).unwrap_or_else(|| "None".into())
}

/// `repr(value)` of the Python object the JSON value stands for.
pub fn repr(value: &Value) -> String {
    match value {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        Value::Number(n) => number(n),
        Value::String(s) => repr_str(s),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(repr).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}: {}", repr_str(k), repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// `repr(text)`: single quotes unless the text has one and no double quote.
pub fn repr_str(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::new();
    out.push(quote);
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

/// Python's truthiness: None, False, 0, "", [] and {} are false.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(m)) => !m.is_empty(),
    }
}

/// `format(n, ",")`: thousands separated by commas.
pub fn commas(value: &Value) -> String {
    let Value::Number(n) = value else {
        return str_of(value);
    };
    let text = number(n);
    let (sign, rest) = text
        .strip_prefix('-')
        .map(|r| ("-", r))
        .unwrap_or(("", text.as_str()));
    if rest.contains('e') {
        return text;
    }
    let (int, frac) = rest
        .split_once('.')
        .map(|(i, f)| (i, Some(f)))
        .unwrap_or((rest, None));
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    match frac {
        Some(f) => format!("{sign}{grouped}.{f}"),
        None => format!("{sign}{grouped}"),
    }
}

/// `format(n, ",")` of an integer.
pub fn commas_int(n: i64) -> String {
    commas(&Value::from(n))
}

/// `text[:n]`: the first `n` characters.
pub fn head(text: &str, n: usize) -> &str {
    match text.char_indices().nth(n) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

/// `text[-n:]`: the last `n` characters.
pub fn tail(text: &str, n: usize) -> &str {
    let count = text.chars().count();
    if count <= n {
        return text;
    }
    match text.char_indices().nth(count - n) {
        Some((at, _)) => &text[at..],
        None => "",
    }
}

/// `len(text)`: characters, not bytes.
pub fn len(text: &str) -> usize {
    text.chars().count()
}

/// `" ".join(text.split())`.
pub fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dumps_like_python() {
        let v = json!({"a": [1, 2.5, null, true], "é": "x\"\n\u{1}", "f": 1731350000.0});
        assert_eq!(
            dumps(&v),
            r#"{"a": [1, 2.5, null, true], "\u00e9": "x\"\n\u0001", "f": 1731350000.0}"#
        );
        assert_eq!(dumps_utf8(&json!({"é": "雪"})), "{\"é\": \"雪\"}");
        assert_eq!(
            dumps_with(&json!({"a": [1], "b": {}}), true, Some(1)),
            "{\n \"a\": [\n  1\n ],\n \"b\": {}\n}"
        );
        assert_eq!(dumps(&json!("😀")), "\"\\ud83d\\ude00\"");
    }

    #[test]
    fn floats_like_python_repr() {
        assert_eq!(float(1.5), "1.5");
        assert_eq!(float(1e16), "1e+16");
        assert_eq!(float(1e15), "1000000000000000.0");
        assert_eq!(float(0.0001), "0.0001");
        assert_eq!(float(0.00001), "1e-05");
        assert_eq!(float(1762900000.123456), "1762900000.123456");
        assert_eq!(float(-2.0), "-2.0");
        assert_eq!(float(0.1), "0.1");
    }

    #[test]
    fn python_str_repr_and_formats() {
        assert_eq!(
            repr(&json!(["a", 1, null, {"k": true}])),
            "['a', 1, None, {'k': True}]"
        );
        assert_eq!(repr_str("it's"), "\"it's\"");
        assert_eq!(commas(&json!(41200)), "41,200");
        assert_eq!(commas(&json!(50000.0)), "50,000.0");
        assert_eq!(commas(&json!(-1234567)), "-1,234,567");
        assert_eq!(commas(&json!(999)), "999");
        assert_eq!(head("héllo", 2), "hé");
        assert_eq!(tail("héllo", 4), "éllo");
        assert!(!truthy(Some(&json!(0))) && truthy(Some(&json!("x"))) && !truthy(None));
    }
}
