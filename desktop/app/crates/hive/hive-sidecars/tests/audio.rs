//! python/audio.py's questions, asked of CoreAudio. Reading these properties opens no device; what
//! the answers are depends on this Mac, so this only checks they're asked safely.

use hive_sidecars::audio;

#[test]
fn no_device_has_no_name() {
    assert_eq!(audio::name(None), "?");
    assert_eq!(audio::name(Some(0)), "?");
    assert_eq!(audio::name(Some(0xFFFF_FFF0)), "?"); // no such device
}

#[test]
fn the_devices_can_be_asked_about() {
    let devices = audio::devices();
    for device in &devices {
        let _ = audio::has_input(*device);
        assert!(!audio::name(Some(*device)).is_empty());
    }
    if let Some(input) = audio::microphone() {
        assert_eq!(audio::microphone(), audio::default_input());
        if input != 0 {
            assert!(devices.contains(&input));
            assert!(audio::has_input(input));
        }
    }
    let _ = audio::output_is_speakers();
}
