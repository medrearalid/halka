//! Crypto-shredding vault. Every stored message and file is encrypted under its own key, kept
//! in a fixed slot of `keys.bin`. Deleting overwrites that slot in place, so ciphertext left
//! behind in redb's freed pages or in a removed blob's old sectors can never be read again.
//! RAM slots never touch the disk at all: their data is unreadable once the process exits.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit as _};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Result, anyhow, ensure};
use parking_lot::Mutex;

/// Slots with this bit live only in memory.
pub const RAM: u32 = 1 << 31;
const SLOT: u64 = 32;
const NONCE: usize = 12;
pub const TAG: usize = 16;

struct Keys {
    file: File,
    disk: HashMap<u32, [u8; 32]>,
    free: Vec<u32>,
    len: u32,
    ram: HashMap<u32, [u8; 32]>,
    next_ram: u32,
    /// Bulk allocation (migration): one fsync at the end instead of one per key.
    deferred: bool,
}

pub struct Vault {
    master: [u8; 32],
    keys: Mutex<Keys>,
}

fn write_slot(f: &mut File, slot: u32, k: &[u8; 32], sync: bool) -> Result<()> {
    f.seek(SeekFrom::Start(slot as u64 * SLOT))?;
    f.write_all(k)?;
    if sync {
        f.sync_data()?;
    }
    Ok(())
}

impl Vault {
    pub fn open(path: &Path, master: [u8; 32]) -> Result<Vault> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)?;
        let (mut disk, mut free) = (HashMap::new(), Vec::new());
        for (i, c) in buf.chunks_exact(SLOT as usize).enumerate() {
            let k: [u8; 32] = c.try_into()?;
            if k == [0; 32] {
                free.push(i as u32);
            } else {
                disk.insert(i as u32, k);
            }
        }
        let len = (buf.len() as u64 / SLOT) as u32;
        Ok(Vault {
            master,
            keys: Mutex::new(Keys {
                file,
                disk,
                free,
                len,
                ram: HashMap::new(),
                next_ram: 0,
                deferred: false,
            }),
        })
    }

    pub fn alloc(&self, ram: bool) -> Result<u32> {
        let k: [u8; 32] = rand::random();
        let mut g = self.keys.lock();
        if ram {
            let s = RAM | g.next_ram;
            g.next_ram = (g.next_ram + 1) & !RAM;
            g.ram.insert(s, k);
            return Ok(s);
        }
        let s = match g.free.pop() {
            Some(s) => s,
            None => {
                ensure!(g.len < RAM, "vault full");
                g.len += 1;
                g.len - 1
            }
        };
        let sync = !g.deferred;
        write_slot(&mut g.file, s, &k, sync)?;
        g.disk.insert(s, k);
        Ok(s)
    }

    /// New keys skip their fsync until `end_bulk`. Shreds always sync.
    pub fn begin_bulk(&self) {
        self.keys.lock().deferred = true;
    }

    pub fn end_bulk(&self) -> Result<()> {
        let mut g = self.keys.lock();
        g.deferred = false;
        g.file.sync_data()?;
        Ok(())
    }

    /// Overwrite the slot's key in place (disk) or forget it (RAM). Idempotent.
    pub fn shred(&self, slot: u32) -> Result<()> {
        let mut g = self.keys.lock();
        if slot & RAM != 0 {
            g.ram.remove(&slot);
        } else if g.disk.remove(&slot).is_some() {
            write_slot(&mut g.file, slot, &[0; 32], true)?;
            g.free.push(slot);
        }
        Ok(())
    }

    pub fn disk_slots(&self) -> Vec<u32> {
        self.keys.lock().disk.keys().copied().collect()
    }

    fn cipher(&self, slot: u32) -> Result<Aes256Gcm> {
        let g = self.keys.lock();
        let raw = if slot & RAM != 0 {
            g.ram.get(&slot)
        } else {
            g.disk.get(&slot)
        }
        .ok_or_else(|| anyhow!("key gone"))?;
        let k = blake3::derive_key("halka/vault/v1", &[self.master, *raw].concat());
        Aes256Gcm::new_from_slice(&k).map_err(|_| anyhow!("bad key"))
    }

    /// slot(le) ++ nonce ++ ciphertext
    pub fn seal(&self, slot: u32, plain: &[u8]) -> Result<Vec<u8>> {
        let n: [u8; NONCE] = rand::random();
        let ct = self
            .cipher(slot)?
            .encrypt(Nonce::from_slice(&n), plain)
            .map_err(|_| anyhow!("encrypt failed"))?;
        Ok([&slot.to_le_bytes()[..], &n, &ct].concat())
    }

    pub fn open_sealed(&self, v: &[u8]) -> Result<Vec<u8>> {
        ensure!(v.len() >= 4 + NONCE + TAG, "short sealed value");
        let slot = u32::from_le_bytes(v[..4].try_into()?);
        self.cipher(slot)?
            .decrypt(Nonce::from_slice(&v[4..4 + NONCE]), &v[4 + NONCE..])
            .map_err(|_| anyhow!("decrypt failed"))
    }

    pub fn slot_of(v: &[u8]) -> Option<u32> {
        Some(u32::from_le_bytes(v.get(..4)?.try_into().ok()?))
    }

    /// File chunks: one key per file, so the chunk index is a unique nonce.
    pub fn seal_chunk(&self, slot: u32, idx: u64, plain: &[u8]) -> Result<Vec<u8>> {
        self.cipher(slot)?
            .encrypt(Nonce::from_slice(&chunk_nonce(idx)), plain)
            .map_err(|_| anyhow!("encrypt failed"))
    }

    pub fn open_chunk(&self, slot: u32, idx: u64, ct: &[u8]) -> Result<Vec<u8>> {
        self.cipher(slot)?
            .decrypt(Nonce::from_slice(&chunk_nonce(idx)), ct)
            .map_err(|_| anyhow!("decrypt failed"))
    }
}

fn chunk_nonce(idx: u64) -> [u8; NONCE] {
    let mut n = [0u8; NONCE];
    n[..8].copy_from_slice(&idx.to_le_bytes());
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shred_makes_data_unreadable_and_zeroes_disk() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("keys.bin");
        let v = Vault::open(&p, [7; 32]).unwrap();
        let (a, b) = (v.alloc(false).unwrap(), v.alloc(false).unwrap());
        let r = v.alloc(true).unwrap();
        let (sa, sb, sr) = (
            v.seal(a, b"alpha").unwrap(),
            v.seal(b, b"beta").unwrap(),
            v.seal(r, b"ram").unwrap(),
        );
        assert_eq!(v.open_sealed(&sa).unwrap(), b"alpha");
        assert_eq!(v.open_sealed(&sr).unwrap(), b"ram");
        v.shred(a).unwrap();
        assert!(v.open_sealed(&sa).is_err());
        let raw = std::fs::read(&p).unwrap();
        assert_eq!(&raw[a as usize * 32..a as usize * 32 + 32], &[0; 32]);
        drop(v);
        // reopen: disk key survives, RAM key and shredded key don't, freed slot is reused
        let v = Vault::open(&p, [7; 32]).unwrap();
        assert_eq!(v.open_sealed(&sb).unwrap(), b"beta");
        assert!(v.open_sealed(&sr).is_err() && v.open_sealed(&sa).is_err());
        assert_eq!(v.alloc(false).unwrap(), a);
        // wrong master can't read
        drop(v);
        let w = Vault::open(&p, [8; 32]).unwrap();
        assert!(w.open_sealed(&sb).is_err());
    }
}
