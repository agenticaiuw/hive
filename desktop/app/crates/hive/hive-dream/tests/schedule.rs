//! The nightly run's postpone checks (the Mac), plus the collect-time checks for
//! settings changed with nothing to explain them and for restart storms. Synthetic data only.

use hive_dream::collect::{restart_storms, settings_check, window, SettingSnap};
use hive_dream::register::Register;
use hive_dream::schedule::{parse_hid_idle_ns, postpone_reason};

const T0: f64 = 1_800_000_000.0;

#[test]
fn reads_the_idle_time_from_ioreg() {
    let text = "  | |   \"HIDIdleTime\" = 45043833\n  | |   \"Other\" = 1\n";
    assert_eq!(parse_hid_idle_ns(text), Some(45_043_833));
    assert_eq!(parse_hid_idle_ns("nothing here"), None);
}

#[test]
fn postpones_when_hive_is_mid_task_or_the_user_is_there() {
    let idle_long = Some(3_600_000_000_000u64);
    let idle_short = Some(30_000_000_000u64);
    assert!(
        postpone_reason(Some(r#"{"status": "active", "id": "x"}"#), idle_long)
            .unwrap()
            .contains("middle of a task")
    );
    assert!(
        postpone_reason(Some(r#"{"status": "finished"}"#), idle_short)
            .unwrap()
            .contains("touched")
    );
    assert_eq!(
        postpone_reason(Some(r#"{"status": "finished"}"#), idle_long),
        None
    );
    assert_eq!(postpone_reason(None, None), None);
    assert_eq!(postpone_reason(Some("not json"), idle_long), None);
}

fn snap(value: &str, mtime: f64) -> SettingSnap {
    SettingSnap {
        value: value.into(),
        mtime,
    }
}

#[test]
fn a_setting_changed_with_nothing_to_explain_it_is_flagged() {
    let cur = snap("off", T0);
    let o = settings_check(
        "speak-aloud",
        Some(&cur),
        Some(&snap("on", T0 - 5000.0)),
        &[],
        &[],
        T0 - 100.0,
        T0 + 100.0,
    )
    .expect("flagged");
    assert_eq!(
        o.signature,
        "settings_changed: speak-aloud changed with no menu action or request recorded"
    );
    assert_eq!(o.example, "speak-aloud: on -> off");
}

#[test]
fn a_menu_action_or_a_request_explains_a_setting_change() {
    let cur = snap("off", T0);
    let prev = snap("on", T0 - 5000.0);
    assert!(settings_check(
        "speak-aloud",
        Some(&cur),
        Some(&prev),
        &[T0 - 2.0],
        &[],
        T0 - 100.0,
        T0 + 100.0
    )
    .is_none());
    let asked = vec![(T0 - 60.0, "please stop speaking aloud".to_string())];
    assert!(settings_check(
        "speak-aloud",
        Some(&cur),
        Some(&prev),
        &[],
        &asked,
        T0 - 100.0,
        T0 + 100.0
    )
    .is_none());
    // Unchanged since the last snapshot, or outside the window: nothing.
    assert!(settings_check(
        "speak-aloud",
        Some(&cur),
        Some(&cur),
        &[],
        &[],
        T0 - 100.0,
        T0 + 100.0
    )
    .is_none());
    assert!(settings_check(
        "speak-aloud",
        Some(&cur),
        Some(&prev),
        &[],
        &[],
        T0 + 1.0,
        T0 + 100.0
    )
    .is_none());
    // work-screen has no menu event in the journal: only a request explains it.
    assert!(settings_check(
        "work-screen",
        Some(&cur),
        Some(&prev),
        &[T0],
        &[],
        T0 - 100.0,
        T0 + 100.0
    )
    .is_some());
}

#[test]
fn three_quick_starts_are_a_restart_storm() {
    let starts = vec![
        (T0, "journal a:1".to_string()),
        (T0 + 2.0, "Agent.log:10".to_string()), // the same start, seen twice
        (T0 + 100.0, "journal b:1".to_string()),
        (T0 + 250.0, "journal c:1".to_string()),
        (T0 + 5000.0, "journal d:1".to_string()),
    ];
    let storms = restart_storms(starts, T0 - 1.0, T0 + 10_000.0);
    assert_eq!(storms.len(), 1);
    assert_eq!(storms[0].times.len(), 3);
    let calm = restart_storms(
        vec![(T0, "a".into()), (T0 + 1000.0, "b".into())],
        T0 - 1.0,
        T0 + 2000.0,
    );
    assert!(calm.is_empty());
}

#[test]
fn the_default_window_is_from_the_last_run_and_at_least_a_day() {
    let mut reg = Register::default();
    let now = T0;
    assert_eq!(window(&reg, None, now), now - 86400.0);
    reg.last_collect = Some(now - 3.0 * 86400.0);
    assert_eq!(window(&reg, None, now), now - 3.0 * 86400.0);
    reg.last_collect = Some(now - 3600.0);
    assert_eq!(window(&reg, None, now), now - 86400.0);
    reg.last_collect = Some(now - 30.0 * 86400.0);
    assert_eq!(window(&reg, None, now), now - 7.0 * 86400.0);
    assert_eq!(window(&reg, Some(72.0), now), now - 72.0 * 3600.0);
}
