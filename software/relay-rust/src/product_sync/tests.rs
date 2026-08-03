//! Mirrors `shared/productSync.test.js` (suite tests 64–67) plus byte-level
//! differential fixtures captured from the real JS implementation.

use super::*;
use serde_json::json;

fn limits() -> Limits {
    PRODUCT_SYNC_LIMITS
}

fn full_fixture() -> Value {
    json!({
        "accountId": "single-owner",
        "sourceDeviceId": "ios-device.1",
        "generatedAt": "2026-08-02T12:00:00.000Z",
        "revision": 3,
        "sessions": [
            {
                "sessionId": "sess-b",
                "title": "  Trip planning  ",
                "createdAt": "2026-08-01T00:00:00.000Z",
                "updatedAt": "2026-08-01T05:00:00.000Z",
                "turns": [
                    { "id": "t2", "createdAt": "2026-08-01T02:00:00.000Z", "role": "user", "content": "second" },
                    { "id": "t1", "createdAt": "2026-08-01T01:00:00.000Z", "content": "first" },
                    { "id": "t1", "createdAt": "2026-08-01T01:00:00.000Z", "updatedAt": "2026-08-01T03:00:00.000Z", "content": "first-updated", "role": "user" },
                    { "turnId": "t3", "createdAt": "2026-08-01T04:00:00.000Z", "deletedAt": "2026-08-01T04:30:00.000Z", "content": "gone" }
                ]
            },
            { "sessionId": "sess-a", "createdAt": "2026-08-02T00:00:00.000Z", "extraField": { "keep": "me" } },
            { "sessionId": "sess-z", "createdAt": "2026-07-01T00:00:00.000Z", "deletedAt": "2026-07-02T00:00:00.000Z" }
        ],
        "memory": {
            "entities": [
                { "id": "e2", "createdAt": "2026-08-01T00:00:00.000Z" },
                { "id": "E1", "createdAt": "2026-08-01T00:00:00.000Z", "type": "  Person ", "name": " Evan " },
                { "id": "e1", "createdAt": "2026-08-01T00:00:00.000Z", "name": "lower e1" }
            ],
            "relations": [
                { "id": "r1", "from": "e1", "to": "e2", "createdAt": "2026-08-01T00:00:00.000Z" }
            ]
        }
    })
}

const GOLDEN_FULL: &str = r#"{"schemaVersion":"product-sync.v1","accountId":"single-owner","sourceDeviceId":"ios-device.1","revision":3,"generatedAt":"2026-08-02T12:00:00.000Z","sessions":[{"sessionId":"sess-a","createdAt":"2026-08-02T00:00:00.000Z","extraField":{"keep":"me"},"title":"New session","updatedAt":"2026-08-02T00:00:00.000Z","deletedAt":null,"sourceDeviceId":"ios-device.1","turns":[]},{"sessionId":"sess-b","title":"Trip planning","createdAt":"2026-08-01T00:00:00.000Z","updatedAt":"2026-08-01T05:00:00.000Z","turns":[{"id":"t1","createdAt":"2026-08-01T01:00:00.000Z","updatedAt":"2026-08-01T03:00:00.000Z","content":"first-updated","role":"user","deletedAt":null,"sourceDeviceId":"ios-device.1"},{"id":"t2","createdAt":"2026-08-01T02:00:00.000Z","role":"user","content":"second","updatedAt":"2026-08-01T02:00:00.000Z","deletedAt":null,"sourceDeviceId":"ios-device.1"},{"turnId":"t3","createdAt":"2026-08-01T04:00:00.000Z","deletedAt":"2026-08-01T04:30:00.000Z","content":"gone","id":"t3","updatedAt":"2026-08-01T04:00:00.000Z","sourceDeviceId":"ios-device.1"}],"deletedAt":null,"sourceDeviceId":"ios-device.1"},{"sessionId":"sess-z","createdAt":"2026-07-01T00:00:00.000Z","deletedAt":"2026-07-02T00:00:00.000Z","title":"New session","updatedAt":"2026-07-01T00:00:00.000Z","sourceDeviceId":"ios-device.1","turns":[]}],"memory":{"entities":[{"id":"e1","createdAt":"2026-08-01T00:00:00.000Z","name":"lower e1","updatedAt":"2026-08-01T00:00:00.000Z","deletedAt":null,"sourceDeviceId":"ios-device.1","type":"Note"},{"id":"E1","createdAt":"2026-08-01T00:00:00.000Z","type":"Person","name":"Evan","updatedAt":"2026-08-01T00:00:00.000Z","deletedAt":null,"sourceDeviceId":"ios-device.1"},{"id":"e2","createdAt":"2026-08-01T00:00:00.000Z","updatedAt":"2026-08-01T00:00:00.000Z","deletedAt":null,"sourceDeviceId":"ios-device.1","type":"Note","name":"Untitled"}],"relations":[{"id":"r1","from":"e1","to":"e2","createdAt":"2026-08-01T00:00:00.000Z","updatedAt":"2026-08-01T00:00:00.000Z","deletedAt":null,"sourceDeviceId":"ios-device.1","type":"related_to"}]}}"#;

#[test]
fn normalization_is_byte_identical_to_the_javascript_implementation() {
    let normalized = normalize_product_sync(&full_fixture(), &limits()).expect("normalizes");
    assert_eq!(stringify(&normalized), GOLDEN_FULL);
}

// --- Version keys: the D1 conflict-resolution contract ----------------------

#[test]
fn record_version_keys_match_the_javascript_implementation() {
    assert_eq!(
        record_version_key(&json!({
            "id": "e1",
            "updatedAt": "2026-08-02T10:00:00.000Z",
            "sourceDeviceId": "mac-bridge",
            "deletedAt": Value::Null
        }))
        .unwrap(),
        "2026-08-02T10:00:00.000Z|0|mac-bridge|947f14f3a4d9c43f"
    );

    // No sourceDeviceId falls back to `unknown-device`; a tombstone flips the
    // deleted flag to 1.
    assert_eq!(
        record_version_key(&json!({
            "id": "e1",
            "createdAt": "2026-08-02T10:00:00.000Z",
            "deletedAt": "2026-08-03T00:00:00.000Z"
        }))
        .unwrap(),
        "2026-08-02T10:00:00.000Z|1|unknown-device|a4fa2ce15ea85425"
    );
}

#[test]
fn a_tombstone_outranks_an_equal_time_update_lexicographically() {
    // The D1 upsert compares version_key with SQL `>`, so the tombstone's `1`
    // must sort above the update's `0` at the same timestamp.
    let updated = record_version_key(&json!({
        "id": "e1", "updatedAt": "2026-08-02T10:00:00.000Z", "sourceDeviceId": "dev-a"
    }))
    .unwrap();
    let deleted = record_version_key(&json!({
        "id": "e1",
        "updatedAt": "2026-08-02T10:00:00.000Z",
        "deletedAt": "2026-08-02T10:00:00.000Z",
        "sourceDeviceId": "dev-a"
    }))
    .unwrap();

    assert!(deleted > updated, "{deleted} should outrank {updated}");
}

#[test]
fn version_keys_order_by_timestamp_first() {
    let older = record_version_key(&json!({
        "id": "e1", "updatedAt": "2026-08-02T10:00:00.000Z", "sourceDeviceId": "dev-a"
    }))
    .unwrap();
    let newer = record_version_key(&json!({
        "id": "e1", "updatedAt": "2026-08-02T10:00:00.001Z", "sourceDeviceId": "dev-a"
    }))
    .unwrap();
    assert!(newer > older);
}

// --- Mirrors test 64: deterministic merge by stable IDs and versions -------

#[test]
fn merges_deterministically_by_stable_ids_and_versions() {
    let normalized = normalize_product_sync(&full_fixture(), &limits()).unwrap();
    let session = &normalized["sessions"][1];
    assert_eq!(session["sessionId"], "sess-b");

    // `t1` appeared twice; the newer updatedAt wins and only one survives.
    let turns = session["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 3);
    assert_eq!(turns[0]["id"], "t1");
    assert_eq!(turns[0]["content"], "first-updated");
    assert_eq!(turns[0]["updatedAt"], "2026-08-01T03:00:00.000Z");
}

#[test]
fn normalization_is_idempotent() {
    let once = normalize_product_sync(&full_fixture(), &limits()).unwrap();
    let twice = normalize_product_sync(&once, &limits()).unwrap();
    assert_eq!(stringify(&once), stringify(&twice));
}

// --- Mirrors test 65: deletion tombstones -----------------------------------

#[test]
fn deletion_tombstones_survive_and_stay_marked() {
    let normalized = normalize_product_sync(&full_fixture(), &limits()).unwrap();

    let deleted_session = &normalized["sessions"][2];
    assert_eq!(deleted_session["sessionId"], "sess-z");
    assert_eq!(deleted_session["deletedAt"], "2026-07-02T00:00:00.000Z");

    // A deleted turn keeps its tombstone and gains no synthesized role.
    let deleted_turn = &normalized["sessions"][1]["turns"][2];
    assert_eq!(deleted_turn["id"], "t3");
    assert_eq!(deleted_turn["deletedAt"], "2026-08-01T04:30:00.000Z");
    assert!(deleted_turn.get("role").is_none());
}

#[test]
fn a_tombstone_wins_an_equal_time_update_during_merge() {
    let input = json!({
        "accountId": "single-owner",
        "sourceDeviceId": "dev-a",
        "generatedAt": "2026-08-02T12:00:00.000Z",
        "sessions": [{
            "sessionId": "s1",
            "createdAt": "2026-08-01T00:00:00.000Z",
            "turns": [
                { "id": "t1", "createdAt": "2026-08-01T00:00:00.000Z", "updatedAt": "2026-08-01T01:00:00.000Z", "content": "alive" },
                { "id": "t1", "createdAt": "2026-08-01T00:00:00.000Z", "updatedAt": "2026-08-01T01:00:00.000Z", "deletedAt": "2026-08-01T01:00:00.000Z" }
            ]
        }]
    });

    let normalized = normalize_product_sync(&input, &limits()).unwrap();
    let turns = normalized["sessions"][0]["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["deletedAt"], "2026-08-01T01:00:00.000Z");
}

// --- Mirrors test 66: oversized records rejected before reaching D1 ---------

#[test]
fn rejects_oversized_turns_with_a_range_error() {
    let input = json!({
        "accountId": "single-owner",
        "generatedAt": "2026-08-02T12:00:00.000Z",
        "sessions": [{
            "sessionId": "s1",
            "createdAt": "2026-08-01T00:00:00.000Z",
            "turns": [{ "id": "t1", "createdAt": "2026-08-01T00:00:00.000Z", "content": "x".repeat(70_000) }]
        }]
    });

    let err = normalize_product_sync(&input, &limits()).unwrap_err();
    assert_eq!(
        err,
        SyncError::Range("sync.sessions[0].turns[0] exceeds 65536 bytes".to_string())
    );
    // RangeError maps to HTTP 413.
    assert_eq!(err.status(), 413);
}

#[test]
fn rejects_oversized_memory_records() {
    let input = json!({
        "accountId": "single-owner",
        "generatedAt": "2026-08-02T12:00:00.000Z",
        "memory": { "entities": [{
            "id": "e1",
            "createdAt": "2026-08-01T00:00:00.000Z",
            "blob": "x".repeat(70_000)
        }]}
    });

    let err = normalize_product_sync(&input, &limits()).unwrap_err();
    // NOTE: the JS builds this name as `${kind}s`, yielding "entitys".
    assert_eq!(
        err,
        SyncError::Range("sync.memory.entitys[0] exceeds 65536 bytes".to_string())
    );
}

#[test]
fn enforces_session_turn_and_memory_count_limits() {
    let small = Limits {
        max_sessions: 1,
        max_turns_per_session: 1,
        max_memory_entities: 1,
        ..PRODUCT_SYNC_LIMITS
    };

    let two_sessions = json!({
        "accountId": "single-owner",
        "generatedAt": "2026-08-02T12:00:00.000Z",
        "sessions": [
            { "sessionId": "s1", "createdAt": "2026-08-01T00:00:00.000Z" },
            { "sessionId": "s2", "createdAt": "2026-08-01T00:00:00.000Z" }
        ]
    });
    assert_eq!(
        normalize_product_sync(&two_sessions, &small).unwrap_err(),
        SyncError::Range("sync.sessions exceeds 1 active sessions".to_string())
    );

    let two_turns = json!({
        "accountId": "single-owner",
        "generatedAt": "2026-08-02T12:00:00.000Z",
        "sessions": [{
            "sessionId": "s1", "createdAt": "2026-08-01T00:00:00.000Z",
            "turns": [
                { "id": "t1", "createdAt": "2026-08-01T00:00:00.000Z" },
                { "id": "t2", "createdAt": "2026-08-01T00:00:00.000Z" }
            ]
        }]
    });
    assert_eq!(
        normalize_product_sync(&two_turns, &small).unwrap_err(),
        SyncError::Range("sync.sessions[0].turns exceeds 1 active turns".to_string())
    );

    let two_entities = json!({
        "accountId": "single-owner",
        "generatedAt": "2026-08-02T12:00:00.000Z",
        "memory": { "entities": [
            { "id": "e1", "createdAt": "2026-08-01T00:00:00.000Z" },
            { "id": "e2", "createdAt": "2026-08-01T00:00:00.000Z" }
        ]}
    });
    assert_eq!(
        normalize_product_sync(&two_entities, &small).unwrap_err(),
        SyncError::Range("sync.memory.entitys exceeds 1 records".to_string())
    );
}

#[test]
fn tombstones_have_their_own_higher_ceiling() {
    // 2 sessions, both deleted, with maxSessions 1 — active count is 0, so the
    // active limit does not fire.
    let small = Limits {
        max_sessions: 1,
        ..PRODUCT_SYNC_LIMITS
    };
    let input = json!({
        "accountId": "single-owner",
        "generatedAt": "2026-08-02T12:00:00.000Z",
        "sessions": [
            { "sessionId": "s1", "createdAt": "2026-08-01T00:00:00.000Z", "deletedAt": "2026-08-01T01:00:00.000Z" },
            { "sessionId": "s2", "createdAt": "2026-08-01T00:00:00.000Z", "deletedAt": "2026-08-01T01:00:00.000Z" }
        ]
    });
    assert!(normalize_product_sync(&input, &small).is_ok());
}

// --- Validation error strings clients surface verbatim ----------------------

#[test]
fn validation_error_strings_match_the_javascript_verbatim() {
    let cases: &[(Value, &str)] = &[
        (json!({}), "sync.accountId must be a stable identifier"),
        (
            json!({ "accountId": "bad id!" }),
            "sync.accountId must be a stable identifier",
        ),
        (
            json!({ "accountId": "single-owner", "sessions": [{ "sessionId": "s1" }] }),
            "sync.sessions[0].createdAt must be an ISO timestamp",
        ),
        (
            json!({ "accountId": "single-owner", "revision": -1 }),
            "sync.revision must be a non-negative integer",
        ),
        (
            json!({ "accountId": "single-owner", "sessions": "nope" }),
            "sync.sessions must be an array",
        ),
    ];

    for (input, expected) in cases {
        let err = normalize_product_sync(input, &limits()).unwrap_err();
        assert_eq!(err.message(), *expected);
        assert_eq!(err.status(), 400, "TypeError must map to 400");
    }
}

#[test]
fn a_non_object_payload_is_rejected() {
    assert_eq!(
        normalize_product_sync(&json!([]), &limits()).unwrap_err(),
        SyncError::Type("sync must be an object".to_string())
    );
    assert_eq!(
        normalize_product_sync(&json!("nope"), &limits()).unwrap_err(),
        SyncError::Type("sync must be an object".to_string())
    );
}

// --- Mirrors test 67: cross-account merges refused --------------------------
// (Enforced by the PUT /v1/product/state route; see routes::product.)

#[test]
fn normalization_preserves_the_account_id_it_was_given() {
    let a = normalize_product_sync(
        &json!({ "accountId": "single-owner", "generatedAt": "2026-08-02T12:00:00.000Z" }),
        &limits(),
    )
    .unwrap();
    assert_eq!(a["accountId"], "single-owner");
    assert_eq!(a["schemaVersion"], PRODUCT_SYNC_SCHEMA_VERSION);
    assert_eq!(a["revision"], 0);
    assert_eq!(a["sourceDeviceId"], "unknown-device");
}

// --- Collation --------------------------------------------------------------

#[test]
fn locale_compare_matches_node_locale_compare() {
    use std::cmp::Ordering::*;
    // Captured from Node: these are the cases where ICU root collation and
    // code-unit ordering DISAGREE.
    assert_eq!(locale_compare("a", "B"), Less);
    assert_eq!(locale_compare("A", "a"), Greater);
    assert_eq!(locale_compare("e1", "E1"), Less);
    assert_eq!(locale_compare("job_1", "job-1"), Less);

    // ...and cases where they agree.
    assert_eq!(locale_compare("session-1", "session-2"), Less);
    assert_eq!(locale_compare("session-10", "session-9"), Less);
    assert_eq!(locale_compare("mac-bridge", "macbridge"), Less);
    assert_eq!(locale_compare("a-b", "ab"), Less);
    assert_eq!(
        locale_compare("2026-08-02T00:00:00.000Z", "2026-08-02T00:00:01.000Z"),
        Less
    );
    assert_eq!(locale_compare("abc", "abd"), Less);
    assert_eq!(
        locale_compare("5465b825ae4a5ef1", "8b9e45119d73448d"),
        Less
    );
    assert_eq!(locale_compare("ios-device.1", "ios-device-1"), Greater);
    assert_eq!(locale_compare("_x", "ax"), Less);
    assert_eq!(locale_compare("z", "한"), Less);
    assert_eq!(locale_compare("same", "same"), Equal);
}

#[test]
fn memory_records_sort_by_id_using_locale_order() {
    let normalized = normalize_product_sync(&full_fixture(), &limits()).unwrap();
    let ids: Vec<&str> = normalized["memory"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    // "e1" < "E1" < "e2" under ICU; code-unit order would give E1, e1, e2.
    assert_eq!(ids, ["e1", "E1", "e2"]);
}

#[test]
fn sessions_sort_newest_first() {
    let normalized = normalize_product_sync(&full_fixture(), &limits()).unwrap();
    let ids: Vec<&str> = normalized["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["sess-a", "sess-b", "sess-z"]);
}

// --- Field defaults ---------------------------------------------------------

#[test]
fn applies_documented_defaults_and_truncations() {
    let input = json!({
        "accountId": "single-owner",
        "generatedAt": "2026-08-02T12:00:00.000Z",
        "sessions": [{
            "sessionId": "s1",
            "createdAt": "2026-08-01T00:00:00.000Z",
            "title": " ".to_string() + &"t".repeat(300),
            "turns": [{ "id": "t1", "createdAt": "2026-08-01T00:00:00.000Z" }]
        }],
        "memory": { "entities": [{ "id": "e1", "createdAt": "2026-08-01T00:00:00.000Z" }] }
    });

    let out = normalize_product_sync(&input, &limits()).unwrap();
    assert_eq!(out["sessions"][0]["title"].as_str().unwrap().len(), 240);
    // Missing role/content get defaults on an active turn.
    assert_eq!(out["sessions"][0]["turns"][0]["role"], "assistant");
    assert_eq!(out["sessions"][0]["turns"][0]["content"], "");
    assert_eq!(out["memory"]["entities"][0]["type"], "Note");
    assert_eq!(out["memory"]["entities"][0]["name"], "Untitled");
    assert_eq!(out["sessions"][0]["updatedAt"], "2026-08-01T00:00:00.000Z");
}

#[test]
fn relations_require_valid_endpoints() {
    let input = json!({
        "accountId": "single-owner",
        "generatedAt": "2026-08-02T12:00:00.000Z",
        "memory": { "relations": [{ "id": "r1", "createdAt": "2026-08-01T00:00:00.000Z" }] }
    });
    assert_eq!(
        normalize_product_sync(&input, &limits())
            .unwrap_err()
            .message(),
        "sync.memory.relations[0].from must be a stable identifier"
    );
}
