//! Python's `json.dumps` formatting: `", "` and `": "` separators, optionally `ensure_ascii`.
//! Files and replies that python wrote with `json.dumps` keep their exact shape.

use serde::Serialize;
use serde_json::ser::{Formatter, Serializer};
use serde_json::Value;
use std::io::{self, Write};

struct Python {
    ascii: bool,
}

impl Formatter for Python {
    fn begin_array_value<W: ?Sized + Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        if first {
            Ok(())
        } else {
            w.write_all(b", ")
        }
    }
    fn begin_object_key<W: ?Sized + Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        if first {
            Ok(())
        } else {
            w.write_all(b", ")
        }
    }
    fn begin_object_value<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        w.write_all(b": ")
    }
    fn write_string_fragment<W: ?Sized + Write>(
        &mut self,
        w: &mut W,
        fragment: &str,
    ) -> io::Result<()> {
        if !self.ascii || fragment.is_ascii() {
            return w.write_all(fragment.as_bytes());
        }
        let mut buffer = [0u16; 2];
        for c in fragment.chars() {
            if c.is_ascii() {
                w.write_all(&[c as u8])?;
            } else {
                for unit in c.encode_utf16(&mut buffer) {
                    write!(w, "\\u{:04x}", unit)?;
                }
            }
        }
        Ok(())
    }
}

/// `json.dumps(value)` (`ensure_ascii` true) or `json.dumps(value, ensure_ascii=False)`.
pub fn dumps(value: &Value, ensure_ascii: bool) -> String {
    let mut out = Vec::new();
    let mut serializer = Serializer::with_formatter(
        &mut out,
        Python {
            ascii: ensure_ascii,
        },
    );
    value
        .serialize(&mut serializer)
        .expect("a JSON value always serializes");
    String::from_utf8(out).expect("JSON is UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_python_json_dumps() {
        let value =
            json!({"state": "ready", "list": [1, 2, {"a": null}], "é": "界😀", "q": "\"\n"});
        assert_eq!(
            dumps(&value, true),
            "{\"state\": \"ready\", \"list\": [1, 2, {\"a\": null}], \"\\u00e9\": \"\\u754c\\ud83d\\ude00\", \"q\": \"\\\"\\n\"}"
        );
        assert_eq!(dumps(&json!(["é", {}]), false), "[\"é\", {}]");
        assert_eq!(
            dumps(&json!({"version": 1, "mode": "closed"}), true),
            "{\"version\": 1, \"mode\": \"closed\"}"
        );
    }
}
