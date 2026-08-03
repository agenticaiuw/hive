pub mod b64;
pub mod jsonjs;
pub mod time;
pub mod uri;

use serde_json::Value;

/// Port of the ubiquitous `String(value ?? '').trim()` idiom.
///
/// JS `String(x)` on a non-string JSON value yields its primitive text form,
/// which for the shapes the relay handles means: strings verbatim, numbers via
/// `Number::toString`, booleans as `true`/`false`, and `null`/`undefined` as
/// the empty string (because every call site uses `?? ''` or `|| ''`).
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else {
                jsonjs::format_number(n.as_f64().unwrap_or(f64::NAN))
            }
        }
        Some(other) => jsonjs::stringify(other),
    }
}

/// `String(value ?? '').trim()`.
pub fn js_string_trimmed(value: Option<&Value>) -> String {
    js_string(value).trim().to_string()
}

/// Port of `Number(value || 0)` returning `f64::NAN` where JS yields `NaN`.
pub fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// Truthiness of a JS value: `''`, `0`, `NaN`, `null`, `undefined`, `false`
/// are falsy; everything else (including `[]` and `{}`) is truthy.
pub fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Take the first `n` characters (JS `String.prototype.slice` counts UTF-16
/// code units, so this does too).
pub fn slice_utf16(value: &str, n: usize) -> String {
    let units: Vec<u16> = value.encode_utf16().collect();
    if units.len() <= n {
        return value.to_string();
    }
    String::from_utf16_lossy(&units[..n])
}

/// Collapse whitespace runs to single spaces and trim — `replace(/\s+/g, ' ').trim()`.
pub fn collapse_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_ws = false;
    for c in value.chars() {
        if c.is_whitespace() {
            in_ws = true;
        } else {
            if in_ws && !out.is_empty() {
                out.push(' ');
            }
            in_ws = false;
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn js_string_matches_javascript_coercion() {
        assert_eq!(js_string(None), "");
        assert_eq!(js_string(Some(&Value::Null)), "");
        assert_eq!(js_string(Some(&json!("hi"))), "hi");
        assert_eq!(js_string(Some(&json!(12))), "12");
        assert_eq!(js_string(Some(&json!(1.0))), "1");
        assert_eq!(js_string(Some(&json!(true))), "true");
    }

    #[test]
    fn js_truthiness_matches_javascript() {
        assert!(!js_truthy(None));
        assert!(!js_truthy(Some(&json!(""))));
        assert!(!js_truthy(Some(&json!(0))));
        assert!(!js_truthy(Some(&json!(false))));
        assert!(js_truthy(Some(&json!("x"))));
        assert!(js_truthy(Some(&json!([]))));
        assert!(js_truthy(Some(&json!({}))));
    }

    #[test]
    fn slice_counts_utf16_code_units() {
        assert_eq!(slice_utf16("hello", 3), "hel");
        assert_eq!(slice_utf16("hi", 10), "hi");
        assert_eq!(slice_utf16("한국어", 2), "한국");
    }

    #[test]
    fn collapses_whitespace_runs() {
        assert_eq!(collapse_whitespace("  a \n\t b  "), "a b");
        assert_eq!(collapse_whitespace(""), "");
        assert_eq!(collapse_whitespace("   "), "");
    }
}
