//! Port of `requiredScopesForRequest` plus route resolution.
//!
//! CRITICAL BEHAVIOUR: the scope lookup compares `request.path` with EXACT
//! string equality. Express itself matches routes case-insensitively and
//! ignores a trailing slash, but the scope table does not — so an
//! authenticated request to `/v1/mac/plan/` or `/V1/mac/plan` finds no scope
//! entry and is rejected with 403, never a 404. The same is true of any
//! genuinely unknown path. A router that 404s unknown paths, or that
//! normalises case/trailing slashes before the lookup, changes observable
//! behaviour for every client.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Health,
    DevicesPair,
    DevicesRegister,
    DevicesHeartbeat,
    DevicesStatus,
    ProductStateGet(String),
    ProductStatePut,
    StateGet(String),
    StatePut(String),
    PendantAnnounce,
    Transcribe,
    PendantCommand,
    Speak,
    PendantSpeak,
    PendantJobSpeech(String),
    MacPlan,
    MacExecute,
    MacJob(String),
    OpsVoiceRuns,
    OpsVoiceRunsLatest,
    OpsAudioCaptures,
    OpsAudioCaptureAudio(String),
    OpsProxy,
    PendantJobEvents(String),
    BridgeWork,
    BridgeWorkResult(String),
}

/// Match `^<prefix><segment><suffix>$` where `<segment>` contains no `/`.
fn match_segment<'a>(path: &'a str, prefix: &str, suffix: &str) -> Option<&'a str> {
    let rest = path.strip_prefix(prefix)?;
    let seg = rest.strip_suffix(suffix)?;
    if seg.is_empty() || seg.contains('/') {
        return None;
    }
    Some(seg)
}

/// Port of `requiredScopesForRequest`. `None` means "no entry", which the
/// middleware turns into a 403 for EVERY principal, including the admin key.
pub fn required_scopes(method: &str, path: &str) -> Option<&'static [&'static str]> {
    match (method, path) {
        ("POST", "/v1/devices/register") => return Some(&["admin"]),
        ("POST", "/v1/devices/heartbeat") => return Some(&["device:heartbeat:self"]),
        ("GET", "/v1/devices/status") => return Some(&["device:status:read"]),
        ("PUT", "/v1/product/state") => return Some(&["product:write"]),
        ("POST", "/v1/pendant/announce") => return Some(&["pendant:announce"]),
        ("POST", "/v1/transcribe") => return Some(&["speech:transcribe"]),
        ("POST", "/v1/pendant/command") => return Some(&["pendant:audio:upload"]),
        ("POST", "/v1/speak") => return Some(&["speech:synthesize"]),
        ("POST", "/v1/pendant/speak") => return Some(&["pendant:speech:read"]),
        ("POST", "/v1/mac/plan") => return Some(&["mac:plan"]),
        ("POST", "/v1/mac/execute") => return Some(&["mac:execute"]),
        ("GET", "/v1/bridge/work") => return Some(&["bridge:work:claim"]),
        _ => {}
    }

    if method == "GET" && match_segment(path, "/v1/product/state/", "").is_some() {
        return Some(&["product:read"]);
    }
    if method == "GET" && path.starts_with("/v1/state/") {
        return Some(&["state:read"]);
    }
    if method == "PUT" && path.starts_with("/v1/state/") {
        return Some(&["state:write"]);
    }
    if method == "GET" && match_segment(path, "/v1/pendant/jobs/", "/speech").is_some() {
        return Some(&["pendant:speech:read"]);
    }
    if method == "GET" && match_segment(path, "/v1/mac/jobs/", "").is_some() {
        return Some(&["mac:jobs:read"]);
    }
    // NOTE: this check precedes the pendant-events check, exactly as in JS.
    // It also applies to EVERY method, not just GET.
    if path.starts_with("/v1/ops/") {
        return Some(&["admin"]);
    }
    if method == "POST" && match_segment(path, "/v1/pendant/jobs/", "/events").is_some() {
        return Some(&["pendant:event:write"]);
    }
    if method == "POST" && match_segment(path, "/v1/bridge/work/", "/result").is_some() {
        return Some(&["bridge:work:complete"]);
    }

    None
}

/// Resolve a request to a handler.
///
/// Route parameters are percent-decoded, matching Express 5. A parameter that
/// fails to decode is left in its raw form rather than throwing, since no
/// caller sends one.
pub fn resolve(method: &str, path: &str) -> Option<Route> {
    let decode = |s: &str| crate::util::uri::decode_uri_component(s).unwrap_or_else(|| s.to_string());

    match (method, path) {
        ("GET", "/health") => return Some(Route::Health),
        ("POST", "/v1/devices/pair") => return Some(Route::DevicesPair),
        ("POST", "/v1/devices/register") => return Some(Route::DevicesRegister),
        ("POST", "/v1/devices/heartbeat") => return Some(Route::DevicesHeartbeat),
        ("GET", "/v1/devices/status") => return Some(Route::DevicesStatus),
        ("PUT", "/v1/product/state") => return Some(Route::ProductStatePut),
        ("POST", "/v1/pendant/announce") => return Some(Route::PendantAnnounce),
        ("POST", "/v1/transcribe") => return Some(Route::Transcribe),
        ("POST", "/v1/pendant/command") => return Some(Route::PendantCommand),
        ("POST", "/v1/speak") => return Some(Route::Speak),
        ("POST", "/v1/pendant/speak") => return Some(Route::PendantSpeak),
        ("POST", "/v1/mac/plan") => return Some(Route::MacPlan),
        ("POST", "/v1/mac/execute") => return Some(Route::MacExecute),
        ("GET", "/v1/ops/voice-runs") => return Some(Route::OpsVoiceRuns),
        ("GET", "/v1/ops/voice-runs/latest") => return Some(Route::OpsVoiceRunsLatest),
        ("GET", "/v1/ops/audio-captures") => return Some(Route::OpsAudioCaptures),
        ("POST", "/v1/ops/proxy") => return Some(Route::OpsProxy),
        ("GET", "/v1/bridge/work") => return Some(Route::BridgeWork),
        _ => {}
    }

    if method == "GET" {
        if let Some(seg) = match_segment(path, "/v1/product/state/", "") {
            return Some(Route::ProductStateGet(decode(seg)));
        }
        if let Some(key) = path.strip_prefix("/v1/state/") {
            return Some(Route::StateGet(decode(key)));
        }
        if let Some(seg) = match_segment(path, "/v1/pendant/jobs/", "/speech") {
            return Some(Route::PendantJobSpeech(decode(seg)));
        }
        if let Some(seg) = match_segment(path, "/v1/mac/jobs/", "") {
            return Some(Route::MacJob(decode(seg)));
        }
        if let Some(seg) = match_segment(path, "/v1/ops/audio-captures/", "/audio") {
            return Some(Route::OpsAudioCaptureAudio(decode(seg)));
        }
    }

    if method == "PUT" {
        if let Some(key) = path.strip_prefix("/v1/state/") {
            return Some(Route::StatePut(decode(key)));
        }
    }

    if method == "POST" {
        if let Some(seg) = match_segment(path, "/v1/pendant/jobs/", "/events") {
            return Some(Route::PendantJobEvents(decode(seg)));
        }
        if let Some(seg) = match_segment(path, "/v1/bridge/work/", "/result") {
            return Some(Route::BridgeWorkResult(decode(seg)));
        }
    }

    None
}

/// Port of `normalizeStateKey`: `/^[a-z0-9][a-z0-9-]{0,63}$/` after
/// `trim().toLowerCase()`.
pub fn normalize_state_key(value: &str) -> String {
    let key = value.trim().to_lowercase();
    let n = key.chars().count();
    if !(1..=64).contains(&n) {
        return String::new();
    }
    let mut chars = key.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return String::new();
    }
    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return String::new();
    }
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_documented_route_to_its_scope() {
        let cases: &[(&str, &str, &[&str])] = &[
            ("POST", "/v1/devices/register", &["admin"]),
            ("POST", "/v1/devices/heartbeat", &["device:heartbeat:self"]),
            ("GET", "/v1/devices/status", &["device:status:read"]),
            ("GET", "/v1/product/state/single-owner", &["product:read"]),
            ("PUT", "/v1/product/state", &["product:write"]),
            ("GET", "/v1/state/agent-snapshot", &["state:read"]),
            ("PUT", "/v1/state/agent-snapshot", &["state:write"]),
            ("POST", "/v1/pendant/announce", &["pendant:announce"]),
            ("POST", "/v1/transcribe", &["speech:transcribe"]),
            ("POST", "/v1/pendant/command", &["pendant:audio:upload"]),
            ("POST", "/v1/speak", &["speech:synthesize"]),
            ("POST", "/v1/pendant/speak", &["pendant:speech:read"]),
            ("GET", "/v1/pendant/jobs/job_1/speech", &["pendant:speech:read"]),
            ("POST", "/v1/mac/plan", &["mac:plan"]),
            ("POST", "/v1/mac/execute", &["mac:execute"]),
            ("GET", "/v1/mac/jobs/job_1", &["mac:jobs:read"]),
            ("GET", "/v1/ops/voice-runs", &["admin"]),
            ("GET", "/v1/ops/voice-runs/latest", &["admin"]),
            ("GET", "/v1/ops/audio-captures", &["admin"]),
            ("GET", "/v1/ops/audio-captures/job_1/audio", &["admin"]),
            ("POST", "/v1/ops/proxy", &["admin"]),
            ("POST", "/v1/pendant/jobs/job_1/events", &["pendant:event:write"]),
            ("GET", "/v1/bridge/work", &["bridge:work:claim"]),
            ("POST", "/v1/bridge/work/job_1/result", &["bridge:work:complete"]),
        ];

        for (method, path, expected) in cases {
            assert_eq!(
                required_scopes(method, path),
                Some(*expected),
                "{method} {path}"
            );
        }
    }

    #[test]
    fn unknown_paths_have_no_scope_entry_and_therefore_403() {
        assert_eq!(required_scopes("GET", "/v1/nope"), None);
        assert_eq!(required_scopes("GET", "/"), None);
        // /health and /v1/devices/pair are public: they are registered BEFORE
        // the auth middleware and never consult the scope table.
        assert_eq!(required_scopes("GET", "/health"), None);
        assert_eq!(required_scopes("POST", "/v1/devices/pair"), None);
    }

    #[test]
    fn trailing_slashes_and_casing_are_not_normalized() {
        // Express would route these; the exact-match scope lookup will not.
        assert_eq!(required_scopes("POST", "/v1/mac/plan/"), None);
        assert_eq!(required_scopes("POST", "/V1/mac/plan"), None);
        assert_eq!(required_scopes("POST", "/v1/MAC/plan"), None);
        assert_eq!(required_scopes("GET", "/v1/devices/status/"), None);
    }

    #[test]
    fn wrong_method_on_a_known_path_has_no_scope_entry() {
        assert_eq!(required_scopes("GET", "/v1/mac/plan"), None);
        assert_eq!(required_scopes("DELETE", "/v1/transcribe"), None);
        assert_eq!(required_scopes("POST", "/v1/bridge/work"), None);
    }

    #[test]
    fn ops_prefix_requires_admin_for_every_method() {
        for method in ["GET", "POST", "PUT", "DELETE", "PATCH"] {
            assert_eq!(
                required_scopes(method, "/v1/ops/anything/at/all"),
                Some(&["admin"][..]),
                "{method}"
            );
        }
    }

    #[test]
    fn multi_segment_ids_do_not_match_single_segment_patterns() {
        assert_eq!(required_scopes("GET", "/v1/mac/jobs/a/b"), None);
        assert_eq!(required_scopes("GET", "/v1/product/state/a/b"), None);
        assert_eq!(required_scopes("GET", "/v1/pendant/jobs/a/b/speech"), None);
    }

    #[test]
    fn state_prefix_matching_is_a_prefix_not_a_segment() {
        // JS uses path.startsWith('/v1/state/'), so nested keys still map to
        // state:read even though the handler will reject the key.
        assert_eq!(
            required_scopes("GET", "/v1/state/a/b"),
            Some(&["state:read"][..])
        );
    }

    #[test]
    fn resolves_routes_and_decodes_parameters() {
        assert_eq!(resolve("GET", "/health"), Some(Route::Health));
        assert_eq!(
            resolve("GET", "/v1/mac/jobs/job_abc"),
            Some(Route::MacJob("job_abc".into()))
        );
        assert_eq!(
            resolve("GET", "/v1/pendant/jobs/job_1/speech"),
            Some(Route::PendantJobSpeech("job_1".into()))
        );
        assert_eq!(
            resolve("POST", "/v1/bridge/work/job_1/result"),
            Some(Route::BridgeWorkResult("job_1".into()))
        );
        assert_eq!(
            resolve("GET", "/v1/state/agent%2Dsnapshot"),
            Some(Route::StateGet("agent-snapshot".into()))
        );
        assert_eq!(resolve("GET", "/v1/unknown"), None);
    }

    #[test]
    fn latest_probe_resolves_before_the_generic_ops_routes() {
        assert_eq!(
            resolve("GET", "/v1/ops/voice-runs/latest"),
            Some(Route::OpsVoiceRunsLatest)
        );
        assert_eq!(resolve("GET", "/v1/ops/voice-runs"), Some(Route::OpsVoiceRuns));
    }

    #[test]
    fn normalizes_state_keys_like_the_javascript_regex() {
        assert_eq!(normalize_state_key("agent-snapshot"), "agent-snapshot");
        assert_eq!(normalize_state_key("  AGENT-Snapshot "), "agent-snapshot");
        assert_eq!(normalize_state_key("a"), "a");
        assert_eq!(normalize_state_key("0"), "0");
        assert_eq!(normalize_state_key("-leading"), "");
        assert_eq!(normalize_state_key("has_underscore"), "");
        assert_eq!(normalize_state_key("has space"), "");
        assert_eq!(normalize_state_key(""), "");
        assert_eq!(normalize_state_key(&"a".repeat(64)).len(), 64);
        assert_eq!(normalize_state_key(&"a".repeat(65)), "");
    }
}
