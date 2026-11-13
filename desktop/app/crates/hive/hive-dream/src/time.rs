//! Wall-clock helpers on libc (no date crate): the journals use epoch seconds, the recordings'
//! timelines local ISO times, Agent.log UTC markers. Everything inside hive-dream is epoch seconds.

use regex::Regex;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

static STAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})[:.](\d{2})[:.](\d{2})(\.\d+)?(?:\s*([+-])(\d{2}):?(\d{2})|Z)?",
    )
    .expect("stamp pattern")
});

fn tm(y: i32, mo: i32, d: i32, h: i32, mi: i32, s: i32) -> libc::tm {
    // SAFETY: libc::tm is plain data; all-zero is a valid value.
    let mut t: libc::tm = unsafe { std::mem::zeroed() };
    t.tm_year = y - 1900;
    t.tm_mon = mo - 1;
    t.tm_mday = d;
    t.tm_hour = h;
    t.tm_min = mi;
    t.tm_sec = s;
    t.tm_isdst = -1;
    t
}

/// "2026-11-13T04:11:44.900" (local time, as the timelines write it), "2026-11-13 04.11.44"
/// (a recording folder's name), or with an offset ("2026-11-13 05:09:22 +0000", Agent.log's
/// markers; "Z" for UTC). `None` if it doesn't start with a date and time.
pub fn parse_stamp(text: &str) -> Option<f64> {
    let c = STAMP.captures(text.trim())?;
    let n = |i: usize| {
        c.get(i)
            .map_or(0, |m| m.as_str().parse::<i32>().unwrap_or(0))
    };
    let frac = c
        .get(7)
        .and_then(|m| m.as_str().parse::<f64>().ok())
        .unwrap_or(0.0);
    let mut t = tm(n(1), n(2), n(3), n(4), n(5), n(6));
    let utc = text.trim().ends_with('Z') || c.get(8).is_some();
    let secs = if utc {
        // SAFETY: timegm reads the struct we own.
        let base = unsafe { libc::timegm(&mut t) } as f64;
        let offset = if c.get(8).is_some() {
            let sign = if &c[8] == "-" { -1.0 } else { 1.0 };
            sign * (n(9) as f64 * 3600.0 + n(10) as f64 * 60.0)
        } else {
            0.0
        };
        base - offset
    } else {
        // SAFETY: mktime reads and normalises the struct we own.
        (unsafe { libc::mktime(&mut t) }) as f64
    };
    Some(secs + frac)
}

fn local(epoch: f64) -> libc::tm {
    let secs = epoch.floor() as libc::time_t;
    // SAFETY: localtime_r writes into the struct we own.
    let mut out: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::localtime_r(&secs, &mut out);
    }
    out
}

/// "2026-11-13T04:11:44", local time.
pub fn iso(epoch: f64) -> String {
    let t = local(epoch);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        t.tm_year + 1900,
        t.tm_mon + 1,
        t.tm_mday,
        t.tm_hour,
        t.tm_min,
        t.tm_sec
    )
}

/// "2026-11-13", local time: the name of a night's folder.
pub fn date(epoch: f64) -> String {
    iso(epoch)[..10].to_string()
}
