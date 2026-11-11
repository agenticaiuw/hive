//! `phone-status`: is the phone connected? (python/phone.py run as a script.)
fn main() {
    let _ = hive_common::settings::load(None);
    let (code, line) = hive_phone::status_line();
    println!("{line}");
    std::process::exit(code);
}
