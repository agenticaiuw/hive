//! `encodeURIComponent` / `decodeURIComponent` ports.

/// Port of JS `encodeURIComponent`.
///
/// The unreserved set is exactly `A-Za-z0-9-_.!~*'()`; everything else becomes
/// percent-encoded UTF-8 with UPPERCASE hex digits. The dashboard reads the
/// `X-Cloud-Transcript` header produced with this, so the escaping must match.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let c = *byte;
        let unreserved = c.is_ascii_alphanumeric()
            || matches!(
                c,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}

/// Port of JS `decodeURIComponent`, used for Express-style route parameters.
///
/// Returns `None` when the input is malformed (JS would throw `URIError`).
pub fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_the_javascript_unreserved_set_alone() {
        let unreserved = "abcXYZ019-_.!~*'()";
        assert_eq!(encode_uri_component(unreserved), unreserved);
    }

    #[test]
    fn percent_encodes_everything_else_with_uppercase_hex() {
        assert_eq!(encode_uri_component("a b"), "a%20b");
        assert_eq!(encode_uri_component("a/b?c=d&e"), "a%2Fb%3Fc%3Dd%26e");
        assert_eq!(encode_uri_component("\n"), "%0A");
        // Multi-byte UTF-8 is encoded byte by byte.
        assert_eq!(encode_uri_component("é"), "%C3%A9");
        assert_eq!(encode_uri_component("한"), "%ED%95%9C");
    }

    #[test]
    fn decodes_round_trip() {
        for s in ["hello world", "a/b?c", "é한국", "plain"] {
            assert_eq!(decode_uri_component(&encode_uri_component(s)).as_deref(), Some(s));
        }
    }

    #[test]
    fn rejects_malformed_escapes_like_js_urierror() {
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%C3"), None); // invalid UTF-8
    }
}
