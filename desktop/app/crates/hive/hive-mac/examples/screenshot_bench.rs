//! Times the Mac tools' screenshot both ways on this Mac: python/mac_mcp.py's
//! `screencapture -C` + `sips` to a 1440-wide JPEG, and the in-process ScreenCaptureKit capture
//! that replaces it. Reads the screen only; the images go to a temporary folder and are deleted.
//!
//!     cargo run --release -p hive-mac --example screenshot_bench [runs] [temp dir]

use std::time::{Duration, Instant};

use hive_mac::screen::Format;
use hive_mac::{RealMac, System};

fn median(mut v: Vec<Duration>) -> f64 {
    v.sort();
    let mid = v.len() / 2;
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    if v.len() % 2 == 0 {
        (ms(v[mid - 1]) + ms(v[mid])) / 2.0
    } else {
        ms(v[mid])
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let runs: usize = args.next().and_then(|n| n.parse().ok()).unwrap_or(10);
    let dir = args
        .next()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let system = RealMac;
    let g = hive_mac::tools::geometry(&system);
    println!(
        "work display {:?}, screenshot {}x{}",
        system.work_display(),
        g.width,
        g.height
    );

    let png = dir.join("bench-shot.png");
    let jpg = dir.join("bench-shot.jpg");
    let width = g.width.to_string();
    let mut python = Vec::new();
    let mut size = 0;
    for _ in 0..runs {
        let start = Instant::now();
        let shot = std::process::Command::new("screencapture")
            .args(["-x", "-m", "-C", "-t", "png"])
            .arg(&png)
            .status()
            .expect("screencapture");
        assert!(shot.success());
        let scaled = std::process::Command::new("sips")
            .args([
                "--resampleWidth",
                &width,
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                "70",
            ])
            .arg(&png)
            .arg("--out")
            .arg(&jpg)
            .output()
            .expect("sips");
        assert!(scaled.status.success());
        size = std::fs::read(&jpg).expect("read jpeg").len();
        python.push(start.elapsed());
    }
    let _ = std::fs::remove_file(&png);
    let _ = std::fs::remove_file(&jpg);
    println!(
        "screencapture + sips: median {:.1} ms over {runs} runs ({size} bytes)",
        median(python)
    );

    let start = Instant::now();
    let first = system
        .capture(g.width, g.height, true, Format::Jpeg(0.7))
        .expect("capture");
    println!(
        "ScreenCaptureKit first capture (fetches the display list): {:.1} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let mut rust = Vec::new();
    for _ in 0..runs {
        let start = Instant::now();
        size = system
            .capture(g.width, g.height, true, Format::Jpeg(0.7))
            .expect("capture")
            .len();
        rust.push(start.elapsed());
    }
    drop(first);
    println!(
        "ScreenCaptureKit + ImageIO: median {:.1} ms over {runs} runs ({size} bytes)",
        median(rust)
    );
}
