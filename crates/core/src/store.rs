//! Local persistence (redb). Everything is stored as the original signed bytes so it can be
//! re-verified and re-served to peers; views are materialized on read.

use std::path::Path;

use anyhow::Result;
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};

use crate::id::Id;
use crate::msg::{Msg, MsgBody, SignedMsg};
use crate::op::SignedOp;
use crate::profile::{Profile, ProfileMeta};

const META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");
/// space ++ op id -> SignedOp
const OPS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("ops");
/// space ++ channel ++ ts(be) ++ id -> SignedMsg   (Text messages only)
const MSGS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("msgs");
/// msg id -> MSGS key
const MSG_LOC: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("msg_loc");
/// target id ++ msg id -> SignedMsg   (edits and deletes)
const MSG_EXTRA: TableDefinition<&[u8], &[u8]> = TableDefinition::new("msg_extra");
/// space ++ channel ++ ts(be) ++ id -> ()   every message, for reconciliation
const MSG_SYNC: TableDefinition<&[u8], ()> = TableDefinition::new("msg_sync");
/// msg id -> SignedMsg (dedupe + fetch by id)
const MSG_IDX: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("msg_idx");
/// member id -> postcard(EndpointAddr)
const PEERS: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("peers");
/// space ++ channel -> last read ts
const READ: TableDefinition<&[u8], u64> = TableDefinition::new("read");
const PROFILES: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("profiles");
const PROFILE_PHOTOS: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("profile_photos");

pub struct Store {
    db: Database,
}

fn key(parts: &[&[u8]]) -> Vec<u8> {
    parts.concat()
}

fn chan_prefix(space: &Id, channel: &Id) -> Vec<u8> {
    key(&[&space.0, &channel.0])
}

/// Exclusive upper bound for a prefix scan.
fn prefix_end(p: &[u8]) -> Vec<u8> {
    let mut e = p.to_vec();
    e.extend_from_slice(&[0xff; 41]);
    e
}

#[derive(Clone, Debug)]
pub struct StoredMsg {
    pub id: Id,
    pub msg: Msg,
    pub text: String,
    pub reply_to: Option<Id>,
    pub edited: bool,
    pub deleted: bool,
}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        let db = Database::create(path)?;
        let w = db.begin_write()?;
        {
            w.open_table(META)?;
            w.open_table(OPS)?;
            w.open_table(MSGS)?;
            w.open_table(MSG_LOC)?;
            w.open_table(MSG_EXTRA)?;
            w.open_table(MSG_SYNC)?;
            w.open_table(MSG_IDX)?;
            w.open_table(PEERS)?;
            w.open_table(READ)?;
            w.open_table(PROFILES)?;
            w.open_table(PROFILE_PHOTOS)?;
        }
        w.commit()?;
        Ok(Store { db })
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

    pub fn delete_space(&self, space: &Id) -> Result<()> {
        // collect this space's message ids first so every index is purged (privacy on leave/kick)
        let ids: Vec<[u8; 32]> = {
            let r = self.db.begin_read()?;
            let t = r.open_table(MSG_SYNC)?;
            let start = space.0.to_vec();
            let end = prefix_end(&start);
            let mut v = Vec::new();
            for kv in t.range(start.as_slice()..end.as_slice())? {
                v.push(kv?.0.value()[72..104].try_into()?);
            }
            v
        };
        let w = self.db.begin_write()?;
        {
            let (mut idx, mut loc, mut extra) = (
                w.open_table(MSG_IDX)?,
                w.open_table(MSG_LOC)?,
                w.open_table(MSG_EXTRA)?,
            );
            for id in &ids {
                idx.remove(id)?;
                loc.remove(id)?;
                let s = id.to_vec();
                extra.retain_in(s.as_slice()..prefix_end(&s).as_slice(), |_, _| false)?;
            }
        }
        {
            let start = space.0.to_vec();
            let end = prefix_end(&start);
            w.open_table(OPS)?
                .retain_in(start.as_slice()..end.as_slice(), |_, _| false)?;
            w.open_table(MSGS)?
                .retain_in(start.as_slice()..end.as_slice(), |_, _| false)?;
            w.open_table(MSG_SYNC)?
                .retain_in(start.as_slice()..end.as_slice(), |_, _| false)?;
            w.open_table(READ)?
                .retain_in(start.as_slice()..end.as_slice(), |_, _| false)?;
        }
        w.commit()?;
        Ok(())
    }

    pub fn has_msg(&self, id: &Id) -> Result<bool> {
        let r = self.db.begin_read()?;
        Ok(r.open_table(MSG_IDX)?.get(&id.0)?.is_some())
    }

    /// Store a verified + authorized message. Returns false if it was already known.
    pub fn put_msg(&self, s: &SignedMsg, m: &Msg) -> Result<bool> {
        let id = s.id();
        let w = self.db.begin_write()?;
        {
            let mut idx = w.open_table(MSG_IDX)?;
            if idx.get(&id.0)?.is_some() {
                return Ok(false);
            }
            let sk = key(&[&m.space.0, &m.channel.0, &m.ts.to_be_bytes(), &id.0]);
            let bytes = postcard::to_stdvec(s)?;
            idx.insert(&id.0, bytes.as_slice())?;
            w.open_table(MSG_SYNC)?.insert(sk.as_slice(), ())?;
            match &m.body {
                MsgBody::Text { .. } => {
                    w.open_table(MSGS)?
                        .insert(sk.as_slice(), bytes.as_slice())?;
                    w.open_table(MSG_LOC)?.insert(&id.0, sk.as_slice())?;
                }
                MsgBody::Edit { target, .. } | MsgBody::Delete { target } => {
                    w.open_table(MSG_EXTRA)?
                        .insert(key(&[&target.0, &id.0]).as_slice(), bytes.as_slice())?;
                }
            }
        }
        w.commit()?;
        Ok(true)
    }

    pub fn get_msgs(&self, ids: &[Id]) -> Result<Vec<SignedMsg>> {
        let r = self.db.begin_read()?;
        let idx = r.open_table(MSG_IDX)?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(v) = idx.get(&id.0)? {
                out.push(postcard::from_bytes(v.value())?);
            }
        }
        Ok(out)
    }

    /// Text message by id, materialized with edits/deletes.
    pub fn msg_view(&self, id: &Id) -> Result<Option<StoredMsg>> {
        let r = self.db.begin_read()?;
        let Some(sk) = r.open_table(MSG_LOC)?.get(&id.0)? else {
            return Ok(None);
        };
        let Some(v) = r.open_table(MSGS)?.get(sk.value())? else {
            return Ok(None);
        };
        let s: SignedMsg = postcard::from_bytes(v.value())?;
        self.materialize(&r, s).map(Some)
    }

    fn materialize(&self, r: &redb::ReadTransaction, s: SignedMsg) -> Result<StoredMsg> {
        let id = s.id();
        let msg: Msg = postcard::from_bytes(&s.bytes)?;
        let MsgBody::Text { text, reply_to } = msg.body.clone() else {
            anyhow::bail!("not text")
        };
        let mut out = StoredMsg {
            id,
            msg,
            text,
            reply_to,
            edited: false,
            deleted: false,
        };
        let extra = r.open_table(MSG_EXTRA)?;
        let start = id.0.to_vec();
        let end = prefix_end(&start);
        let mut best_edit = 0u64;
        for kv in extra.range(start.as_slice()..end.as_slice())? {
            let (_, v) = kv?;
            let e: SignedMsg = postcard::from_bytes(v.value())?;
            let m: Msg = postcard::from_bytes(&e.bytes)?;
            match m.body {
                MsgBody::Delete { .. } => out.deleted = true,
                // only the author may edit (checked at ingest); latest edit wins
                MsgBody::Edit { text, .. } if m.ts >= best_edit => {
                    best_edit = m.ts;
                    out.text = text;
                    out.edited = true;
                }
                _ => {}
            }
        }
        if out.deleted {
            out.text.clear();
        }
        Ok(out)
    }

    /// Up to `limit` text messages older than `before`, oldest first.
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
            raw.push(postcard::from_bytes::<SignedMsg>(v.value())?);
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
            let s: SignedMsg = postcard::from_bytes(v.value())?;
            if postcard::from_bytes::<Msg>(&s.bytes)?.author != *me {
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
}
