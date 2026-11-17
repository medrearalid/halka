//! Shareable invite codes. A code carries the invite *secret* (an ed25519 key whose public half
//! was registered in the space log) plus a few member addresses to bootstrap from. Any online
//! member can admit the holder, so the inviter doesn't need to be online.

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use crate::id::Id;

const PREFIX: &str = "halka1";
const MAX_CODE: usize = 4096;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InviteCode {
    pub space: Id,
    pub space_name: String,
    pub secret: [u8; 32],
    pub peers: Vec<iroh::EndpointAddr>,
}

impl InviteCode {
    pub fn encode(&self) -> Result<String> {
        let b = postcard::to_stdvec(self)?;
        Ok(format!("{PREFIX}{}", data_encoding::BASE32_NOPAD.encode(&b).to_lowercase()))
    }

    pub fn decode(s: &str) -> Result<InviteCode> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        ensure!(s.len() <= MAX_CODE, "davet kodu çok uzun");
        let body = s.strip_prefix(PREFIX).context("bu bir Halka davet kodu değil")?;
        let b = data_encoding::BASE32_NOPAD.decode(body.to_uppercase().as_bytes()).context("davet kodu bozuk")?;
        let c: InviteCode = postcard::from_bytes(&b).context("davet kodu bozuk")?;
        ensure!(c.peers.len() <= 8, "davet kodu bozuk");
        Ok(c)
    }

    pub fn key(&self) -> iroh::SecretKey {
        iroh::SecretKey::from_bytes(&self.secret)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let k = iroh::SecretKey::generate();
        let c = InviteCode { space: Id([7; 32]), space_name: "x".into(), secret: k.to_bytes(), peers: vec![iroh::EndpointAddr::new(k.public())] };
        let s = c.encode().unwrap();
        let d = InviteCode::decode(&format!(" {s}\n")).unwrap();
        assert_eq!(d.space, c.space);
        assert!(InviteCode::decode("nope").is_err());
    }
}
