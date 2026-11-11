//! Signs lioneye.zip so the self-update installs only releases from this PC.
//!
//! The key lives in a folder of its own (default `%USERPROFILE%\Downloads\lioneye-signing`):
//! - `release.key`: the secret key, password-protected (minisign's format). The backup:
//!   keep a copy and its password somewhere safe, off this PC.
//! - `release.key.dpapi`: the same key, locked to this Windows account (DPAPI), so signing
//!   asks for nothing.
//! - `release.pub`: the public key, copied to `log-api/release-key.pub` and built into the exe.
//!
//! Commands (run from the repo root):
//!   sign-release keygen [--dir <folder>]            a new key; asks the backup's password
//!   sign-release restore [--dir <folder>]           this PC's copy from release.key
//!   sign-release sign <zip> <tag> [--dir <folder>]  writes <zip>.minisig

use std::{
    io::Cursor,
    path::{Path, PathBuf},
    process::ExitCode,
};

use minisign::{KeyPair, PublicKey, PublicKeyBox, SecretKey, SecretKeyBox};

/// The exe's copy of the public key, relative to the repo root.
const REPO_PUBLIC_KEY: &str = "log-api/release-key.pub";
/// The release asset the exe downloads (update.rs `ASSET`).
const ZIP_NAME: &str = "lioneye.zip";
/// What the signature's trusted (signed) comment says; the exe checks it names the tag.
fn trusted_comment(zip_name: &str, tag: &str) -> String {
    format!("{zip_name} {tag}")
}

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}

fn run(mut args: Vec<String>) -> Result<(), String> {
    let dir = match args.iter().position(|a| a == "--dir") {
        Some(i) => {
            if i + 1 >= args.len() {
                return Err("--dir needs a folder".into());
            }
            let dir = PathBuf::from(args.remove(i + 1));
            args.remove(i);
            dir
        }
        None => default_dir()?,
    };
    match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["keygen"] => keygen(&dir),
        ["restore"] => restore(&dir),
        ["sign", zip, tag] => sign(&dir, Path::new(zip), tag, Path::new(REPO_PUBLIC_KEY)),
        _ => {
            Err("Usage: sign-release keygen | restore | sign <zip> <tag>   [--dir <folder>]".into())
        }
    }
}

fn default_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE").ok_or("USERPROFILE not set")?;
    Ok(PathBuf::from(home)
        .join("Downloads")
        .join("lioneye-signing"))
}

struct Files {
    backup: PathBuf,
    local: PathBuf,
    public: PathBuf,
}

fn files(dir: &Path) -> Files {
    Files {
        backup: dir.join("release.key"),
        local: dir.join("release.key.dpapi"),
        public: dir.join("release.pub"),
    }
}

/// A new key pair. Refuses to replace one: every installed copy trusts only its key.
fn keygen(dir: &Path) -> Result<(), String> {
    let f = files(dir);
    if f.backup.exists() || f.local.exists() || f.public.exists() {
        return Err(format!(
            "A key already exists in {}. Installed copies trust only that key; delete it \
             yourself if you really mean to replace it.",
            dir.display()
        ));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    println!("Password for the backup copy (release.key). Keep it with the backup.");
    let password = rpassword::prompt_password("Password: ").map_err(|e| e.to_string())?;
    let again = rpassword::prompt_password("Again: ").map_err(|e| e.to_string())?;
    if password != again {
        return Err("Passwords differ; nothing written.".into());
    }
    if password.is_empty() {
        return Err("Empty password; nothing written.".into());
    }
    let KeyPair { pk, sk } =
        KeyPair::generate_encrypted_keypair(Some(password.clone())).map_err(|e| e.to_string())?;
    let sk_box = sk
        .to_box(Some("Lioneye release key (password-protected)"))
        .map_err(|e| e.to_string())?;
    let pk_box = pk.to_box().map_err(|e| e.to_string())?;
    let sk = SecretKey::from_box(sk_box.clone(), Some(password)).map_err(|e| e.to_string())?;

    write_new(&f.backup, sk_box.to_string().as_bytes())?;
    write_new(&f.public, pk_box.to_string().as_bytes())?;
    write_new(&f.local, &protect_key(&sk)?)?;
    println!("Key made in {}.", dir.display());
    println!(
        "Public key (copy to {REPO_PUBLIC_KEY}):\n{}",
        pk_box.to_string().trim_end()
    );
    println!("Back up release.key and its password off this PC.");
    Ok(())
}

/// This PC's Windows-protected copy, from the password-protected backup.
fn restore(dir: &Path) -> Result<(), String> {
    let f = files(dir);
    let text =
        std::fs::read_to_string(&f.backup).map_err(|e| format!("{}: {e}", f.backup.display()))?;
    let password = rpassword::prompt_password("Password: ").map_err(|e| e.to_string())?;
    let sk = SecretKey::from_box(
        SecretKeyBox::from_string(&text).map_err(|e| e.to_string())?,
        Some(password),
    )
    .map_err(|e| e.to_string())?;
    let pk = PublicKey::from_secret_key(&sk).map_err(|e| e.to_string())?;
    let pk_text = pk.to_box().map_err(|e| e.to_string())?.to_string();
    std::fs::write(&f.local, protect_key(&sk)?)
        .map_err(|e| format!("{}: {e}", f.local.display()))?;
    std::fs::write(&f.public, pk_text.as_bytes())
        .map_err(|e| format!("{}: {e}", f.public.display()))?;
    println!("Restored {}.", f.local.display());
    Ok(())
}

/// Signs `zip` for release `tag`, after checking this key is the one the exe trusts
/// (`trusted_path`).
fn sign(dir: &Path, zip: &Path, tag: &str, trusted_path: &Path) -> Result<(), String> {
    let f = files(dir);
    let locked = std::fs::read(&f.local).map_err(|e| format!("{}: {e}", f.local.display()))?;
    let mut plain = dpapi::unprotect(&locked)?;
    let sk = SecretKey::from_bytes(&plain).map_err(|e| e.to_string());
    wipe(&mut plain);
    let sk = sk?;
    if sk.is_encrypted() {
        return Err("The Windows-protected key is damaged; run restore.".into());
    }
    let pk = PublicKey::from_secret_key(&sk).map_err(|e| e.to_string())?;
    let trusted = std::fs::read_to_string(trusted_path)
        .map_err(|e| format!("{} (run from the repo root): {e}", trusted_path.display()))?;
    let trusted = PublicKeyBox::from_string(&trusted)
        .and_then(PublicKeyBox::into_public_key)
        .map_err(|e| format!("{}: {e}", trusted_path.display()))?;
    if trusted.to_base64() != pk.to_base64() {
        return Err(format!(
            "This key isn't the one in {}; nothing signed.",
            trusted_path.display()
        ));
    }

    // The signed comment names the file; the exe expects this one.
    let zip_name = zip.file_name().and_then(|n| n.to_str());
    if zip_name != Some(ZIP_NAME) {
        return Err(format!(
            "Sign the release's {ZIP_NAME}, not {}",
            zip.display()
        ));
    }
    let zip_name = ZIP_NAME;
    // As the exe's plain_tag: a tag it wouldn't read is never offered.
    if tag.is_empty()
        || tag.len() > 32
        || !tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(format!("Tag {tag:?} isn't a plain tag like v0.4.37"));
    }
    let data = std::fs::read(zip).map_err(|e| format!("{}: {e}", zip.display()))?;
    let comment = trusted_comment(zip_name, tag);
    let signature = minisign::sign(
        Some(&pk),
        &sk,
        Cursor::new(&data),
        Some(&comment),
        Some("Lioneye release signature"),
    )
    .map_err(|e| e.to_string())?;
    // Read back the way the exe will.
    let signature_box =
        minisign::SignatureBox::from_string(&signature.to_string()).map_err(|e| e.to_string())?;
    minisign::verify(&pk, &signature_box, Cursor::new(&data), true, false, false)
        .map_err(|e| format!("Signature didn't verify: {e}"))?;

    let mut out = zip.as_os_str().to_owned();
    out.push(".minisig");
    let out = PathBuf::from(out);
    std::fs::write(&out, signature.to_string()).map_err(|e| format!("{}: {e}", out.display()))?;
    println!("Signed {} as {comment:?}: {}", zip.display(), out.display());
    Ok(())
}

/// The key, DPAPI-protected; its plain bytes are wiped once protected.
fn protect_key(sk: &SecretKey) -> Result<Vec<u8>, String> {
    let mut plain = sk.to_bytes();
    let locked = dpapi::protect(&plain);
    wipe(&mut plain);
    locked
}

/// Zeroes key bytes before they're freed (volatile, so it isn't optimized away).
fn wipe(bytes: &mut [u8]) {
    for byte in bytes.iter_mut() {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

/// Writes a file that must not exist yet.
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(bytes)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// The key locked to this Windows account (DPAPI, user scope): readable only by this user
/// on this PC.
#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };

    /// Mixed in, so another program's DPAPI blob of this user can't be passed off as the key.
    const ENTROPY: &[u8] = b"lioneye-release-key";

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        unsafe {
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            std::ptr::write_bytes(out.pbData, 0, out.cbData as usize);
            LocalFree(out.pbData.cast());
            bytes
        }
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &blob(data),
                std::ptr::null(),
                &blob(ENTROPY),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(format!(
                "Not protected: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(take(out))
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &blob(data),
                std::ptr::null_mut(),
                &blob(ENTROPY),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(format!(
                "Key not readable by this Windows account ({}); run restore.",
                std::io::Error::last_os_error()
            ));
        }
        Ok(take(out))
    }
}

#[cfg(not(windows))]
mod dpapi {
    pub fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("Signing needs Windows".into())
    }
    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("Signing needs Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn round_trips_through_dpapi() {
        let data = b"secret bytes";
        let locked = dpapi::protect(data).unwrap();
        assert_ne!(&locked[..], data);
        assert_eq!(dpapi::unprotect(&locked).unwrap(), data);
    }

    /// A key made as keygen makes it, then a zip signed and read back.
    #[cfg(windows)]
    #[test]
    fn signs_with_the_trusted_key() {
        let dir = std::env::temp_dir().join(format!("sign-release-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = files(&dir);
        let KeyPair { pk, sk } = KeyPair::generate_encrypted_keypair(Some("pw".into())).unwrap();
        let sk = SecretKey::from_box(sk.to_box(None).unwrap(), Some("pw".into())).unwrap();
        std::fs::write(&f.local, dpapi::protect(&sk.to_bytes()).unwrap()).unwrap();
        std::fs::write(&f.public, pk.to_box().unwrap().to_string()).unwrap();
        let zip = dir.join(ZIP_NAME);
        std::fs::write(&zip, b"zip bytes").unwrap();

        sign(&dir, &zip, "v1.2.3", &f.public).unwrap();
        let text = std::fs::read_to_string(dir.join("lioneye.zip.minisig")).unwrap();
        let signature = minisign::SignatureBox::from_string(&text).unwrap();
        assert_eq!(signature.trusted_comment().unwrap(), "lioneye.zip v1.2.3");
        minisign::verify(
            &pk,
            &signature,
            Cursor::new(b"zip bytes"),
            true,
            false,
            false,
        )
        .unwrap();

        // Another key than the trusted one: nothing signed.
        let other = KeyPair::generate_unencrypted_keypair().unwrap().pk;
        let other_path = dir.join("other.pub");
        std::fs::write(&other_path, other.to_box().unwrap().to_string()).unwrap();
        assert!(sign(&dir, &zip, "v1.2.3", &other_path).is_err());
        // Another file name, or a tag that isn't plain: refused.
        let renamed = dir.join("other.zip");
        std::fs::write(&renamed, b"zip bytes").unwrap();
        assert!(sign(&dir, &renamed, "v1.2.3", &f.public).is_err());
        assert!(sign(&dir, &zip, "v1 2", &f.public).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_the_tag() {
        assert_eq!(
            trusted_comment("lioneye.zip", "v0.4.37"),
            "lioneye.zip v0.4.37"
        );
    }
}
