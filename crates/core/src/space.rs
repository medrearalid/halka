//! Space state machine: deterministic replay of the signed op DAG.
//!
//! Ordering: ops are replayed in (clock, id) order, which is topological because a child's clock
//! is always max(parent clocks) + 1. Each op is checked against the state replayed so far.
//!
//! Revocation wins: once a member is kicked/banned by op R, every op they authored that is
//! *concurrent* with R (neither an ancestor nor a descendant of R) is void. This stops a removed
//! member from "backdating" ops onto an old fork of the DAG. Because voiding can change which
//! revocations are valid, replay iterates to a fixpoint.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use anyhow::{Result, bail, ensure};

use crate::id::{self, Id};
use crate::op::{self, ChannelKind, Entry, Op, OpBody, SignedOp};
use crate::perm::Perms;

pub const OWNER_RANK: u64 = u64::MAX;
const MAX_PENDING: usize = 2048;

#[derive(Clone, Debug)]
pub struct Member {
    pub name: String,
    pub roles: BTreeSet<Id>,
}

#[derive(Clone, Debug)]
pub struct Role {
    pub name: String,
    pub color: u32,
    pub perms: Perms,
    pub rank: u32,
}

#[derive(Clone, Debug)]
pub struct Channel {
    pub name: String,
    pub kind: ChannelKind,
    pub private_roles: Option<BTreeSet<Id>>,
    pub order: (u64, Id),
    pub ttl_ms: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct Invite {
    pub created_by: Id,
    pub expires: Option<u64>,
    pub max_uses: Option<u32>,
    pub uses: u32,
}

#[derive(Clone, Debug)]
pub struct State {
    pub id: Id,
    pub owner: Id,
    pub name: String,
    pub members: BTreeMap<Id, Member>,
    pub roles: BTreeMap<Id, Role>,
    pub channels: BTreeMap<Id, Channel>,
    pub invites: BTreeMap<Id, Invite>,
    pub bans: BTreeSet<Id>,
    pub relay_required: bool,
    pub deleted: bool,
    /// Ex-members' last known names (so history still shows who wrote what).
    pub former: BTreeMap<Id, String>,
}

impl State {
    fn genesis(e: &Entry) -> Result<State> {
        let OpBody::Genesis { name, .. } = &e.op.body else {
            bail!("not a genesis op")
        };
        let mut s = State {
            id: e.id,
            owner: e.op.author,
            name: name.clone(),
            members: BTreeMap::new(),
            roles: BTreeMap::new(),
            channels: BTreeMap::new(),
            invites: BTreeMap::new(),
            bans: BTreeSet::new(),
            relay_required: false,
            deleted: false,
            former: BTreeMap::new(),
        };
        s.members.insert(
            e.op.author,
            Member {
                name: "Kurucu".into(),
                roles: BTreeSet::new(),
            },
        );
        // Built-in @everyone role shares the space id, like Discord.
        s.roles.insert(
            e.id,
            Role {
                name: "herkes".into(),
                color: 0x8a8f98,
                perms: Perms::EVERYONE,
                rank: 0,
            },
        );
        Ok(s)
    }

    /// A relay-required space stays inactive (no sync, no voice) until relay-only is on, so a
    /// direct endpoint never hands its IP to this space's members.
    pub fn locked(&self, relay_active: bool) -> bool {
        self.relay_required && !relay_active
    }

    pub fn is_member(&self, m: &Id) -> bool {
        self.members.contains_key(m)
    }

    pub fn rank(&self, m: &Id) -> u64 {
        if *m == self.owner {
            return OWNER_RANK;
        }
        self.members
            .get(m)
            .map(|mm| {
                mm.roles
                    .iter()
                    .filter_map(|r| self.roles.get(r))
                    .map(|r| r.rank as u64)
                    .max()
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    }

    /// Space-level effective permissions.
    pub fn perms(&self, m: &Id) -> Perms {
        let Some(mm) = self.members.get(m) else {
            return Perms(0);
        };
        if *m == self.owner {
            return Perms::ALL;
        }
        let base = self
            .roles
            .get(&self.id)
            .map(|r| r.perms)
            .unwrap_or_default();
        mm.roles
            .iter()
            .filter_map(|r| self.roles.get(r))
            .fold(base, |p, r| p.union(r.perms))
            .effective()
    }

    pub fn can(&self, m: &Id, p: Perms) -> bool {
        self.is_member(m) && self.perms(m).has(p)
    }

    pub fn can_view(&self, m: &Id, channel: &Id) -> bool {
        let Some(c) = self.channels.get(channel) else {
            return false;
        };
        let Some(mm) = self.members.get(m) else {
            return false;
        };
        match &c.private_roles {
            None => true,
            Some(allowed) => {
                self.perms(m).has(Perms::ADMIN) || mm.roles.iter().any(|r| allowed.contains(r))
            }
        }
    }

    pub fn can_in(&self, m: &Id, channel: &Id, p: Perms) -> bool {
        self.can_view(m, channel) && self.perms(m).has(p)
    }

    fn need(&self, a: &Id, p: Perms) -> Result<()> {
        ensure!(self.is_member(a), "üye değilsin");
        ensure!(self.perms(a).has(p), "bu işlem için yetkin yok");
        Ok(())
    }

    fn outranks(&self, a: &Id, target: &Id) -> Result<()> {
        ensure!(*target != self.owner, "kurucuya bu yapılamaz");
        ensure!(
            self.rank(a) > self.rank(target),
            "bu kişi senden yüksek ya da eşit rütbede"
        );
        Ok(())
    }

    fn known_roles(&self, roles: &Option<Vec<Id>>) -> Option<BTreeSet<Id>> {
        roles.as_ref().map(|r| {
            r.iter()
                .filter(|r| self.roles.contains_key(r))
                .copied()
                .collect()
        })
    }

    fn remove_member(&mut self, m: &Id) {
        if let Some(mm) = self.members.remove(m) {
            self.former.insert(*m, mm.name);
        }
        self.invites.retain(|_, i| i.created_by != *m);
    }

    /// Apply one op, checking permissions against the current state.
    pub fn apply(&mut self, e: &Entry) -> Result<()> {
        let a = &e.op.author;
        ensure!(!self.deleted, "halka silindi");
        match &e.op.body {
            OpBody::Genesis { .. } => bail!("duplicate genesis"),
            OpBody::RenameSpace { name } => {
                self.need(a, Perms::MANAGE_SPACE)?;
                self.name = name.clone();
            }
            OpBody::RequireRelay => {
                ensure!(*a == self.owner, "bunu yalnızca kurucu yapabilir");
                self.relay_required = true;
                // old codes lack the relay flag, so a direct joiner would dial with its IP
                self.invites.clear();
            }
            OpBody::DeleteSpace => {
                ensure!(*a == self.owner, "halkayı yalnızca kurucu silebilir");
                self.deleted = true;
                self.members.clear();
                self.invites.clear();
            }
            OpBody::CreateChannel {
                name,
                kind,
                private_roles,
            } => {
                self.need(a, Perms::MANAGE_CHANNELS)?;
                let pr = self.known_roles(private_roles);
                self.channels.insert(
                    e.id,
                    Channel {
                        name: name.clone(),
                        kind: *kind,
                        private_roles: pr,
                        order: (e.op.clock, e.id),
                        ttl_ms: None,
                    },
                );
            }
            OpBody::UpdateChannel {
                channel,
                name,
                private_roles,
            } => {
                self.need(a, Perms::MANAGE_CHANNELS)?;
                let pr = self.known_roles(private_roles);
                let c = self
                    .channels
                    .get_mut(channel)
                    .ok_or_else(|| anyhow::anyhow!("kanal yok"))?;
                c.name = name.clone();
                c.private_roles = pr;
            }
            OpBody::SetChannelTtl { channel, ttl_ms } => {
                self.need(a, Perms::MANAGE_CHANNELS)?;
                self.channels
                    .get_mut(channel)
                    .ok_or_else(|| anyhow::anyhow!("kanal yok"))?
                    .ttl_ms = *ttl_ms;
            }
            OpBody::DeleteChannel { channel } => {
                self.need(a, Perms::MANAGE_CHANNELS)?;
                ensure!(self.channels.remove(channel).is_some(), "kanal yok");
            }
            OpBody::CreateRole {
                name,
                color,
                perms,
                rank,
            } => {
                self.need(a, Perms::MANAGE_ROLES)?;
                ensure!(
                    *rank >= 1 && (*rank as u64) < self.rank(a),
                    "rütbe kendi rütbenden düşük ve en az 1 olmalı"
                );
                ensure!(
                    perms.subset_of(self.perms(a)),
                    "sahip olmadığın yetkiyi veremezsin"
                );
                self.roles.insert(
                    e.id,
                    Role {
                        name: name.clone(),
                        color: color & 0xffffff,
                        perms: *perms,
                        rank: *rank,
                    },
                );
            }
            OpBody::UpdateRole {
                role,
                name,
                color,
                perms,
                rank,
            } => {
                self.need(a, Perms::MANAGE_ROLES)?;
                let my_rank = self.rank(a);
                let my_perms = self.perms(a);
                let everyone = *role == self.id;
                let r = self
                    .roles
                    .get_mut(role)
                    .ok_or_else(|| anyhow::anyhow!("rol yok"))?;
                ensure!((r.rank as u64) < my_rank, "bu rol senden yüksek");
                ensure!(
                    perms.subset_of(my_perms),
                    "sahip olmadığın yetkiyi veremezsin"
                );
                let rank = if everyone { 0 } else { *rank };
                ensure!(
                    everyone || (rank >= 1 && (rank as u64) < my_rank),
                    "geçersiz rütbe"
                );
                *r = Role {
                    name: name.clone(),
                    color: color & 0xffffff,
                    perms: *perms,
                    rank,
                };
            }
            OpBody::MoveRole { role, target } => {
                ensure!(
                    a == &self.owner,
                    "rol sırasını yalnızca kurucu değiştirebilir"
                );
                let (mut ids, from, to) = self.role_move(role, target)?;
                let moved = ids.remove(from);
                ids.insert(to, moved);
                let count = ids.len() as u32;
                for (index, id) in ids.iter().enumerate() {
                    self.roles.get_mut(id).expect("checked").rank = count - index as u32;
                }
            }
            OpBody::DeleteRole { role } => {
                self.need(a, Perms::MANAGE_ROLES)?;
                ensure!(*role != self.id, "herkes rolü silinemez");
                let r = self
                    .roles
                    .get(role)
                    .ok_or_else(|| anyhow::anyhow!("rol yok"))?;
                ensure!((r.rank as u64) < self.rank(a), "bu rol senden yüksek");
                self.roles.remove(role);
                for m in self.members.values_mut() {
                    m.roles.remove(role);
                }
                for c in self.channels.values_mut() {
                    if let Some(pr) = &mut c.private_roles {
                        pr.remove(role);
                    }
                }
            }
            // dropping one of your own roles is always allowed and never grants anything
            OpBody::AssignRole {
                member,
                role,
                on: false,
            } if member == a => {
                let m = self
                    .members
                    .get_mut(a)
                    .ok_or_else(|| anyhow::anyhow!("üye değilsin"))?;
                ensure!(m.roles.remove(role), "bu role sahip değilsin");
            }
            OpBody::AssignRole { member, role, on } => {
                self.need(a, Perms::MANAGE_ROLES)?;
                ensure!(*role != self.id, "herkes rolü atanamaz");
                let r = self
                    .roles
                    .get(role)
                    .ok_or_else(|| anyhow::anyhow!("rol yok"))?;
                ensure!((r.rank as u64) < self.rank(a), "bu rol senden yüksek");
                ensure!(self.is_member(member), "üye yok");
                if member != a {
                    self.outranks(a, member)?;
                }
                let m = self.members.get_mut(member).expect("checked");
                if *on {
                    m.roles.insert(*role)
                } else {
                    m.roles.remove(role)
                };
            }
            OpBody::CreateInvite {
                key,
                expires,
                max_uses,
            } => {
                self.need(a, Perms::INVITE)?;
                ensure!(!self.invites.contains_key(key), "davet zaten var");
                self.invites.insert(
                    *key,
                    Invite {
                        created_by: *a,
                        expires: *expires,
                        max_uses: *max_uses,
                        uses: 0,
                    },
                );
            }
            OpBody::RevokeInvite { key } => {
                ensure!(self.is_member(a), "üye değilsin");
                let i = self
                    .invites
                    .get(key)
                    .ok_or_else(|| anyhow::anyhow!("davet yok"))?;
                ensure!(
                    i.created_by == *a || self.perms(a).has(Perms::MANAGE_SPACE),
                    "bu daveti iptal edemezsin"
                );
                self.invites.remove(key);
            }
            OpBody::Join {
                invite,
                proof,
                name,
            } => {
                ensure!(!self.is_member(a), "zaten üyesin");
                ensure!(!self.bans.contains(a), "bu halkadan yasaklandın");
                let i = self
                    .invites
                    .get_mut(invite)
                    .ok_or_else(|| anyhow::anyhow!("davet geçersiz ya da iptal edilmiş"))?;
                ensure!(
                    i.max_uses.is_none_or(|m| i.uses < m),
                    "davetin kullanım hakkı doldu"
                );
                ensure!(
                    i.expires.is_none_or(|x| e.op.ts <= x),
                    "davetin süresi dolmuş"
                );
                ensure!(
                    id::verify(
                        invite,
                        op::DOMAIN_JOIN,
                        &op::join_proof_msg(&self.id, a),
                        proof
                    ),
                    "davet kanıtı geçersiz"
                );
                i.uses += 1;
                self.former.remove(a);
                self.members.insert(
                    *a,
                    Member {
                        name: name.clone(),
                        roles: BTreeSet::new(),
                    },
                );
            }
            OpBody::SetName { name } => {
                let m = self
                    .members
                    .get_mut(a)
                    .ok_or_else(|| anyhow::anyhow!("üye değilsin"))?;
                m.name = name.clone();
            }
            OpBody::Kick { member } => {
                self.need(a, Perms::KICK)?;
                ensure!(self.is_member(member), "üye yok");
                self.outranks(a, member)?;
                self.remove_member(member);
            }
            OpBody::Ban { member, on } => {
                self.need(a, Perms::BAN)?;
                if *on {
                    ensure!(*member != self.owner, "kurucu yasaklanamaz");
                    if self.is_member(member) {
                        self.outranks(a, member)?;
                        self.remove_member(member);
                    }
                    self.bans.insert(*member);
                } else {
                    ensure!(self.bans.remove(member), "yasaklı değil");
                }
            }
            OpBody::Leave => {
                ensure!(self.is_member(a), "üye değilsin");
                ensure!(*a != self.owner, "kurucu halkadan ayrılamaz");
                self.remove_member(a);
            }
        }
        Ok(())
    }

    fn role_move(&self, role: &Id, target: &Id) -> Result<(Vec<Id>, usize, usize)> {
        ensure!(role != target, "farklı bir rol seç");
        let mut ids: Vec<_> = self
            .roles
            .keys()
            .copied()
            .filter(|id| *id != self.id)
            .collect();
        ids.sort_by_key(|id| (Reverse(self.roles[id].rank), *id));
        let from = ids
            .iter()
            .position(|id| id == role)
            .ok_or_else(|| anyhow::anyhow!("rol yok"))?;
        let to = ids
            .iter()
            .position(|id| id == target)
            .ok_or_else(|| anyhow::anyhow!("hedef rol yok"))?;
        Ok((ids, from, to))
    }
}

fn removal_target(op: &Op) -> Option<Id> {
    match op.body {
        OpBody::Kick { member } | OpBody::Ban { member, on: true } => Some(member),
        _ => None,
    }
}

/// Members whose powers `op` takes away, evaluated against the state right before it applies.
/// Their ops concurrent with `op` get voided ("revocation wins"), so a demoted admin can't fork
/// the DAG from before the demotion and keep acting with old rights.
fn revoked_by(st: &State, op: &Op) -> Vec<Id> {
    // Only people the author outranks: never the author itself (an op must not void itself)
    // and never someone above, or a removed mod could backdate an op that voids the owner.
    let a = op.author;
    let mut t = revoked_candidates(st, op);
    t.retain(|m| *m != a && *m != st.owner && st.rank(&a) > st.rank(m));
    t
}

fn revoked_candidates(st: &State, op: &Op) -> Vec<Id> {
    let holders = |role: &Id| -> Vec<Id> {
        st.members
            .iter()
            .filter(|(_, m)| m.roles.contains(role))
            .map(|(id, _)| *id)
            .collect()
    };
    match &op.body {
        OpBody::Kick { member } | OpBody::Ban { member, on: true } => vec![*member],
        OpBody::AssignRole {
            member,
            role,
            on: false,
        } => st
            .members
            .get(member)
            .filter(|m| m.roles.contains(role))
            .map(|_| vec![*member])
            .unwrap_or_default(),
        OpBody::DeleteRole { role } => holders(role),
        OpBody::MoveRole { role, target } => match st.role_move(role, target) {
            Ok((_, from, to)) if from < to => holders(role),
            Ok((ids, from, to)) => ids[to..from].iter().flat_map(holders).collect(),
            Err(_) => vec![],
        },
        OpBody::UpdateRole {
            role, perms, rank, ..
        } => match st.roles.get(role) {
            Some(old) if !old.perms.subset_of(*perms) || *rank < old.rank => {
                if *role == st.id {
                    st.members.keys().copied().collect()
                } else {
                    holders(role)
                }
            }
            _ => vec![],
        },
        _ => vec![],
    }
}

#[derive(Debug, PartialEq)]
pub enum Added {
    New,
    Duplicate,
    /// Parked until its parents arrive.
    Pending,
}

/// All ops of one space plus the replayed state.
pub struct SpaceLog {
    pub id: Id,
    ops: HashMap<Id, Entry>,
    children: HashMap<Id, Vec<Id>>,
    heads: BTreeSet<Id>,
    pending: HashMap<Id, Entry>,
    pub state: State,
    /// Ops rejected by replay (permission failures, revocations). Kept so sync stays convergent.
    pub rejected: HashSet<Id>,
}

impl SpaceLog {
    pub fn new(genesis: SignedOp) -> Result<SpaceLog> {
        let e = genesis.verify()?;
        let state = State::genesis(&e)?;
        let id = e.id;
        let mut log = SpaceLog {
            id,
            ops: HashMap::new(),
            children: HashMap::new(),
            heads: BTreeSet::from([id]),
            pending: HashMap::new(),
            state,
            rejected: HashSet::new(),
        };
        log.ops.insert(id, e);
        Ok(log)
    }

    pub fn len(&self) -> usize {
        self.ops.len()
    }

    pub fn contains(&self, id: &Id) -> bool {
        self.ops.contains_key(id)
    }

    pub fn get(&self, id: &Id) -> Option<&Entry> {
        self.ops.get(id)
    }

    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.ops.values()
    }

    pub fn genesis(&self) -> &SignedOp {
        &self.ops[&self.id].signed
    }

    /// Insert verified-or-not ops in any order; returns ids that became part of the DAG.
    /// The state is rebuilt once at the end if anything changed.
    pub fn insert_many(&mut self, ops: impl IntoIterator<Item = SignedOp>) -> Vec<Id> {
        let mut added = Vec::new();
        // parents first: keeps the bounded pending pool for genuinely missing parents only
        let mut entries: Vec<Entry> = ops.into_iter().filter_map(|s| s.verify().ok()).collect();
        entries.sort_by_key(|e| e.op.clock);
        for e in entries {
            let id = e.id;
            if let Ok(Added::New) = self.insert_entry(e) {
                added.push(id);
            }
        }
        self.drain_pending(&mut added);
        if !added.is_empty() {
            self.rebuild();
        }
        added
    }

    fn insert_entry(&mut self, e: Entry) -> Result<Added> {
        if self.ops.contains_key(&e.id) {
            return Ok(Added::Duplicate);
        }
        ensure!(e.op.space == self.id, "op for another space");
        if e.op.parents.iter().any(|p| !self.ops.contains_key(p)) {
            if self.pending.len() < MAX_PENDING {
                self.pending.insert(e.id, e);
            }
            return Ok(Added::Pending);
        }
        let max =
            e.op.parents
                .iter()
                .map(|p| self.ops[p].op.clock)
                .max()
                .unwrap_or(0);
        ensure!(e.op.clock == max + 1, "bad clock");
        for p in &e.op.parents {
            self.heads.remove(p);
            self.children.entry(*p).or_default().push(e.id);
        }
        self.heads.insert(e.id);
        self.ops.insert(e.id, e);
        Ok(Added::New)
    }

    fn drain_pending(&mut self, added: &mut Vec<Id>) {
        loop {
            let ready: Vec<Id> = self
                .pending
                .iter()
                .filter(|(_, e)| e.op.parents.iter().all(|p| self.ops.contains_key(p)))
                .map(|(id, _)| *id)
                .collect();
            if ready.is_empty() {
                return;
            }
            for id in ready {
                let e = self.pending.remove(&id).expect("listed");
                if let Ok(Added::New) = self.insert_entry(e) {
                    added.push(id);
                }
            }
        }
    }

    /// Undo the insert of a just-authored leaf op that replay rejected, so nothing builds on it.
    fn unlink(&mut self, id: &Id) {
        let Some(e) = self.ops.remove(id) else { return };
        self.heads.remove(id);
        for p in &e.op.parents {
            if let Some(c) = self.children.get_mut(p) {
                c.retain(|x| x != id);
            }
            if self.children.get(p).is_none_or(|c| c.is_empty()) {
                self.heads.insert(*p);
            }
        }
    }

    pub fn missing_parents(&self) -> Vec<Id> {
        let mut v: Vec<Id> = self
            .pending
            .values()
            .flat_map(|e| e.op.parents.iter())
            .filter(|p| !self.ops.contains_key(p) && !self.pending.contains_key(p))
            .copied()
            .collect();
        v.sort();
        v.dedup();
        v
    }

    /// The latest accepted kick/ban of `member` together with all its ancestors: enough for an
    /// ex-member to verify their own removal, without revealing anything that happened after.
    pub fn removal_proof(&self, member: &Id) -> Option<Vec<SignedOp>> {
        let r =
            self.order().into_iter().rev().find(|e| {
                !self.rejected.contains(&e.id)
                    && (removal_target(&e.op) == Some(*member)
                        || matches!(e.op.body, OpBody::DeleteSpace))
            })?;
        let mut out: Vec<SignedOp> = self
            .reach(r.id, false)
            .iter()
            .map(|id| self.ops[id].signed.clone())
            .collect();
        out.push(r.signed.clone());
        Some(out)
    }

    fn order(&self) -> Vec<&Entry> {
        let mut v: Vec<&Entry> = self.ops.values().collect();
        v.sort_by_key(|e| (e.op.clock, e.id));
        v
    }

    fn reach(&self, from: Id, forward: bool) -> HashSet<Id> {
        let mut seen = HashSet::new();
        let mut stack = vec![from];
        while let Some(x) = stack.pop() {
            let next: &[Id] = if forward {
                self.children.get(&x).map(|v| v.as_slice()).unwrap_or(&[])
            } else {
                self.ops
                    .get(&x)
                    .map(|e| e.op.parents.as_slice())
                    .unwrap_or(&[])
            };
            for n in next {
                if seen.insert(*n) {
                    stack.push(*n);
                }
            }
        }
        seen
    }

    fn rebuild(&mut self) {
        match self.replay() {
            Some((st, rejected)) => {
                self.state = st;
                self.rejected = rejected;
            }
            None => tracing::warn!("space {:?}: revocation replay did not converge", self.id),
        }
    }

    fn replay(&self) -> Option<(State, HashSet<Id>)> {
        let order = self.order();
        let genesis = &self.ops[&self.id];
        let mut void: HashSet<Id> = HashSet::new();
        let mut reach_cache: HashMap<Id, (HashSet<Id>, HashSet<Id>)> = HashMap::new();
        // Each round voids a strictly larger set, so this terminates; the cap is a safety net.
        for _ in 0..32 {
            let mut st = State::genesis(genesis).expect("genesis verified");
            let mut accepted: Vec<&Entry> = Vec::new();
            let mut rejected = HashSet::new();
            let mut revocations = Vec::new();
            for e in order.iter().skip(1) {
                let targets = revoked_by(&st, &e.op);
                if void.contains(&e.id) || st.apply(e).is_err() {
                    rejected.insert(e.id);
                    continue;
                }
                revocations.extend(targets.into_iter().map(|t| (e.id, t)));
                accepted.push(e);
            }
            let mut grew = false;
            for (r, target) in revocations {
                let (anc, desc) = reach_cache
                    .entry(r)
                    .or_insert_with(|| (self.reach(r, false), self.reach(r, true)));
                for e in &accepted {
                    if e.op.author == target
                        && !anc.contains(&e.id)
                        && !desc.contains(&e.id)
                        && void.insert(e.id)
                    {
                        grew = true;
                    }
                }
            }
            if !grew {
                return Some((st, rejected));
            }
        }
        None
    }

    /// Build, check and insert a local op. Fails (without inserting) if replay would reject it.
    pub fn author(&mut self, key: &iroh::SecretKey, body: OpBody) -> Result<SignedOp> {
        let parents: Vec<Id> = {
            let mut h: Vec<&Entry> = self.heads.iter().map(|h| &self.ops[h]).collect();
            h.sort_by_key(|e| std::cmp::Reverse((e.op.clock, e.id)));
            let mut p: Vec<Id> = h.iter().take(op::MAX_PARENTS).map(|e| e.id).collect();
            p.sort();
            p
        };
        let clock = parents
            .iter()
            .map(|p| self.ops[p].op.clock)
            .max()
            .unwrap_or(0)
            + 1;
        let op = Op {
            space: self.id,
            author: key.public().into(),
            parents,
            clock,
            ts: id::now_ms(),
            body,
        };
        let signed = SignedOp::sign(key, &op)?;
        let e = signed.verify()?;
        self.state.clone().apply(&e)?;
        let id = e.id;
        self.insert_entry(e)?;
        self.rebuild();
        if self.rejected.contains(&id) {
            self.unlink(&id);
            self.rebuild();
            bail!("işlem reddedildi");
        }
        Ok(signed)
    }
}

pub fn create_genesis(key: &iroh::SecretKey, name: &str) -> Result<SignedOp> {
    op::check_name(name)?;
    let op = Op {
        space: Id::ZERO,
        author: key.public().into(),
        parents: vec![],
        clock: 0,
        ts: id::now_ms(),
        body: OpBody::Genesis {
            name: name.into(),
            nonce: Id(rand::random()),
        },
    };
    SignedOp::sign(key, &op)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::op::join_proof_msg;

    fn key() -> iroh::SecretKey {
        iroh::SecretKey::generate()
    }
    fn idk(k: &iroh::SecretKey) -> Id {
        k.public().into()
    }

    /// Craft an op with explicit parents (what a malicious peer could send).
    fn forge(log: &SpaceLog, k: &iroh::SecretKey, parents: Vec<Id>, body: OpBody) -> SignedOp {
        let clock = parents
            .iter()
            .map(|p| log.get(p).unwrap().op.clock)
            .max()
            .unwrap()
            + 1;
        let op = Op {
            space: log.id,
            author: idk(k),
            parents,
            clock,
            ts: id::now_ms(),
            body,
        };
        SignedOp::sign(k, &op).unwrap()
    }

    fn join(log: &mut SpaceLog, owner: &iroh::SecretKey, who: &iroh::SecretKey) {
        let inv = key();
        log.author(
            owner,
            OpBody::CreateInvite {
                key: idk(&inv),
                expires: None,
                max_uses: None,
            },
        )
        .unwrap();
        let proof = id::sign(&inv, op::DOMAIN_JOIN, &join_proof_msg(&log.id, &idk(who)));
        log.author(
            who,
            OpBody::Join {
                invite: idk(&inv),
                proof,
                name: "b".into(),
            },
        )
        .unwrap();
    }

    fn setup() -> (iroh::SecretKey, iroh::SecretKey, SpaceLog) {
        let (o, b) = (key(), key());
        let mut log = SpaceLog::new(create_genesis(&o, "test").unwrap()).unwrap();
        join(&mut log, &o, &b);
        (o, b, log)
    }

    #[test]
    fn relay_required_owner_only_and_locks() {
        let (o, b, mut log) = setup();
        assert!(log.author(&b, OpBody::RequireRelay).is_err());
        assert!(!log.state.relay_required && !log.state.locked(false));
        let op = log.author(&o, OpBody::RequireRelay).unwrap();
        assert!(log.state.locked(false) && !log.state.locked(true));
        let mut replay = SpaceLog::new(log.get(&log.id).unwrap().signed.clone()).unwrap();
        replay.insert_many(log.entries().map(|e| e.signed.clone()).collect::<Vec<_>>());
        assert!(replay.state.relay_required && replay.contains(&op.id()));
    }

    #[test]
    fn only_owner_deletes_and_it_ends_the_space() {
        let (o, b, mut log) = setup();
        assert!(log.author(&b, OpBody::DeleteSpace).is_err());
        log.author(&o, OpBody::DeleteSpace).unwrap();
        assert!(log.state.deleted && !log.state.is_member(&idk(&o)) && !log.state.is_member(&idk(&b)));
        assert!(log.author(&o, OpBody::RenameSpace { name: "x".into() }).is_err());
        // an offline member replaying the proof ends up outside too
        let proof = log.removal_proof(&idk(&b)).unwrap();
        let mut late = SpaceLog::new(log.get(&log.id).unwrap().signed.clone()).unwrap();
        late.insert_many(proof);
        assert!(late.state.deleted && !late.state.is_member(&idk(&b)));
    }

    #[test]
    fn join_and_permissions() {
        let (o, b, mut log) = setup();
        assert!(log.state.is_member(&idk(&b)));
        assert!(
            log.author(
                &b,
                OpBody::CreateChannel {
                    name: "x".into(),
                    kind: ChannelKind::Text,
                    private_roles: None
                }
            )
            .is_err()
        );
        log.author(
            &o,
            OpBody::CreateChannel {
                name: "genel".into(),
                kind: ChannelKind::Text,
                private_roles: None,
            },
        )
        .unwrap();
        // forged op bypassing local checks is stored but rejected by replay
        let heads: Vec<Id> = log.heads.iter().copied().collect();
        let f = forge(
            &log,
            &b,
            heads,
            OpBody::RenameSpace {
                name: "pwned".into(),
            },
        );
        let fid = f.id();
        log.insert_many([f]);
        assert!(log.contains(&fid) && log.rejected.contains(&fid));
        assert_eq!(log.state.name, "test");
    }

    #[test]
    fn invalid_join_proof_rejected() {
        let (o, _b, mut log) = setup();
        let inv = key();
        let c = key();
        log.author(
            &o,
            OpBody::CreateInvite {
                key: idk(&inv),
                expires: None,
                max_uses: Some(1),
            },
        )
        .unwrap();
        let wrong = id::sign(&key(), op::DOMAIN_JOIN, &join_proof_msg(&log.id, &idk(&c)));
        assert!(
            log.author(
                &c,
                OpBody::Join {
                    invite: idk(&inv),
                    proof: wrong,
                    name: "c".into()
                }
            )
            .is_err()
        );
        let ok = id::sign(&inv, op::DOMAIN_JOIN, &join_proof_msg(&log.id, &idk(&c)));
        log.author(
            &c,
            OpBody::Join {
                invite: idk(&inv),
                proof: ok,
                name: "c".into(),
            },
        )
        .unwrap();
        let d = key();
        let p = id::sign(&inv, op::DOMAIN_JOIN, &join_proof_msg(&log.id, &idk(&d)));
        assert!(
            log.author(
                &d,
                OpBody::Join {
                    invite: idk(&inv),
                    proof: p,
                    name: "d".into()
                }
            )
            .is_err(),
            "max_uses"
        );
    }

    #[test]
    fn revocation_wins_over_backdated_ops() {
        let (o, b, mut log) = setup();
        let before_kick: Vec<Id> = log.heads.iter().copied().collect();
        log.author(&o, OpBody::Kick { member: idk(&b) }).unwrap();
        assert!(!log.state.is_member(&idk(&b)));
        // b forks from before the kick and creates an invite to sneak back in
        let inv = key();
        let f = forge(
            &log,
            &b,
            before_kick,
            OpBody::CreateInvite {
                key: idk(&inv),
                expires: None,
                max_uses: None,
            },
        );
        let fid = f.id();
        log.insert_many([f]);
        assert!(log.rejected.contains(&fid));
        assert!(!log.state.invites.contains_key(&idk(&inv)));
    }

    #[test]
    fn owner_can_move_roles_with_tied_ranks() {
        let (owner, member, mut log) = setup();
        let mut create = |name: &str, rank| {
            log.author(
                &owner,
                OpBody::CreateRole {
                    name: name.into(),
                    color: 0,
                    perms: Perms::ADMIN,
                    rank,
                },
            )
            .unwrap()
            .id()
        };
        let high = create("high", 5);
        let tied = create("tied", 5);
        let low = create("low", 1);
        log.author(
            &owner,
            OpBody::AssignRole {
                member: idk(&member),
                role: high,
                on: true,
            },
        )
        .unwrap();
        let move_low = OpBody::MoveRole {
            role: low,
            target: high.min(tied),
        };
        assert!(log.author(&member, move_low.clone()).is_err());
        assert!(
            log.author(
                &owner,
                OpBody::MoveRole {
                    role: low,
                    target: log.id,
                },
            )
            .is_err()
        );
        log.author(&owner, move_low).unwrap();
        assert_eq!(log.state.roles[&low].rank, 3);
        assert_eq!(log.state.roles[&high.min(tied)].rank, 2);
        assert_eq!(log.state.roles[&high.max(tied)].rank, 1);
        assert_eq!(log.state.roles[&log.id].rank, 0);
    }

    #[test]
    fn demotion_wins_over_backdated_ops() {
        let (o, b, mut log) = setup();
        let admin = log
            .author(
                &o,
                OpBody::CreateRole {
                    name: "adm".into(),
                    color: 0,
                    perms: Perms::ADMIN,
                    rank: 5,
                },
            )
            .unwrap()
            .id();
        log.author(
            &o,
            OpBody::AssignRole {
                member: idk(&b),
                role: admin,
                on: true,
            },
        )
        .unwrap();
        let before: Vec<Id> = log.heads.iter().copied().collect();
        log.author(
            &o,
            OpBody::AssignRole {
                member: idk(&b),
                role: admin,
                on: false,
            },
        )
        .unwrap();
        // b forks from while it was admin and renames the space
        let f = forge(
            &log,
            &b,
            before,
            OpBody::RenameSpace {
                name: "ele gecirildi".into(),
            },
        );
        let fid = f.id();
        log.insert_many([f]);
        assert!(log.rejected.contains(&fid));
        assert_eq!(log.state.name, "test");
        // deleting a role revokes its holders the same way
        let mut log2 = SpaceLog::new(log.genesis().clone()).unwrap();
        log2.insert_many(log.entries().map(|e| e.signed.clone()).collect::<Vec<_>>());
        assert_eq!(log2.state.name, "test");
    }

    #[test]
    fn owner_can_narrow_everyone_and_self_unassign() {
        let (o, b, mut log) = setup();
        let everyone = log.id;
        let narrowed = Perms(Perms::EVERYONE.0 & !Perms::STREAM.0);
        log.author(
            &o,
            OpBody::UpdateRole {
                role: everyone,
                name: "herkes".into(),
                color: 0,
                perms: narrowed,
                rank: 0,
            },
        )
        .unwrap();
        assert!(!log.state.perms(&idk(&b)).has(Perms::STREAM));
        let r = log
            .author(
                &o,
                OpBody::CreateRole {
                    name: "mod".into(),
                    color: 0,
                    perms: Perms::MANAGE_ROLES,
                    rank: 3,
                },
            )
            .unwrap()
            .id();
        log.author(
            &o,
            OpBody::AssignRole {
                member: idk(&b),
                role: r,
                on: true,
            },
        )
        .unwrap();
        // b drops its own role: must not void itself
        log.author(
            &b,
            OpBody::AssignRole {
                member: idk(&b),
                role: r,
                on: false,
            },
        )
        .unwrap();
        assert!(!log.state.members[&idk(&b)].roles.contains(&r));
    }

    #[test]
    fn kicked_mod_cannot_void_the_kick() {
        let (o, b, mut log) = setup();
        let r = log
            .author(
                &o,
                OpBody::CreateRole {
                    name: "mod".into(),
                    color: 0,
                    perms: Perms::MANAGE_ROLES,
                    rank: 3,
                },
            )
            .unwrap()
            .id();
        log.author(
            &o,
            OpBody::AssignRole {
                member: idk(&b),
                role: r,
                on: true,
            },
        )
        .unwrap();
        let before: Vec<Id> = log.heads.iter().copied().collect();
        log.author(&o, OpBody::Kick { member: idk(&b) }).unwrap();
        // backdated narrowing of @everyone (lower clock than the kick) aimed at everyone, owner included
        let f = forge(
            &log,
            &b,
            before,
            OpBody::UpdateRole {
                role: log.id,
                name: "herkes".into(),
                color: 0,
                perms: Perms(0),
                rank: 0,
            },
        );
        log.insert_many([f]);
        assert!(!log.state.is_member(&idk(&b)), "kick must stand");
        assert!(log.state.perms(&idk(&o)).has(Perms::ALL));
    }

    #[test]
    fn rejected_local_op_is_rolled_back() {
        let (_o, b, mut log) = setup();
        let n = log.len();
        assert!(
            log.author(&b, OpBody::RenameSpace { name: "x".into() })
                .is_err()
        );
        assert_eq!(log.len(), n);
    }

    #[test]
    fn ranks_enforced() {
        let (o, b, mut log) = setup();
        let mod_role = log
            .author(
                &o,
                OpBody::CreateRole {
                    name: "mod".into(),
                    color: 0,
                    perms: Perms(Perms::MANAGE_ROLES.0 | Perms::KICK.0),
                    rank: 5,
                },
            )
            .unwrap()
            .id();
        log.author(
            &o,
            OpBody::AssignRole {
                member: idk(&b),
                role: mod_role,
                on: true,
            },
        )
        .unwrap();
        // b can create a lower role but not an equal/higher one, nor grant perms it lacks
        assert!(
            log.author(
                &b,
                OpBody::CreateRole {
                    name: "x".into(),
                    color: 0,
                    perms: Perms(0),
                    rank: 5
                }
            )
            .is_err()
        );
        assert!(
            log.author(
                &b,
                OpBody::CreateRole {
                    name: "x".into(),
                    color: 0,
                    perms: Perms::BAN,
                    rank: 2
                }
            )
            .is_err()
        );
        log.author(
            &b,
            OpBody::CreateRole {
                name: "x".into(),
                color: 0,
                perms: Perms::KICK,
                rank: 2,
            },
        )
        .unwrap();
        assert!(log.author(&b, OpBody::Kick { member: idk(&o) }).is_err());
        assert!(
            log.author(
                &b,
                OpBody::UpdateRole {
                    role: mod_role,
                    name: "mod".into(),
                    color: 0,
                    perms: Perms::ALL,
                    rank: 9
                }
            )
            .is_err()
        );
    }

    #[test]
    fn converges_in_any_order() {
        let (o, b, mut log) = setup();
        let r = log
            .author(
                &o,
                OpBody::CreateRole {
                    name: "r".into(),
                    color: 0,
                    perms: Perms::KICK,
                    rank: 1,
                },
            )
            .unwrap();
        log.author(
            &o,
            OpBody::AssignRole {
                member: idk(&b),
                role: r.id(),
                on: true,
            },
        )
        .unwrap();
        log.author(
            &o,
            OpBody::RenameSpace {
                name: "yeni".into(),
            },
        )
        .unwrap();
        let mut all: Vec<SignedOp> = log.entries().map(|e| e.signed.clone()).collect();
        all.reverse();
        let mut other = SpaceLog::new(log.genesis().clone()).unwrap();
        other.insert_many(all);
        assert_eq!(other.len(), log.len());
        assert_eq!(other.state.name, "yeni");
        assert_eq!(
            other.state.members[&idk(&b)].roles,
            log.state.members[&idk(&b)].roles
        );
    }
}
