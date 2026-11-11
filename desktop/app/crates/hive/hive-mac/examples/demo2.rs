//! Second demo: the agent looks at the screen and acts on what it sees.
//!
//!   1. Opens Calculator through Spotlight, works out 1234 x 5678, copies the answer and checks it.
//!   2. Opens a 200-line note and scrolls, reading the screen each time, until it sees a hidden word.
//!   3. Double-clicks that word, copies it, and checks the clipboard.
//!   4. Right-clicks it, reads the context menu, and closes it.
//!   5. Closes everything and puts your clipboard back.
//! Touch anything at any point to take control back.
//!
//!     cargo run -p hive-mac --example demo2

use std::collections::BTreeSet;
use std::process::{Command, ExitCode};
use std::thread::sleep;
use std::time::Duration;

use hive_mac::vhid::{temp_file, TextBox, VhidError};
use hive_mac::{AgentVHID, RealMac, System};

// Picked at run time so the word can't already be on screen somewhere else.
const HIDDEN_WORDS: [&str; 6] = ["pineapple", "lighthouse", "marmalade", "porcupine", "trombone", "avalanche"];
const HIDDEN_LINE: usize = 160;

fn io(e: std::io::Error) -> VhidError {
    VhidError::Io(e.to_string())
}

fn pause(seconds: f64) {
    sleep(Duration::from_secs_f64(seconds));
}

fn clipboard() -> String {
    String::from_utf8_lossy(&RealMac.clipboard()).into_owned()
}

fn report(ok: bool, what: &str) -> bool {
    println!("  {} {}", if ok { "OK  " } else { "FAIL" }, what);
    ok
}

/// The note's line numbers on screen: boxes that are the three digits of a "Line NNN" prefix.
fn visible_line_numbers(boxes: &[TextBox]) -> Vec<usize> {
    let mut numbers = BTreeSet::new();
    for b in boxes {
        let Some(rest) = b.line.strip_prefix("Line ") else { continue };
        let digits = rest.get(..3).unwrap_or("");
        let word_after = rest[3.min(rest.len())..]
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || c == '_');
        if digits.len() == 3 && digits.bytes().all(|c| c.is_ascii_digit()) && !word_after && b.text == digits {
            numbers.insert(digits.parse().unwrap());
        }
    }
    numbers.into_iter().collect()
}

/// Returns Ok(exit code); `results` collects each check.
fn steps(mac: &AgentVHID, word: &str, results: &mut Vec<bool>) -> Result<Option<u8>, VhidError> {
    // 1. Spotlight -> Calculator
    println!("Calculator via Spotlight");
    mac.key("cmd+space")?;
    pause(0.8);
    mac.type_text("Calculator")?;
    pause(1.0);
    mac.key("return")?;
    pause(2.0);
    mac.key("escape")?;
    mac.key("escape")?;
    mac.type_text("1234*5678=")?;
    pause(0.5);
    mac.key("cmd+c")?;
    pause(0.3);
    let answer = clipboard().replace(',', "").trim().to_string();
    let shown = if answer.is_empty() { "(nothing copied)" } else { &answer };
    results.push(report(answer == "7006652", &format!("1234 x 5678 = {shown}")));
    mac.key("cmd+q")?;
    pause(0.8);

    // 2. Scroll until the hidden word shows up
    println!("Scroll until the hidden word is visible");
    let mut note = String::new();
    for n in 1..=200 {
        if n == HIDDEN_LINE {
            note += &format!("Line {n:03} here is the {word} you were looking for\n");
        } else {
            note += &format!("Line {n:03} the quick brown fox jumps over the lazy dog\n");
        }
    }
    let path = temp_file("agent-vhid-note-", ".txt", note.as_bytes()).map_err(io)?;
    let opened = Command::new("open").arg("-e").arg(&path).status().map_err(io)?;
    if !opened.success() {
        return Err(VhidError::Io(format!("open exited with {opened}")));
    }
    pause(1.5);

    let mut boxes = mac.read_screen(None)?;
    let Some(first) = mac.find_text("001", Some(&boxes), Some("Line 001"))? else {
        results.push(report(false, "could not see the note's first line"));
        return Ok(Some(1));
    };
    let (fx, fy) = first.center();
    mac.move_to(fx + 120.0, fy + 60.0)?; // over the text, so the scroll lands there

    let mut target = None;
    let mut previous_top = *visible_line_numbers(&boxes)
        .first()
        .ok_or_else(|| VhidError::Invalid("no line numbers visible".into()))?;
    for _ in 0..30 {
        mac.scroll(5, 0, None)?;
        pause(0.4);
        boxes = mac.read_screen(None)?;
        let lines = visible_line_numbers(&boxes);
        let top = lines.first().copied().unwrap_or(previous_top);
        let q = |v: Option<&usize>| v.map_or("?".to_string(), |n| n.to_string());
        println!("    scrolled 5 notches: lines {}-{} visible", q(lines.first()), q(lines.last()));
        if top < previous_top {
            results.push(report(false, "scrolling went the wrong way"));
            break;
        }
        previous_top = top;
        target = mac.find_text(word, Some(&boxes), Some(&format!("Line {HIDDEN_LINE}")))?;
        if target.is_some() {
            break;
        }
    }
    results.push(report(
        target.is_some(),
        &if target.is_some() { format!("found '{word}' on line {HIDDEN_LINE}") } else { "never saw the word".to_string() },
    ));

    if let Some(target) = target {
        // 3. Double-click the word and copy it
        println!("Double-click and copy");
        mac.double_click(Some(target.center()))?;
        pause(0.3);
        mac.key("cmd+c")?;
        pause(0.3);
        let copied = clipboard();
        results.push(report(copied == word, &format!("clipboard holds {copied:?}")));

        // 4. Right-click and read the menu
        println!("Right-click menu");
        mac.right_click(Some(target.center()))?;
        pause(0.8);
        let (cx, cy) = target.center();
        let menu: BTreeSet<String> = mac
            .read_screen(None)?
            .into_iter()
            .filter(|b| cx - 60.0 < b.x && b.x < cx + 450.0 && cy - 450.0 < b.y && b.y < cy + 600.0)
            .map(|b| b.line)
            .collect();
        let has_lookup = menu.iter().any(|l| l.contains("Look Up"));
        let has_copy = menu.iter().any(|l| l.trim() == "Copy");
        let listed: Vec<&str> = menu
            .iter()
            .map(String::as_str)
            .filter(|l| matches!(l.trim(), "Copy" | "Cut" | "Paste") || l.contains("Look Up"))
            .collect();
        results.push(report(has_lookup && has_copy, &format!("menu shows {}", listed.join(", "))));
        mac.key("escape")?;
        pause(0.3);
    }

    // 5. Clean up
    mac.key("cmd+w")?;
    pause(0.5);
    Ok(None)
}

fn run() -> Result<u8, VhidError> {
    let mac = AgentVHID::default();
    if mac.status()?.get("vhid") != Some("ready") {
        println!("virtual devices are not ready; is the helper running?");
        return Ok(1);
    }
    let saved_clipboard = RealMac.clipboard();
    // Picked from the clock, which is plenty random for choosing a word.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as usize)
        .unwrap_or(0);
    let word = HIDDEN_WORDS[nanos % HIDDEN_WORDS.len()];
    let mut results = Vec::new();

    mac.wait_engaged(None, true)?;
    println!("engaged");
    let outcome = steps(&mac, word, &mut results);
    // Whatever happened, put the clipboard back.
    RealMac.set_clipboard(&saved_clipboard).map_err(VhidError::Io)?;
    match outcome {
        Ok(Some(code)) => return Ok(code),
        Ok(None) => {}
        Err(VhidError::Disengaged(e)) => {
            println!("you took over ({e}); demo stopped");
            return Ok(3);
        }
        Err(e) => return Err(e),
    }

    let passed = results.iter().filter(|&&r| r).count();
    println!("{}/{} checks passed", passed, results.len());
    Ok(if results.iter().all(|&r| r) { 0 } else { 1 })
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
