//! Gets the Path of Building bundle (fetch-pob.ps1) before the exe embeds it, so a plain
//! `cargo build` works from a fresh checkout. The script skips the download when the
//! bundle is already the latest release.

use std::process::Command;

fn main() {
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
