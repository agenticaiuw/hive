//! End-to-end check with the real virtual devices.
//!
//! Waits for you to hand over control, then:
//!   1. moves the cursor to a few points and reports how close it landed,
//!   2. opens a scratch file in TextEdit, types a sentence, saves, and checks the file,
//!   3. takes a screenshot.
//! Touch anything at any point to take control back; the demo stops cleanly.
//!
//!     cargo run -p hive-mac --example demo

use std::process::{Command, ExitCode};
use std::thread::sleep;
use std::time::{Duration, Instant};

use hive_mac::vhid::{temp_file, VhidError};
use hive_mac::{AgentVHID, RealMac, System};

// Plain dictionary words, so TextEdit's autocorrect has nothing to change.
const SENTENCE: &str = "Hello, World! The quick brown fox jumps over the lazy dog. 1234567890 !@#$%^&*()";

fn io(e: std::io::Error) -> VhidError {
    VhidError::Io(e.to_string())
}

fn pause(seconds: f64) {
    sleep(Duration::from_secs_f64(seconds));
}

fn run() -> Result<u8, VhidError> {
    let mac = AgentVHID::default();
    let status = mac.status()?;
    let fields: Vec<String> = status.0.iter().map(|(k, v)| format!("{k}={v}")).collect();
    println!("helper: {}", fields.join(" "));
    if status.get("vhid") != Some("ready") {
        println!("virtual devices are not ready; is the daemon running?");
        return Ok(1);
    }

    mac.wait_engaged(None, true)?;
    println!("engaged");
    let outcome = (|| -> Result<(), VhidError> {
        // 1. Mouse accuracy
        let (_, _, w, h) = RealMac.main_display();
        let start = mac.cursor();
        for (name, (x, y)) in [
            ("center", (w / 2.0, h / 2.0)),
            ("top-left", (120.0, 120.0)),
            ("bottom-right", (w - 120.0, h - 120.0)),
            ("start", start),
        ] {
            let t = Instant::now();
            mac.move_to(x, y)?;
            let (cx, cy) = mac.cursor();
            println!(
                "  move {:12} -> ({:7.1}, {:6.1})  off by ({:+.2}, {:+.2})  {:.2}s",
                name,
                cx,
                cy,
                cx - x,
                cy - y,
                t.elapsed().as_secs_f64()
            );
        }

        // 2. Keyboard: type into a scratch file and save it
        let path = temp_file("agent-vhid-demo-", ".txt", b"").map_err(io)?;
        let opened = Command::new("open").arg("-e").arg(&path).status().map_err(io)?;
        if !opened.success() {
            return Err(VhidError::Io(format!("open exited with {opened}")));
        }
        pause(1.5); // let TextEdit open and focus the window
        mac.type_text(SENTENCE)?;
        mac.key("cmd+s")?;
        pause(0.8);
        mac.key("cmd+w")?;
        let saved = std::fs::read_to_string(&path).map_err(io)?;
        println!("  typed and saved: {}", if saved == SENTENCE { "OK" } else { "MISMATCH" });
        if saved != SENTENCE {
            println!("    expected {SENTENCE:?}\n    got      {saved:?}");
        }

        // 3. Screen
        let shot = mac.screenshot(None, Some(1280))?;
        println!(
            "  screenshot: {} {}x{}, {:.3} points per pixel",
            shot.path.display(),
            shot.width,
            shot.height,
            shot.scale
        );
        Ok(())
    })();
    match outcome {
        Ok(()) => Ok(0),
        Err(VhidError::Disengaged(e)) => {
            println!("you took over ({e}); demo stopped");
            Ok(3)
        }
        Err(e) => Err(e),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(1)
        }
    }
}
