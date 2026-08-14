use std::process::Command;

fn main() {
    let hash = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "source-tree".to_string());
    println!("cargo:rustc-env=ORCHESTRA_DAEMON_HASH={hash}");
    println!("cargo:rerun-if-changed=build.rs");
}
