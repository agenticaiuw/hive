//! The register: new signatures start open, each occurrence is counted once however often collect
//! reads it, a landed signature seen again afterwards reopens.

use hive_dream::evidence::{cluster, Occurrence, Source};
use hive_dream::register::{Register, Status};

const T0: f64 = 1_800_000_000.0;

fn occ(sig: &str, t: f64, minutes: f64) -> Occurrence {
    Occurrence::new(
        "tool_error",
        sig,
        t,
        Source::Journal,
        format!("journal s:{t}"),
    )
    .minutes(minutes)
}

#[test]
fn overlapping_collects_count_each_occurrence_once() {
    let mut reg = Register::default();
    let first = cluster(&[
        occ("a thing failed", T0, 1.0),
        occ("a thing failed", T0 + 60.0, 1.0),
    ]);
    let applied = reg.apply(&first, T0 + 100.0);
    assert_eq!(applied.new, vec!["tool_error: a thing failed"]);
    let e = &reg.entries["tool_error: a thing failed"];
    assert_eq!((e.count, e.minutes, e.status), (2, 2.0, Status::Open));

    // The next night reads an overlapping window: one old occurrence, one new.
    let second = cluster(&[
        occ("a thing failed", T0 + 60.0, 1.0),
        occ("a thing failed", T0 + 7200.0, 1.0),
    ]);
    let applied = reg.apply(&second, T0 + 8000.0);
    assert!(applied.new.is_empty());
    let e = &reg.entries["tool_error: a thing failed"];
    assert_eq!(e.count, 3);
    assert!((e.minutes - 3.0).abs() < 1e-9);
    assert_eq!(e.last_seen, T0 + 7200.0);
}

#[test]
fn statuses_change_and_a_landed_signature_reopens_when_seen_again() {
    let mut reg = Register::default();
    reg.apply(&cluster(&[occ("x broke", T0, 1.0)]), T0 + 10.0);
    reg.set(
        "tool_error: x broke",
        Status::Proposed,
        "the gate passed",
        T0 + 20.0,
    )
    .unwrap();
    assert_eq!(reg.status("tool_error: x broke"), Status::Proposed);
    reg.set("tool_error: x broke", Status::Landed, "landed", T0 + 30.0)
        .unwrap();

    // Seen again, but from before it landed: still landed.
    let applied = reg.apply(&cluster(&[occ("x broke", T0 + 5.0, 1.0)]), T0 + 40.0);
    assert!(applied.regressed.is_empty());
    assert_eq!(reg.status("tool_error: x broke"), Status::Landed);

    // Seen after it landed: open again, and reported.
    let applied = reg.apply(&cluster(&[occ("x broke", T0 + 3600.0, 1.0)]), T0 + 4000.0);
    assert_eq!(applied.regressed, vec!["tool_error: x broke"]);
    assert_eq!(reg.status("tool_error: x broke"), Status::Open);
    assert_eq!(reg.entries["tool_error: x broke"].history.len(), 4);
}

#[test]
fn ignored_stays_ignored_and_unknown_signatures_are_open() {
    let mut reg = Register::default();
    reg.apply(&cluster(&[occ("noise", T0, 0.1)]), T0 + 10.0);
    reg.set("tool_error: noise", Status::Ignored, "by hand", T0 + 11.0)
        .unwrap();
    reg.apply(&cluster(&[occ("noise", T0 + 500.0, 0.1)]), T0 + 600.0);
    assert_eq!(reg.status("tool_error: noise"), Status::Ignored);
    assert_eq!(reg.status("tool_error: never seen"), Status::Open);
    assert!(reg
        .set("tool_error: never seen", Status::Ignored, "", T0)
        .is_err());
}

#[test]
fn find_by_slug_or_branch_and_round_trip_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("register.json");
    let mut reg = Register::load(&path).unwrap();
    let clusters = cluster(&[occ("y broke", T0, 1.0)]);
    reg.apply(&clusters, T0 + 1.0);
    let sig = "tool_error: y broke".to_string();
    reg.entries.get_mut(&sig).unwrap().branch =
        Some(format!("dream/2030-01-15-{}", clusters[0].slug));
    reg.save(&path).unwrap();
    let back = Register::load(&path).unwrap();
    assert_eq!(back.find(&clusters[0].slug), Some(sig.clone()));
    assert_eq!(
        back.find(&format!("dream/2030-01-15-{}", clusters[0].slug)),
        Some(sig)
    );

    std::fs::write(&path, "not json").unwrap();
    assert!(Register::load(&path).is_err());
}

#[test]
fn old_ids_are_dropped_after_a_while() {
    let mut reg = Register::default();
    reg.apply(&cluster(&[occ("z", T0, 1.0)]), T0 + 1.0);
    reg.apply(
        &cluster(&[occ("z", T0 + 60.0 * 86400.0, 1.0)]),
        T0 + 60.0 * 86400.0,
    );
    let e = &reg.entries["tool_error: z"];
    assert_eq!(e.count, 2);
    assert_eq!(e.seen.len(), 1);
}
