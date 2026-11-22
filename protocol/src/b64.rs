//! Base64, the standard alphabet.
const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 4 / 3 + 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() { out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char) } else { out.push('=') }
        }
    }
    out
}

pub fn decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for b in s.bytes() {
        let v = match b { b'A'..=b'Z' => b - b'A', b'a'..=b'z' => b - b'a' + 26, b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62, b'/' | b'_' => 63, b'=' | b'\n' | b'\r' | b' ' => continue, _ => return None };
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((acc >> bits) as u8); }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip() {
        for s in [&b""[..], b"a", b"ab", b"abc", b"hello world!"] {
            assert_eq!(super::decode(&super::encode(s)).unwrap(), s);
        }
        assert_eq!(super::encode(b"hi"), "aGk=");
    }
}
