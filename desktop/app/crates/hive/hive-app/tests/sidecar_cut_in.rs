//! The voice sidecar's callbacks all run on one thread of hive-sidecars' (on_text, on_speech,
//! on_ignored, cut's `then`, on_play). Wired to the agent (`real::wire_voice`), each only puts an
//! event on the agent's queue or stops the voice, so talking over its voice stops it at once even
//! while the agent is busy with what you said before.
//!
//! Runs the real sidecar client against hive-sidecars' tests/fakes/fake_voice.py (no models,
//! microphone or speakers: each sentence "plays" as a `sleep`). Needs `python3`
//! (HIVE_TEST_PYTHON overrides it).

mod support;

use hive_app::parts::{Backend, Captions, Console, Ears, Host, Mac, Voice};
use hive_app::real::{wire_voice, SidecarEars, SidecarVoice};
use hive_app::{Event, Parts, VoiceAgent};
use hive_sidecars::{VoiceOptions, VoiceSidecar};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::{wait_for, FakeBackend, FakeCaptions, FakeConsole, FakeHost, FakeMac, Isolated, Rec};

fn fake_voice() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../hive-sidecars/tests/fakes/fake_voice.py")
}

/// The fake sidecar; each sentence plays for `seconds`.
fn sidecar(seconds: f64) -> Arc<VoiceSidecar> {
    let mut command: Vec<OsString> = vec!["/usr/bin/env".into()];
    for var in [
        "PYTHONDONTWRITEBYTECODE=1".to_owned(),
        "TTS_VOICE=say".into(),
        format!("FAKE_PLAY_SECONDS={seconds}"),
    ] {
        command.push(var.into());
    }
    command.push(std::env::var_os("HIVE_TEST_PYTHON").unwrap_or_else(|| "python3".into()));
    command.push(fake_voice().into_os_string());
    let options = VoiceOptions {
        command,
        speak: true,
        voiceprint: false,
        listening: false,
        log: Arc::new(|_line: &str| {}),
        ready_timeout: Duration::from_secs(20),
    };
    Arc::new(VoiceSidecar::start(options).expect("the fake voice sidecar starts"))
}

/// Scripts the fake ({"cmd": "fake", ...}) and returns what it says about itself.
fn fake(sidecar: &VoiceSidecar, fields: Value) -> Value {
    let Value::Object(fields) = fields else {
        panic!("not an object")
    };
    sidecar
        .request_raw("fake", fields)
        .expect("the fake answers")
}

fn played(sidecar: &VoiceSidecar) -> Vec<String> {
    let reply = fake(sidecar, json!({}));
    reply["played"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn talking_over_its_voice_stops_it_while_the_agent_is_busy_with_what_you_said() {
    let env = Isolated::new();
    let sidecar = sidecar(10.0);
    let trace: Arc<Rec<String>> = Arc::default();
    let host = Arc::new(FakeHost::new(trace.clone()));
    let backend = Arc::new(FakeBackend::new(trace));
    let captions = Arc::new(FakeCaptions::default());
    let voice = sidecar.voice().expect("a voice");
    let agent = VoiceAgent::new(Parts {
        ears: Arc::new(SidecarEars::new(sidecar.clone())) as Arc<dyn Ears>,
        voice: Some(Arc::new(SidecarVoice(voice.clone())) as Arc<dyn Voice>),
        captions: captions.clone() as Arc<dyn Captions>,
        mac: Arc::new(FakeMac::new(env.path().join("no-helper.sock"))) as Arc<dyn Mac>,
        backend: backend.clone() as Arc<dyn Backend>,
        host: host.clone() as Arc<dyn Host>,
        console: Arc::new(FakeConsole::default()) as Arc<dyn Console>,
        app: false,
    });
    wire_voice(&sidecar, &agent);
    let looping = {
        let agent = agent.clone();
        std::thread::spawn(move || agent.run())
    };
    agent.put(Event::Toggle); // tap fn: it listens
    wait_for("it to listen", 10.0, || sidecar.ears().listening());

    // What you said is being saved: the main loop is stuck there.
    host.admitting.close();
    fake(&sidecar, json!({"hear": "Open Safari.", "final": true}));
    wait_for("the main loop to be busy", 10.0, || {
        host.admitting.waiting.load(Ordering::SeqCst) == 1
    });

    // Meanwhile its voice says something long, and you talk over it.
    agent.say(
        "Here is a long answer that takes ten seconds to say.",
        None,
        None,
    );
    wait_for("its voice to play", 10.0, || voice.audible());
    let began = Instant::now();
    fake(&sidecar, json!({"hear": "Wait", "final": false})); // on_text first, then on_speech
    fake(&sidecar, json!({"speech": true}));
    assert!(
        voice.wait(Some(Duration::from_millis(1500))),
        "its voice didn't stop"
    );
    let took = began.elapsed();
    assert!(
        took < Duration::from_millis(1500),
        "it took {took:?} to stop"
    );
    assert_eq!(host.admitting.waiting.load(Ordering::SeqCst), 1); // the loop is still busy
    assert_eq!(
        played(&sidecar),
        ["Here is a long answer that takes ten seconds to say."]
    );
    assert_eq!(captions.of("say").last().map(String::as_str), Some("")); // the captions cleared too

    host.admitting.open();
    wait_for("the request", 10.0, || !backend.tasks.is_empty());
    assert_eq!(backend.texts(), ["Open Safari."]);
    agent.stopped.set(true);
    looping.join().unwrap();
    agent.shutdown();
    sidecar.close();
}
