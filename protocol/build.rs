fn main() {
    let git = |args: &[&str]| std::process::Command::new("git").args(args).output().ok().filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "dev".into());
    println!("cargo:rustc-env=HIVE_GIT={}", git(&["rev-parse", "--short=12", "HEAD"]));
    // What devices download is GitHub's build, so their version comes from the part of this checkout that's on GitHub.
    let base = git(&["merge-base", "HEAD", "origin/main"]);
    let base = if base == "dev" { "HEAD".to_string() } else { base };
    println!("cargo:rustc-env=HIVE_DEVICES={}", git(&["log", "-1", "--format=%h", "--abbrev=12", &base, "--", ":/desktop", ":/browser", ":/protocol", ":/Cargo.lock"]));
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");
    println!("cargo:rerun-if-changed=../.git/refs/remotes");
    println!("cargo:rerun-if-changed=../.git/packed-refs");
}
