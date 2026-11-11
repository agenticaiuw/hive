//! Task recordings (tests/test_task_recording.py): the timeline and subtitles line up with the
//! video; nothing is really recorded (a fake screencapture and a fake Mac).

mod common;

use hive_knowledge::task_recording::{self, Capture, Probe, Recorder, RecorderOptions};
use serde_json::{json, Value};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// screencapture that ends on SIGINT, or (with `quits`) on its own with that code.
struct FakeCapture {
    code: Option<i32>,
}

impl Capture for FakeCapture {
    fn poll(&mut self) -> Option<i32> {
        self.code
    }
    fn interrupt(&mut self) {
        self.code = Some(0);
    }
    fn wait(&mut self, _timeout: Duration) -> bool {
        true
    }
    fn kill(&mut self) {
        self.code = Some(-9);
    }
}

struct FakeMac {
    quits: Option<i32>,
    started: AtomicUsize,
}

impl Probe for FakeMac {
    fn front_window(&self) -> Option<(String, String)> {
        Some(("Safari".into(), "WIN".into()))
    }
    fn idle_seconds(&self) -> f64 {
        30.0
    }
    fn video_length(&self, _path: &Path) -> Option<f64> {
        Some(1.5)
    }
    fn start_capture(&self, _movie: &Path, _log: File) -> std::io::Result<Box<dyn Capture>> {
        self.started.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(FakeCapture { code: self.quits }))
    }
}

fn options(finished: &Arc<Mutex<Vec<PathBuf>>>) -> RecorderOptions {
    let done = finished.clone();
    let mut options = RecorderOptions::new(|| true);
    options.engaged = Some(Box::new(|| true));
    options.title = Some(Box::new(|| "Fill the form!".to_string()));
    options.cursor = Some(Box::new(|| Some((10.4, 20.6))));
    options.on_finished = Some(Box::new(move |folder: &Path| {
        done.lock().unwrap().push(folder.to_path_buf())
    }));
    options.start_thread = false;
    options
}

fn timeline(folder: &Path) -> Vec<Value> {
    std::fs::read_to_string(folder.join("timeline.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn the_timeline_keeps_the_request_and_lines_up_with_the_video() {
    let mut env = common::Env::new(&[("HIVE_RECORDINGS", "")]);
    env.remove("HIVE_RECORD");
    let finished = Arc::new(Mutex::new(Vec::new()));
    let mac = Arc::new(FakeMac {
        quits: None,
        started: AtomicUsize::new(0),
    });
    let r = Recorder::with_probe(options(&finished), mac.clone());
    assert!(r.enabled);
    r.event("hive", "🗣  Fill the form!"); // before the recording starts: kept
    r.start().unwrap();
    r.event("status", "Clicking");
    r.event("hive", "   → click(x=1, y=2)");
    r.event("hive", "\x1b[1m  \r"); // nothing left once the escapes go: not a line
    std::thread::sleep(Duration::from_millis(50));
    r.stop();
    let folder = finished.lock().unwrap()[0].clone();
    assert!(folder.starts_with(env.path()));
    assert!(folder
        .file_name()
        .unwrap()
        .to_string_lossy()
        .ends_with("Fill the form"));
    let lines = timeline(&folder);
    let kinds: Vec<&str> = lines.iter().map(|x| x["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds[0], "recording");
    assert_eq!(*kinds.last().unwrap(), "recording");
    assert!(kinds.contains(&"mac"));
    let mac_line = lines.iter().find(|x| x["kind"] == json!("mac")).unwrap();
    assert_eq!(
        (
            &mac_line["front_app"],
            &mac_line["control"],
            &mac_line["cursor"],
            &mac_line["someone_touching"]
        ),
        (
            &json!("Safari"),
            &json!("agent"),
            &json!([10, 20]),
            &json!(false)
        )
    );
    assert!(lines
        .iter()
        .any(|x| x["text"] == json!("🗣  Fill the form!")));
    assert!(lines
        .iter()
        .all(|x| x.get("video").is_some() && x.get("t").is_some()));
    assert_eq!(lines.len(), 6);
    let srt = std::fs::read_to_string(folder.join("screen.srt")).unwrap();
    assert!(srt.contains("Hive: → click(x=1, y=2)"), "{srt}");
    assert!(srt.contains("Hive: [Clicking]"));
    assert!(srt.contains("Mac: Safari — WIN · agent has mouse & keyboard"));
    let meta: Value =
        serde_json::from_str(&std::fs::read_to_string(folder.join("meta.json")).unwrap()).unwrap();
    assert_eq!(meta["videoSeconds"], json!(1.5));
    assert_eq!(meta["video"], json!("screen.mov"));
    assert!(!r.recording());
    assert_eq!(mac.started.load(Ordering::SeqCst), 1);
}

#[test]
fn a_capture_that_quits_by_itself_is_not_restarted() {
    let mut env = common::Env::new(&[("HIVE_RECORDINGS", "")]);
    env.remove("HIVE_RECORD");
    let finished = Arc::new(Mutex::new(Vec::new()));
    let mac = Arc::new(FakeMac {
        quits: Some(1),
        started: AtomicUsize::new(0),
    });
    let mut options = options(&finished);
    options.start_thread = true;
    options.poll = Duration::from_millis(10);
    let r = Recorder::with_probe(options, mac.clone());
    assert!(common::wait_for(5.0, || !finished
        .lock()
        .unwrap()
        .is_empty()));
    std::thread::sleep(Duration::from_millis(100)); // a few more rounds of the watch
    assert_eq!(mac.started.load(Ordering::SeqCst), 1);
    let folder = finished.lock().unwrap()[0].clone();
    let lines = timeline(&folder);
    assert!(lines.iter().any(
        |x| x["text"] == json!("screencapture quit by itself (exit 1); see screencapture.log")
    ));
    drop(r);
}

#[test]
fn recording_can_be_turned_off() {
    let mut env = common::Env::new(&[("HIVE_RECORDINGS", "")]);
    env.set("HIVE_RECORD", "0");
    let finished = Arc::new(Mutex::new(Vec::new()));
    let r = Recorder::with_probe(
        options(&finished),
        Arc::new(FakeMac {
            quits: None,
            started: AtomicUsize::new(0),
        }),
    );
    assert!(!r.enabled);
}

#[test]
fn srt_times() {
    assert_eq!(task_recording::srt_time(3725.5), "01:02:05,500");
    assert_eq!(task_recording::srt_time(0.0), "00:00:00,000");
}

#[test]
fn the_folder_and_names() {
    let mut env = common::Env::new(&[]);
    env.set("HIVE_RECORDINGS", "/tmp/somewhere");
    assert_eq!(task_recording::folder(), PathBuf::from("/tmp/somewhere"));
    env.remove("HIVE_RECORDINGS");
    assert!(task_recording::folder().ends_with("Movies/Hive"));
    assert_eq!(
        task_recording::slug("Fill the form! (quickly), please"),
        "Fill the form quickly please"
    );
    assert!(task_recording::slug(&"word ".repeat(20)).chars().count() <= 48);
    assert_eq!(task_recording::clock(0.25).len(), "00:00:00.250".len());
}
