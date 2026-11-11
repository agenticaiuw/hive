//! `hive-credentials configure mac|phone` (`python3 python/credentials.py configure ...`): shows
//! the Hive bundle's secure entry sheet for that account's password or passcode.

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::ExitCode::from(hive_mac::credentials::main(&args).clamp(0, 255) as u8)
}
