//! Chat messages: individually signed, validated against the space state on receipt.
//! Edits and deletes are messages too, referencing a target.

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

use crate::id::{self, Id, Sig};
use crate::perm::Perms;
use crate::space::State;

pub const MAX_TEXT: usize = 4000;
pub const MAX_FILES: usize = 10;
/// Hard cap on any attachment, whatever the tier (the receiver applies its own lower cap).
pub const MAX_FILE: u64 = 500 * 1024 * 1024;
pub const MIN_TTL_MS: u32 = 5_000;
pub const MAX_TTL_MS: u32 = 30 * 86_400_000;
const MAX_FILE_NAME: usize = 120;
const MAX_IMAGE_SIDE: u16 = 8192;
pub const MAX_MSG_BYTES: usize = 16 * 1024;
/// Messages claiming to be from further in the future than this are refused.
pub const MAX_CLOCK_SKEW_MS: u64 = 5 * 60 * 1000;
const DOMAIN_MSG: &str = "halka/msg/v1";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum MsgBody {
    Text { text: String, reply_to: Option<Id> },
    Edit { target: Id, text: String },
    Delete { target: Id },
    /// Appended last so older variants keep their postcard tags. Plain text without a timer or
    /// files still goes out as `Text`, so peers that haven't updated keep reading it.
    Post {
        text: String,
        reply_to: Option<Id>,
        ttl_ms: Option<u32>,
        files: Vec<FileRef>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRef {
    /// blake3 of the plain file bytes.
    pub hash: Id,
    pub size: u64,
    pub name: String,
    pub mime: String,
    /// Width and height when the sender claims a WebP image (re-checked before display).
    pub image: Option<(u16, u16)>,
}

impl Msg {
    /// Unix ms after which the message must be gone everywhere.
    pub fn expires(&self) -> Option<u64> {
        match &self.body {
            MsgBody::Post { ttl_ms: Some(t), .. } => Some(self.ts.saturating_add(*t as u64)),
            _ => None,
        }
    }

    pub fn files(&self) -> &[FileRef] {
        match &self.body {
            MsgBody::Post { files, .. } => files,
            _ => &[],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Msg {
    pub space: Id,
    pub channel: Id,
    pub author: Id,
    pub ts: u64,
    pub body: MsgBody,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SignedMsg {
    pub bytes: Vec<u8>,
    pub sig: Sig,
}

impl SignedMsg {
    pub fn sign(key: &iroh::SecretKey, m: &Msg) -> Result<SignedMsg> {
        let bytes = postcard::to_stdvec(m)?;
        Ok(SignedMsg {
            sig: id::sign(key, DOMAIN_MSG, &bytes),
            bytes,
        })
    }

    pub fn id(&self) -> Id {
        Id::hash(DOMAIN_MSG, &self.bytes)
    }

    /// Structural check only (size, encoding, signature, text limits).
    pub fn verify(&self) -> Result<Msg> {
        ensure!(self.bytes.len() <= MAX_MSG_BYTES, "message too large");
        let m: Msg = postcard::from_bytes(&self.bytes)?;
        ensure!(
            postcard::to_stdvec(&m)? == self.bytes,
            "non-canonical message"
        );
        ensure!(
            id::verify(&m.author, DOMAIN_MSG, &self.bytes, &self.sig),
            "bad message signature"
        );
        match &m.body {
            MsgBody::Text { text, .. } | MsgBody::Edit { text, .. } => check_text(text)?,
            MsgBody::Delete { .. } => {}
            MsgBody::Post {
                text,
                ttl_ms,
                files,
                ..
            } => {
                ensure!(files.len() <= MAX_FILES, "en fazla {MAX_FILES} dosya eklenebilir");
                if files.is_empty() {
                    check_text(text)?;
                } else {
                    ensure!(text.chars().count() <= MAX_TEXT, "mesaj çok uzun");
                }
                ensure!(ttl_ms.is_some() || !files.is_empty(), "non-canonical post");
                check_ttl(*ttl_ms)?;
                for f in files {
                    check_file(f)?;
                }
            }
        }
        Ok(m)
    }
}

pub fn check_text(t: &str) -> Result<()> {
    ensure!(!t.trim().is_empty(), "boş mesaj");
    ensure!(
        t.chars().count() <= MAX_TEXT,
        "mesaj en fazla {MAX_TEXT} karakter olabilir"
    );
    Ok(())
}

pub fn check_ttl(t: Option<u32>) -> Result<()> {
    ensure!(
        t.is_none_or(|t| (MIN_TTL_MS..=MAX_TTL_MS).contains(&t)),
        "süre 5 saniye ile 30 gün arasında olmalı"
    );
    Ok(())
}

fn check_file(f: &FileRef) -> Result<()> {
    ensure!(f.size > 0 && f.size <= MAX_FILE, "dosya en fazla 500 MB olabilir");
    check_file_name(&f.name)?;
    ensure!(
        f.mime.len() <= 64
            && f.mime.split_once('/').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
            && f.mime.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"/.+-".contains(&c)),
        "geçersiz dosya türü"
    );
    if let Some((w, h)) = f.image {
        ensure!(
            f.mime == "image/webp"
                && (1..=MAX_IMAGE_SIDE).contains(&w)
                && (1..=MAX_IMAGE_SIDE).contains(&h),
            "geçersiz görsel"
        );
    }
    Ok(())
}

/// A name that is safe to show and to save on Windows: no path parts, no control or
/// direction-override characters (which can disguise `exe` as `txt`), no reserved device names.
pub fn check_file_name(n: &str) -> Result<()> {
    let count = n.chars().count();
    ensure!(
        (1..=MAX_FILE_NAME).contains(&count),
        "dosya adı 1–{MAX_FILE_NAME} karakter olmalı"
    );
    ensure!(
        n.chars().all(|c| !c.is_control()
            && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            && !matches!(c as u32, 0x200e | 0x200f | 0x202a..=0x202e | 0x2066..=0x2069)),
        "dosya adı geçersiz karakter içeriyor"
    );
    ensure!(
        !n.ends_with(['.', ' ']) && !n.starts_with(' '),
        "dosya adı geçersiz"
    );
    let stem = n.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    ensure!(!reserved, "dosya adı geçersiz");
    Ok(())
}

/// May this (structurally valid) message be accepted given the current space state?
/// Ex-members' messages pass here so history stays intact; the node never accepts them
/// as live pushes, only via reconciliation from current members.
pub fn authorized(st: &State, m: &Msg, now: u64) -> Result<()> {
    ensure!(m.space == st.id, "wrong space");
    ensure!(m.ts <= now + MAX_CLOCK_SKEW_MS, "message from the future");
    ensure!(m.expires().is_none_or(|e| e > now), "message expired");
    ensure!(st.channels.contains_key(&m.channel), "kanal yok");
    if st.is_member(&m.author) {
        let need = match m.body {
            MsgBody::Text { .. } | MsgBody::Edit { .. } | MsgBody::Post { .. } => Perms::SEND,
            MsgBody::Delete { .. } => Perms(0),
        };
        ensure!(
            st.can_view(&m.author, &m.channel) && st.perms(&m.author).has(need),
            "bu kanalda yazma yetkin yok"
        );
        return Ok(());
    }
    ensure!(st.former.contains_key(&m.author), "üye değil");
    Ok(())
}

/// Can `actor` delete `target_author`'s message in `channel`?
pub fn can_delete(st: &State, actor: &Id, target_author: &Id, channel: &Id) -> bool {
    actor == target_author || st.can_in(actor, channel, Perms::MANAGE_MESSAGES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_and_ttl() {
        for ok in ["rapor.pdf", "ekran görüntüsü 1.webp", "a", ".gitignore", "console.log"] {
            assert!(check_file_name(ok).is_ok(), "{ok}");
        }
        let long = "x".repeat(121);
        for bad in [
            "", "a/b", "..\\x", "c:x", "con.txt", "COM1", "lpt9.log", "x.", " x",
            "fatura\u{202e}fdp.exe", "a\nb", long.as_str(),
        ] {
            assert!(check_file_name(bad).is_err(), "{bad:?}");
        }
        assert!(check_ttl(Some(MIN_TTL_MS)).is_ok() && check_ttl(None).is_ok());
        assert!(check_ttl(Some(1000)).is_err() && check_ttl(Some(MAX_TTL_MS + 1)).is_err());
    }
}
