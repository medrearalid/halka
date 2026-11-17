use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use data_encoding::BASE64;
use image_webp::WebPDecoder;
use iroh::endpoint::{Connection, RecvStream};
use serde::{Deserialize, Serialize};

use crate::api::{Event, ProfileView};
use crate::id::Id;
use crate::node::{Inner, Node, St, publish_name};
use crate::op;

pub(crate) const TAG: u8 = b'P';
const MAX_PHOTO: usize = 32 * 1024;
const MAX_PACKET: usize = MAX_PHOTO + 64;
const TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_COLOR: u32 = 0x9f76fa;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProfileMeta {
    revision: u64,
    orb_color: u32,
    bio: String,
    photo: Option<Id>,
}

impl Default for ProfileMeta {
    fn default() -> Self {
        Self {
            revision: 0,
            orb_color: DEFAULT_COLOR,
            bio: String::new(),
            photo: None,
        }
    }
}

#[derive(Clone)]
pub(crate) struct Profile {
    pub meta: ProfileMeta,
    pub photo_ready: bool,
}

impl Profile {
    pub fn view(&self) -> ProfileView {
        ProfileView {
            orb_color: self.meta.orb_color,
            bio: self.meta.bio.clone(),
            photo: self.meta.photo.filter(|_| self.photo_ready),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum PhotoEdit {
    Keep,
    Remove,
    Replace(String),
}

#[derive(Serialize, Deserialize)]
enum Packet {
    Sync(Option<ProfileMeta>),
    Meta(ProfileMeta),
    WantPhoto(Id),
    Photo { hash: Id, bytes: Vec<u8> },
}

fn validate_fields(orb_color: u32, bio: &str) -> Result<()> {
    ensure!(orb_color <= 0xff_ff_ff, "Geçersiz orb rengi");
    ensure!(
        bio.chars().take(161).count() <= 160,
        "Biyografi en fazla 160 karakter olabilir"
    );
    ensure!(
        bio.chars().all(|c| !c.is_control() || c == '\n'),
        "Biyografi geçersiz karakter içeriyor"
    );
    Ok(())
}

fn check_photo(bytes: &[u8]) -> Result<Id> {
    ensure!(bytes.len() <= MAX_PHOTO, "Profil fotoğrafı çok büyük");
    let mut decoder = WebPDecoder::new(Cursor::new(bytes)).context("Geçersiz WebP fotoğrafı")?;
    ensure!(
        decoder.dimensions() == (192, 192) && !decoder.is_animated(),
        "Profil fotoğrafı 192 × 192 boyutunda olmalı"
    );
    decoder.set_memory_limit(2 * 1024 * 1024);
    decoder
        .read_image(&mut vec![
            0;
            decoder
                .output_buffer_size()
                .context("Geçersiz fotoğraf boyutu")?
        ])
        .context("Profil fotoğrafı okunamadı")?;
    Ok(Id(*blake3::hash(bytes).as_bytes()))
}

pub(crate) fn shares_space(st: &St, me: Id, remote: Id) -> bool {
    me == remote
        || st
            .spaces
            .values()
            .any(|log| log.state.is_member(&me) && log.state.is_member(&remote))
}

fn connected(st: &St, me: Id, remote: Id, conn: &Connection) -> bool {
    st.peers.get(&remote).is_some_and(|peer| {
        peer.conn.stable_id() == conn.stable_id()
            && peer.joining.is_none()
            && peer.spaces.iter().any(|space| {
                st.spaces
                    .get(space)
                    .is_some_and(|log| log.state.is_member(&me) && log.state.is_member(&remote))
            })
    })
}

impl Node {
    pub fn update_profile(
        &self,
        name: &str,
        orb_color: u32,
        bio: &str,
        photo: PhotoEdit,
    ) -> Result<()> {
        let name = name.trim();
        let bio = bio.trim();
        op::check_name(name)?;
        validate_fields(orb_color, bio)?;
        let replacement = match &photo {
            PhotoEdit::Replace(encoded) => {
                ensure!(
                    encoded.len() <= MAX_PHOTO.div_ceil(3) * 4,
                    "Profil fotoğrafı çok büyük"
                );
                let bytes = BASE64
                    .decode(encoded.as_bytes())
                    .context("Geçersiz profil fotoğrafı")?;
                let hash = check_photo(&bytes)?;
                Some((hash, bytes))
            }
            _ => None,
        };
        let i = &self.0;
        let mut st = i.st.lock();
        let previous = st
            .profiles
            .get(&i.me)
            .map(|p| p.meta.clone())
            .unwrap_or_default();
        let mut meta = ProfileMeta {
            revision: previous.revision,
            orb_color,
            bio: bio.into(),
            photo: match photo {
                PhotoEdit::Keep => previous.photo,
                PhotoEdit::Remove => None,
                PhotoEdit::Replace(_) => replacement.as_ref().map(|(hash, _)| *hash),
            },
        };
        let changed = meta != previous;
        let name_changed = st.name != name;
        if !changed && !name_changed {
            return Ok(());
        }
        let photo_changed = meta.photo != previous.photo;
        if changed {
            meta.revision = meta
                .revision
                .checked_add(1)
                .context("Profil sürümü sınırına ulaşıldı")?;
        }
        i.store.put_profile(
            i.me,
            &meta,
            name_changed.then_some(name),
            replacement
                .as_ref()
                .filter(|_| photo_changed)
                .map(|(_, bytes)| bytes.as_slice()),
            photo_changed,
        )?;
        if name_changed {
            publish_name(i, &mut st, name);
        }
        st.profiles.insert(
            i.me,
            Profile {
                photo_ready: meta.photo.is_some(),
                meta,
            },
        );
        if changed {
            for &remote in st.peers.keys() {
                announce(i, &st, remote, false);
            }
        }
        drop(st);
        i.emit(Event::Changed);
        Ok(())
    }

    pub fn profile_photo(&self, member: Id, hash: Id) -> Result<String> {
        let i = &self.0;
        let st = i.st.lock();
        ensure!(shares_space(&st, i.me, member), "Profil görünmüyor");
        ensure!(
            st.profiles
                .get(&member)
                .is_some_and(|p| p.photo_ready && p.meta.photo == Some(hash)),
            "Profil fotoğrafı bulunamadı"
        );
        Ok(BASE64.encode(
            &i.store
                .profile_photo(member)?
                .context("Profil fotoğrafı bulunamadı")?,
        ))
    }
}

pub(crate) fn announce(i: &Arc<Inner>, st: &St, remote: Id, sync: bool) {
    let Some(peer) = st.peers.get(&remote) else {
        return;
    };
    if !connected(st, i.me, remote, &peer.conn) {
        return;
    }
    let meta = st.profiles.get(&i.me).map(|p| p.meta.clone());
    let packet = if sync {
        Some(Packet::Sync(meta))
    } else {
        meta.map(Packet::Meta)
    };
    if let Some(packet) = packet {
        send(i, remote, peer.conn.clone(), packet);
    }
}

fn send(i: &Arc<Inner>, remote: Id, conn: Connection, packet: Packet) {
    let rt = i.rt.clone();
    let i = Arc::downgrade(i);
    rt.spawn(async move {
        let _ = tokio::time::timeout(TIMEOUT, async {
            let bytes = postcard::to_stdvec(&packet)?;
            let mut stream = conn.open_uni().await?;
            let Some(i) = i.upgrade() else {
                return Ok::<(), anyhow::Error>(());
            };
            if !connected(&i.st.lock(), i.me, remote, &conn) {
                return Ok(());
            }
            drop(i);
            stream.write_all(&[TAG]).await?;
            stream.write_all(&bytes).await?;
            stream.finish()?;
            Ok(())
        })
        .await;
    });
}

pub(crate) async fn receive(
    i: &Arc<Inner>,
    conn: &Connection,
    r: &mut RecvStream,
    remote: Id,
) -> Result<()> {
    ensure!(
        connected(&i.st.lock(), i.me, remote, conn),
        "profile access denied"
    );
    let bytes = tokio::time::timeout(TIMEOUT, r.read_to_end(MAX_PACKET)).await??;
    let packet: Packet = postcard::from_bytes(&bytes)?;
    let mut st = i.st.lock();
    ensure!(connected(&st, i.me, remote, conn), "profile access denied");
    match packet {
        Packet::Sync(meta) => {
            if let Some(meta) = meta {
                accept(i, &mut st, conn, remote, meta)?;
            }
            announce(i, &st, remote, false);
        }
        Packet::Meta(meta) => accept(i, &mut st, conn, remote, meta)?,
        Packet::WantPhoto(hash) => {
            if st
                .profiles
                .get(&i.me)
                .is_some_and(|p| p.meta.photo == Some(hash))
                && let Some(bytes) = i.store.profile_photo(i.me)?
            {
                send(i, remote, conn.clone(), Packet::Photo { hash, bytes });
            }
        }
        Packet::Photo { hash, bytes } => {
            if !st
                .profiles
                .get(&remote)
                .is_some_and(|p| !p.photo_ready && p.meta.photo == Some(hash))
            {
                return Ok(());
            }
            drop(st);
            ensure!(check_photo(&bytes)? == hash, "profile photo hash mismatch");
            let mut st = i.st.lock();
            ensure!(connected(&st, i.me, remote, conn), "profile access denied");
            if let Some(profile) = st.profiles.get_mut(&remote)
                && !profile.photo_ready
                && profile.meta.photo == Some(hash)
            {
                i.store.put_profile_photo(remote, &bytes)?;
                profile.photo_ready = true;
                i.emit(Event::Changed);
            }
        }
    }
    Ok(())
}

fn accept(
    i: &Arc<Inner>,
    st: &mut St,
    conn: &Connection,
    remote: Id,
    meta: ProfileMeta,
) -> Result<()> {
    validate_fields(meta.orb_color, &meta.bio)?;
    let current = st.profiles.get(&remote);
    let revision = current.map_or(0, |p| p.meta.revision);
    if meta.revision < revision || meta.revision == 0 {
        return Ok(());
    }
    if meta.revision > revision {
        let same_photo = current.is_some_and(|p| p.meta.photo == meta.photo);
        let photo_ready = same_photo && current.is_some_and(|p| p.photo_ready);
        i.store
            .put_profile(remote, &meta, None, None, !same_photo)?;
        st.profiles.insert(remote, Profile { meta, photo_ready });
        i.emit(Event::Changed);
    }
    if let Some(profile) = st.profiles.get(&remote)
        && !profile.photo_ready
        && let Some(hash) = profile.meta.photo
    {
        send(i, remote, conn.clone(), Packet::WantPhoto(hash));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn older_profile_revision_cannot_replace_latest() {
        let dir = tempfile::tempdir().unwrap();
        let (a, _a_events) = Node::start(&dir.path().join("a")).await.unwrap();
        let (b, _b_events) = Node::start(&dir.path().join("b")).await.unwrap();
        a.update_profile("Ayşe", 0x414141, "İlk", PhotoEdit::Keep)
            .unwrap();
        let first = a.0.st.lock().profiles[&a.id()].meta.clone();
        let space = a.create_space("Profil").unwrap();
        b.join_space(&a.create_invite(space, None, None).unwrap())
            .await
            .unwrap();
        a.update_profile("Ayşe", 0x515151, "Son", PhotoEdit::Keep)
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while b
                .snapshot()
                .profiles
                .get(&a.id())
                .is_none_or(|p| p.bio != "Son")
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();

        {
            let mut st = b.0.st.lock();
            let conn = st.peers[&a.id()].conn.clone();
            accept(&b.0, &mut st, &conn, a.id(), first).unwrap();
        }
        assert_eq!(b.snapshot().profiles[&a.id()].orb_color, 0x515151);
        a.shutdown().await;
        b.shutdown().await;
    }
}
