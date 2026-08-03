//! Port of `cloud-relay/deviceAuth.js`.
//!
//! Two credentials coexist: the shared admin key (`RELAY_API_KEY`) and
//! per-device scoped bearer tokens minted by `POST /v1/devices/pair`. Only the
//! SHA-256 of a device token's secret is ever persisted.

use sha2::{Digest, Sha256};

use crate::util::b64;
use crate::util::time::parse_iso;

pub const TOKEN_ID_BYTES: usize = 12;
pub const TOKEN_SECRET_BYTES: usize = 32;
pub const LAST_USED_WRITE_INTERVAL_MS: i64 = 60_000;

/// Client-visible error for EVERY authentication failure. The internal reason
/// code is deliberately never sent to clients.
pub const AUTH_ERROR: &str = "Blocked for safety: invalid or missing relay credential.";
pub const SCOPE_ERROR: &str = "Blocked for safety: this device is not allowed to use that route.";

/// Insertion order is load-bearing: `/v1/devices/pair`'s 400 message is built
/// from `Object.keys(DEVICE_SCOPES).join('|')`.
pub const DEVICE_SCOPES: &[(&str, &[&str])] = &[
    (
        "mobile",
        &[
            "device:heartbeat:self",
            "device:status:read",
            "mac:plan",
            "mac:execute",
            "mac:jobs:read",
            "speech:transcribe",
            "speech:synthesize",
            "product:read",
            "product:write",
            "state:read",
        ],
    ),
    (
        "mac_bridge",
        &[
            "device:heartbeat:self",
            "device:status:read",
            "bridge:work:claim",
            "bridge:work:complete",
            "product:read",
            "product:write",
            "state:read",
            "state:write",
            "pendant:event:write",
            "speech:synthesize",
        ],
    ),
    (
        "nrf_pendant",
        &[
            "device:heartbeat:self",
            "pendant:announce",
            "pendant:audio:upload",
            "pendant:speech:read",
            "pendant:event:write",
            "mac:plan",
            "mac:jobs:read",
            "speech:transcribe",
        ],
    ),
];

pub fn supported_device_types() -> Vec<&'static str> {
    DEVICE_SCOPES.iter().map(|(name, _)| *name).collect()
}

pub fn scopes_for_device_type(device_type: &str) -> Option<&'static [&'static str]> {
    DEVICE_SCOPES
        .iter()
        .find(|(name, _)| *name == device_type)
        .map(|(_, scopes)| *scopes)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialRecord {
    pub token_id: String,
    pub token_hash: String,
    pub device_id: String,
    pub role: String,
    pub scopes: Vec<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrincipalKind {
    Admin,
    Device,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub kind: PrincipalKind,
    pub token_id: Option<String>,
    pub device_id: Option<String>,
    pub role: String,
    pub scopes: Vec<String>,
}

impl Principal {
    pub fn admin() -> Self {
        Principal {
            kind: PrincipalKind::Admin,
            token_id: None,
            device_id: None,
            role: "admin".to_string(),
            scopes: vec!["*".to_string()],
        }
    }

    pub fn device(record: &CredentialRecord) -> Self {
        Principal {
            kind: PrincipalKind::Device,
            token_id: Some(record.token_id.clone()),
            device_id: Some(record.device_id.clone()),
            role: record.role.clone(),
            scopes: record.scopes.clone(),
        }
    }

    pub fn is_device(&self) -> bool {
        self.kind == PrincipalKind::Device
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedToken {
    pub token_id: String,
    pub secret: String,
}

/// What a raw `Authorization` header resolves to before any store lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthAttempt {
    /// Matched the shared admin key.
    Admin,
    /// A well-formed `pdt_<id>.<secret>` token awaiting credential lookup.
    Device(ParsedToken),
    /// No usable bearer token in the header.
    MissingBearer,
    /// A bearer token that is not the admin key and is not parseable.
    InvalidBearer,
}

/// Port of `/^\s*Bearer\s+(\S+)\s*$/i`.
pub fn bearer_token(authorization: &str) -> Option<String> {
    let rest = authorization.trim_start_matches(|c: char| c.is_whitespace());
    if rest.len() < 6 || !rest[..6].eq_ignore_ascii_case("bearer") {
        return None;
    }
    let after = &rest[6..];
    // `\s+` requires at least one separator.
    if !after.starts_with(|c: char| c.is_whitespace()) {
        return None;
    }
    let after = after.trim_start_matches(|c: char| c.is_whitespace());
    let token: String = after
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    if token.is_empty() {
        return None;
    }
    // Anything other than trailing whitespace after the token fails the anchor.
    if !after[token.len()..].chars().all(|c| c.is_whitespace()) {
        return None;
    }
    Some(token)
}

/// Port of `/^pdt_([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{40,128})$/`.
///
/// The bounds are deliberately loose — older tokens may sit at the edges, so
/// this must not be tightened.
pub fn parse_device_token(token: &str) -> Option<ParsedToken> {
    let trimmed = token.trim();
    let rest = trimmed.strip_prefix("pdt_")?;
    let (id, secret) = rest.split_once('.')?;
    let ok = |s: &str, lo: usize, hi: usize| {
        let n = s.len();
        n >= lo
            && n <= hi
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    if !ok(id, 16, 64) || !ok(secret, 40, 128) {
        return None;
    }
    // A second '.' would break the anchored regex.
    if secret.contains('.') {
        return None;
    }
    Some(ParsedToken {
        token_id: id.to_string(),
        secret: secret.to_string(),
    })
}

pub fn hash_token_secret(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Port of `safeEqual`: SHA-256 BOTH operands, then compare the digests in
/// constant time.
///
/// Hashing first makes the comparison length-independent, which is why a naive
/// `==` on the raw strings is not an acceptable substitute.
pub fn safe_equal(left: &str, right: &str) -> bool {
    let a = Sha256::digest(left.as_bytes());
    let b = Sha256::digest(right.as_bytes());
    let mut diff = 0u8;
    for i in 0..32 {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// Port of `normalizeDeviceId`: `/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/`
/// (3–128 characters). Anything else normalizes to the empty string.
pub fn normalize_device_id(value: &str) -> String {
    let trimmed = value.trim();
    let n = trimmed.chars().count();
    if !(3..=128).contains(&n) {
        return String::new();
    }
    let mut chars = trimmed.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return String::new();
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-')) {
        return String::new();
    }
    trimmed.to_string()
}

/// Port of `principalOwnsDevice`.
///
/// Admin passes unconditionally — before normalization — so a 1–2 character
/// deviceId that can never be owned by a device principal is still fine for
/// the admin key.
pub fn principal_owns_device(principal: &Principal, device_id: &str) -> bool {
    match principal.kind {
        PrincipalKind::Admin => true,
        PrincipalKind::Device => {
            principal.device_id.as_deref().unwrap_or("") == normalize_device_id(device_id)
                && !normalize_device_id(device_id).is_empty()
        }
    }
}

/// Port of `principalHasScopes`.
pub fn principal_has_scopes(principal: &Principal, required: &[&str]) -> bool {
    if principal.scopes.iter().any(|s| s == "*") {
        return true;
    }
    required
        .iter()
        .all(|need| principal.scopes.iter().any(|have| have == need))
}

/// Port of `verifyPairingCode`.
pub fn verify_pairing_code(provided: &str, configured: &str) -> bool {
    !configured.is_empty() && safe_equal(provided, configured)
}

/// Port of `verifyDeviceToken`.
pub fn verify_device_token(token: &str, record: &CredentialRecord, now_ms: i64) -> bool {
    let Some(parsed) = parse_device_token(token) else {
        return false;
    };
    if parsed.token_id != record.token_id {
        return false;
    }
    if record.revoked_at.as_deref().is_some_and(|v| !v.is_empty()) {
        return false;
    }
    if let Some(expires) = record.expires_at.as_deref().filter(|v| !v.is_empty()) {
        if let Some(expiry_ms) = parse_iso(expires) {
            if expiry_ms <= now_ms {
                return false;
            }
        }
    }
    safe_equal(&hash_token_secret(&parsed.secret), &record.token_hash)
}

/// Classify an `Authorization` header. The caller performs the async
/// credential lookup for the `Device` case.
pub fn classify_authorization(authorization: &str, admin_api_key: &str) -> AuthAttempt {
    let Some(token) = bearer_token(authorization) else {
        return AuthAttempt::MissingBearer;
    };

    // An empty RELAY_API_KEY must never grant admin.
    if !admin_api_key.is_empty() && safe_equal(&token, admin_api_key) {
        return AuthAttempt::Admin;
    }

    match parse_device_token(&token) {
        Some(parsed) => AuthAttempt::Device(parsed),
        None => AuthAttempt::InvalidBearer,
    }
}

/// Should `last_used_at` be written back for this credential?
///
/// Throttled to once a minute; an unparseable/absent timestamp always writes.
pub fn should_touch_credential(record: &CredentialRecord, now_ms: i64) -> bool {
    let last = record
        .last_used_at
        .as_deref()
        .filter(|v| !v.is_empty())
        .and_then(parse_iso);
    match last {
        None => true,
        Some(ms) => now_ms - ms >= LAST_USED_WRITE_INTERVAL_MS,
    }
}

#[derive(Debug, Clone)]
pub struct IssuedCredential {
    pub token: String,
    pub record: CredentialRecord,
}

/// Port of `createDeviceCredential`. Randomness is injected so tests are
/// deterministic and the wasm layer can source it from WebCrypto.
pub fn create_device_credential(
    device_id: &str,
    device_type: &str,
    now: &str,
    id_bytes: &[u8],
    secret_bytes: &[u8],
) -> Result<IssuedCredential, String> {
    let normalized_device_id = normalize_device_id(device_id);
    let normalized_device_type = device_type.trim();

    if normalized_device_id.is_empty() {
        return Err("A valid deviceId is required.".to_string());
    }

    let Some(scopes) = scopes_for_device_type(normalized_device_type) else {
        return Err(format!(
            "deviceType must be one of: {}.",
            supported_device_types().join(", ")
        ));
    };

    let token_id = b64::encode_url(id_bytes);
    let secret = b64::encode_url(secret_bytes);
    let token = format!("pdt_{token_id}.{secret}");

    Ok(IssuedCredential {
        record: CredentialRecord {
            token_id,
            token_hash: hash_token_secret(&secret),
            device_id: normalized_device_id,
            role: normalized_device_type.to_string(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            created_at: now.to_string(),
            last_used_at: None,
            expires_at: None,
            revoked_at: None,
            updated_at: now.to_string(),
        },
        token,
    })
}

/// Port of `publicCredential` — the credential shape returned by `/pair`,
/// with the token itself appended by the route.
pub fn public_credential(record: &CredentialRecord) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("tokenId".into(), record.token_id.clone().into());
    map.insert("deviceId".into(), record.device_id.clone().into());
    map.insert("role".into(), record.role.clone().into());
    map.insert("scopes".into(), record.scopes.clone().into());
    map.insert("createdAt".into(), record.created_at.clone().into());
    map.insert("lastUsedAt".into(), opt(&record.last_used_at));
    map.insert("expiresAt".into(), opt(&record.expires_at));
    map.insert("revokedAt".into(), opt(&record.revoked_at));
    map.insert("updatedAt".into(), record.updated_at.clone().into());
    serde_json::Value::Object(map)
}

fn opt(value: &Option<String>) -> serde_json::Value {
    match value {
        Some(v) if !v.is_empty() => serde_json::Value::String(v.clone()),
        _ => serde_json::Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> CredentialRecord {
        create_device_credential(
            "mac-bridge-01",
            "mac_bridge",
            "2026-08-02T00:00:00.000Z",
            &[1u8; TOKEN_ID_BYTES],
            &[2u8; TOKEN_SECRET_BYTES],
        )
        .expect("credential")
        .record
    }

    fn issued() -> IssuedCredential {
        create_device_credential(
            "mac-bridge-01",
            "mac_bridge",
            "2026-08-02T00:00:00.000Z",
            &[1u8; TOKEN_ID_BYTES],
            &[2u8; TOKEN_SECRET_BYTES],
        )
        .expect("credential")
    }

    // --- Mirrors deviceAuth.test.js test 15: only a hash is stored ---------

    #[test]
    fn credential_creation_stores_only_a_hash() {
        let issued = issued();
        assert!(issued.token.starts_with("pdt_"));
        // The raw secret must never appear in the persisted record.
        let secret = issued.token.split('.').nth(1).unwrap();
        assert_ne!(issued.record.token_hash, secret);
        assert_eq!(issued.record.token_hash.len(), 64);
        assert!(issued.record.token_hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(issued.record.token_hash, hash_token_secret(secret));
    }

    #[test]
    fn issued_token_has_the_documented_shape() {
        let issued = issued();
        let parsed = parse_device_token(&issued.token).expect("parses");
        assert_eq!(parsed.token_id.len(), 16);
        assert_eq!(parsed.secret.len(), 43);
        assert_eq!(parsed.token_id, issued.record.token_id);
    }

    #[test]
    fn credential_scopes_follow_the_device_role() {
        let issued = issued();
        assert_eq!(issued.record.role, "mac_bridge");
        assert!(issued.record.scopes.contains(&"bridge:work:claim".to_string()));
        assert!(!issued.record.scopes.contains(&"pendant:announce".to_string()));
    }

    #[test]
    fn rejects_invalid_device_ids_and_types() {
        let err = create_device_credential("ab", "mobile", "t", &[0; 12], &[0; 32]).unwrap_err();
        assert_eq!(err, "A valid deviceId is required.");

        let err =
            create_device_credential("good-device", "toaster", "t", &[0; 12], &[0; 32]).unwrap_err();
        assert_eq!(err, "deviceType must be one of: mobile, mac_bridge, nrf_pendant.");
    }

    // --- Mirrors test 16: malformed / altered / expired / revoked ----------

    #[test]
    fn rejects_malformed_and_altered_tokens() {
        let record = record();
        let issued = issued();

        assert!(verify_device_token(&issued.token, &record, 0));
        assert!(!verify_device_token("not-a-token", &record, 0));
        assert!(!verify_device_token("pdt_short.secret", &record, 0));

        // Flip one character of the secret.
        let mut altered = issued.token.clone();
        altered.pop();
        altered.push(if issued.token.ends_with('A') { 'B' } else { 'A' });
        assert!(!verify_device_token(&altered, &record, 0));

        // A token whose id belongs to a different credential.
        let other = create_device_credential(
            "mobile-01",
            "mobile",
            "2026-08-02T00:00:00.000Z",
            &[9u8; 12],
            &[2u8; 32],
        )
        .unwrap();
        assert!(!verify_device_token(&other.token, &record, 0));
    }

    #[test]
    fn rejects_expired_and_revoked_credentials() {
        let issued = issued();

        let mut expired = issued.record.clone();
        expired.expires_at = Some("2026-08-02T00:00:00.000Z".to_string());
        let expiry = parse_iso("2026-08-02T00:00:00.000Z").unwrap();
        assert!(!verify_device_token(&issued.token, &expired, expiry));
        assert!(!verify_device_token(&issued.token, &expired, expiry + 1));
        // Still valid a millisecond before expiry.
        assert!(verify_device_token(&issued.token, &expired, expiry - 1));

        let mut revoked = issued.record.clone();
        revoked.revoked_at = Some("2026-08-02T00:00:00.000Z".to_string());
        assert!(!verify_device_token(&issued.token, &revoked, 0));
    }

    // --- Mirrors test 17: admin fallback + device auth --------------------

    #[test]
    fn classifies_admin_key_and_device_tokens() {
        let issued = issued();
        assert_eq!(
            classify_authorization("Bearer super-secret-admin", "super-secret-admin"),
            AuthAttempt::Admin
        );
        match classify_authorization(&format!("Bearer {}", issued.token), "admin-key") {
            AuthAttempt::Device(parsed) => assert_eq!(parsed.token_id, issued.record.token_id),
            other => panic!("expected device attempt, got {other:?}"),
        }
        assert_eq!(
            classify_authorization("", "admin-key"),
            AuthAttempt::MissingBearer
        );
        assert_eq!(
            classify_authorization("Bearer nonsense", "admin-key"),
            AuthAttempt::InvalidBearer
        );
    }

    #[test]
    fn an_empty_admin_key_never_grants_admin() {
        // Guards against an unset RELAY_API_KEY silently authorising everyone.
        assert_eq!(classify_authorization("Bearer ", ""), AuthAttempt::MissingBearer);
        assert_eq!(
            classify_authorization("Bearer something", ""),
            AuthAttempt::InvalidBearer
        );
    }

    #[test]
    fn bearer_extraction_matches_the_javascript_regex() {
        assert_eq!(bearer_token("Bearer abc").as_deref(), Some("abc"));
        assert_eq!(bearer_token("  bearer   abc  ").as_deref(), Some("abc"));
        assert_eq!(bearer_token("BEARER abc").as_deref(), Some("abc"));
        // Extra tokens after the credential fail the `$` anchor.
        assert_eq!(bearer_token("Bearer abc def"), None);
        assert_eq!(bearer_token("Basic abc"), None);
        assert_eq!(bearer_token("Bearer"), None);
        assert_eq!(bearer_token("Bearer "), None);
    }

    // --- Mirrors test 19: constant-time pairing-code comparison -----------

    #[test]
    fn pairing_code_comparison_is_exact() {
        assert!(verify_pairing_code("hunter2", "hunter2"));
        assert!(!verify_pairing_code("hunter3", "hunter2"));
        assert!(!verify_pairing_code("hunter2 ", "hunter2"));
        // An unconfigured pairing code rejects everything, including "".
        assert!(!verify_pairing_code("", ""));
        assert!(!verify_pairing_code("anything", ""));
    }

    #[test]
    fn safe_equal_is_length_independent_and_exact() {
        assert!(safe_equal("a", "a"));
        assert!(!safe_equal("a", "ab"));
        assert!(!safe_equal("", "x"));
        assert!(safe_equal("", ""));
    }

    // --- Scope + ownership semantics --------------------------------------

    #[test]
    fn admin_wildcard_satisfies_every_scope() {
        let admin = Principal::admin();
        assert!(principal_has_scopes(&admin, &["admin"]));
        assert!(principal_has_scopes(&admin, &["bridge:work:claim", "state:write"]));
    }

    #[test]
    fn device_scopes_require_every_listed_scope() {
        let principal = Principal::device(&record());
        assert!(principal_has_scopes(&principal, &["bridge:work:claim"]));
        assert!(principal_has_scopes(
            &principal,
            &["bridge:work:claim", "state:write"]
        ));
        assert!(!principal_has_scopes(&principal, &["admin"]));
        assert!(!principal_has_scopes(
            &principal,
            &["bridge:work:claim", "pendant:announce"]
        ));
    }

    #[test]
    fn no_device_role_can_reach_admin_only_routes() {
        for (device_type, _) in DEVICE_SCOPES {
            let issued =
                create_device_credential("device-abc", device_type, "t", &[0; 12], &[0; 32])
                    .unwrap();
            let principal = Principal::device(&issued.record);
            assert!(
                !principal_has_scopes(&principal, &["admin"]),
                "{device_type} unexpectedly holds the admin scope"
            );
        }
    }

    #[test]
    fn device_may_only_act_for_itself_but_admin_acts_for_anyone() {
        let principal = Principal::device(&record());
        assert!(principal_owns_device(&principal, "mac-bridge-01"));
        assert!(principal_owns_device(&principal, "  mac-bridge-01  "));
        assert!(!principal_owns_device(&principal, "other-device"));

        let admin = Principal::admin();
        assert!(principal_owns_device(&admin, "anything-at-all"));
        // Admin passes even for ids that cannot normalize.
        assert!(principal_owns_device(&admin, "ab"));
        assert!(principal_owns_device(&admin, ""));
    }

    #[test]
    fn short_device_ids_never_normalize_so_devices_cannot_own_them() {
        assert_eq!(normalize_device_id("ab"), "");
        assert_eq!(normalize_device_id("abc"), "abc");
        assert_eq!(normalize_device_id("_abc"), "", "must start alphanumeric");
        assert_eq!(normalize_device_id("nrf9160-pendant"), "nrf9160-pendant");
        assert_eq!(normalize_device_id("a.b:c_d-e"), "a.b:c_d-e");
        assert_eq!(normalize_device_id("bad space"), "");
        assert_eq!(normalize_device_id(&"a".repeat(129)), "");
        assert_eq!(normalize_device_id(&"a".repeat(128)).len(), 128);
    }

    #[test]
    fn last_used_writeback_is_throttled_to_one_minute() {
        let mut record = record();
        record.last_used_at = None;
        assert!(should_touch_credential(&record, 1_000));

        record.last_used_at = Some("2026-08-02T00:00:00.000Z".to_string());
        let base = parse_iso("2026-08-02T00:00:00.000Z").unwrap();
        assert!(!should_touch_credential(&record, base + 59_999));
        assert!(should_touch_credential(&record, base + 60_000));

        record.last_used_at = Some("garbage".to_string());
        assert!(should_touch_credential(&record, base));
    }

    #[test]
    fn public_credential_never_leaks_the_hash() {
        let json = public_credential(&record());
        assert!(json.get("tokenHash").is_none());
        assert_eq!(json["tokenId"], record().token_id.as_str());
        assert_eq!(json["lastUsedAt"], serde_json::Value::Null);
        assert_eq!(json["revokedAt"], serde_json::Value::Null);
    }
}
