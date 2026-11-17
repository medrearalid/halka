//! Chat messages: individually signed, validated against the space state on receipt.
//! Edits and deletes are messages too, referencing a target.

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

use crate::id::{self, Id, Sig};
use crate::perm::Perms;
use crate::space::State;

pub const MAX_TEXT: usize = 4000;
pub const MAX_MSG_BYTES: usize = 16 * 1024;
/// Messages claiming to be from further in the future than this are refused.
pub const MAX_CLOCK_SKEW_MS: u64 = 5 * 60 * 1000;
const DOMAIN_MSG: &str = "halka/msg/v1";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum MsgBody {
    Text { text: String, reply_to: Option<Id> },
    Edit { target: Id, text: String },
    Delete { target: Id },
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

/// May this (structurally valid) message be accepted given the current space state?
/// Ex-members' messages pass here so history stays intact; the node never accepts them
/// as live pushes, only via reconciliation from current members.
pub fn authorized(st: &State, m: &Msg, now: u64) -> Result<()> {
    ensure!(m.space == st.id, "wrong space");
    ensure!(m.ts <= now + MAX_CLOCK_SKEW_MS, "message from the future");
    let ch = st
        .channels
        .get(&m.channel)
        .ok_or_else(|| anyhow::anyhow!("kanal yok"))?;
    ensure!(
        ch.kind == crate::op::ChannelKind::Text,
        "metin kanalı değil"
    );
    if st.is_member(&m.author) {
        let need = match m.body {
            MsgBody::Text { .. } | MsgBody::Edit { .. } => Perms::SEND,
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
