//! Wire protocol: one bidirectional control stream of length-prefixed postcard frames per
//! connection, QUIC datagrams for voice, and one unidirectional stream per screen-share GOP.

use anyhow::{Result, ensure};
use iroh::endpoint::{RecvStream, SendStream};
use serde::{Deserialize, Serialize};

use crate::id::{Id, Sig};
use crate::msg::SignedMsg;
use crate::op::SignedOp;

pub const ALPN: &[u8] = b"halka/1";
pub const MAX_FRAME: usize = 1 << 20;
pub const MAX_HELLO: usize = 16 * 1024;
/// Datagram tags.
pub const DG_VOICE: u8 = 1;
/// Screen-share audio, sent only to that stream's watchers.
pub const DG_STREAM_AUDIO: u8 = 2;
/// A peer's own connection quality, every 2 s. Older clients ignore unknown datagram tags.
pub const DG_LINK: u8 = 3;
/// Uni-stream tag for screen share GOPs.
pub const UNI_STREAM: u8 = b'S';

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bucket {
    pub key: u64,
    pub count: u32,
    pub xor: Id,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Presence {
    pub channel: Id,
    pub muted: bool,
    pub deafened: bool,
    pub streaming: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JoinReq {
    /// Invite public key; the acceptor looks up which space it belongs to.
    pub invite: Id,
    /// Invite key's signature over (invite, joiner) under DOMAIN_ADMIT.
    pub proof: Sig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Frame {
    /// First frame from the dialer: spaces it believes we share, or a join request.
    Hello {
        spaces: Vec<Id>,
        join: Option<JoinReq>,
    },
    /// Acceptor's answer: the spaces this connection is allowed to talk about.
    Welcome {
        spaces: Vec<Id>,
    },
    OpSummary {
        space: Id,
        buckets: Vec<Bucket>,
    },
    OpIds {
        space: Id,
        bucket: u64,
        ids: Vec<Id>,
    },
    WantOps {
        space: Id,
        ids: Vec<Id>,
    },
    Ops {
        space: Id,
        ops: Vec<SignedOp>,
    },
    MsgSummary {
        space: Id,
        channel: Id,
        buckets: Vec<Bucket>,
    },
    MsgIds {
        space: Id,
        channel: Id,
        bucket: u64,
        ids: Vec<Id>,
    },
    /// `live`: a fresh push (vs. history from reconciliation).
    Msgs {
        space: Id,
        msgs: Vec<SignedMsg>,
        live: bool,
    },
    /// Sender's own voice presence in a space (None = not in voice there).
    Presence {
        space: Id,
        voice: Option<Presence>,
    },
    /// Ask the remote to start/stop sending us its screen share.
    Watch {
        on: bool,
    },
    /// Watcher asks the sharer for a key frame.
    Keyframe,
}

pub async fn write_frame(s: &mut SendStream, f: &Frame) -> Result<()> {
    let b = postcard::to_stdvec(f)?;
    ensure!(b.len() <= MAX_FRAME, "frame too large");
    s.write_all(&(b.len() as u32).to_le_bytes()).await?;
    s.write_all(&b).await?;
    Ok(())
}

/// Reads one frame, refusing anything over `max` bytes before allocating it.
pub async fn read_frame(r: &mut RecvStream, max: usize) -> Result<Option<Frame>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(()) => {}
        Err(iroh::endpoint::ReadExactError::FinishedEarly(0)) => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_le_bytes(len) as usize;
    ensure!(len <= max, "frame of {len} bytes exceeds limit");
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Ok(Some(postcard::from_bytes(&buf)?))
}

/// Bucketed set summary for reconciliation: items are (sort key, id).
pub fn summarize(items: impl IntoIterator<Item = (u64, Id)>, width: u64) -> Vec<Bucket> {
    let mut out: std::collections::BTreeMap<u64, Bucket> = Default::default();
    for (k, id) in items {
        let key = k / width;
        let b = out.entry(key).or_insert(Bucket {
            key,
            count: 0,
            xor: Id::ZERO,
        });
        b.count += 1;
        for (x, y) in b.xor.0.iter_mut().zip(id.0) {
            *x ^= y;
        }
    }
    out.into_values().collect()
}

/// Buckets that differ between `ours` and `theirs` (present on either side).
pub fn diff(ours: &[Bucket], theirs: &[Bucket]) -> Vec<u64> {
    let a: std::collections::BTreeMap<u64, &Bucket> = ours.iter().map(|b| (b.key, b)).collect();
    let b: std::collections::BTreeMap<u64, &Bucket> = theirs.iter().map(|b| (b.key, b)).collect();
    let keys: std::collections::BTreeSet<u64> = a.keys().chain(b.keys()).copied().collect();
    keys.into_iter().filter(|k| a.get(k) != b.get(k)).collect()
}

/// Sender's own view of its links: median RTT to the peers it measures and how many of those
/// paths are direct vs relayed; `hidden_ip` = it runs relay-only, so every link to it is relayed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Link {
    pub ms: Option<u16>,
    pub direct: u8,
    pub relay: u8,
    pub hidden_ip: bool,
}

impl Link {
    pub fn encode(&self) -> [u8; 6] {
        let ms = self.ms.unwrap_or(u16::MAX).to_le_bytes();
        [DG_LINK, ms[0], ms[1], self.direct, self.relay, self.hidden_ip as u8]
    }
    pub fn decode(dg: &[u8]) -> Option<Link> {
        let [DG_LINK, a, b, direct, relay, flags, ..] = *dg else { return None };
        let ms = u16::from_le_bytes([a, b]);
        Some(Link { ms: (ms != u16::MAX).then_some(ms), direct, relay, hidden_ip: flags & 1 != 0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_roundtrip() {
        for l in [
            Link { ms: Some(38), direct: 2, relay: 1, hidden_ip: false },
            Link { ms: None, direct: 0, relay: 0, hidden_ip: true },
        ] {
            assert_eq!(Link::decode(&l.encode()), Some(l));
        }
        assert_eq!(Link::decode(&[DG_LINK, 1, 2]), None);
        assert_eq!(Link::decode(&[DG_VOICE, 0, 0, 0, 0, 0]), None);
    }

    #[test]
    fn diff_finds_mismatch() {
        let a = summarize([(1, Id([1; 32])), (70, Id([2; 32]))], 64);
        let b = summarize(
            [(1, Id([1; 32])), (70, Id([3; 32])), (200, Id([4; 32]))],
            64,
        );
        assert_eq!(diff(&a, &b), vec![1, 3]);
        assert!(diff(&a, &a).is_empty());
    }
}
