//! Downloads the Path of Building bundle (fetch-pob.ps1) when it's missing,
//! so a plain `cargo build` works from a fresh checkout.

use std::{path::Path, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=fetch-pob.ps1");
    println!("cargo:rerun-if-changed=pob/pob.zip");
    println!("cargo:rerun-if-changed=pob/version.txt");

    if Path::new("pob/pob.zip").exists() && Path::new("pob/version.txt").exists() {
        return;
    }
    let args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "fetch-pob.ps1"];
    let ok = ["pwsh", "powershell"]
        .iter()
        .find_map(|shell| Command::new(shell).args(args).status().ok())
        .is_some_and(|status| status.success());
    if !ok {
        panic!("Couldn't download Path of Building. Run log-api/fetch-pob.ps1 (needs git and PowerShell).");
    }
}
