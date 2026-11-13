//! Ports of tests/test_phone_rust.py (the relay transport, driven with a synthetic `curl`, never
//! the phone) and of the phone tools of tests/test_tools.py; the tool list is compared with the
//! one python/phone_mcp.py defined (tests/python-tools.json).

use base64::Engine;
use hive_common::tools::{is_error, texts, ToolNamespace};
use hive_phone::{CoreTransport, Phone, PhoneAuthenticator, PhoneTools, Transport};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// A 1x1 PNG.
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

static ENV: Mutex<()> = Mutex::new(());

fn env_lock() -> MutexGuard<'static, ()> {
    ENV.lock().unwrap_or_else(|e| e.into_inner())
}

fn relay(secret: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("private")).unwrap();
    std::fs::write(dir.path().join("endpoint.txt"), "http://fixture.invalid\n").unwrap();
    std::fs::write(
        dir.path().join("private/secrets.json"),
        json!({"CONTROL_TOKEN": secret}).to_string(),
    )
    .unwrap();
    dir
}

// ---------------------------------------------------------------- a scripted fake transport

#[derive(Clone, Default)]
struct Fake {
    seen: Arc<Mutex<Vec<Value>>>,
    source: Arc<Mutex<String>>,
    element: Arc<Mutex<Value>>,
    fail_on: Arc<Mutex<Option<String>>>,
    /// What /wda/locked answers (None: false, an unlocked phone).
    locked: Arc<Mutex<Option<Value>>>,
    real: bool,
}

impl Fake {
    fn operations(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|p| {
                format!(
                    "{} {}",
                    p["operation"].as_str().unwrap(),
                    p["path"].as_str().unwrap()
                )
            })
            .collect()
    }
}

impl Transport for Fake {
    fn call(&self, payload: &Value) -> Option<Value> {
        self.seen.lock().unwrap().push(payload.clone());
        let path = payload["path"].as_str().unwrap_or("");
        if let Some(bad) = self.fail_on.lock().unwrap().as_deref() {
            if path == bad {
                return Some(
                    json!({"error": format!("The relay refused {path}"), "session": "s1"}),
                );
            }
        }
        let value = match payload["operation"].as_str().unwrap() {
            "request" => match path {
                "/health" => json!({"connected": true}),
                "/api/screenshot" => json!({"value": PNG}),
                "/api/wda/activeAppInfo" => {
                    json!({"value": {"name": "Safari", "bundleId": "com.apple.mobilesafari"}})
                }
                "/api/wda/locked" => {
                    json!({"value": self.locked.lock().unwrap().clone().unwrap_or(json!(false))})
                }
                _ => json!({"value": null}),
            },
            "in_session" => match path {
                "/window/size" => json!({"value": {"width": 1, "height": 2}}),
                "/source" => json!({"value": self.source.lock().unwrap().clone()}),
                _ => json!({"value": null}),
            },
            "tap_element" => self.element.lock().unwrap().clone(),
            "visible_elements" | "action_plan" if self.real => {
                return CoreTransport.call(payload);
            }
            "action_plan" => {
                let (path, in_session) = match payload["body"]["name"].as_str().unwrap() {
                    "home" => ("/api/wda/homescreen", false),
                    "tap" => ("/wda/tap", true),
                    _ => ("/wda/other", true),
                };
                json!({"path": path, "body": {"args": payload["body"]["args"]}, "in_session": in_session})
            }
            other => panic!("unexpected operation {other}"),
        };
        Some(json!({"value": value, "session": "s1"}))
    }
}

fn tools(fake: &Fake, folder: &Path) -> PhoneTools {
    let phone = Phone::with_transport(folder.to_str(), Box::new(fake.clone())).unwrap();
    PhoneTools::with_phone(phone).with_settle(Duration::from_millis(1))
}

// ---------------------------------------------------------------- the tool list

#[test]
fn tool_list_is_the_one_python_defined() {
    let golden: Value = serde_json::from_str(include_str!("python-tools.json")).unwrap();
    assert_eq!(Value::Array(hive_phone::tool_list()), golden);
    let handle = PhoneTools::new();
    assert_eq!(handle.namespace(), "phone");
    assert_eq!(
        handle.about(),
        "The user's iPhone: see its screen and tap, swipe and type."
    );
    assert_eq!(handle.tools(), hive_phone::tool_list());
    assert_eq!(
        hive_phone::BATCHABLE,
        [
            "tap",
            "tap_element",
            "swipe",
            "type_text",
            "press_home",
            "open_app",
            "wait"
        ]
    );
}

// ---------------------------------------------------------------- tools over a fake transport

#[test]
fn screenshot_is_a_jpeg_in_points_with_the_front_app() {
    let relay = relay("synthetic-token");
    let fake = Fake::default();
    let result = tools(&fake, relay.path())
        .call("screenshot", &json!({}))
        .unwrap();
    assert!(!is_error(&result));
    assert_eq!(
        texts(&result),
        "Phone screenshot 1x2 points. In front: Safari (com.apple.mobilesafari)."
    );
    let image = &result["content"][1];
    assert_eq!(image["mimeType"], "image/jpeg");
    let jpeg = base64::engine::general_purpose::STANDARD
        .decode(image["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
}

#[test]
fn tap_posts_the_planned_action_and_confirms_with_the_given_numbers() {
    let relay = relay("synthetic-token");
    let fake = Fake::default();
    let result = tools(&fake, relay.path())
        .call("tap", &json!({"x": 220, "y": 90.5, "screenshot": false}))
        .unwrap();
    assert_eq!(texts(&result), "Tapped (220, 90.5).");
    assert_eq!(fake.operations(), ["action_plan ", "in_session /wda/tap"]);
    let plan = fake.seen.lock().unwrap()[0].clone();
    assert_eq!(
        plan["body"],
        json!({"name": "tap", "args": {"x": 220.0, "y": 90.5}})
    );
    let home = tools(&fake, relay.path())
        .call("press_home", &json!({"screenshot": false}))
        .unwrap();
    assert_eq!(texts(&home), "Home screen.");
    // only once the phone has said it isn't locked
    assert_eq!(
        fake.operations()[2..],
        [
            "request /api/wda/locked",
            "action_plan ",
            "request /api/wda/homescreen"
        ]
    );
}

/// press_home on a locked iPhone hung WebDriverAgent until the relay app was reopened
/// (2026-11-12): it only wakes the screen there, and says how to unlock.
#[test]
fn press_home_never_goes_home_on_a_locked_phone() {
    let relay = relay("synthetic-token");
    let fake = Fake::default();
    *fake.locked.lock().unwrap() = Some(json!(true));
    let t = tools(&fake, relay.path());
    let res = t.call("press_home", &json!({"screenshot": false})).unwrap();
    assert!(is_error(&res));
    assert_eq!(
        texts(&res),
        format!(
            "{} It woke the screen instead. {}",
            hive_phone::LOCKED_HOME,
            hive_phone::UNLOCK_STEPS
        )
    );
    assert!(texts(&res).contains("call authenticate"));
    assert_eq!(
        fake.operations(),
        ["request /api/wda/locked", "in_session /wda/pressButton"]
    );
    let wake = fake.seen.lock().unwrap()[1].clone();
    assert_eq!(wake["method"], "POST");
    assert_eq!(wake["body"], json!({"name": "home"}));

    // in a batch too: it stops there
    let batch = t
        .call("batch", &json!({"steps": [{"tool": "press_home"}, {"tool": "tap", "x": 1, "y": 2}], "screenshot": false}))
        .unwrap();
    assert!(is_error(&batch));
    assert!(
        texts(&batch).starts_with("Step 1 (press_home) failed"),
        "{}",
        texts(&batch)
    );

    // a wake that fails is said, and still nothing goes home
    *fake.fail_on.lock().unwrap() = Some("/wda/pressButton".into());
    let res = t.call("press_home", &json!({"screenshot": false})).unwrap();
    assert!(texts(&res)
        .contains("Waking the screen didn't work either (The relay refused /wda/pressButton)."));

    // and when the phone doesn't say whether it's locked, it doesn't guess
    *fake.fail_on.lock().unwrap() = None;
    *fake.locked.lock().unwrap() = Some(Value::Null);
    let res = t.call("press_home", &json!({"screenshot": false})).unwrap();
    assert!(is_error(&res));
    assert!(
        texts(&res).starts_with("press_home refused: the iPhone didn't say whether it's locked")
    );
    assert!(!fake.operations().iter().any(|o| o.contains("homescreen")));
}

// ---------------------------------------------------------------- tests/test_one_way.py

const ASKED: &str = r#"send the backup to the general channel saying "I decided to delete the all-members channel""#;

#[test]
fn a_one_way_step_is_refused_before_the_phone_is_touched() {
    let relay = relay("synthetic-token");
    let fake = Fake::default();
    let t = tools(&fake, relay.path());
    ToolNamespace::set_words(&t, ASKED);
    for (tool, args) in [
        (
            "tap",
            json!({"x": 1, "y": 2, "step": "One-way: sending @Badger a request."}),
        ),
        (
            "tap_element",
            json!({"label": "Send", "step": "One-way: sending it."}),
        ),
        (
            "type_text",
            json!({"text": "hi\n", "step": "One-way: \"general channel please\""}),
        ),
        (
            "batch",
            json!({"steps": [{"tool": "press_home"}],
                         "step": "One-way: asking the bot (you said: \"please export all-members\")"}),
        ),
    ] {
        let res = t.call(tool, &args).unwrap();
        assert!(is_error(&res), "{tool}");
        assert!(texts(&res).starts_with("Refused: a one-way step"), "{tool}");
    }
    assert!(fake.operations().is_empty());
    let asked = json!({"x": 1, "y": 2, "screenshot": false,
                       "step": "One-way: posting it (you said: “I decided to delete the all-members channel”)."});
    assert_eq!(texts(&t.call("tap", &asked).unwrap()), "Tapped (1, 2).");
}

#[test]
fn every_phone_action_says_what_it_does() {
    for tool in hive_phone::tool_list() {
        if ["tap", "tap_element", "type_text", "batch"].contains(&tool["name"].as_str().unwrap()) {
            assert_eq!(
                tool["inputSchema"]["required"][0], "step",
                "{}",
                tool["name"]
            );
        }
    }
    assert!(hive_phone::INSTRUCTIONS.ends_with(
        "Give every action a `step` saying what it does; one that can't be undone starts with \"One-way:\" and \
         quotes the user's words asking for it."
    ));
}

#[test]
fn an_action_looks_again_after_settling_unless_told_not_to() {
    let relay = relay("synthetic-token");
    let fake = Fake::default();
    let result = tools(&fake, relay.path())
        .call("type_text", &json!({"text": "hi"}))
        .unwrap();
    assert_eq!(result["content"].as_array().unwrap().len(), 2);
    assert!(texts(&result).starts_with("Typed.\nPhone screenshot 1x2 points."));
}

#[test]
fn a_phone_error_is_an_error_result_not_a_failure() {
    let relay = relay("synthetic-token");
    let fake = Fake::default();
    *fake.fail_on.lock().unwrap() = Some("/api/screenshot".into());
    let result = tools(&fake, relay.path())
        .call("screenshot", &json!({}))
        .unwrap();
    assert!(is_error(&result));
    assert_eq!(texts(&result), "The relay refused /api/screenshot");
    // Anything else (a missing argument) is a failure for the driver to report.
    assert_eq!(
        tools(&fake, relay.path())
            .call("tap", &json!({"y": 1}))
            .unwrap_err(),
        "'x'"
    );
    let unknown = tools(&fake, relay.path()).call("nope", &json!({})).unwrap();
    assert_eq!(texts(&unknown), "Unknown tool 'nope'");
}

#[test]
fn phone_relay_not_set_is_reported_by_the_call() {
    let _guard = env_lock();
    std::env::remove_var("PHONE_RELAY");
    let result = PhoneTools::new().call("screenshot", &json!({})).unwrap();
    assert!(is_error(&result));
    assert_eq!(
        texts(&result),
        "Phone control isn't set up: PHONE_RELAY (in .env) isn't set."
    );
    let missing = Phone::new(Some("/nonexistent-relay-folder")).err().unwrap();
    assert_eq!(
        missing.0,
        "Phone control isn't set up: can't read the relay's endpoint.txt (No such file or directory)."
    );
}

#[test]
fn batch_runs_steps_quietly_and_stops_at_the_first_failure() {
    let relay = relay("synthetic-token");
    let fake = Fake::default();
    let t = tools(&fake, relay.path());
    let ok = t
        .call("batch", &json!({"steps": [{"tool": "tap", "x": 1, "y": 2}, {"tool": "press_home"}], "screenshot": false}))
        .unwrap();
    assert_eq!(texts(&ok), "Did 2 steps: tap, press_home.");
    // Steps never take a screenshot of their own; the batch looks once.
    let looked = t
        .call("batch", &json!({"steps": [{"tool": "press_home"}]}))
        .unwrap();
    assert!(texts(&looked).starts_with("Did 1 steps: press_home.\nPhone screenshot"));
    assert_eq!(
        fake.operations()
            .iter()
            .filter(|o| *o == "request /api/screenshot")
            .count(),
        1
    );

    *fake.fail_on.lock().unwrap() = Some("/wda/tap".into());
    let failed = t
        .call("batch", &json!({"steps": [{"tool": "press_home"}, {"tool": "tap", "x": 1, "y": 2}, {"tool": "press_home"}]}))
        .unwrap();
    assert!(is_error(&failed));
    assert_eq!(
        texts(&failed),
        "Step 2 (tap) failed after press_home: The relay refused /wda/tap"
    );

    let bad = t
        .call("batch", &json!({"steps": [{"tool": "screenshot"}]}))
        .unwrap();
    assert_eq!(
        texts(&bad),
        "Step 1: 'screenshot' can't go in a batch (use one of tap, tap_element, swipe, type_text, press_home, open_app, wait)."
    );
}

struct Auth(Result<String, String>);
impl PhoneAuthenticator for Auth {
    fn authenticate_phone(&self, _phone: &Phone) -> Result<String, String> {
        self.0.clone()
    }
}

#[test]
fn authenticate_is_alone_argument_free_and_reports_status_only() {
    let relay = relay("synthetic-token");
    let fake = Fake::default();
    let phone = Phone::with_transport(relay.path().to_str(), Box::new(fake.clone())).unwrap();
    let done = "Phone passcode prompt completed. Verify the account sign-in result on screen.";
    let t = PhoneTools::with_phone(phone).with_authenticator(Arc::new(Auth(Ok(done.into()))));
    assert_eq!(texts(&t.call("authenticate", &json!({})).unwrap()), done);
    let with_args = t
        .call("authenticate", &json!({"passcode": "1234"}))
        .unwrap();
    assert!(is_error(&with_args));
    assert_eq!(
        texts(&with_args),
        "Authentication takes no arguments; never pass a passcode."
    );
    // As a batch's only step it is the same call; chained, or with arguments, it is refused.
    assert_eq!(
        texts(
            &t.call("batch", &json!({"steps": [{"tool": "authenticate"}]}))
                .unwrap()
        ),
        done
    );
    for steps in [
        json!([{"tool": "authenticate"}, {"tool": "press_home"}]),
        json!([{"tool": "authenticate", "x": 1}]),
    ] {
        let refused = t.call("batch", &json!({"steps": steps})).unwrap();
        assert!(is_error(&refused));
        assert!(texts(&refused).starts_with("authenticate can't be combined with other steps"));
    }
    let failing = PhoneTools::with_phone(
        Phone::with_transport(relay.path().to_str(), Box::new(fake.clone())).unwrap(),
    )
    .with_authenticator(Arc::new(Auth(Err("secret detail".into()))));
    let refused = failing.call("authenticate", &json!({})).unwrap();
    assert!(is_error(&refused));
    assert!(texts(&refused).starts_with("Phone authentication was not confirmed."));
    assert!(!texts(&refused).contains("secret detail"));
}

#[test]
fn unicode_element_ids_follow_the_word_character_rule_before_clicking() {
    let relay = relay("synthetic-token");
    let fake = Fake::default();
    let phone = Phone::with_transport(relay.path().to_str(), Box::new(fake.clone())).unwrap();
    *fake.element.lock().unwrap() = json!("é-2");
    phone.tap_element("test").unwrap();
    assert_eq!(
        fake.operations(),
        ["tap_element ", "in_session /element/é-2/click"]
    );
    *fake.element.lock().unwrap() = json!("e\u{301}");
    assert!(phone.tap_element("test").is_err());
    *fake.element.lock().unwrap() = Value::Null;
    assert_eq!(
        phone.tap_element("Send").unwrap_err().0,
        "Nothing called \"Send\" on screen."
    );
    assert_eq!(
        fake.operations()
            .iter()
            .filter(|o| o.contains("/click"))
            .count(),
        1
    );
}

#[test]
fn invalid_bundle_never_contacts_the_relay() {
    let relay = relay("synthetic-token");
    let fake = Fake::default();
    let phone = Phone::with_transport(relay.path().to_str(), Box::new(fake.clone())).unwrap();
    let error = phone.open_app("bad/bundle").unwrap_err();
    assert_eq!(
        error.0,
        "'bad/bundle' isn't an app's bundle id (like com.apple.mobilesafari)."
    );
    assert!(phone.open_app("ab").is_err());
    assert!(fake.seen.lock().unwrap().is_empty());
}

#[test]
fn the_phone_remembers_the_session_and_notices_rotation() {
    let relay = relay("synthetic-token");
    let fake = Fake::default();
    let phone = Phone::with_transport(relay.path().to_str(), Box::new(fake.clone())).unwrap();
    assert!(phone.connected().unwrap());
    phone.size(None).unwrap();
    assert_eq!(fake.seen.lock().unwrap().last().unwrap()["session"], "s1");
    // A landscape screenshot of a portrait phone asks for the size again.
    let mut landscape = vec![0u8; 24];
    landscape[16..20].copy_from_slice(&2u32.to_be_bytes());
    landscape[20..24].copy_from_slice(&1u32.to_be_bytes());
    let before = fake.seen.lock().unwrap().len();
    phone.size(Some(&landscape)).unwrap();
    assert_eq!(fake.seen.lock().unwrap().len(), before + 1);
    phone.size(Some(&landscape[..0])).unwrap();
    assert_eq!(fake.seen.lock().unwrap().len(), before + 1);
}

// ---------------------------------------------------------------- the real transport, fake curl

/// A stand-in for curl: it writes down its arguments, how often it ran and its config (stdin), and
/// answers as PHONE_FIXTURE_MODE says. `relay` and `offline` answer like the phone's relay with
/// WebDriverAgent behind it, a 44x96-point phone (tests/test_tools.py's `Relay`), and write each
/// call down as `METHOD PATH BODY` (the body as curl's config quotes it).
const CURL: &str = r#"#!/bin/sh
cfg=$(cat)
printf '%s\n' "$*" >> "$PHONE_FIXTURE_LOG.args"
echo call >> "$PHONE_FIXTURE_LOG.count"
printf '%s\n' "$cfg" >> "$PHONE_FIXTURE_LOG.stdin"
case "$PHONE_FIXTURE_MODE" in
tls) exit 35;;
timeout) echo 'synthetic secret' >&2; exit 28;;
busy) printf '{}\n429'; exit 0;;
relay|offline) ;;
*) printf '{"value": null}\n200'; exit 0;;
esac
for a; do url=$a; done
path=/${url#*://*/}
method=GET; prev=
for a; do [ "$prev" = --request ] && method=$a; prev=$a; done
data=$(printf '%s\n' "$cfg" | sed -n 's/^data-binary = //p')
answer() { printf '%s\n%s' "$2" "$1"; exit 0; }
case "$cfg" in
*'"Authorization: Bearer synthetic-token-1234"'*) ;;
*) answer 401 '{"error": "unauthorized"}';;
esac
printf '%s %s %s\n' "$method" "$path" "$data" >> "$PHONE_FIXTURE_LOG.relay"
if [ "$path" = /health ]; then
  if [ "$PHONE_FIXTURE_MODE" = relay ]; then on=true; else on=false; fi
  answer 200 "{\"connected\": $on, \"pending\": 0}"
fi
[ "$PHONE_FIXTURE_MODE" = offline ] && answer 503 '{"error": "phone offline"}'
case "$path" in
/api/status) answer 200 '{"sessionId": "S1", "value": {"ready": true}}';;
/api/screenshot) answer 200 "$(cat "$PHONE_FIXTURE_LOG.screenshot")";;
/api/wda/activeAppInfo) answer 200 '{"value": {"bundleId": "com.apple.mobilesafari", "name": "Safari"}}';;
/api/wda/locked) if [ -e "$PHONE_FIXTURE_LOG.locked" ]; then answer 200 '{"value": true}'; else answer 200 '{"value": false}'; fi;;
/api/session/S1/window/size) answer 200 '{"value": {"width": 44, "height": 96}}';;
/api/session/S1/source) answer 200 "$(cat "$PHONE_FIXTURE_LOG.source")";;
/api/session/S1/element)
  case "$data" in
  *'\"value\":\"Send\"}"') answer 200 '{"value": {"ELEMENT": "E-1"}}';;
  *'\"using\":\"predicate string\"'*Fallback*) answer 200 '{"value": {"element-6066-11e4-a52e-4f735466cecf": "E-2"}}';;
  *'\"value\":\"Bad ID\"}"') answer 200 '{"value": {"ELEMENT": "../../bad"}}';;
  *) answer 404 '{"value": {"error": "no such element", "message": "unable to find"}}';;
  esac;;
esac
answer 200 '{"value": null}'
"#;

struct CurlFixture {
    dir: tempfile::TempDir,
    old_path: Option<std::ffi::OsString>,
    _guard: MutexGuard<'static, ()>,
}

impl CurlFixture {
    fn new() -> CurlFixture {
        let guard = env_lock();
        let dir = relay("synthetic-token-1234");
        let curl = dir.path().join("curl");
        std::fs::write(&curl, CURL).unwrap();
        std::fs::set_permissions(&curl, std::fs::Permissions::from_mode(0o755)).unwrap();
        let old_path = std::env::var_os("PATH");
        let mut path = dir.path().as_os_str().to_owned();
        path.push(":");
        path.push(old_path.clone().unwrap_or_default());
        std::env::set_var("PATH", path);
        std::env::set_var("PHONE_FIXTURE_LOG", dir.path().join("calls"));
        std::env::remove_var("PHONE_FIXTURE_MODE");
        CurlFixture {
            dir,
            old_path,
            _guard: guard,
        }
    }
    fn phone(&self) -> Phone {
        Phone::new(self.dir.path().to_str()).unwrap()
    }
    fn calls(&self) -> usize {
        std::fs::read_to_string(self.dir.path().join("calls.count"))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }
    fn file(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }
    fn write_secret(&self, secret: &str) {
        std::fs::write(
            self.file("private/secrets.json"),
            json!({"CONTROL_TOKEN": secret}).to_string(),
        )
        .unwrap();
    }
    /// From now on curl answers like the relay, with the phone connected or not.
    fn answer_as_relay(&self, online: bool) {
        let shot = base64::engine::general_purpose::STANDARD.encode(png(132, 288));
        std::fs::write(
            self.file("calls.screenshot"),
            json!({ "value": shot }).to_string(),
        )
        .unwrap();
        std::fs::write(
            self.file("calls.source"),
            json!({ "value": SOURCE }).to_string(),
        )
        .unwrap();
        std::env::set_var("PHONE_FIXTURE_MODE", if online { "relay" } else { "offline" });
    }
    /// What the relay was asked, in order: (method, path, body).
    fn relay_calls(&self) -> Vec<(String, String, Value)> {
        let log = std::fs::read_to_string(self.file("calls.relay")).unwrap_or_default();
        log.lines()
            .map(|line| {
                let mut parts = line.splitn(3, ' ');
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("").to_string();
                let body = match parts.next().unwrap_or("") {
                    "" => Value::Null,
                    quoted => {
                        let text: String = serde_json::from_str(quoted).unwrap();
                        serde_json::from_str(&text).unwrap()
                    }
                };
                (method, path, body)
            })
            .collect()
    }
    fn posts(&self) -> Vec<(String, Value)> {
        self.relay_calls()
            .into_iter()
            .filter(|(method, _, _)| method == "POST")
            .map(|(_, path, body)| (path, body))
            .collect()
    }
}

impl Drop for CurlFixture {
    fn drop(&mut self) {
        match &self.old_path {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
        std::env::remove_var("PHONE_FIXTURE_LOG");
        std::env::remove_var("PHONE_FIXTURE_MODE");
    }
}

#[test]
fn token_and_body_are_only_on_stdin() {
    let fixture = CurlFixture::new();
    fixture
        .phone()
        .request(
            "/api/secret",
            "POST",
            json!({"value": ["synthetic secret"]}),
            true,
        )
        .unwrap();
    assert_eq!(fixture.calls(), 1);
    let args = std::fs::read_to_string(fixture.file("calls.args")).unwrap();
    let stdin = std::fs::read_to_string(fixture.file("calls.stdin")).unwrap();
    assert!(!args.contains("synthetic-token") && !args.contains("synthetic secret"));
    assert!(stdin.contains("synthetic-token") && stdin.contains("synthetic secret"));
}

#[test]
fn action_plans_are_pure_and_an_unknown_action_fails() {
    let fixture = CurlFixture::new();
    let phone = fixture.phone();
    // Through the public API: a swipe is planned without ever contacting the relay first.
    let plan = CoreTransport
        .call(&json!({"operation": "action_plan", "folder": fixture.dir.path(), "base": "http://x",
                      "body": {"name": "swipe", "args": {"from_x": 1, "from_y": 2, "to_x": 3, "to_y": 4, "seconds": 0.3}}}))
        .unwrap();
    assert_eq!(
        plan["value"],
        json!({"path": "/wda/dragfromtoforduration", "in_session": true,
               "body": {"fromX": 1, "fromY": 2, "toX": 3, "toY": 4, "duration": 0.3}})
    );
    let unknown = CoreTransport
        .call(&json!({"operation": "action_plan", "body": {"name": "unknown", "args": {}}}))
        .unwrap();
    assert_eq!(unknown["error"], "Unknown phone action");
    drop(phone);
    assert_eq!(fixture.calls(), 0);
}

fn elements_of(fixture: &CurlFixture, source: &str) -> Result<Vec<String>, hive_phone::PhoneError> {
    let fake = Fake {
        real: true,
        ..Fake::default()
    };
    *fake.source.lock().unwrap() = source.to_string();
    Phone::with_transport(fixture.dir.path().to_str(), Box::new(fake))
        .unwrap()
        .elements()
}

#[test]
fn accessibility_xml_escapes_redaction_and_secure_values() {
    let fixture = CurlFixture::new();
    let source = "<AppiumAUT><XCUIElementTypeButton visible=\"true\" x=\"0\" y=\"1\" width=\"5\" height=\"3\" \
                  label=\"Café &amp; tea\" value=\"synthetic-token-1234\"/>\
                  <XCUIElementTypeSecureTextField visible=\"true\" x=\"1\" y=\"2\" width=\"2\" height=\"2\" \
                  label=\"Password\" value=\"hidden passcode\"/></AppiumAUT>";
    assert_eq!(
        elements_of(&fixture, source).unwrap(),
        [
            "(2, 2) Button \"Café & tea\" value=\"[hidden]\"",
            "(2, 3) SecureTextField \"Password\""
        ]
    );
    assert_eq!(fixture.calls(), 0);
}

#[test]
fn malformed_accessibility_xml_is_a_parse_error() {
    let fixture = CurlFixture::new();
    let error = elements_of(&fixture, "<AppiumAUT><Broken></AppiumAUT>").unwrap_err();
    assert_eq!(error.0, "Invalid phone accessibility XML");
}

#[test]
fn namespace_and_dtd_use_the_compatibility_parser_with_redaction() {
    let fixture = CurlFixture::new();
    fixture.write_secret("synthetic-token-1234");
    let sources = [
        "<AppiumAUT xmlns:x=\"urn:test\"><x:XCUIElementTypeButton visible=\"true\" x=\"0\" y=\"0\" \
         width=\"2\" height=\"2\" label=\"Namespace\" value=\"synthetic-token-1234\"/></AppiumAUT>",
        "<!DOCTYPE AppiumAUT [<!ENTITY title \"Entity\">]><AppiumAUT><XCUIElementTypeButton \
         visible=\"true\" x=\"0\" y=\"0\" width=\"2\" height=\"2\" label=\"&title;\" \
         value=\"synthetic-token-1234\"/></AppiumAUT>",
    ];
    for source in sources {
        let lines = elements_of(&fixture, source).unwrap();
        assert_eq!(lines.len(), 1, "{source}");
        assert!(lines[0].contains("value=\"[hidden]\""), "{}", lines[0]);
        assert!(!lines[0].contains("synthetic-token-1234"));
    }
    let entity = elements_of(&fixture, sources[1]).unwrap();
    assert_eq!(entity[0], "(1, 1) Button \"Entity\" value=\"[hidden]\"");
    assert_eq!(fixture.calls(), 0);
}

#[test]
fn sensitive_busy_and_failure_do_not_retry_or_echo() {
    for mode in ["busy", "timeout", "tls"] {
        let fixture = CurlFixture::new();
        std::env::set_var("PHONE_FIXTURE_MODE", mode);
        let error = fixture
            .phone()
            .request(
                "/api/secret",
                "POST",
                json!({"value": ["synthetic secret"]}),
                true,
            )
            .unwrap_err();
        assert_eq!(fixture.calls(), 1, "{mode}");
        assert!(!error.0.contains("synthetic secret"), "{mode}: {}", error.0);
    }
}

// ---------------------------------------------------------------- tests/test_tools.py's PhoneTest:
// the phone tools through hive-core's real phone transport, with curl answering like the relay

const TOKEN: &str = "synthetic-token-1234";

const SOURCE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Safari" visible="true" x="0" y="0" width="44" height="96">
<XCUIElementTypeButton type="XCUIElementTypeButton" name="Send" label="Send" visible="true" x="30" y="80" width="10" height="6"/>
<XCUIElementTypeTextField type="XCUIElementTypeTextField" label="Address" value="synthetic-token-1234" visible="true" x="2" y="4" width="40" height="5"/>
<XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" label="Password" value="hunter2" visible="true" x="2" y="20" width="40" height="5"/>
<XCUIElementTypeButton type="XCUIElementTypeButton" label="Hidden" visible="false" x="0" y="0" width="1" height="1"/>
</XCUIElementTypeApplication></AppiumAUT>"#;

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// A plain grey PNG (test_tools.py's `png`), its pixels stored without compression.
fn png(width: u32, height: u32) -> Vec<u8> {
    fn chunk(out: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
        out.extend((data.len() as u32).to_be_bytes());
        let body = [kind, data].concat();
        out.extend(&body);
        out.extend(crc32(&body).to_be_bytes());
    }
    let mut rows = Vec::new();
    for _ in 0..height {
        rows.push(0); // no filter
        for _ in 0..width {
            rows.extend([0x80, 0x80, 0x80]);
        }
    }
    let mut zlib = vec![0x78, 0x01];
    let mut blocks = rows.chunks(65535).peekable();
    while let Some(block) = blocks.next() {
        zlib.push(u8::from(blocks.peek().is_none()));
        let len = block.len() as u16;
        zlib.extend(len.to_le_bytes());
        zlib.extend((!len).to_le_bytes());
        zlib.extend(block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in &rows {
        a = (a + u32::from(byte)) % 65521;
        b = (b + a) % 65521;
    }
    zlib.extend(((b << 16) | a).to_be_bytes());
    let ihdr = [
        &width.to_be_bytes()[..],
        &height.to_be_bytes()[..],
        &[8, 2, 0, 0, 0][..],
    ]
    .concat();
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// A JPEG's (width, height), from its start-of-frame segment.
fn jpeg_size(jpeg: &[u8]) -> Option<(u16, u16)> {
    let mut i = 2;
    while i + 9 <= jpeg.len() {
        if jpeg[i] != 0xff {
            return None;
        }
        let marker = jpeg[i + 1];
        if marker == 0xff {
            i += 1;
            continue;
        }
        if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
            let height = u16::from_be_bytes([jpeg[i + 5], jpeg[i + 6]]);
            let width = u16::from_be_bytes([jpeg[i + 7], jpeg[i + 8]]);
            return Some((width, height));
        }
        i += 2 + usize::from(u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]));
    }
    None
}

fn relay_tools(fixture: &CurlFixture) -> PhoneTools {
    PhoneTools::with_phone(fixture.phone()).with_settle(Duration::from_millis(1))
}

#[test]
fn screenshot_is_in_points_with_the_app_in_front() {
    let fixture = CurlFixture::new();
    fixture.answer_as_relay(true);
    let res = relay_tools(&fixture).call("screenshot", &json!({})).unwrap();
    assert!(!is_error(&res), "{}", texts(&res));
    let note = res["content"][0]["text"].as_str().unwrap();
    assert!(note.contains("44x96 points"), "{note}");
    assert!(note.contains("Safari (com.apple.mobilesafari)"), "{note}");
    let jpeg = base64::engine::general_purpose::STANDARD
        .decode(res["content"][1]["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
    let (width, _) = jpeg_size(&jpeg).expect("a JPEG frame");
    assert_eq!(width, 44); // one pixel per point: what taps use
}

#[test]
fn actions_go_to_webdriveragent() {
    let fixture = CurlFixture::new();
    fixture.answer_as_relay(true);
    let tools = relay_tools(&fixture);
    for (tool, args) in [
        ("tap", json!({"x": 10, "y": 20, "screenshot": false})),
        ("type_text", json!({"text": "pizza\n", "screenshot": false})),
        (
            "open_app",
            json!({"bundle_id": "com.apple.Maps", "screenshot": false}),
        ),
        ("press_home", json!({"screenshot": false})),
        (
            "swipe",
            json!({"from_x": 20, "from_y": 80, "to_x": 20, "to_y": 20, "screenshot": false}),
        ),
    ] {
        let res = tools.call(tool, &args).unwrap();
        assert!(!is_error(&res), "{tool}: {}", texts(&res));
    }
    let posts = fixture.posts();
    for expected in [
        ("/api/session/S1/wda/tap", json!({"x": 10.0, "y": 20.0})),
        ("/api/session/S1/wda/keys", json!({"value": ["pizza\n"]})),
        (
            "/api/session/S1/wda/apps/activate",
            json!({"bundleId": "com.apple.Maps"}),
        ),
        ("/api/wda/homescreen", json!({})),
        (
            "/api/session/S1/wda/dragfromtoforduration",
            json!({"fromX": 20.0, "fromY": 80.0, "toX": 20.0, "toY": 20.0, "duration": 0.3}),
        ),
    ] {
        let expected = (expected.0.to_string(), expected.1);
        assert!(posts.contains(&expected), "{expected:?} not in {posts:?}");
    }
    let settings: Vec<_> = posts
        .iter()
        .filter(|(path, _)| path.ends_with("/appium/settings"))
        .map(|(_, body)| body.clone())
        .collect();
    assert_eq!(
        settings,
        [json!({"settings": {"waitForIdleTimeout": 0, "animationCoolOffTimeout": 0}})]
    );
}

#[test]
fn a_locked_phone_is_woken_and_never_sent_home() {
    let fixture = CurlFixture::new();
    fixture.answer_as_relay(true);
    std::fs::write(fixture.file("calls.locked"), "").unwrap();
    let res = relay_tools(&fixture)
        .call("press_home", &json!({"screenshot": false}))
        .unwrap();
    assert!(is_error(&res));
    assert!(texts(&res).starts_with(hive_phone::LOCKED_HOME));
    let calls = fixture.relay_calls();
    assert!(
        calls.contains(&("GET".into(), "/api/wda/locked".into(), Value::Null)),
        "{calls:?}"
    );
    assert!(
        !calls.iter().any(|(_, path, _)| path.contains("homescreen")),
        "{calls:?}"
    );
    assert!(fixture.posts().contains(&(
        "/api/session/S1/wda/pressButton".into(),
        json!({"name": "home"})
    )));
}

#[test]
fn elements_list_whats_visible_and_hide_secrets() {
    let fixture = CurlFixture::new();
    fixture.answer_as_relay(true);
    let res = relay_tools(&fixture).call("elements", &json!({})).unwrap();
    let listing = res["content"][0]["text"].as_str().unwrap();
    assert!(listing.contains("(35, 83) Button \"Send\""), "{listing}");
    assert!(listing.contains("Address"), "{listing}");
    assert!(!listing.contains(TOKEN), "{listing}");
    assert!(!listing.contains("hunter2"), "{listing}"); // a password field's contents
    assert!(!listing.contains("Hidden"), "{listing}"); // visible="false"
}

#[test]
fn tap_element_fallback_and_invalid_id() {
    let fixture = CurlFixture::new();
    fixture.answer_as_relay(true);
    let phone = fixture.phone();
    phone.tap_element("Fallback").unwrap();
    let calls = fixture.relay_calls();
    let call = |method: &str, path: &str, body: Value| (method.to_string(), path.to_string(), body);
    let predicate = call(
        "POST",
        "/api/session/S1/element",
        json!({"using": "predicate string", "value": "name == \"Fallback\" OR label == \"Fallback\""}),
    );
    assert!(calls.contains(&predicate), "{calls:?}");
    let click = call("POST", "/api/session/S1/element/E-2/click", json!({}));
    assert!(calls.contains(&click), "{calls:?}");
    assert!(phone.tap_element("Bad ID").is_err());
    assert!(!fixture
        .relay_calls()
        .iter()
        .any(|(_, path, _)| path.contains("../../bad")));
}

#[test]
fn offline_phone_says_how_to_connect_it() {
    let fixture = CurlFixture::new();
    fixture.answer_as_relay(false);
    assert!(!fixture.phone().connected().unwrap());
    let res = relay_tools(&fixture)
        .call("tap", &json!({"x": 1, "y": 1}))
        .unwrap();
    assert!(is_error(&res));
    assert!(texts(&res).contains("WebDriverAgent relay app"), "{}", texts(&res));
}
