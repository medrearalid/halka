//! The node's long-term secret key. On Windows it is sealed with DPAPI (bound to the user
//! account), so copying the data directory to another machine/user doesn't leak the identity.

use anyhow::Result;

use crate::store::Store;

const KEY: &str = "identity";

pub fn load_or_create(store: &Store) -> Result<iroh::SecretKey> {
    if let Some(sealed) = store.meta(KEY)? {
        let raw = unseal(&sealed)?;
        let b: [u8; 32] = raw
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("corrupt identity"))?;
        return Ok(iroh::SecretKey::from_bytes(&b));
    }
    let k = iroh::SecretKey::generate();
    store.set_meta(KEY, &seal(&k.to_bytes())?)?;
    Ok(k)
}

#[cfg(windows)]
fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::Foundation::{HLOCAL, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: input points to a live slice; out is filled by the OS and freed with LocalFree.
    unsafe {
        let ok = if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        anyhow::ensure!(ok != 0, "DPAPI failed: {}", std::io::Error::last_os_error());
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as HLOCAL);
        Ok(v)
    }
}

#[cfg(windows)]
pub(crate) fn seal(d: &[u8]) -> Result<Vec<u8>> {
    dpapi(d, true)
}
#[cfg(windows)]
pub(crate) fn unseal(d: &[u8]) -> Result<Vec<u8>> {
    dpapi(d, false)
}

// shortcut: other platforms store the key unsealed in the (user-private) data dir; upgrade to the
// OS keychain when non-Windows builds matter.
#[cfg(not(windows))]
pub(crate) fn seal(d: &[u8]) -> Result<Vec<u8>> {
    Ok(d.to_vec())
}
#[cfg(not(windows))]
pub(crate) fn unseal(d: &[u8]) -> Result<Vec<u8>> {
    Ok(d.to_vec())
}
