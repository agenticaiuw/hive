//! End-to-end encryption for Hive Cloud. Only devices hold the 32-byte account key; the server
//! stores ciphertext, keyed hashes and sizes.
//!
//! - Chunks: AES-256-GCM, nonce = HMAC(nonce key, plaintext)[..12]. Encryption is deterministic,
//!   so an unchanged chunk has the same ciphertext and is never uploaded twice. The cost: the
//!   server can tell two chunks of this account are equal, and nothing else.
//! - Record metadata (path, size, chunk list): AES-256-GCM with a random nonce, bound to the
//!   record ID so the server cannot swap metadata between records.
//! - Record IDs: HMAC(id key, path), so the server never learns file names.
//! - Key wrapping: invites and the recovery code each derive an auth value (sent to the server,
//!   which keeps only its SHA-256) and a separate wrapping key (never sent).
use base64::Engine as _;
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};
use ring::{digest, hkdf, hmac};

pub const CHUNK: usize = 1024 * 1024;
const SALT: &[u8] = b"hive-cloud v1";

struct Len32;
impl hkdf::KeyType for Len32 {
    fn len(&self) -> usize {
        32
    }
}

pub fn derive(ikm: &[u8], info: &str) -> [u8; 32] {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, SALT).extract(ikm);
    let info = [info.as_bytes()];
    let okm = prk.expand(&info, Len32).expect("HKDF length");
    let mut out = [0u8; 32];
    okm.fill(&mut out).expect("HKDF fill");
    out
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    SystemRandom::new().fill(&mut out).expect("system randomness");
    out
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, data).as_ref())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn unb64(text: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|e| format!("bad base64: {e}"))
}

pub fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn gcm(key: &[u8; 32]) -> LessSafeKey {
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).expect("AES-256 key"))
}

fn seal(key: &LessSafeKey, nonce: [u8; 12], aad: &[u8], plain: &[u8]) -> Vec<u8> {
    let mut buf = plain.to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad), &mut buf)
        .expect("AES-GCM seal");
    let mut out = Vec::with_capacity(12 + buf.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    out
}

fn open(key: &LessSafeKey, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.len() < 12 + aead::AES_256_GCM.tag_len() {
        return Err("ciphertext too short".into());
    }
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&sealed[..12]);
    let mut buf = sealed[12..].to_vec();
    let plain = key
        .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::from(aad), &mut buf)
        .map_err(|_| "decryption failed: wrong key or damaged data".to_string())?;
    Ok(plain.to_vec())
}

/// The account key and everything derived from it.
pub struct Keys {
    master: [u8; 32],
    data: LessSafeKey,
    meta: LessSafeKey,
    nonce: hmac::Key,
    id: hmac::Key,
    check: String,
}

impl Keys {
    pub fn new(master: [u8; 32]) -> Keys {
        let check_key = hmac::Key::new(hmac::HMAC_SHA256, &derive(&master, "key check"));
        let check = hex(&hmac::sign(&check_key, b"hive key check").as_ref()[..16]);
        Keys {
            master,
            data: gcm(&derive(&master, "chunk data")),
            meta: gcm(&derive(&master, "record meta")),
            nonce: hmac::Key::new(hmac::HMAC_SHA256, &derive(&master, "chunk nonce")),
            id: hmac::Key::new(hmac::HMAC_SHA256, &derive(&master, "record id")),
            check,
        }
    }

    pub fn generate() -> Keys {
        Keys::new(random::<32>())
    }

    pub fn master(&self) -> &[u8; 32] {
        &self.master
    }

    /// A public fingerprint of the key, so a device can tell it unwrapped the right one.
    pub fn check(&self) -> &str {
        &self.check
    }

    pub fn record_id(&self, path: &str) -> String {
        let mut input = b"path\0".to_vec();
        input.extend_from_slice(path.as_bytes());
        hex(&hmac::sign(&self.id, &input).as_ref()[..16])
    }

    pub fn seal_chunk(&self, plain: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; 12];
        nonce.copy_from_slice(&hmac::sign(&self.nonce, plain).as_ref()[..12]);
        seal(&self.data, nonce, b"hive chunk v1", plain)
    }

    pub fn open_chunk(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        open(&self.data, b"hive chunk v1", sealed)
    }

    pub fn seal_meta(&self, record_id: &str, plain: &[u8]) -> String {
        b64(&seal(&self.meta, random::<12>(), &meta_aad(record_id), plain))
    }

    pub fn open_meta(&self, record_id: &str, sealed: &str) -> Result<Vec<u8>, String> {
        open(&self.meta, &meta_aad(record_id), &unb64(sealed)?)
    }
}

fn meta_aad(record_id: &str) -> Vec<u8> {
    let mut aad = b"hive meta v1:".to_vec();
    aad.extend_from_slice(record_id.as_bytes());
    aad
}

/// What a short secret (an invite code or the recovery code) unlocks.
pub struct CodeKeys {
    /// Sent to the server, which stores only its SHA-256.
    pub auth: String,
    wrap: [u8; 32],
}

impl CodeKeys {
    pub fn from_secret(secret: &[u8], purpose: &str) -> CodeKeys {
        CodeKeys {
            auth: b64url(&derive(secret, &format!("{purpose} auth"))),
            wrap: derive(secret, &format!("{purpose} wrap")),
        }
    }

    pub fn wrap_key(&self, keys: &Keys) -> String {
        b64(&seal(&gcm(&self.wrap), random::<12>(), b"hive key wrap v1", keys.master()))
    }

    pub fn unwrap_key(&self, wrapped: &str, expected_check: &str) -> Result<Keys, String> {
        let raw = open(&gcm(&self.wrap), b"hive key wrap v1", &unb64(wrapped)?)?;
        let master: [u8; 32] = raw.try_into().map_err(|_| "wrapped key has the wrong length")?;
        let keys = Keys::new(master);
        if keys.check() != expected_check {
            return Err("the unwrapped key does not match this Hive Cloud".into());
        }
        Ok(keys)
    }
}

// ---- human codes: Crockford base32, grouped -------------------------------------------------

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub fn base32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn unbase32(text: &str, len: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.chars().filter(|c| !matches!(c, '-' | ' ')) {
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        };
        let v = ALPHABET
            .iter()
            .position(|&a| a as char == c)
            .ok_or_else(|| format!("'{c}' is not part of a Hive code"))?;
        acc = (acc << 5) | v as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    if out.len() != len {
        return Err(format!("a Hive code here has {} characters", (len * 8).div_ceil(5)));
    }
    Ok(out)
}

pub fn grouped(code: &str) -> String {
    code.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_round_trip_and_are_deterministic() {
        let keys = Keys::generate();
        let a = keys.seal_chunk(b"hello hive");
        assert_eq!(a, keys.seal_chunk(b"hello hive"));
        assert_ne!(a, keys.seal_chunk(b"hello hivE"));
        assert_eq!(keys.open_chunk(&a).unwrap(), b"hello hive");
        let other = Keys::generate();
        assert!(other.open_chunk(&a).is_err());
    }

    #[test]
    fn meta_is_bound_to_its_record() {
        let keys = Keys::generate();
        let sealed = keys.seal_meta("aa", b"{}");
        assert_eq!(keys.open_meta("aa", &sealed).unwrap(), b"{}");
        assert!(keys.open_meta("ab", &sealed).is_err());
    }

    #[test]
    fn codes_wrap_and_unwrap_the_account_key() {
        let keys = Keys::generate();
        let secret = random::<20>();
        let code = grouped(&base32(&secret));
        let parsed = unbase32(&code.to_lowercase(), 20).unwrap();
        assert_eq!(parsed, secret);
        let wrapper = CodeKeys::from_secret(&parsed, "recovery");
        let wrapped = wrapper.wrap_key(&keys);
        let back = CodeKeys::from_secret(&secret, "recovery").unwrap_key(&wrapped, keys.check()).unwrap();
        assert_eq!(back.master(), keys.master());
        assert!(CodeKeys::from_secret(&random::<20>(), "recovery").unwrap_key(&wrapped, keys.check()).is_err());
        assert_ne!(wrapper.auth, CodeKeys::from_secret(&secret, "invite").auth);
    }

    #[test]
    fn record_ids_hide_paths() {
        let keys = Keys::generate();
        let id = keys.record_id("state/memory/personal-memory.sqlite3");
        assert_eq!(id.len(), 32);
        assert!(!id.contains("memory"));
        assert_eq!(id, keys.record_id("state/memory/personal-memory.sqlite3"));
    }
}
