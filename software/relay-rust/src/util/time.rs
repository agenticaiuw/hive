//! Timestamp helpers that reproduce JavaScript `Date` semantics exactly.
//!
//! Every timestamp the relay writes is `new Date().toISOString()` — always
//! millisecond precision with a `Z` suffix. Several comparisons in the JS relay
//! are *lexicographic* on these strings (`failQueuedAgentProxyJobs`'s
//! `olderThan`, product-sync ordering), so any format drift silently changes
//! behaviour.

/// Current wall-clock time in milliseconds since the Unix epoch.
///
/// On Workers this reads the frozen-between-IO clock via `Date.now()`, exactly
/// like the JS relay does.
#[cfg(target_arch = "wasm32")]
pub fn now_ms() -> i64 {
    worker::Date::now().as_millis() as i64
}

#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}

pub fn now_iso() -> String {
    iso_from_ms(now_ms())
}

/// Port of `new Date(ms).toISOString()`.
///
/// Uses Howard Hinnant's civil-from-days algorithm so it is correct for
/// pre-epoch values too (JS happily formats those).
pub fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let mut rem = ms.rem_euclid(86_400_000);

    let milli = rem % 1000;
    rem /= 1000;
    let sec = rem % 60;
    rem /= 60;
    let min = rem % 60;
    let hour = rem / 60;

    let (year, month, day) = civil_from_days(days);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, min, sec, milli
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Port of `Date.parse(value)` restricted to the ISO-8601 forms this system
/// actually produces and consumes. Returns `None` for anything JS would turn
/// into `NaN`.
///
/// A date-time with no offset is treated as UTC. That matches the deployed
/// behaviour: Workers run with `TZ=UTC`, so JS "local time" *is* UTC there.
pub fn parse_iso(value: &str) -> Option<i64> {
    let s = value.trim();
    if s.is_empty() {
        return None;
    }
    let b = s.as_bytes();
    if b.len() < 10 {
        return None;
    }

    let year: i64 = s.get(0..4)?.parse().ok()?;
    if b[4] != b'-' {
        return None;
    }
    let month: u32 = s.get(5..7)?.parse().ok()?;
    if b[7] != b'-' {
        return None;
    }
    let day: u32 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let mut hour = 0i64;
    let mut minute = 0i64;
    let mut second = 0i64;
    let mut milli = 0i64;
    let mut offset_min = 0i64;

    if b.len() > 10 {
        if b[10] != b'T' && b[10] != b' ' {
            return None;
        }
        hour = s.get(11..13)?.parse().ok()?;
        if b.get(13) != Some(&b':') {
            return None;
        }
        minute = s.get(14..16)?.parse().ok()?;

        let mut idx = 16;
        if b.get(idx) == Some(&b':') {
            second = s.get(17..19)?.parse().ok()?;
            idx = 19;
            if b.get(idx) == Some(&b'.') {
                let start = idx + 1;
                let mut end = start;
                while end < b.len() && b[end].is_ascii_digit() {
                    end += 1;
                }
                if end == start {
                    return None;
                }
                // JS keeps only millisecond precision.
                let frac = &s[start..end];
                let mut ms_digits: String = frac.chars().take(3).collect();
                while ms_digits.len() < 3 {
                    ms_digits.push('0');
                }
                milli = ms_digits.parse().ok()?;
                idx = end;
            }
        }

        match b.get(idx) {
            None => {}
            Some(&b'Z') | Some(&b'z') => {
                if idx + 1 != b.len() {
                    return None;
                }
            }
            Some(&c @ (b'+' | b'-')) => {
                let oh: i64 = s.get(idx + 1..idx + 3)?.parse().ok()?;
                let om: i64 = if b.get(idx + 3) == Some(&b':') {
                    s.get(idx + 4..idx + 6)?.parse().ok()?
                } else {
                    s.get(idx + 3..idx + 5)?.parse().ok()?
                };
                offset_min = oh * 60 + om;
                if c == b'+' {
                    offset_min = -offset_min;
                }
            }
            _ => return None,
        }

        if hour > 24 || minute > 59 || second > 59 {
            return None;
        }
    }

    let days = days_from_civil(year, month, day);
    Some(
        days * 86_400_000
            + hour * 3_600_000
            + minute * 60_000
            + second * 1000
            + milli
            + offset_min * 60_000,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_millisecond_iso_with_z() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_754_155_445_123), "2025-08-02T17:24:05.123Z");
    }

    #[test]
    fn iso_round_trips_through_parse() {
        for ms in [0i64, 1_000, 1_754_155_445_123, 2_000_000_000_000] {
            let iso = iso_from_ms(ms);
            assert_eq!(parse_iso(&iso), Some(ms), "round trip failed for {iso}");
        }
    }

    #[test]
    fn parses_offsets_and_date_only_forms() {
        assert_eq!(parse_iso("1970-01-01"), Some(0));
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        // +01:00 means the instant is one hour earlier in UTC.
        assert_eq!(parse_iso("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(parse_iso("1970-01-01T00:00:00-00:30"), Some(1_800_000));
    }

    #[test]
    fn rejects_garbage_like_js_nan() {
        assert_eq!(parse_iso(""), None);
        assert_eq!(parse_iso("not-a-date"), None);
        assert_eq!(parse_iso("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn iso_strings_sort_lexicographically_in_time_order() {
        // failQueuedAgentProxyJobs compares createdAt strings with `<`.
        let a = iso_from_ms(1_700_000_000_000);
        let b = iso_from_ms(1_700_000_000_001);
        let c = iso_from_ms(1_800_000_000_000);
        assert!(a < b && b < c);
    }
}
