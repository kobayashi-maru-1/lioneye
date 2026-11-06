//! Gets the Path of Building bundle (fetch-pob.ps1) before the exe embeds it, so a plain
//! `cargo build` works from a fresh checkout. The script skips the download when the
//! bundle is already the latest release.

use std::process::Command;

/// The build's commit (short), shown in the guide's footer so two builds of one version
/// can be told apart: GitHub Actions' GITHUB_SHA, else git, else "dev".
fn commit() -> String {
    if let Ok(sha) = std::env::var("GITHUB_SHA") {
        return sha.chars().take(7).collect();
    }
    Command::new("git")
        .args(["rev-parse", "--short=7", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
        .unwrap_or_else(|| "dev".to_string())
}

fn main() {
    println!("cargo:rustc-env=LIONEYE_COMMIT={}", commit());
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=fetch-pob.ps1");
    println!("cargo:rerun-if-changed=pob/pob.zip");
    println!("cargo:rerun-if-changed=pob/version.txt");

    let args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "fetch-pob.ps1"];
    let ok = ["pwsh", "powershell"]
        .iter()
        .find_map(|shell| Command::new(shell).args(args).status().ok())
        .is_some_and(|status| status.success());
    if !ok {
        panic!("Couldn't get Path of Building. Run log-api/fetch-pob.ps1 (needs git and PowerShell).");
    }
}
