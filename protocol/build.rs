fn main() {
    let git = std::process::Command::new("git").args(["rev-parse", "--short", "HEAD"]).output().ok()
        .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_else(|| "dev".into());
    println!("cargo:rustc-env=HIVE_GIT={git}");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");
}
