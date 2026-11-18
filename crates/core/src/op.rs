//! Signed control operations. Every space is a DAG of these ops; the state is a deterministic
//! replay of the DAG (see `space.rs`). Messages live in a separate, lighter log (`msg.rs`).

use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};

use crate::id::{self, Id, Sig};
use crate::perm::Perms;

pub const MAX_OP_BYTES: usize = 8 * 1024;
pub const MAX_PARENTS: usize = 16;
pub const MAX_NAME: usize = 64;
pub const MAX_PRIVATE_ROLES: usize = 32;
const DOMAIN_OP: &str = "halka/op/v1";
pub const DOMAIN_JOIN: &str = "halka/join/v1";
/// Proof shown to the member we dial, before we know which space the invite belongs to.
pub const DOMAIN_ADMIT: &str = "halka/admit/v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelKind {
    Text,
    Voice,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum OpBody {
    Genesis {
        name: String,
        nonce: Id,
    },
    RenameSpace {
        name: String,
    },
    CreateChannel {
        name: String,
        kind: ChannelKind,
        private_roles: Option<Vec<Id>>,
    },
    UpdateChannel {
        channel: Id,
        name: String,
        private_roles: Option<Vec<Id>>,
    },
    DeleteChannel {
        channel: Id,
    },
    CreateRole {
        name: String,
        color: u32,
        perms: Perms,
        rank: u32,
    },
    UpdateRole {
        role: Id,
        name: String,
        color: u32,
        perms: Perms,
        rank: u32,
    },
    DeleteRole {
        role: Id,
    },
    AssignRole {
        member: Id,
        role: Id,
        on: bool,
    },
    CreateInvite {
        key: Id,
        expires: Option<u64>,
        max_uses: Option<u32>,
    },
    RevokeInvite {
        key: Id,
    },
    /// Authored by the joiner. `proof` is the invite key's signature over (space, joiner).
    Join {
        invite: Id,
        proof: Sig,
        name: String,
    },
    SetName {
        name: String,
    },
    Kick {
        member: Id,
    },
    Ban {
        member: Id,
        on: bool,
    },
    Leave,
    MoveRole {
        role: Id,
        target: Id,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Op {
    /// Space id (= id of its genesis op); `Id::ZERO` for the genesis op itself.
    pub space: Id,
    pub author: Id,
    /// Sorted, unique. Empty only for genesis.
    pub parents: Vec<Id>,
    /// Lamport clock, always exactly max(parent clocks) + 1, so (clock, id) is a topological order
    /// and an author cannot jump ahead arbitrarily.
    pub clock: u64,
    /// Author's wall clock (unix ms). Display and invite expiry only; never trusted for ordering.
    pub ts: u64,
    pub body: OpBody,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SignedOp {
    pub bytes: Vec<u8>,
    pub sig: Sig,
}

/// A verified, decoded op.
#[derive(Clone, Debug)]
pub struct Entry {
    pub id: Id,
    pub op: Op,
    pub signed: SignedOp,
}

impl SignedOp {
    pub fn sign(key: &iroh::SecretKey, op: &Op) -> Result<SignedOp> {
        let bytes = postcard::to_stdvec(op)?;
        ensure!(bytes.len() <= MAX_OP_BYTES, "işlem çok büyük");
        Ok(SignedOp {
            sig: id::sign(key, DOMAIN_OP, &bytes),
            bytes,
        })
    }

    /// Id is the hash of the op bytes only, so signature malleability can't fork identities.
    pub fn id(&self) -> Id {
        Id::hash(DOMAIN_OP, &self.bytes)
    }

    /// Structural validation: size, encoding, signature, field limits. No state needed.
    pub fn verify(&self) -> Result<Entry> {
        ensure!(self.bytes.len() <= MAX_OP_BYTES, "op too large");
        let op: Op = postcard::from_bytes(&self.bytes)?;
        ensure!(
            postcard::to_stdvec(&op)? == self.bytes,
            "non-canonical op encoding"
        );
        ensure!(
            id::verify(&op.author, DOMAIN_OP, &self.bytes, &self.sig),
            "bad op signature"
        );
        ensure!(op.parents.len() <= MAX_PARENTS, "too many parents");
        ensure!(
            op.parents.windows(2).all(|w| w[0] < w[1]),
            "parents not sorted/unique"
        );
        match &op.body {
            OpBody::Genesis { name, .. } => {
                ensure!(
                    op.space == Id::ZERO && op.parents.is_empty() && op.clock == 0,
                    "bad genesis"
                );
                check_name(name)?;
            }
            body => {
                ensure!(
                    op.space != Id::ZERO && !op.parents.is_empty() && op.clock > 0,
                    "bad op header"
                );
                match body {
                    OpBody::RenameSpace { name }
                    | OpBody::CreateRole { name, .. }
                    | OpBody::UpdateRole { name, .. }
                    | OpBody::SetName { name }
                    | OpBody::Join { name, .. } => check_name(name)?,
                    OpBody::CreateChannel {
                        name,
                        private_roles,
                        ..
                    }
                    | OpBody::UpdateChannel {
                        name,
                        private_roles,
                        ..
                    } => {
                        check_name(name)?;
                        ensure!(
                            private_roles
                                .as_ref()
                                .is_none_or(|r| r.len() <= MAX_PRIVATE_ROLES),
                            "too many roles"
                        );
                    }
                    _ => {}
                }
            }
        }
        Ok(Entry {
            id: self.id(),
            op,
            signed: self.clone(),
        })
    }
}

pub fn check_name(name: &str) -> Result<()> {
    let n = name.chars().count();
    if n == 0 || n > MAX_NAME || name.trim() != name || name.chars().any(char::is_control) {
        bail!("isim 1-{MAX_NAME} karakter olmalı, baş/son boşluk ve kontrol karakteri içermemeli");
    }
    Ok(())
}

/// Message signed by an invite key to prove the joiner holds the invite.
pub fn join_proof_msg(space: &Id, joiner: &Id) -> Vec<u8> {
    [space.0, joiner.0].concat()
}
