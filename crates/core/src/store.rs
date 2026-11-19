//! Local persistence (redb). Messages are stored as their original signed bytes so they can be
//! re-verified and re-served to peers, but every message with content (and every file) is
//! sealed under its own vault key: purging shreds that key, so nothing readable survives in
//! redb's copy-on-write free pages. Views are materialized on read.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use redb::{
    Database, ReadableDatabase, ReadableTable, Table, TableDefinition, WriteTransaction,
};
use serde::{Deserialize, Serialize};

use crate::id::Id;
use crate::msg::{FileRef, Msg, MsgBody, SignedMsg};
use crate::op::SignedOp;
use crate::profile::{Profile, ProfileMeta};
use crate::vault::{self, Vault};

const META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");
/// space ++ op id -> SignedOp
const OPS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("ops");
/// sk -> packed SignedMsg   (Text/Post only); sk = space ++ channel ++ ts(be) ++ id
const MSGS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("msgs");
/// msg id -> sk ++ expires(be, 0 = never) ++ file hashes   (plain index used to purge)
const MSG_LOC: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("msg_loc");
/// target id ++ edit id -> edit sk ++ packed SignedMsg   (sealed with the target's key)
const MSG_EXTRA: TableDefinition<&[u8], &[u8]> = TableDefinition::new("msg_extra");
/// sk -> ()   every live message, for reconciliation
const MSG_SYNC: TableDefinition<&[u8], ()> = TableDefinition::new("msg_sync");
/// msg id -> packed SignedMsg (dedupe + fetch by id)
const MSG_IDX: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("msg_idx");
/// ids removed by a Delete: never stored or served again
const DELETED: TableDefinition<&[u8; 32], ()> = TableDefinition::new("deleted");
/// expires(be) ++ msg id -> ()
const EXPIRY: TableDefinition<&[u8], ()> = TableDefinition::new("expiry");
/// file hash -> vault-sealed FileMeta
const FILES: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("files");
/// target id ++ delete id -> ()   deletes waiting for a target we haven't seen: stored and
/// synced (so they converge), but only applied once the right to delete can be checked
const HELD: TableDefinition<&[u8], ()> = TableDefinition::new("held_deletes");
/// file hash ++ msg id -> ()
const MSG_FILES: TableDefinition<&[u8], ()> = TableDefinition::new("msg_files");
/// member id -> postcard(EndpointAddr)
const PEERS: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("peers");
/// space ++ channel -> last read ts
const READ: TableDefinition<&[u8], u64> = TableDefinition::new("read");
const PROFILES: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("profiles");
const PROFILE_PHOTOS: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("profile_photos");

const VAULT_VERSION: &str = "vault_v";
const VAULT_MASTER: &str = "vault_master";
const SK: usize = 104;
/// Plain bytes per sealed file chunk.
pub const CHUNK: usize = 64 * 1024;

pub struct Store {
    db: Database,
    vault: Vault,
    blobs: PathBuf,
}

fn key(parts: &[&[u8]]) -> Vec<u8> {
    parts.concat()
}

fn chan_prefix(space: &Id, channel: &Id) -> Vec<u8> {
    key(&[&space.0, &channel.0])
}

fn sk_of(m: &Msg, id: &Id) -> Vec<u8> {
    key(&[&m.space.0, &m.channel.0, &m.ts.to_be_bytes(), &id.0])
}

/// Exclusive upper bound for a prefix scan.
fn prefix_end(p: &[u8]) -> Vec<u8> {
    let mut e = p.to_vec();
    e.extend_from_slice(&[0xff; 41]);
    e
}

/// 0 ++ postcard (no content: deletes) or 1 ++ vault-sealed postcard.
fn pack(v: &Vault, slot: Option<u32>, s: &SignedMsg) -> Result<Vec<u8>> {
    let b = postcard::to_stdvec(s)?;
    Ok(match slot {
        None => [&[0u8][..], &b].concat(),
        Some(slot) => [&[1u8][..], &v.seal(slot, &b)?].concat(),
    })
}

fn unpack(v: &Vault, b: &[u8]) -> Result<SignedMsg> {
    Ok(match b.split_first() {
        Some((0, b)) => postcard::from_bytes(b)?,
        Some((1, b)) => postcard::from_bytes(&v.open_sealed(b)?)?,
        _ => bail!("bad stored message"),
    })
}

fn slot_in(b: &[u8]) -> Option<u32> {
    (b.first() == Some(&1)).then(|| Vault::slot_of(&b[1..]))?
}

#[derive(Clone, Debug)]
pub struct StoredMsg {
    pub id: Id,
    pub msg: Msg,
    pub text: String,
    pub reply_to: Option<Id>,
    pub edited: bool,
    pub expires: Option<u64>,
    pub files: Vec<FileRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileMeta {
    pub size: u64,
    /// The whole file is stored and its hash verified.
    pub done: bool,
    /// Size of a WebP that decoded cleanly (the only thing shown inline).
    pub image: Option<(u16, u16)>,
}

/// What a purge removed. Keys are shredded and blobs deleted only after the commit.
#[derive(Default)]
pub struct Gone {
    slots: Vec<u32>,
    blobs: Vec<Id>,
    /// (space, channel, id) of removed content messages.
    pub msgs: Vec<(Id, Id, Id)>,
}

struct Tx<'t> {
    msgs: Table<'t, &'static [u8], &'static [u8]>,
    loc: Table<'t, &'static [u8; 32], &'static [u8]>,
    extra: Table<'t, &'static [u8], &'static [u8]>,
    sync: Table<'t, &'static [u8], ()>,
    idx: Table<'t, &'static [u8; 32], &'static [u8]>,
    deleted: Table<'t, &'static [u8; 32], ()>,
    expiry: Table<'t, &'static [u8], ()>,
    files: Table<'t, &'static [u8; 32], &'static [u8]>,
    msg_files: Table<'t, &'static [u8], ()>,
    held: Table<'t, &'static [u8], ()>,
}

impl<'t> Tx<'t> {
    fn open(w: &'t WriteTransaction) -> Result<Tx<'t>> {
        Ok(Tx {
            msgs: w.open_table(MSGS)?,
            loc: w.open_table(MSG_LOC)?,
            extra: w.open_table(MSG_EXTRA)?,
            sync: w.open_table(MSG_SYNC)?,
            idx: w.open_table(MSG_IDX)?,
            deleted: w.open_table(DELETED)?,
            expiry: w.open_table(EXPIRY)?,
            files: w.open_table(FILES)?,
            msg_files: w.open_table(MSG_FILES)?,
            held: w.open_table(HELD)?,
        })
    }

    fn put(&mut self, v: &Vault, s: &SignedMsg, m: &Msg, ram: bool, out: &mut Gone) -> Result<bool> {
        let id = s.id();
        if self.idx.get(&id.0)?.is_some() || self.deleted.get(&id.0)?.is_some() {
            return Ok(false);
        }
        let sk = sk_of(m, &id);
        match &m.body {
            MsgBody::Text { .. } | MsgBody::Post { .. } => {
                let slot = v.alloc(ram)?;
                let b = pack(v, Some(slot), s)?;
                self.idx.insert(&id.0, b.as_slice())?;
                self.msgs.insert(sk.as_slice(), b.as_slice())?;
                let exp = m.expires();
                let mut loc = key(&[&sk, &exp.unwrap_or(0).to_be_bytes()]);
                if let Some(e) = exp {
                    self.expiry.insert(key(&[&e.to_be_bytes(), &id.0]).as_slice(), ())?;
                }
                for f in m.files() {
                    loc.extend_from_slice(&f.hash.0);
                    self.msg_files.insert(key(&[&f.hash.0, &id.0]).as_slice(), ())?;
                }
                self.loc.insert(&id.0, loc.as_slice())?;
            }
            MsgBody::Edit { target, .. } => {
                let slot = self
                    .idx
                    .get(&target.0)?
                    .and_then(|g| slot_in(g.value()))
                    .context("unknown target")?;
                let b = pack(v, Some(slot), s)?;
                self.idx.insert(&id.0, b.as_slice())?;
                self.extra
                    .insert(key(&[&target.0, &id.0]).as_slice(), key(&[&sk, &b]).as_slice())?;
            }
            MsgBody::Delete { target } => {
                self.idx.insert(&id.0, pack(v, None, s)?.as_slice())?;
                self.deleted.insert(&target.0, ())?;
                self.purge(target, out)?;
            }
        }
        self.sync.insert(sk.as_slice(), ())?;
        Ok(true)
    }

    /// Remove a content message, its edits and its unshared files. Needs no key, so it also
    /// works for RAM-keyed messages after a restart.
    fn purge(&mut self, id: &Id, out: &mut Gone) -> Result<()> {
        let Some(loc) = self.loc.remove(&id.0)?.map(|g| g.value().to_vec()) else {
            return Ok(());
        };
        let sk = &loc[..SK];
        self.msgs.remove(sk)?;
        self.sync.remove(sk)?;
        if let Some(slot) = self.idx.remove(&id.0)?.and_then(|g| slot_in(g.value())) {
            out.slots.push(slot);
        }
        out.msgs.push((
            Id(sk[..32].try_into()?),
            Id(sk[32..64].try_into()?),
            *id,
        ));
        let exp = &loc[SK..SK + 8];
        if exp != [0; 8] {
            self.expiry.remove(key(&[exp, &id.0]).as_slice())?;
        }
        let start = id.0.to_vec();
        let mut edits = Vec::new();
        for kv in self.extra.range(start.as_slice()..prefix_end(&start).as_slice())? {
            let (k, v) = kv?;
            edits.push((k.value().to_vec(), v.value()[..SK].to_vec()));
        }
        for (k, esk) in edits {
            self.extra.remove(k.as_slice())?;
            let eid: [u8; 32] = k[32..64].try_into()?;
            self.idx.remove(&eid)?;
            self.sync.remove(esk.as_slice())?;
        }
        for h in loc[SK + 8..].chunks_exact(32) {
            let hash = Id(h.try_into()?);
            self.msg_files.remove(key(&[&hash.0, &id.0]).as_slice())?;
            let p = hash.0.to_vec();
            if self
                .msg_files
                .range(p.as_slice()..prefix_end(&p).as_slice())?
                .next()
                .is_none()
            {
                self.drop_file(&hash, out)?;
            }
        }
        Ok(())
    }

    fn drop_file(&mut self, hash: &Id, out: &mut Gone) -> Result<()> {
        if let Some(slot) = self
            .files
            .remove(&hash.0)?
            .and_then(|g| Vault::slot_of(g.value()))
        {
            out.slots.push(slot);
        }
        out.blobs.push(*hash);
        Ok(())
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        let dir = path.parent().context("bad store path")?;
        let blobs = dir.join("blobs");
        std::fs::create_dir_all(&blobs)?;
        let db = Database::create(path)?;
        let w = db.begin_write()?;
        {
            w.open_table(META)?;
            w.open_table(OPS)?;
            w.open_table(PEERS)?;
            w.open_table(READ)?;
            w.open_table(PROFILES)?;
            w.open_table(PROFILE_PHOTOS)?;
            Tx::open(&w)?;
        }
        w.commit()?;
        let master = {
            let r = db.begin_read()?;
            r.open_table(META)?.get(VAULT_MASTER)?.map(|v| v.value().to_vec())
        };
        let master: [u8; 32] = match master {
            Some(sealed) => crate::identity::unseal(&sealed)?
                .as_slice()
                .try_into()
                .context("corrupt vault key")?,
            None => {
                let k: [u8; 32] = rand::random();
                let w = db.begin_write()?;
                w.open_table(META)?
                    .insert(VAULT_MASTER, crate::identity::seal(&k)?.as_slice())?;
                w.commit()?;
                k
            }
        };
        let vault = Vault::open(&dir.join("keys.bin"), master)?;
        let s = Store { db, vault, blobs };
        s.migrate()?;
        s.gc()?;
        Ok(s)
    }

    /// Re-store pre-vault plain history sealed. Messages deleted before are purged for real.
    fn migrate(&self) -> Result<()> {
        if self.meta(VAULT_VERSION)?.is_some() {
            return Ok(());
        }
        let mut all: Vec<(SignedMsg, Msg)> = Vec::new();
        {
            let r = self.db.begin_read()?;
            for kv in r.open_table(MSG_IDX)?.iter()? {
                let s: SignedMsg = postcard::from_bytes(kv?.1.value())?;
                let m: Msg = postcard::from_bytes(&s.bytes)?;
                all.push((s, m));
            }
        }
        // contents first, then edits, then deletes (which purge their targets)
        all.sort_by_key(|(_, m)| match m.body {
            MsgBody::Text { .. } | MsgBody::Post { .. } => 0,
            MsgBody::Edit { .. } => 1,
            MsgBody::Delete { .. } => 2,
        });
        let mut gone = Gone::default();
        self.vault.begin_bulk();
        let w = self.db.begin_write()?;
        {
            for t in [MSGS, MSG_EXTRA] {
                w.open_table(t)?.retain(|_, _| false)?;
            }
            w.open_table(MSG_SYNC)?.retain(|_, _| false)?;
            w.open_table(MSG_LOC)?.retain(|_, _| false)?;
            w.open_table(MSG_IDX)?.retain(|_, _| false)?;
            let mut tx = Tx::open(&w)?;
            for (s, m) in &all {
                if let Err(e) = tx.put(&self.vault, s, m, false, &mut gone) {
                    tracing::debug!("dropping message during migration: {e:#}");
                }
            }
            w.open_table(META)?.insert(VAULT_VERSION, &b"1"[..])?;
        }
        // keys must be durable before the rows that need them
        self.vault.end_bulk()?;
        w.commit()?;
        self.finish(gone);
        Ok(())
    }

    /// Startup cleanup: RAM-keyed messages (their keys died with the last process), expired
    /// messages, unreferenced or partial files, and disk keys nothing points to any more.
    fn gc(&self) -> Result<()> {
        let mut gone = Gone::default();
        let w = self.db.begin_write()?;
        {
            let mut tx = Tx::open(&w)?;
            let mut ram = Vec::new();
            for kv in tx.idx.iter()? {
                let (k, v) = kv?;
                if slot_in(v.value()).is_some_and(|s| s & vault::RAM != 0) {
                    ram.push(Id(*k.value()));
                }
            }
            for id in &ram {
                tx.purge(id, &mut gone)?;
                tx.idx.remove(&id.0)?; // stray edit of a RAM message
            }
            let mut files = Vec::new();
            for kv in tx.files.iter()? {
                let (k, v) = kv?;
                files.push((Id(*k.value()), v.value().to_vec()));
            }
            for (hash, v) in files {
                let p = hash.0.to_vec();
                let used = tx
                    .msg_files
                    .range(p.as_slice()..prefix_end(&p).as_slice())?
                    .next()
                    .is_some();
                let done = self
                    .vault
                    .open_sealed(&v)
                    .ok()
                    .and_then(|b| postcard::from_bytes::<FileMeta>(&b).ok())
                    .is_some_and(|m| m.done);
                if !used || !done {
                    tx.drop_file(&hash, &mut gone)?;
                }
            }
        }
        w.commit()?;
        self.finish(gone);
        self.expire(crate::id::now_ms())?;
        // keys nothing refers to (crash between alloc and commit, or before a shred)
        let r = self.db.begin_read()?;
        let mut live = std::collections::HashSet::new();
        for kv in r.open_table(MSG_IDX)?.iter()? {
            live.extend(slot_in(kv?.1.value()));
        }
        let mut blobs = std::collections::HashSet::new();
        for kv in r.open_table(FILES)?.iter()? {
            let (k, v) = kv?;
            live.extend(Vault::slot_of(v.value()));
            blobs.insert(data_encoding::HEXLOWER.encode(k.value()));
        }
        for s in self.vault.disk_slots() {
            if !live.contains(&s) {
                self.vault.shred(s)?;
            }
        }
        for e in std::fs::read_dir(&self.blobs)?.flatten() {
            if !blobs.contains(e.file_name().to_string_lossy().as_ref()) {
                let _ = std::fs::remove_file(e.path());
            }
        }
        Ok(())
    }

    fn finish(&self, gone: Gone) {
        for s in gone.slots {
            if let Err(e) = self.vault.shred(s) {
                tracing::warn!("shred failed: {e:#}");
            }
        }
        for h in gone.blobs {
            let _ = std::fs::remove_file(self.blob_path(&h));
        }
    }

    pub fn meta(&self, k: &str) -> Result<Option<Vec<u8>>> {
        let r = self.db.begin_read()?;
        Ok(r.open_table(META)?.get(k)?.map(|v| v.value().to_vec()))
    }

    pub fn set_meta(&self, k: &str, v: &[u8]) -> Result<()> {
        let w = self.db.begin_write()?;
        w.open_table(META)?.insert(k, v)?;
        w.commit()?;
        Ok(())
    }

    pub(crate) fn load_profiles(&self) -> Result<std::collections::HashMap<Id, Profile>> {
        let r = self.db.begin_read()?;
        let photos = r.open_table(PROFILE_PHOTOS)?;
        let mut profiles = std::collections::HashMap::new();
        for entry in r.open_table(PROFILES)?.iter()? {
            let (key, value) = entry?;
            let meta = postcard::from_bytes(value.value())?;
            profiles.insert(Id(*key.value()), Profile {
                meta,
                photo_ready: photos.get(key.value())?.is_some(),
            });
        }
        Ok(profiles)
    }

    pub(crate) fn put_profile(
        &self,
        member: Id,
        meta: &ProfileMeta,
        name: Option<&str>,
        photo: Option<&[u8]>,
        remove_photo: bool,
    ) -> Result<()> {
        let bytes = postcard::to_stdvec(meta)?;
        let w = self.db.begin_write()?;
        w.open_table(PROFILES)?.insert(&member.0, bytes.as_slice())?;
        if let Some(name) = name {
            w.open_table(META)?.insert("name", name.as_bytes())?;
        }
        if let Some(photo) = photo {
            w.open_table(PROFILE_PHOTOS)?.insert(&member.0, photo)?;
        } else if remove_photo {
            w.open_table(PROFILE_PHOTOS)?.remove(&member.0)?;
        }
        w.commit()?;
        Ok(())
    }

    pub(crate) fn profile_photo(&self, member: Id) -> Result<Option<Vec<u8>>> {
        let r = self.db.begin_read()?;
        Ok(r.open_table(PROFILE_PHOTOS)?.get(&member.0)?.map(|v| v.value().to_vec()))
    }

    pub(crate) fn put_profile_photo(&self, member: Id, photo: &[u8]) -> Result<()> {
        let w = self.db.begin_write()?;
        w.open_table(PROFILE_PHOTOS)?.insert(&member.0, photo)?;
        w.commit()?;
        Ok(())
    }

    pub fn put_ops(&self, space: &Id, ops: &[SignedOp]) -> Result<()> {
        let w = self.db.begin_write()?;
        {
            let mut t = w.open_table(OPS)?;
            for o in ops {
                t.insert(
                    key(&[&space.0, &o.id().0]).as_slice(),
                    postcard::to_stdvec(o)?.as_slice(),
                )?;
            }
        }
        w.commit()?;
        Ok(())
    }

    /// All spaces with their ops (genesis included, any order).
    pub fn load_spaces(&self) -> Result<Vec<(Id, Vec<SignedOp>)>> {
        let r = self.db.begin_read()?;
        let t = r.open_table(OPS)?;
        let mut out: Vec<(Id, Vec<SignedOp>)> = Vec::new();
        for kv in t.iter()? {
            let (k, v) = kv?;
            let space = Id(k.value()[..32].try_into()?);
            let op: SignedOp = postcard::from_bytes(v.value())?;
            match out.last_mut() {
                Some((s, ops)) if *s == space => ops.push(op),
                _ => out.push((space, vec![op])),
            }
        }
        Ok(out)
    }

    /// Purge everything of a space (privacy on leave/kick/delete): content keys are shredded.
    pub fn delete_space(&self, space: &Id) -> Result<()> {
        let ids: Vec<Id> = {
            let r = self.db.begin_read()?;
            let t = r.open_table(MSG_SYNC)?;
            let start = space.0.to_vec();
            let end = prefix_end(&start);
            let mut v = Vec::new();
            for kv in t.range(start.as_slice()..end.as_slice())? {
                v.push(Id(kv?.0.value()[72..104].try_into()?));
            }
            v
        };
        let mut gone = Gone::default();
        let w = self.db.begin_write()?;
        {
            let mut tx = Tx::open(&w)?;
            for id in &ids {
                tx.purge(id, &mut gone)?;
                // what's left are deletes: drop them and their tombstones
                if let Some(v) = tx.idx.remove(&id.0)?.map(|g| g.value().to_vec())
                    && let Ok(s) = unpack(&self.vault, &v)
                    && let Ok(m) = postcard::from_bytes::<Msg>(&s.bytes)
                    && let MsgBody::Delete { target } = m.body
                {
                    tx.deleted.remove(&target.0)?;
                    tx.held.remove(key(&[&target.0, &id.0]).as_slice())?;
                }
            }
            let start = space.0.to_vec();
            let end = prefix_end(&start);
            tx.msgs
                .retain_in(start.as_slice()..end.as_slice(), |_, _| false)?;
            tx.sync
                .retain_in(start.as_slice()..end.as_slice(), |_, _| false)?;
            drop(tx);
            w.open_table(OPS)?
                .retain_in(start.as_slice()..end.as_slice(), |_, _| false)?;
            w.open_table(READ)?
                .retain_in(start.as_slice()..end.as_slice(), |_, _| false)?;
        }
        w.commit()?;
        self.finish(gone);
        Ok(())
    }

    pub fn has_msg(&self, id: &Id) -> Result<bool> {
        let r = self.db.begin_read()?;
        Ok(r.open_table(MSG_IDX)?.get(&id.0)?.is_some()
            || r.open_table(DELETED)?.get(&id.0)?.is_some())
    }

    pub fn is_deleted(&self, id: &Id) -> Result<bool> {
        let r = self.db.begin_read()?;
        Ok(r.open_table(DELETED)?.get(&id.0)?.is_some())
    }

    /// Store a verified + authorized message (a Delete also purges its target). `ram`: keep
    /// the content key in memory only. Returns None if it was already known or deleted.
    pub fn put_msg(&self, s: &SignedMsg, m: &Msg, ram: bool) -> Result<Option<Vec<(Id, Id, Id)>>> {
        let mut gone = Gone::default();
        let w = self.db.begin_write()?;
        let new = {
            let mut tx = Tx::open(&w)?;
            tx.put(&self.vault, s, m, ram, &mut gone)?
        };
        w.commit()?;
        let msgs = std::mem::take(&mut gone.msgs);
        self.finish(gone);
        Ok(new.then_some(msgs))
    }

    /// Keep a delete whose target we don't have (yet). Returns false if already known.
    pub fn hold_delete(&self, s: &SignedMsg, m: &Msg) -> Result<bool> {
        let MsgBody::Delete { target } = m.body else {
            bail!("not a delete")
        };
        let id = s.id();
        let w = self.db.begin_write()?;
        {
            let mut tx = Tx::open(&w)?;
            if tx.idx.get(&id.0)?.is_some() {
                return Ok(false);
            }
            tx.idx.insert(&id.0, pack(&self.vault, None, s)?.as_slice())?;
            tx.sync.insert(sk_of(m, &id).as_slice(), ())?;
            tx.held.insert(key(&[&target.0, &id.0]).as_slice(), ())?;
        }
        w.commit()?;
        Ok(true)
    }

    /// Deletes waiting for `target`.
    pub fn held_for(&self, target: &Id) -> Result<Vec<(SignedMsg, Msg)>> {
        let r = self.db.begin_read()?;
        let (held, idx) = (r.open_table(HELD)?, r.open_table(MSG_IDX)?);
        let p = target.0.to_vec();
        let mut out = Vec::new();
        for kv in held.range(p.as_slice()..prefix_end(&p).as_slice())? {
            let did: [u8; 32] = kv?.0.value()[32..64].try_into()?;
            if let Some(v) = idx.get(&did)? {
                let s = unpack(&self.vault, v.value())?;
                let m = postcard::from_bytes(&s.bytes)?;
                out.push((s, m));
            }
        }
        Ok(out)
    }

    /// The target of a held delete arrived: apply it if it was allowed, otherwise forget it.
    pub fn resolve_held(&self, target: &Id, d: &SignedMsg, dm: &Msg, allowed: bool) -> Result<Vec<(Id, Id, Id)>> {
        let did = d.id();
        let mut gone = Gone::default();
        let w = self.db.begin_write()?;
        {
            let mut tx = Tx::open(&w)?;
            tx.held.remove(key(&[&target.0, &did.0]).as_slice())?;
            if allowed {
                tx.deleted.insert(&target.0, ())?;
                tx.purge(target, &mut gone)?;
            } else {
                tx.idx.remove(&did.0)?;
                tx.sync.remove(sk_of(dm, &did).as_slice())?;
            }
        }
        w.commit()?;
        let msgs = std::mem::take(&mut gone.msgs);
        self.finish(gone);
        Ok(msgs)
    }

    /// Purge every message whose time is up.
    pub fn expire(&self, now: u64) -> Result<Vec<(Id, Id, Id)>> {
        let due: Vec<Vec<u8>> = {
            let r = self.db.begin_read()?;
            let t = r.open_table(EXPIRY)?;
            let end = (now + 1).to_be_bytes();
            let mut v = Vec::new();
            for kv in t.range(..&end[..])? {
                v.push(kv?.0.value().to_vec());
            }
            v
        };
        if due.is_empty() {
            return Ok(vec![]);
        }
        let mut gone = Gone::default();
        let w = self.db.begin_write()?;
        {
            let mut tx = Tx::open(&w)?;
            for k in &due {
                tx.expiry.remove(k.as_slice())?;
                tx.purge(&Id(k[8..40].try_into()?), &mut gone)?;
            }
        }
        w.commit()?;
        let msgs = std::mem::take(&mut gone.msgs);
        self.finish(gone);
        Ok(msgs)
    }

    pub fn next_expiry(&self) -> Result<Option<u64>> {
        let r = self.db.begin_read()?;
        Ok(match r.open_table(EXPIRY)?.first()? {
            Some((k, _)) => Some(u64::from_be_bytes(k.value()[..8].try_into()?)),
            None => None,
        })
    }

    pub fn get_msgs(&self, ids: &[Id]) -> Result<Vec<SignedMsg>> {
        let r = self.db.begin_read()?;
        let idx = r.open_table(MSG_IDX)?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(v) = idx.get(&id.0)?
                && let Ok(s) = unpack(&self.vault, v.value())
            {
                out.push(s);
            }
        }
        Ok(out)
    }

    /// Content message by id, materialized with edits.
    pub fn msg_view(&self, id: &Id) -> Result<Option<StoredMsg>> {
        let r = self.db.begin_read()?;
        let Some(loc) = r.open_table(MSG_LOC)?.get(&id.0)? else {
            return Ok(None);
        };
        let Some(v) = r.open_table(MSGS)?.get(&loc.value()[..SK])? else {
            return Ok(None);
        };
        let s = unpack(&self.vault, v.value())?;
        self.materialize(&r, s).map(Some)
    }

    fn materialize(&self, r: &redb::ReadTransaction, s: SignedMsg) -> Result<StoredMsg> {
        let id = s.id();
        let msg: Msg = postcard::from_bytes(&s.bytes)?;
        let (text, reply_to) = match msg.body.clone() {
            MsgBody::Text { text, reply_to } | MsgBody::Post { text, reply_to, .. } => {
                (text, reply_to)
            }
            _ => bail!("not content"),
        };
        let mut out = StoredMsg {
            id,
            expires: msg.expires(),
            files: msg.files().to_vec(),
            msg,
            text,
            reply_to,
            edited: false,
        };
        let extra = r.open_table(MSG_EXTRA)?;
        let start = id.0.to_vec();
        let end = prefix_end(&start);
        let mut best_edit = 0u64;
        for kv in extra.range(start.as_slice()..end.as_slice())? {
            let (_, v) = kv?;
            let e = unpack(&self.vault, &v.value()[SK..])?;
            let m: Msg = postcard::from_bytes(&e.bytes)?;
            // only the author may edit (checked at ingest); latest edit wins
            if let MsgBody::Edit { text, .. } = m.body
                && m.ts >= best_edit
            {
                best_edit = m.ts;
                out.text = text;
                out.edited = true;
            }
        }
        Ok(out)
    }

    /// Up to `limit` content messages older than `before`, oldest first.
    pub fn page(
        &self,
        space: &Id,
        channel: &Id,
        before: Option<u64>,
        limit: usize,
    ) -> Result<Vec<StoredMsg>> {
        let r = self.db.begin_read()?;
        let t = r.open_table(MSGS)?;
        let p = chan_prefix(space, channel);
        let end = match before {
            Some(b) => key(&[&p, &b.to_be_bytes()]),
            None => prefix_end(&p),
        };
        let mut raw = Vec::new();
        for kv in t.range(p.as_slice()..end.as_slice())?.rev().take(limit) {
            let (_, v) = kv?;
            match unpack(&self.vault, v.value()) {
                Ok(s) => raw.push(s),
                Err(e) => tracing::debug!("unreadable message skipped: {e:#}"),
            }
        }
        raw.reverse();
        raw.into_iter().map(|s| self.materialize(&r, s)).collect()
    }

    pub fn unread(&self, space: &Id, channel: &Id, me: &Id) -> Result<u32> {
        let r = self.db.begin_read()?;
        let p = chan_prefix(space, channel);
        let since = r
            .open_table(READ)?
            .get(p.as_slice())?
            .map(|v| v.value())
            .unwrap_or(0);
        let t = r.open_table(MSGS)?;
        let start = key(&[&p, &(since + 1).to_be_bytes()]);
        let mut n = 0;
        for kv in t
            .range(start.as_slice()..prefix_end(&p).as_slice())?
            .rev()
            .take(100)
        {
            let (_, v) = kv?;
            if let Ok(s) = unpack(&self.vault, v.value())
                && postcard::from_bytes::<Msg>(&s.bytes)?.author != *me
            {
                n += 1;
            }
        }
        Ok(n)
    }

    pub fn mark_read(&self, space: &Id, channel: &Id, ts: u64) -> Result<()> {
        let w = self.db.begin_write()?;
        {
            let mut t = w.open_table(READ)?;
            let p = chan_prefix(space, channel);
            let cur = t.get(p.as_slice())?.map(|v| v.value()).unwrap_or(0);
            if ts > cur {
                t.insert(p.as_slice(), ts)?;
            }
        }
        w.commit()?;
        Ok(())
    }

    /// (ts, id) of every message in a channel within [from, to).
    pub fn sync_items(
        &self,
        space: &Id,
        channel: &Id,
        from: u64,
        to: u64,
    ) -> Result<Vec<(u64, Id)>> {
        let r = self.db.begin_read()?;
        let t = r.open_table(MSG_SYNC)?;
        let p = chan_prefix(space, channel);
        let (s, e) = (
            key(&[&p, &from.to_be_bytes()]),
            key(&[&p, &to.to_be_bytes()]),
        );
        let mut out = Vec::new();
        for kv in t.range(s.as_slice()..e.as_slice())? {
            let (k, _) = kv?;
            let k = k.value();
            out.push((
                u64::from_be_bytes(k[64..72].try_into()?),
                Id(k[72..104].try_into()?),
            ));
        }
        Ok(out)
    }

    pub fn put_peer_addr(&self, member: &Id, addr: &[u8]) -> Result<()> {
        let w = self.db.begin_write()?;
        w.open_table(PEERS)?.insert(&member.0, addr)?;
        w.commit()?;
        Ok(())
    }

    pub fn peer_addrs(&self) -> Result<Vec<(Id, Vec<u8>)>> {
        let r = self.db.begin_read()?;
        let t = r.open_table(PEERS)?;
        let mut out = Vec::new();
        for kv in t.iter()? {
            let (k, v) = kv?;
            out.push((Id(*k.value()), v.value().to_vec()));
        }
        Ok(out)
    }

    // ------------------------------------------------------------------ files

    pub(crate) fn vault(&self) -> &Vault {
        &self.vault
    }

    pub(crate) fn blob_path(&self, hash: &Id) -> PathBuf {
        self.blobs.join(data_encoding::HEXLOWER.encode(&hash.0))
    }

    /// (key slot, meta) of a stored or in-progress file.
    pub(crate) fn file(&self, hash: &Id) -> Result<Option<(u32, FileMeta)>> {
        let r = self.db.begin_read()?;
        let Some(v) = r.open_table(FILES)?.get(&hash.0)? else {
            return Ok(None);
        };
        let v = v.value();
        let slot = Vault::slot_of(v).context("bad file record")?;
        Ok(Some((slot, postcard::from_bytes(&self.vault.open_sealed(v)?)?)))
    }

    pub(crate) fn file_set(&self, hash: &Id, slot: u32, meta: &FileMeta) -> Result<()> {
        let v = self.vault.seal(slot, &postcard::to_stdvec(meta)?)?;
        let w = self.db.begin_write()?;
        w.open_table(FILES)?.insert(&hash.0, v.as_slice())?;
        w.commit()?;
        Ok(())
    }

    /// Remove a file nothing should keep (bad hash, abandoned transfer).
    pub(crate) fn file_drop(&self, hash: &Id) -> Result<()> {
        let mut gone = Gone::default();
        let w = self.db.begin_write()?;
        Tx::open(&w)?.drop_file(hash, &mut gone)?;
        w.commit()?;
        self.finish(gone);
        Ok(())
    }

    /// Live messages that reference this file.
    pub(crate) fn file_refs(&self, hash: &Id) -> Result<Vec<Id>> {
        let r = self.db.begin_read()?;
        let t = r.open_table(MSG_FILES)?;
        let p = hash.0.to_vec();
        let mut out = Vec::new();
        for kv in t.range(p.as_slice()..prefix_end(&p).as_slice())? {
            out.push(Id(kv?.0.value()[32..64].try_into()?));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msg::{FileRef, Msg, MsgBody, SignedMsg};

    fn signed(k: &iroh::SecretKey, ts: u64, body: MsgBody) -> (SignedMsg, Msg) {
        let m = Msg {
            space: Id([1; 32]),
            channel: Id([2; 32]),
            author: k.public().into(),
            ts,
            body,
        };
        (SignedMsg::sign(k, &m).unwrap(), m)
    }

    /// Does any file under `dir` contain `needle`?
    fn on_disk(dir: &Path, needle: &[u8]) -> bool {
        walk(dir).iter().any(|p| {
            std::fs::read(p)
                .map(|b| b.windows(needle.len()).any(|w| w == needle))
                .unwrap_or(false)
        })
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push(p);
            }
        }
        out
    }

    fn sealed(s: &Store, id: &Id) -> Vec<u8> {
        let r = s.db.begin_read().unwrap();
        let v = r.open_table(MSG_IDX).unwrap().get(&id.0).unwrap().unwrap().value().to_vec();
        v[1..].to_vec()
    }

    /// The acceptance test for the privacy promise: once a message is deleted or expires,
    /// nothing in the data directory can bring it back, even with the vault master key.
    #[test]
    fn purged_content_is_unrecoverable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("halka.redb");
        let s = Store::open(&path).unwrap();
        let k = iroh::SecretKey::generate();
        let now = crate::id::now_ms();
        let text = |t: &str| MsgBody::Text { text: t.into(), reply_to: None };

        let (t, tm) = signed(&k, now, text("IZ-SILINEN-7f3a9c"));
        s.put_msg(&t, &tm, false).unwrap().unwrap();
        let (e, em) = signed(&k, now + 1, MsgBody::Edit { target: t.id(), text: "IZ-DUZELTME-55e1".into() });
        s.put_msg(&e, &em, false).unwrap().unwrap();
        let (p, pm) = signed(&k, now - 4_000, MsgBody::Post {
            text: "IZ-SURELI-41bd02".into(),
            reply_to: None,
            ttl_ms: Some(5_000),
            files: vec![],
        });
        s.put_msg(&p, &pm, false).unwrap().unwrap();
        let (r, rm) = signed(&k, now, MsgBody::Post {
            text: "IZ-RAM-9d0c".into(),
            reply_to: None,
            ttl_ms: Some(86_400_000),
            files: vec![],
        });
        s.put_msg(&r, &rm, true).unwrap().unwrap();

        let data: Vec<u8> = b"IZ-DOSYA-c0ffee".iter().copied().cycle().take(3 * CHUNK + 77).collect();
        let mut w = crate::files::Writer::new(&s, false, data.len() as u64, "a.bin".into(), "application/octet-stream".into()).unwrap();
        w.push(&s, &data).unwrap();
        let (hash, size, _) = w.finish(&s, None).unwrap();
        let f = FileRef { hash, size, name: "a.bin".into(), mime: "application/octet-stream".into(), image: None };
        let (fp, fpm) = signed(&k, now, MsgBody::Post { text: String::new(), reply_to: None, ttl_ms: None, files: vec![f] });
        s.put_msg(&fp, &fpm, false).unwrap().unwrap();
        let (keep, keepm) = signed(&k, now + 2, text("IZ-KALIR-0aa1"));
        s.put_msg(&keep, &keepm, false).unwrap().unwrap();

        // encrypted at rest from the start
        for m in ["IZ-SILINEN", "IZ-DUZELTME", "IZ-SURELI", "IZ-RAM", "IZ-DOSYA", "IZ-KALIR"] {
            assert!(!on_disk(dir.path(), m.as_bytes()), "{m} stored in plain");
        }
        assert_eq!(s.msg_view(&t.id()).unwrap().unwrap().text, "IZ-DUZELTME-55e1");
        let (st, sp, sr) = (sealed(&s, &t.id()), sealed(&s, &p.id()), sealed(&s, &r.id()));
        let file_slot = s.file(&hash).unwrap().unwrap().0;

        let (d, dm) = signed(&k, now + 3, MsgBody::Delete { target: t.id() });
        assert_eq!(s.put_msg(&d, &dm, false).unwrap().unwrap().len(), 1);
        let (d2, d2m) = signed(&k, now + 4, MsgBody::Delete { target: fp.id() });
        s.put_msg(&d2, &d2m, false).unwrap().unwrap();
        assert_eq!(s.expire(now + 1_500).unwrap().len(), 1);
        assert!(s.msg_view(&t.id()).unwrap().is_none() && s.msg_view(&p.id()).unwrap().is_none());
        assert!(!s.blob_path(&hash).exists() && s.file(&hash).unwrap().is_none());
        // a peer re-offering deleted content is refused
        assert!(s.put_msg(&t, &tm, false).unwrap().is_none());
        drop(s);

        let s = Store::open(&path).unwrap();
        for v in [&st, &sp, &sr] {
            assert!(s.vault.open_sealed(v).is_err(), "purged content still decrypts");
        }
        assert!(s.vault.open_chunk(file_slot, 0, &[0; 32]).is_err());
        assert!(s.msg_view(&r.id()).unwrap().is_none(), "RAM-keyed message survived a restart");
        assert_eq!(s.msg_view(&keep.id()).unwrap().unwrap().text, "IZ-KALIR-0aa1");
        let ids: Vec<Id> = s
            .sync_items(&Id([1; 32]), &Id([2; 32]), 0, u64::MAX)
            .unwrap()
            .into_iter()
            .map(|(_, id)| id)
            .collect();
        assert!(ids.contains(&d.id()) && ids.contains(&keep.id()) && !ids.contains(&t.id()) && !ids.contains(&e.id()));
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use crate::msg::{Msg, MsgBody, SignedMsg};

    /// A 0.1.6 database (plain postcard rows, no vault) opens with its history intact, edits
    /// applied, and messages deleted back then purged for real.
    #[test]
    fn old_plain_history_is_sealed_on_first_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("halka.redb");
        let k = iroh::SecretKey::generate();
        let (space, channel) = (Id([1; 32]), Id([2; 32]));
        let sign = |ts: u64, body: MsgBody| {
            let m = Msg { space, channel, author: k.public().into(), ts, body };
            (SignedMsg::sign(&k, &m).unwrap(), m)
        };
        let text = |t: &str| MsgBody::Text { text: t.into(), reply_to: None };
        let mut rows = vec![];
        let (t1, _) = sign(1_000, text("ilk hali"));
        rows.push(sign(1_000, text("ilk hali")));
        rows.push(sign(2_000, MsgBody::Edit { target: t1.id(), text: "düzeltilmiş".into() }));
        let (t2, _) = sign(3_000, text("silinmişti"));
        rows.push(sign(3_000, text("silinmişti")));
        rows.push(sign(4_000, MsgBody::Delete { target: t2.id() }));
        const FILLER: u64 = 20_000;
        for n in 0..FILLER {
            rows.push(sign(10_000 + n, text(&format!("mesaj {n}"))));
        }
        {
            // the pre-vault layout: raw postcard everywhere
            let db = Database::create(&path).unwrap();
            let w = db.begin_write().unwrap();
            {
                let (mut idx, mut msgs, mut loc, mut extra, mut sync) = (
                    w.open_table(MSG_IDX).unwrap(),
                    w.open_table(MSGS).unwrap(),
                    w.open_table(MSG_LOC).unwrap(),
                    w.open_table(MSG_EXTRA).unwrap(),
                    w.open_table(MSG_SYNC).unwrap(),
                );
                for (s, m) in &rows {
                    let id = s.id();
                    let b = postcard::to_stdvec(s).unwrap();
                    let sk = sk_of(m, &id);
                    idx.insert(&id.0, b.as_slice()).unwrap();
                    sync.insert(sk.as_slice(), ()).unwrap();
                    match &m.body {
                        MsgBody::Text { .. } => {
                            msgs.insert(sk.as_slice(), b.as_slice()).unwrap();
                            loc.insert(&id.0, sk.as_slice()).unwrap();
                        }
                        MsgBody::Edit { target, .. } | MsgBody::Delete { target } => {
                            extra.insert(key(&[&target.0, &id.0]).as_slice(), b.as_slice()).unwrap();
                        }
                        _ => {}
                    }
                }
            }
            w.commit().unwrap();
        }
        let started = std::time::Instant::now();
        let s = Store::open(&path).unwrap();
        let took = started.elapsed();
        eprintln!("migrated {} rows in {took:?}", rows.len());
        assert!(took < std::time::Duration::from_secs(30), "migration too slow: {took:?}");
        let v = s.msg_view(&t1.id()).unwrap().unwrap();
        assert!(v.edited && v.text == "düzeltilmiş");
        assert!(s.msg_view(&t2.id()).unwrap().is_none() && s.is_deleted(&t2.id()).unwrap());
        assert_eq!(s.page(&space, &channel, None, 3).unwrap().last().unwrap().text, format!("mesaj {}", FILLER - 1));
        assert_eq!(
            s.sync_items(&space, &channel, 0, u64::MAX).unwrap().len() as u64,
            FILLER + 3, // t1 + its edit + the delete (t2 itself is gone)
        );
        drop(s);
        // second open: no re-migration, everything still readable
        let s = Store::open(&path).unwrap();
        assert_eq!(s.msg_view(&t1.id()).unwrap().unwrap().text, "düzeltilmiş");
    }
}
