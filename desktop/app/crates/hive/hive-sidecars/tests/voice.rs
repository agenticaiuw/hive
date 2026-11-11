//! The voice sidecar's client (Ears, Voice, Voiceprint) against tests/fakes/fake_voice.py: the real
//! python/sidecar_voice.py protocol and speech.py's Voice, with no models, microphone or speakers
//! (each sentence "plays" as `sleep`). Ports the Ears/speech parts of tests/test_voice.py and
//! tests/test_speech.py, and measures what the process boundary adds.
//!
//! The fake needs only the standard library: `python3` (HIVE_TEST_PYTHON overrides it).

use hive_sidecars::{VoiceOptions, VoiceSidecar};
use serde_json::{json, Map, Value};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};

type Record<T> = Arc<Mutex<Vec<T>>>;

fn record<T>() -> Record<T> {
    Arc::new(Mutex::new(Vec::new()))
}

fn python() -> OsString {
    std::env::var_os("HIVE_TEST_PYTHON").unwrap_or_else(|| "python3".into())
}

fn fake_voice() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fakes/fake_voice.py")
}

struct Fake {
    sidecar: VoiceSidecar,
    log: Record<String>,
}

/// The fake sidecar with these environment variables (TTS_VOICE=say and 0.3 s sentences unless
/// given) and options.
fn start_with(
    env: &[(&str, &str)],
    extra: &[&str],
    options: impl FnOnce(&mut VoiceOptions),
) -> std::io::Result<Fake> {
    let mut vars: Vec<(String, String)> = vec![
        ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
        ("TTS_VOICE".into(), "say".into()),
        ("FAKE_PLAY_SECONDS".into(), "0.3".into()),
    ];
    for (key, value) in env {
        vars.retain(|(k, _)| k != key);
        vars.push((key.to_string(), value.to_string()));
    }
    let mut command: Vec<OsString> = vec!["/usr/bin/env".into()];
    command.extend(vars.iter().map(|(k, v)| OsString::from(format!("{k}={v}"))));
    command.push(python());
    command.push(fake_voice().into_os_string());
    command.extend(extra.iter().map(OsString::from));
    let log: Record<String> = record();
    let lines = log.clone();
    let mut opts = VoiceOptions {
        command,
        log: Arc::new(move |line: &str| lines.lock().unwrap().push(line.to_string())),
        ready_timeout: Duration::from_secs(20),
        ..VoiceOptions::default()
    };
    options(&mut opts);
    Ok(Fake {
        sidecar: VoiceSidecar::start(opts)?,
        log,
    })
}

fn start(env: &[(&str, &str)]) -> Fake {
    start_with(env, &[], |_| {}).expect("the fake voice sidecar starts")
}

impl Fake {
    /// Scripts the fake ({"cmd": "fake", ...}) and returns what it says about itself: deaf, may_speak,
    /// calls (to Ears.listen and Ears.cut), played (what Voice "played"), and timestamps.
    fn fake(&self, fields: Value) -> Value {
        let Value::Object(fields) = fields else {
            panic!("not an object")
        };
        self.sidecar
            .request_raw("fake", fields)
            .expect("the fake answers")
    }

    fn played(&self) -> Vec<String> {
        let reply = self.fake(json!({}));
        reply["played"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    }

    fn logged(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

fn wait_for(what: &str, timeout: f64, check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    while Instant::now() < deadline {
        if check() {
            return;
        }
        sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn ears_that_work_but_report_a_problem_still_say_what_hears_you() {
    // Parakeet up, Silero VAD down (listen.py sets ears.error): the reply's "ears_error" is about
    // the ears, not a failed request, so the model and its description still come through.
    let fake = start(&[("FAKE_EARS_ERROR", "Silero VAD: no model")]);
    let ears = fake.sidecar.ears();
    assert_eq!(ears.describe(), "Parakeet (fake)");
    assert!(ears.has_model());
    assert_eq!(ears.error().as_deref(), Some("Silero VAD: no model"));
}

#[test]
fn it_says_what_it_has() {
    let fake = start(&[]);
    let ears = fake.sidecar.ears();
    let voice = fake.sidecar.voice().expect("a voice");
    assert_eq!(ears.describe(), "Parakeet (fake)");
    assert!(ears.has_model());
    assert_eq!(ears.error(), None);
    assert_eq!(voice.voice(), "say");
    assert_eq!(voice.describe(), "the Mac's voice");
    assert_eq!(
        ears.voiceprint().expect("a voiceprint").describe(),
        "on (your voice, VOICE_MATCH 0.4)"
    );
    assert!(ears.listening());
    assert!(fake.sidecar.pid().is_some());
    assert_eq!(fake.sidecar.exited(), None);
}

#[test]
fn words_show_up_as_you_talk_then_all_of_it_with_when_you_stopped() {
    let fake = start(&[]);
    let ears = fake.sidecar.ears();
    assert!(ears.heard_times().is_empty());
    let heard: Record<(String, bool, f64)> = record();
    let (into, reader) = (heard.clone(), ears.clone());
    ears.set_on_text(move |text, final_| {
        // heard_times are already those of this text when on_text hears it's final
        let times = reader.heard_times();
        let gap = match (times.get("stopped"), times.get("written")) {
            (Some(stopped), Some(written)) if final_ => {
                written.duration_since(*stopped).as_secs_f64()
            }
            _ => -1.0,
        };
        into.lock().unwrap().push((text.to_string(), final_, gap));
    });
    fake.fake(json!({"hear": "open"}));
    fake.fake(json!({"hear": "open safari"}));
    fake.fake(json!({"hear": "Open Safari.", "final": true}));
    wait_for("the final text", 5.0, || heard.lock().unwrap().len() == 3);
    let heard = heard.lock().unwrap().clone();
    assert_eq!(heard[0], ("open".to_string(), false, -1.0));
    assert_eq!(heard[1], ("open safari".to_string(), false, -1.0));
    assert_eq!((heard[2].0.as_str(), heard[2].1), ("Open Safari.", true));
    assert!(
        (heard[2].2 - 0.9).abs() < 0.05,
        "you stopped 0.9 s before it was written: {}",
        heard[2].2
    );
    let times = ears.heard_times();
    assert_eq!(
        times.keys().collect::<Vec<_>>(),
        ["decided", "stopped", "written"]
    );
    assert!(times["written"].elapsed() < Duration::from_secs(3));
}

#[test]
fn it_says_you_started_talking_before_any_words() {
    let fake = start(&[]);
    let ears = fake.sidecar.ears();
    let order: Record<String> = record();
    let (a, b) = (order.clone(), order.clone());
    ears.set_on_speech(move || a.lock().unwrap().push("speech".into()));
    ears.set_on_text(move |text, _| b.lock().unwrap().push(text.into()));
    fake.fake(json!({"speech": true, "hear": "wait"}));
    wait_for("the words", 5.0, || order.lock().unwrap().len() == 2);
    assert_eq!(*order.lock().unwrap(), ["speech", "wait"]);
}

#[test]
fn cut_ends_what_you_were_saying_and_then_runs_after_it() {
    let fake = start(&[]);
    let ears = fake.sidecar.ears();
    let order: Record<String> = record();
    let into = order.clone();
    ears.set_on_text(move |text, final_| into.lock().unwrap().push(format!("{text} {final_}")));
    fake.fake(json!({"hear": "open calculator"}));
    let then = order.clone();
    ears.cut_then(move || then.lock().unwrap().push("then".into()));
    wait_for("then", 5.0, || order.lock().unwrap().len() == 3);
    assert_eq!(
        *order.lock().unwrap(),
        ["open calculator false", "open calculator true", "then"]
    );
    ears.cut(); // nothing being said: nothing more
    assert_eq!(
        fake.fake(json!({}))["calls"],
        json!([["cut", true], ["cut", false]])
    );
    sleep(Duration::from_millis(200));
    assert_eq!(order.lock().unwrap().len(), 3);
}

#[test]
fn listen_false_ends_what_you_were_saying_and_stops_listening() {
    let fake = start(&[]);
    let ears = fake.sidecar.ears();
    let finals: Record<String> = record();
    let into = finals.clone();
    ears.set_on_text(move |text, final_| {
        if final_ {
            into.lock().unwrap().push(text.into());
        }
    });
    fake.fake(json!({"hear": "type hello"}));
    ears.listen(false);
    assert!(!ears.listening());
    ears.listen(false); // already off: nothing is sent
    wait_for("the final text", 5.0, || !finals.lock().unwrap().is_empty());
    assert_eq!(*finals.lock().unwrap(), ["type hello"]);
    fake.fake(json!({"hear": "not listening"}));
    ears.listen(true);
    assert!(ears.listening());
    assert_eq!(
        fake.fake(json!({}))["calls"],
        json!([["listen", false], ["cut", false], ["listen", true]])
    );
    assert_eq!(*finals.lock().unwrap(), ["type hello"]);
}

#[test]
fn someone_else_is_left_out_and_its_own_voice_is_told_apart() {
    let fake = start(&[]);
    let ears = fake.sidecar.ears();
    let voiceprint = ears.voiceprint().unwrap();
    let ignored: Record<(f64, f64, bool)> = record();
    let into = ignored.clone();
    let machine = voiceprint.clone();
    ears.set_on_ignored(move |seconds, similarity| {
        into.lock()
            .unwrap()
            .push((seconds, similarity, machine.heard_machine()));
    });
    fake.fake(json!({"ignored": [1.2, 0.1], "machine": false}));
    fake.fake(json!({"ignored": [2.5, 0.8], "machine": true}));
    wait_for("on_ignored", 5.0, || ignored.lock().unwrap().len() == 2);
    assert_eq!(
        *ignored.lock().unwrap(),
        [(1.2, 0.1, false), (2.5, 0.8, true)]
    );
    assert!(voiceprint.heard_machine());
}

// -- speech (tests/test_speech.py, with speech.py's real Voice in `say` mode) --

#[test]
fn it_waits_for_you_to_finish_talking() {
    let fake = start(&[]);
    let ears = fake.sidecar.ears();
    let voice = fake.sidecar.voice().unwrap();
    fake.fake(json!({"talking": true}));
    wait_for("talking", 5.0, || ears.talking());
    assert!(!fake.sidecar.may_speak());
    assert_eq!(fake.fake(json!({}))["may_speak"], json!(false));
    voice.say("Something to say once you're done.");
    assert!(!voice.wait(Some(Duration::from_secs(2))));
    assert!(fake.played().is_empty());
    fake.fake(json!({"talking": false}));
    assert!(voice.wait(Some(Duration::from_secs(10))));
    assert!(!ears.talking());
    assert!(fake.sidecar.may_speak());
    assert_eq!(fake.played(), ["Something to say once you're done."]);
}

#[test]
fn stop_drops_the_rest() {
    let fake = start(&[("FAKE_PLAY_SECONDS", "1")]);
    let voice = fake.sidecar.voice().unwrap();
    let plays: Record<String> = record();
    let into = plays.clone();
    voice.set_on_play(move |words| into.lock().unwrap().push(words.into()));
    voice.say("This is the first sentence, and it goes on for a little while.");
    voice.say("This one should never be heard.");
    voice.say("Nor this one.");
    wait_for("the first sentence", 10.0, || {
        !plays.lock().unwrap().is_empty()
    });
    voice.stop();
    assert!(voice.wait(Some(Duration::from_secs(10))));
    assert_eq!(fake.played().len(), 1);
    voice.say("Talking again works."); // a new generation
    assert!(voice.wait(Some(Duration::from_secs(10))));
    assert_eq!(fake.played().len(), 2);
    assert_eq!(
        plays.lock().unwrap().last().unwrap(),
        "Talking again works."
    );
}

#[test]
fn audible_while_playing_and_a_moment_after() {
    let fake = start(&[]);
    let voice = fake.sidecar.voice().unwrap();
    assert!(!voice.audible());
    assert_eq!(voice.quiet_for(), 1e9);
    let plays: Record<String> = record();
    let into = plays.clone();
    voice.set_on_play(move |words| into.lock().unwrap().push(words.into()));
    voice.say("Short and sweet.");
    wait_for("it to play", 10.0, || !plays.lock().unwrap().is_empty());
    assert!(voice.audible());
    assert_eq!(voice.quiet_for(), 0.0);
    assert!(voice.wait(Some(Duration::from_secs(10))));
    assert!(voice.audible()); // the room is still echoing
    sleep(Duration::from_secs_f64(hive_sidecars::voice::ECHO + 0.1));
    assert!(!voice.audible());
    assert!(voice.quiet_for() > hive_sidecars::voice::ECHO);
}

#[test]
fn falls_back_to_the_macs_voice() {
    let fake = start(&[("TTS_VOICE", "af_heart")]); // Kokoro, whose model isn't there
    let voice = fake.sidecar.voice().unwrap();
    assert_eq!(voice.voice(), "af_heart");
    assert!(
        voice.describe().starts_with("the Mac's voice (Kokoro: "),
        "{}",
        voice.describe()
    );
    voice.say("Still talking.");
    assert!(voice.wait(Some(Duration::from_secs(10))));
    assert_eq!(fake.played(), ["Still talking."]);
    drop(fake);
    assert_eq!(
        start(&[]).sidecar.voice().unwrap().describe(),
        "the Mac's voice"
    );
}

#[test]
fn saying_nothing_is_done_at_once() {
    let fake = start(&[]);
    let voice = fake.sidecar.voice().unwrap();
    voice.say("   ");
    assert!(voice.wait(Some(Duration::from_secs(5))));
    assert!(fake.played().is_empty());
}

#[test]
fn without_kokoro_it_learns_nothing_of_its_voice() {
    let fake = start(&[]);
    assert_eq!(fake.sidecar.learn_its_voice(), Ok(false));
}

#[test]
fn without_a_voice_or_a_voiceprint() {
    let fake = start_with(&[], &[], |o| {
        o.speak = false;
        o.voiceprint = false;
        o.listening = false;
    })
    .unwrap();
    assert!(fake.sidecar.voice().is_none());
    let ears = fake.sidecar.ears();
    assert!(ears.voiceprint().is_none());
    assert!(!ears.listening());
    assert_eq!(fake.sidecar.learn_its_voice(), Ok(false));
    let mut what = Map::new();
    what.insert("what".into(), "voiceprint".into());
    assert_eq!(
        fake.sidecar.request_raw("describe", what),
        Err("there's no voiceprint to describe".into())
    );
    assert!(fake.sidecar.may_speak());
    assert!(!fake.sidecar.deaf());
}

// -- voice_agent.py's rules, in the sidecar --

#[test]
fn deaf_only_while_its_voice_comes_out_of_the_speakers_unheard() {
    let fake = start(&[("FAKE_PLAY_SECONDS", "3")]);
    let voice = fake.sidecar.voice().unwrap();
    let deaf = || fake.fake(json!({}))["deaf"].as_bool().unwrap();
    assert!(!deaf()); // quiet
    assert!(!fake.sidecar.deaf());
    let plays: Record<String> = record();
    let into = plays.clone();
    voice.set_on_play(move |words| into.lock().unwrap().push(words.into()));
    voice.say("I opened Calculator for you.");
    wait_for("it to play", 10.0, || !plays.lock().unwrap().is_empty());
    assert!(deaf()); // its voice, out of the speakers, and nothing takes it out of what the mic hears
    fake.fake(json!({"speakers": false}));
    assert!(!deaf()); // headphones
    fake.fake(json!({"speakers": true, "mac_plays": true}));
    assert!(!deaf()); // the echo canceller hears the Mac
    wait_for("the status", 2.0, || fake.sidecar.ears().hears_the_mac());
    assert!(!fake.sidecar.deaf());
    voice.stop();
    assert!(voice.wait(Some(Duration::from_secs(5))));
}

#[test]
fn it_hears_the_mac_only_while_the_sidecar_says_so_lately() {
    let fake = start(&[]);
    let ears = fake.sidecar.ears();
    assert!(!ears.hears_the_mac());
    fake.fake(json!({"mac_plays": true, "mic_level": 0.42}));
    wait_for("it to hear the Mac", 2.0, || ears.hears_the_mac());
    wait_for("the mic level", 2.0, || ears.mic_level() == 0.42);
    let microphone = ears.microphone().expect("the microphone");
    assert_eq!(microphone.name, "Fake Microphone");
    assert_eq!(
        microphone.describe(),
        "on (it takes what the Mac plays out of what it hears)"
    );
    assert_eq!(
        (
            microphone.error,
            microphone.tap_error,
            microphone.canceller_error
        ),
        (None, None, None)
    );
    assert_eq!(ears.mic_name(), "Fake Microphone");
    assert_eq!(ears.mic_error(), None);
    wait_for("it to stop hearing the Mac", 3.0, || !ears.hears_the_mac());
}

// -- the process --

#[test]
fn what_the_model_code_prints_goes_to_the_log() {
    let fake = start(&[]);
    fake.fake(json!({"print": "   ✗ voice: something broke"}));
    assert!(fake.sidecar.send_raw(json!({"cmd": "nope"})));
    fake.fake(json!({}));
    let logged = fake.logged();
    assert!(
        logged.contains(&"   ✗ voice: something broke".to_string()),
        "{logged:?}"
    );
    assert!(
        logged.contains(&"   ✗ voice sidecar: no command 'nope'".to_string()),
        "{logged:?}"
    );
}

#[test]
fn when_the_sidecar_stops_nothing_waits_for_it() {
    let fake = start(&[("FAKE_PLAY_SECONDS", "2")]);
    let ears = fake.sidecar.ears();
    let voice = fake.sidecar.voice().unwrap();
    voice.say("Something long.");
    let thens: Record<&str> = record();
    fake.fake(json!({"stall": 5}));
    let then = thens.clone();
    ears.cut_then(move || then.lock().unwrap().push("waiting"));
    fake.sidecar.send_raw(json!({"cmd": "fake", "exit": 7}));
    assert!(voice.wait(Some(Duration::from_secs(5))));
    wait_for("the cut's then", 5.0, || thens.lock().unwrap().len() == 1);
    assert_eq!(
        fake.sidecar.exited().as_deref(),
        Some("the voice sidecar stopped (exit 7)")
    );
    assert!(fake
        .logged()
        .contains(&"   ✗ the voice sidecar stopped (exit 7)".to_string()));
    let then = thens.clone();
    ears.cut_then(move || then.lock().unwrap().push("after"));
    wait_for("a then after it stopped", 5.0, || {
        thens.lock().unwrap().len() == 2
    });
    assert_eq!(
        ears.describe(),
        "nothing (Parakeet: the voice sidecar stopped (exit 7))"
    );
    assert_eq!(
        ears.error().as_deref(),
        Some("the voice sidecar stopped (exit 7)")
    );
    assert!(fake.sidecar.learn_its_voice().is_err());
    assert!(!voice.audible());
    voice.say("Nobody hears this.");
    assert!(voice.wait(Some(Duration::from_secs(1))));
}

#[test]
fn it_doesnt_start_if_the_sidecar_dies_first() {
    let error = start_with(&[], &["--die"], |_| {})
        .err()
        .expect("no sidecar");
    assert_eq!(error.to_string(), "the voice sidecar stopped (exit 3)");
}

#[test]
fn close_stops_it_talking_and_it_exits() {
    let fake = start(&[("FAKE_PLAY_SECONDS", "5")]);
    let voice = fake.sidecar.voice().unwrap();
    let pid = fake.sidecar.pid().unwrap() as i32;
    let plays: Record<String> = record();
    let into = plays.clone();
    voice.set_on_play(move |words| into.lock().unwrap().push(words.into()));
    voice.say("A long goodbye.");
    wait_for("it to play", 10.0, || !plays.lock().unwrap().is_empty());
    let started = Instant::now();
    fake.sidecar.close();
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "it exited at once: {:?}",
        started.elapsed()
    );
    // SAFETY: signal 0 only asks whether the process exists.
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert!(voice.wait(Some(Duration::from_secs(1))));
    assert!(
        !fake.logged().iter().any(|line| line.contains('✗')),
        "{:?}",
        fake.logged()
    );
}

// -- latency --

/// The clock both sides can read: CLOCK_UPTIME_RAW (Python's time.CLOCK_UPTIME_RAW).
fn raw_clock() -> f64 {
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: now is a valid timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &mut now) };
    now.tv_sec as f64 + now.tv_nsec as f64 / 1e9
}

fn summary(what: &str, mut ms: Vec<f64>) -> f64 {
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = ms[ms.len() / 2];
    let p95 = ms[(ms.len() * 95 / 100).min(ms.len() - 1)];
    println!(
        "sidecar latency: {what}: {median:.2} ms median, {p95:.2} ms p95, {:.2} ms max (n={})",
        ms[ms.len() - 1],
        ms.len()
    );
    median
}

fn floats(value: &Value) -> Vec<f64> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}

/// What the boundary adds: run with `-- --nocapture --test-threads=1 latency` for the numbers.
#[test]
fn latency_of_the_sidecar_boundary() {
    let fake = start(&[("FAKE_PLAY_SECONDS", "0.02")]);
    let ears = fake.sidecar.ears();
    let voice = fake.sidecar.voice().unwrap();

    // Heard text: the sidecar's on_text -> the agent's on_text.
    let got: Record<f64> = record();
    let into = got.clone();
    ears.set_on_text(move |_, _| into.lock().unwrap().push(raw_clock()));
    let n = 100;
    let sent = floats(&fake.fake(json!({"bench": n}))["stamps"]);
    wait_for("the bench's texts", 5.0, || got.lock().unwrap().len() == n);
    let got = got.lock().unwrap().clone();
    let heard = summary(
        "heard text, sidecar -> on_text",
        sent.iter().zip(&got).map(|(s, g)| (g - s) * 1e3).collect(),
    );

    // A command: the agent -> the sidecar's handler.
    let mut sends = Vec::new();
    for _ in 0..n {
        sends.push(raw_clock());
        fake.sidecar.send_raw(json!({"cmd": "fake", "stamp": true}));
        sleep(Duration::from_millis(2));
    }
    let arrived = floats(&fake.fake(json!({}))["arrived"]);
    summary(
        "command, agent -> sidecar",
        sends
            .iter()
            .zip(&arrived)
            .map(|(s, a)| (a - s) * 1e3)
            .collect(),
    );

    // Speech start: Voice.say in the agent -> speech.Voice.say, and the sentence starting -> on_play.
    let plays: Record<f64> = record();
    let into = plays.clone();
    voice.set_on_play(move |_| into.lock().unwrap().push(raw_clock()));
    let mut says = Vec::new();
    for i in 0..30 {
        says.push(raw_clock());
        voice.say(&format!("Sentence number {i}."));
        assert!(voice.wait(Some(Duration::from_secs(5))));
    }
    let reply = fake.fake(json!({}));
    let (said_at, play_at) = (floats(&reply["said_at"]), floats(&reply["play_at"]));
    let plays = plays.lock().unwrap().clone();
    let say = summary(
        "say, agent -> speech.Voice.say",
        says.iter()
            .zip(&said_at)
            .map(|(s, a)| (a - s) * 1e3)
            .collect(),
    );
    summary(
        "on_play, sidecar -> agent",
        play_at
            .iter()
            .zip(&plays)
            .map(|(p, g)| (g - p) * 1e3)
            .collect(),
    );
    summary(
        "speech start, agent's say -> agent's on_play (includes speech.py's own queues)",
        says.iter()
            .zip(&plays)
            .map(|(s, g)| (g - s) * 1e3)
            .collect(),
    );
    assert!(
        heard < 20.0 && say < 20.0,
        "the boundary adds {heard:.1} ms to heard text and {say:.1} ms to say"
    );
}
