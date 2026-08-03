//! Base64 helpers matching Node `Buffer` semantics.
//!
//! Node's base64 decoder is deliberately lenient: it accepts both the standard
//! (`+/`) and URL-safe (`-_`) alphabets, and silently skips padding, whitespace
//! and any other invalid character. Strict decoders reject inputs the live
//! relay accepts today, so this is hand-rolled rather than delegated.

const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn sextet(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Port of `String(x).replace(/^data:[^;]+;base64,/, '').trim()`.
pub fn strip_data_url(value: &str) -> &str {
    // Mirrors /^data:[^;]+;base64,/ : `[^;]+` cannot cross the first `;`, so
    // the mime type is exactly the span up to that separator and must be
    // non-empty.
    let stripped = (|| {
        let rest = value.strip_prefix("data:")?;
        let idx = rest.find(';')?;
        if idx == 0 {
            return None;
        }
        rest[idx..].strip_prefix(";base64,")
    })();
    stripped.unwrap_or(value).trim()
}

/// Port of `Buffer.from(value, 'base64')`.
pub fn decode(value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() * 3 / 4 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &c in value.as_bytes() {
        let Some(v) = sextet(c) else { continue };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    out
}

/// Port of `buffer.toString('base64')` (standard alphabet, padded).
pub fn encode(bytes: &[u8]) -> String {
    encode_with(bytes, STD, true)
}

/// Port of `buffer.toString('base64url')` (URL alphabet, unpadded).
pub fn encode_url(bytes: &[u8]) -> String {
    encode_with(bytes, URL, false)
}

fn encode_with(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(alphabet[(n >> 18) as usize & 63] as char);
        out.push(alphabet[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(alphabet[(n >> 6) as usize & 63] as char);
        } else if pad {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(alphabet[n as usize & 63] as char);
        } else if pad {
            out.push('=');
        }
    }
    out
}

/// Port of `Buffer.byteLength(value, 'base64')`.
///
/// Node does NOT decode to measure — it strips at most two `=` characters from
/// the end and returns `(len * 3) >>> 2`. `/v1/transcribe` uses this value for
/// its 1 MiB / 8 MiB storage gates, so the arithmetic must match exactly.
pub fn byte_length(value: &str) -> usize {
    let units: Vec<u16> = value.encode_utf16().collect();
    let mut len = units.len();
    if len > 0 && units[len - 1] == 0x3D {
        len -= 1;
    }
    if len > 1 && units[len - 1] == 0x3D {
        len -= 1;
    }
    (len * 3) >> 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_leniently_like_node() {
        assert_eq!(decode("aGVsbG8="), b"hello");
        // Missing padding is fine.
        assert_eq!(decode("aGVsbG8"), b"hello");
        // Whitespace and stray characters are skipped, not rejected.
        assert_eq!(decode("aGVs bG8=\n"), b"hello");
        // URL-safe alphabet decodes through the same path.
        assert_eq!(decode("-_8="), vec![0xfb, 0xff]);
    }

    #[test]
    fn encodes_standard_and_url_alphabets() {
        assert_eq!(encode(b"hello"), "aGVsbG8=");
        assert_eq!(encode(&[0xfb, 0xff]), "+/8=");
        assert_eq!(encode_url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn round_trips_arbitrary_bytes() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        assert_eq!(decode(&encode(&bytes)), bytes);
        assert_eq!(decode(&encode_url(&bytes)), bytes);
    }

    #[test]
    fn byte_length_matches_node_formula() {
        assert_eq!(byte_length("aGVsbG8="), 5);
        assert_eq!(byte_length("aGVsbG8"), 5);
        assert_eq!(byte_length(""), 0);
        // 4 chars of base64 == 3 bytes.
        assert_eq!(byte_length("AAAA"), 3);
        assert_eq!(byte_length("AAA="), 2);
        assert_eq!(byte_length("AA=="), 1);
    }

    #[test]
    fn strips_data_url_prefix_and_trims() {
        assert_eq!(strip_data_url("data:audio/wav;base64,AAAA"), "AAAA");
        assert_eq!(strip_data_url("  AAAA  "), "AAAA");
        // Only a leading data: prefix is removed.
        assert_eq!(strip_data_url("AAdata:x;base64,B"), "AAdata:x;base64,B");
    }

    #[test]
    fn token_id_and_secret_lengths_match_js() {
        // 12 random bytes -> 16 base64url chars; 32 -> 43. The device-token
        // regex depends on these widths.
        assert_eq!(encode_url(&[0u8; 12]).len(), 16);
        assert_eq!(encode_url(&[0u8; 32]).len(), 43);
    }
}
