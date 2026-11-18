//! Shareable invite codes, short enough to paste in a chat line.
//!
//! A code is 48 bytes: a 128-bit invite seed and the inviter's node id. The seed derives the
//! ed25519 invite key whose public half was registered in the space log, so holding the code is
//! the capability to join. Nothing else needs to travel: the member being dialed finds the space
//! from the invite key, and node addresses come from discovery (DNS / mDNS).

use anyhow::{Context, Result, ensure};

use crate::id::Id;

const PREFIX: &str = "halka:";
const SEED_LEN: usize = 16;

#[derive(Clone, Debug, PartialEq)]
pub struct InviteCode {
    pub seed: [u8; SEED_LEN],
    /// A member to dial (the inviter).
    pub peer: Id,
    /// The space requires relay-only, so the joiner can refuse before dialing with its IP.
    /// Carried as an optional 49th byte: plain codes stay exactly as before.
    pub relay: bool,
}

impl InviteCode {
    pub fn new(peer: Id) -> InviteCode {
        InviteCode {
            seed: rand::random(),
            peer,
            relay: false,
        }
    }

    pub fn encode(&self) -> String {
        let flag: &[u8] = if self.relay { &[1] } else { &[] };
        let b = [&self.seed[..], &self.peer.0[..], flag].concat();
        format!("{PREFIX}{}", data_encoding::BASE64URL_NOPAD.encode(&b))
    }

    pub fn decode(s: &str) -> Result<InviteCode> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        let body = s
            .strip_prefix(PREFIX)
            .context("bu bir Halka davet kodu değil")?;
        let b = data_encoding::BASE64URL_NOPAD
            .decode(body.as_bytes())
            .context("davet kodu bozuk")?;
        ensure!(
            b.len() == SEED_LEN + 32 || b.get(SEED_LEN + 32..) == Some(&[1][..]),
            "davet kodu eksik ya da fazla kopyalanmış"
        );
        Ok(InviteCode {
            seed: b[..SEED_LEN].try_into()?,
            peer: Id(b[SEED_LEN..SEED_LEN + 32].try_into()?),
            relay: b.len() > SEED_LEN + 32,
        })
    }

    pub fn key(&self) -> iroh::SecretKey {
        iroh::SecretKey::from_bytes(&Id::hash("halka/invite-seed/v1", &self.seed).0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_short_and_strict() {
        let c = InviteCode::new(Id([7; 32]));
        let s = c.encode();
        assert!(s.len() <= 70, "{} chars: {s}", s.len());
        assert_eq!(InviteCode::decode(&format!(" {s}\n")).unwrap(), c);
        assert_eq!(
            c.key().public(),
            InviteCode::decode(&s).unwrap().key().public()
        );
        assert!(InviteCode::decode("nope").is_err());
        let r = InviteCode { relay: true, ..c.clone() };
        assert_eq!(InviteCode::decode(&r.encode()).unwrap(), r);
        assert!(!InviteCode::decode(&s).unwrap().relay);
        assert!(
            InviteCode::decode(&s[..s.len() - 2]).is_err(),
            "truncated code rejected"
        );
    }
}
