//! `JSON.stringify`-compatible serialization and the product-sync fingerprint.
//!
//! `stableFingerprint` drives `version_key`, which drives EVERY product-sync
//! conflict resolution (`WHERE excluded.version_key > table.version_key`, a
//! lexicographic compare). If Rust and JS disagree about a single byte of the
//! stringified record, Rust-written rows become unresolvable against
//! JS-written rows already sitting in D1. Hence a hand-written stringifier
//! rather than `serde_json::to_string`.

use serde_json::Value;

/// Format a number the way ECMAScript's `Number::toString` does.
///
/// `serde_json` would render `1.0` as `"1.0"` and `1e21` as a long digit
/// string; JavaScript renders `"1"` and `"1e+21"`. This implements the spec
/// algorithm over the shortest round-tripping digit string.
pub fn format_number(x: f64) -> String {
    if !x.is_finite() {
        // JSON.stringify turns NaN/Infinity into null.
        return "null".to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }

    let negative = x < 0.0;
    let a = x.abs();

    // `{:e}` gives the shortest round-tripping representation as `d.dddde±X`.
    let sci = format!("{:e}", a);
    let (mantissa, exponent) = sci.split_once('e').expect("scientific notation");
    let exp10: i32 = exponent.parse().expect("decimal exponent");

    let mut digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }

    let k = digits.len() as i32;
    // value == 0.<digits> * 10^n
    let n = exp10 + 1;

    let body = if k <= n && n <= 21 {
        let mut s = digits;
        for _ in 0..(n - k) {
            s.push('0');
        }
        s
    } else if 0 < n && n <= 21 {
        let (head, tail) = digits.split_at(n as usize);
        format!("{head}.{tail}")
    } else if -6 < n && n <= 0 {
        let mut s = String::from("0.");
        for _ in 0..(-n) {
            s.push('0');
        }
        s.push_str(&digits);
        s
    } else {
        let e = n - 1;
        let sign = if e >= 0 { '+' } else { '-' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            let (head, tail) = digits.split_at(1);
            format!("{head}.{tail}e{sign}{}", e.abs())
        }
    };

    if negative {
        format!("-{body}")
    } else {
        body
    }
}

fn escape_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0a}' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\u{0d}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            // JSON.stringify emits non-ASCII literally (and Rust strings can
            // never hold a lone surrogate, so the well-formed-stringify escape
            // path is unreachable here).
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.stringify(value)` for values that contain no `undefined`/functions.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else {
                out.push_str(&format_number(n.as_f64().unwrap_or(f64::NAN)));
            }
        }
        Value::String(s) => escape_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut first = true;
            for (key, val) in map {
                if !first {
                    out.push(',');
                }
                first = false;
                escape_string(key, out);
                out.push(':');
                write_value(val, out);
            }
            out.push('}');
        }
    }
}

/// UTF-8 byte length of `JSON.stringify(value)`, used by the product-sync
/// size limits.
pub fn stringify_byte_len(value: &Value) -> usize {
    stringify(value).len()
}

/// Port of `sortObject`: recursively reorder object keys ascending.
///
/// JS `Array.prototype.sort` on strings compares UTF-16 code units, which is
/// what Rust's `Ord for str` does for all of BMP; the two agree except for
/// supplementary characters, which never appear in these key names.
pub fn sort_object(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sort_object).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| cmp_utf16(a, b));
            let mut out = serde_json::Map::new();
            for key in keys {
                out.insert(key.clone(), sort_object(&map[key]));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Compare two strings by UTF-16 code unit, matching JS `<`/`>` on strings.
pub fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Port of `stableFingerprint` — a double FNV-ish hash over the stably
/// stringified record, iterating **UTF-16 code units** with `Math.imul`
/// (wrapping 32-bit multiply).
pub fn stable_fingerprint(value: &Value) -> String {
    let text = stringify(&sort_object(value));
    let mut left: u32 = 0x811c_9dc5;
    let mut right: u32 = 0x9e37_79b1;
    for code in text.encode_utf16() {
        let code = code as u32;
        left = (left ^ code).wrapping_mul(0x0100_0193);
        right = (right ^ code).wrapping_mul(0x85eb_ca6b);
    }
    format!("{left:08x}{right:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_numbers_like_javascript() {
        assert_eq!(format_number(1.0), "1");
        assert_eq!(format_number(-1.0), "-1");
        assert_eq!(format_number(0.0), "0");
        assert_eq!(format_number(1.5), "1.5");
        assert_eq!(format_number(100.0), "100");
        assert_eq!(format_number(0.1), "0.1");
        assert_eq!(format_number(1e-7), "1e-7");
        assert_eq!(format_number(1e21), "1e+21");
        assert_eq!(format_number(1e20), "100000000000000000000");
        assert_eq!(format_number(1.2345e-9), "1.2345e-9");
        assert_eq!(format_number(0.000001), "0.000001");
    }

    #[test]
    fn stringifies_integers_without_decimal_point() {
        // JSON.stringify({a:1}) === '{"a":1}' — never '{"a":1.0}'.
        assert_eq!(stringify(&json!({"a": 1})), r#"{"a":1}"#);
        assert_eq!(stringify(&json!({"a": 1.0})), r#"{"a":1}"#);
    }

    #[test]
    fn escapes_control_characters_like_javascript() {
        assert_eq!(stringify(&json!("a\nb")), r#""a\nb""#);
        assert_eq!(stringify(&json!("a\u{1}b")), r#""a\u0001b""#);
        assert_eq!(stringify(&json!("quote\"back\\slash")), r#""quote\"back\\slash""#);
        // Forward slashes and non-ASCII stay literal.
        assert_eq!(stringify(&json!("a/b")), r#""a/b""#);
        assert_eq!(stringify(&json!("한국어")), "\"한국어\"");
    }

    #[test]
    fn preserves_insertion_order_of_object_keys() {
        // serde_json is built with `preserve_order`; the firmware scans for the
        // first `"text"` and first `"jobId"` in a response body.
        let v = json!({"ok": true, "text": "hi", "model": "m", "jobId": "j"});
        assert_eq!(
            stringify(&v),
            r#"{"ok":true,"text":"hi","model":"m","jobId":"j"}"#
        );
    }

    #[test]
    fn sorts_object_keys_recursively() {
        let v = json!({"b": {"z": 1, "a": 2}, "a": [ {"y": 1, "x": 2} ]});
        assert_eq!(
            stringify(&sort_object(&v)),
            r#"{"a":[{"x":2,"y":1}],"b":{"a":2,"z":1}}"#
        );
    }

    /// Golden vectors captured by executing the real `stableFingerprint` from
    /// `shared/productSync.js` under Node. These pin the exact bytes that feed
    /// `version_key`, so a Rust-written product row resolves identically to a
    /// JS-written one already in D1.
    #[test]
    fn fingerprint_matches_reference_values_from_javascript() {
        let cases: &[(Value, &str, &str)] = &[
            (json!({}), "{}", "5465b825ae4a5ef1"),
            (json!({"a": 1}), r#"{"a":1}"#, "8b9e45119d73448d"),
            (
                json!({"b": {"z": 1, "a": 2}, "a": [{"y": 1, "x": 2}]}),
                r#"{"a":[{"x":2,"y":1}],"b":{"a":2,"z":1}}"#,
                "f47f320c86f2d018",
            ),
            (
                json!({
                    "id": "turn-1",
                    "content": "Hello world",
                    "role": "user",
                    "createdAt": "2026-08-02T00:00:00.000Z"
                }),
                r#"{"content":"Hello world","createdAt":"2026-08-02T00:00:00.000Z","id":"turn-1","role":"user"}"#,
                "acc56166b066d412",
            ),
            (
                json!({"name": "한국어", "n": 1.5, "t": true, "z": null}),
                r#"{"n":1.5,"name":"한국어","t":true,"z":null}"#,
                "cd32777a429a2fde",
            ),
            (
                json!({"n": 1.0, "m": 100, "big": 1e21, "tiny": 1e-7}),
                r#"{"big":1e+21,"m":100,"n":1,"tiny":1e-7}"#,
                "24275384eaa27c50",
            ),
        ];

        for (value, expected_json, expected_fp) in cases {
            assert_eq!(
                &stringify(&sort_object(value)),
                expected_json,
                "stable stringify diverged from JSON.stringify"
            );
            assert_eq!(&stable_fingerprint(value), expected_fp);
        }
    }

    #[test]
    fn fingerprint_is_order_independent() {
        let a = json!({"x": 1, "y": 2});
        let b = json!({"y": 2, "x": 1});
        assert_eq!(stable_fingerprint(&a), stable_fingerprint(&b));
    }

    #[test]
    fn fingerprint_is_16_hex_chars() {
        let fp = stable_fingerprint(&json!({"a": 1}));
        assert_eq!(fp.len(), 16);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
