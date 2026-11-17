use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// 32 bytes: a public key (member, invite) or a blake3 hash (op, message, space, channel, role).
/// Hex when human-readable (JSON/UI), raw bytes on the wire.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct Id(pub [u8; 32]);

impl Id {
    pub const ZERO: Id = Id([0; 32]);

    pub fn hash(domain: &str, data: &[u8]) -> Id {
        let mut h = blake3::Hasher::new_derive_key(domain);
        h.update(data);
        Id(*h.finalize().as_bytes())
    }

    pub fn hex(&self) -> String {
        hex::encode(self.0)
    }

    pub fn parse(s: &str) -> anyhow::Result<Id> {
        let mut b = [0u8; 32];
        hex::decode_to_slice(s.trim(), &mut b)?;
        Ok(Id(b))
    }

    pub fn key(&self) -> anyhow::Result<iroh::PublicKey> {
        Ok(iroh::PublicKey::from_bytes(&self.0)?)
    }
}

impl From<iroh::PublicKey> for Id {
    fn from(k: iroh::PublicKey) -> Self {
        Id(*k.as_bytes())
    }
}

impl fmt::Debug for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", &self.hex()[..10])
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.hex())
    }
}

impl Serialize for Id {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            s.serialize_str(&self.hex())
        } else {
            s.serialize_bytes(&self.0)
        }
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        if d.is_human_readable() {
            let s = String::deserialize(d)?;
            Id::parse(&s).map_err(D::Error::custom)
        } else {
            let b: &[u8] = serde_bytes_slice(d)?;
            Ok(Id(b
                .try_into()
                .map_err(|_| D::Error::custom("id must be 32 bytes"))?))
        }
    }
}

fn serde_bytes_slice<'de, D: Deserializer<'de>>(d: D) -> Result<&'de [u8], D::Error> {
    struct V;
    impl<'de> serde::de::Visitor<'de> for V {
        type Value = &'de [u8];
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("32 bytes")
        }
        fn visit_borrowed_bytes<E>(self, v: &'de [u8]) -> Result<Self::Value, E> {
            Ok(v)
        }
    }
    d.deserialize_bytes(V)
}

/// 64-byte ed25519 signature as raw bytes on the wire.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Sig(pub [u8; 64]);

impl fmt::Debug for Sig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Sig(..)")
    }
}

impl Serialize for Sig {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(&self.0)
    }
}

impl<'de> Deserialize<'de> for Sig {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let b = serde_bytes_slice(d)?;
        Ok(Sig(b
            .try_into()
            .map_err(|_| D::Error::custom("sig must be 64 bytes"))?))
    }
}

pub fn sign(key: &iroh::SecretKey, domain: &str, msg: &[u8]) -> Sig {
    Sig(key.sign(&domained(domain, msg)).to_bytes())
}

pub fn verify(author: &Id, domain: &str, msg: &[u8], sig: &Sig) -> bool {
    let Ok(pk) = author.key() else { return false };
    pk.verify(&domained(domain, msg), &iroh::Signature::from_bytes(&sig.0))
        .is_ok()
}

// Domain separation so a signature for one purpose can never be replayed as another.
fn domained(domain: &str, msg: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(domain.len() + 1 + msg.len());
    v.extend_from_slice(domain.as_bytes());
    v.push(0);
    v.extend_from_slice(msg);
    v
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_domains() {
        let k = iroh::SecretKey::generate();
        let id: Id = k.public().into();
        let s = sign(&k, "a", b"m");
        assert!(verify(&id, "a", b"m", &s));
        assert!(!verify(&id, "b", b"m", &s));
        let bytes = postcard::to_stdvec(&id).unwrap();
        assert_eq!(bytes.len(), 33);
        assert_eq!(postcard::from_bytes::<Id>(&bytes).unwrap(), id);
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(serde_json::from_str::<Id>(&json).unwrap(), id);
    }
}
