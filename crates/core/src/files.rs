//! Attachments. A file is stored sealed in 64 KiB chunks under its own vault key (so purging
//! shreds it), travels over its own uni-streams, and is served only to peers that can read a
//! live message referencing it. Nothing is ever written to disk decrypted, except when the user
//! saves a file themselves.

use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use image_webp::WebPDecoder;
use iroh::endpoint::{Connection, RecvStream};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::api::Event;
use crate::id::Id;
use crate::msg::{self, FileRef};
use crate::node::{Inner, Node, St};
use crate::store::{CHUNK, FileMeta, Store};
use crate::vault::TAG as AEAD_TAG;

pub(crate) const TAG: u8 = b'F';
const IDLE: Duration = Duration::from_secs(20);
const MAX_HEADER: usize = 255;
/// Uploads we run at once for one peer; further requests queue.
pub(crate) const MAX_SERVING: usize = 2;
const QUEUE_WAIT: Duration = Duration::from_secs(120);
/// How long a source may take to start sending (includes its queue).
const START_WAIT: Duration = Duration::from_secs(150);
const MAX_INLINE_SIDE: u32 = 4096;
const PROGRESS_STEP: u64 = 512 * 1024;
const MB: u64 = 1024 * 1024;

/// What a space's trust level allows locally. Relay-required spaces are the untrusted tier.
pub struct Tier {
    pub max_file: u64,
    /// Images up to this size load inline without a click.
    pub auto_image: u64,
}

pub fn tier(relay_required: bool) -> Tier {
    if relay_required {
        Tier { max_file: 50 * MB, auto_image: 8 * MB }
    } else {
        Tier { max_file: 500 * MB, auto_image: 25 * MB }
    }
}

#[derive(Serialize, Deserialize)]
enum Packet {
    Want { space: Id, msg: Id, hash: Id },
    /// Followed by exactly `FileRef.size` raw bytes.
    Data { hash: Id },
    /// We can't or won't send it: ask someone else instead of waiting.
    Refuse { hash: Id },
}

/// Streams plain bytes into a sealed blob under a temp name; `finish` checks the hash and
/// moves it into place. Anything unfinished is reclaimed on abort or by the startup GC.
pub(crate) struct Writer {
    slot: u32,
    file: File,
    tmp: PathBuf,
    idx: u64,
    buf: Vec<u8>,
    hasher: blake3::Hasher,
    len: u64,
    max: u64,
    pub mime: String,
    pub name: String,
}

impl Writer {
    pub fn new(store: &Store, ram: bool, max: u64, name: String, mime: String) -> Result<Writer> {
        let r: [u8; 16] = rand::random();
        let tmp = store
            .blob_path(&Id::ZERO)
            .with_file_name(format!("tmp-{}", data_encoding::HEXLOWER.encode(&r)));
        let file = File::create(&tmp)?;
        Ok(Writer {
            slot: store.vault().alloc(ram)?,
            file,
            tmp,
            idx: 0,
            buf: Vec::with_capacity(CHUNK),
            hasher: blake3::Hasher::new(),
            len: 0,
            max,
            mime,
            name,
        })
    }

    pub fn push(&mut self, store: &Store, mut data: &[u8]) -> Result<()> {
        self.len += data.len() as u64;
        ensure!(self.len <= self.max, "dosya boyut sınırını aşıyor");
        self.hasher.update(data);
        while !data.is_empty() {
            let n = (CHUNK - self.buf.len()).min(data.len());
            self.buf.extend_from_slice(&data[..n]);
            data = &data[n..];
            if self.buf.len() == CHUNK {
                self.flush(store)?;
            }
        }
        Ok(())
    }

    fn flush(&mut self, store: &Store) -> Result<()> {
        let ct = store.vault().seal_chunk(self.slot, self.idx, &self.buf)?;
        self.file.write_all(&ct)?;
        self.buf.clear();
        self.idx += 1;
        Ok(())
    }

    /// Returns (hash, size, inline image size if it is a valid WebP).
    pub fn finish(mut self, store: &Store, expect: Option<Id>) -> Result<(Id, u64, Option<(u16, u16)>)> {
        let r = (|| {
            if !self.buf.is_empty() {
                self.flush(store)?;
            }
            ensure!(self.len > 0, "boş dosya");
            let hash = Id(*self.hasher.finalize().as_bytes());
            if let Some(e) = expect {
                ensure!(hash == e, "dosya bozuk geldi");
            }
            self.file.sync_all()?;
            Ok(hash)
        })();
        let hash = match r {
            Ok(h) => h,
            Err(e) => {
                self.abort(store);
                return Err(e);
            }
        };
        let existing = store.file(&hash)?;
        if let Some((_, m)) = &existing
            && m.done
        {
            // already stored (same bytes): keep that copy
            let image = m.image;
            self.abort(store);
            return Ok((hash, m.size, image));
        }
        drop(self.file);
        std::fs::rename(&self.tmp, store.blob_path(&hash))?;
        if let Some((old, _)) = existing {
            store.vault().shred(old)?;
        }
        let image = (self.mime == "image/webp")
            .then(|| read_all(store, &hash, self.slot, self.len, 32 * MB).ok())
            .flatten()
            .and_then(|b| check_webp(&b));
        store.file_set(&hash, self.slot, &FileMeta { size: self.len, done: true, image })?;
        Ok((hash, self.len, image))
    }

    pub fn abort(self, store: &Store) {
        let _ = store.vault().shred(self.slot);
        drop(self.file);
        let _ = std::fs::remove_file(&self.tmp);
    }
}

/// Decode the whole WebP with a memory-safe decoder before the webview ever sees it.
fn check_webp(b: &[u8]) -> Option<(u16, u16)> {
    let mut d = WebPDecoder::new(Cursor::new(b)).ok()?;
    let (w, h) = d.dimensions();
    if w == 0 || h == 0 || w > MAX_INLINE_SIDE || h > MAX_INLINE_SIDE || d.is_animated() {
        return None;
    }
    d.set_memory_limit((MAX_INLINE_SIDE * MAX_INLINE_SIDE * 4) as usize + 1024);
    let mut out = vec![0; d.output_buffer_size()?];
    d.read_image(&mut out).ok()?;
    Some((w as u16, h as u16))
}

fn read_chunk(store: &Store, f: &mut File, slot: u32, size: u64, idx: u64) -> Result<Vec<u8>> {
    let n = (size - idx * CHUNK as u64).min(CHUNK as u64) as usize;
    f.seek(SeekFrom::Start(idx * (CHUNK + AEAD_TAG) as u64))?;
    let mut ct = vec![0; n + AEAD_TAG];
    f.read_exact(&mut ct)?;
    store.vault().open_chunk(slot, idx, &ct)
}

fn chunks(size: u64) -> u64 {
    size.div_ceil(CHUNK as u64)
}

fn read_all(store: &Store, hash: &Id, slot: u32, size: u64, max: u64) -> Result<Vec<u8>> {
    ensure!(size <= max, "dosya burada gösterilemeyecek kadar büyük");
    let mut f = File::open(store.blob_path(hash))?;
    let mut out = Vec::with_capacity(size as usize);
    for i in 0..chunks(size) {
        out.extend(read_chunk(store, &mut f, slot, size, i)?);
    }
    Ok(out)
}

/// Best guess from the extension; only `image/webp` ever means anything to the UI.
pub fn mime_of(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("webp") => "image/webp",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("pdf") => "application/pdf",
        Some("txt" | "md" | "log") => "text/plain",
        Some("zip") => "application/zip",
        Some("mp4") => "video/mp4",
        Some("mp3") => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// Replace whatever would make a received name unsafe to show or save.
pub fn safe_name(n: &str) -> String {
    if msg::check_file_name(n).is_ok() {
        return n.to_string();
    }
    let mut s: String = n
        .chars()
        .filter(|c| !matches!(*c as u32, 0x200e | 0x200f | 0x202a..=0x202e | 0x2066..=0x2069))
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .take(100)
        .collect();
    s = s.trim().trim_end_matches('.').to_string();
    if msg::check_file_name(&s).is_err() {
        s = format!("dosya_{s}");
    }
    if msg::check_file_name(&s).is_err() { "dosya".into() } else { s }
}

/// Live content message + its channel + the referenced file, if `who` may read it.
fn lookup(i: &Inner, st: &St, who: &Id, space: Id, msg: Id, hash: Id) -> Result<(FileRef, bool, bool)> {
    let log = st.spaces.get(&space).context("halka yok")?;
    let m = i.store.msg_view(&msg)?.context("mesaj yok")?;
    ensure!(m.msg.space == space, "mesaj yok");
    ensure!(log.state.can_view(who, &m.msg.channel), "bu kanalı göremezsin");
    let f = m.files.iter().find(|f| f.hash == hash).cloned().context("dosya yok")?;
    let ram = m.expires.is_some() && log.state.relay_required;
    Ok((f, ram, log.state.relay_required))
}

impl Node {
    /// Start an upload of a local attachment; bytes follow via `attach_chunk`.
    pub fn attach_begin(&self, space: Id, name: &str, size: u64) -> Result<u32> {
        let i = &self.0;
        let name = safe_name(name.trim());
        let max = {
            let st = i.st.lock();
            let log = st.spaces.get(&space).context("halka yok")?;
            tier(log.state.relay_required).max_file
        };
        ensure!(size > 0, "boş dosya gönderilemez");
        ensure!(size <= max, "bu halkada dosyalar en fazla {} MB olabilir", max / MB);
        let w = Writer::new(&i.store, false, size, name.clone(), mime_of(&name).into())?;
        let mut st = i.st.lock();
        st.next_upload = st.next_upload.wrapping_add(1);
        let h = st.next_upload;
        st.uploads.insert(h, w);
        Ok(h)
    }

    pub fn attach_chunk(&self, handle: u32, bytes: &[u8]) -> Result<()> {
        let i = &self.0;
        let mut st = i.st.lock();
        let w = st.uploads.get_mut(&handle).context("yükleme yok")?;
        if let Err(e) = w.push(&i.store, bytes) {
            if let Some(w) = st.uploads.remove(&handle) {
                w.abort(&i.store);
            }
            return Err(e);
        }
        Ok(())
    }

    pub fn attach_end(&self, handle: u32) -> Result<FileRef> {
        let i = &self.0;
        let w = i.st.lock().uploads.remove(&handle).context("yükleme yok")?;
        let (name, mime) = (w.name.clone(), w.mime.clone());
        let (hash, size, image) = w.finish(&i.store, None)?;
        let f = FileRef { hash, size, name, mime, image };
        i.st.lock().staged.insert(hash, f.clone());
        Ok(f)
    }

    pub fn attach_cancel(&self, handle: u32) {
        let i = &self.0;
        if let Some(w) = i.st.lock().uploads.remove(&handle) {
            w.abort(&i.store);
        }
    }

    /// The user removed a finished attachment before sending: shred it unless a message uses it.
    pub fn attach_discard(&self, hash: Id) -> Result<()> {
        let i = &self.0;
        if i.st.lock().staged.remove(&hash).is_some() && i.store.file_refs(&hash)?.is_empty() {
            i.store.file_drop(&hash)?;
        }
        Ok(())
    }

    /// Decrypted bytes of a stored, validated inline image (for a Blob URL in the UI).
    pub fn file_bytes(&self, space: Id, msg: Id, hash: Id) -> Result<Vec<u8>> {
        let i = &self.0;
        let (f, _, _) = lookup(i, &i.st.lock(), &i.me, space, msg, hash)?;
        let (slot, meta) = i.store.file(&hash)?.filter(|(_, m)| m.done).context("dosya henüz inmedi")?;
        ensure!(meta.image.is_some() && f.image == meta.image, "görsel doğrulanamadı");
        read_all(&i.store, &hash, slot, meta.size, 32 * MB)
    }

    /// Is the file fully here? (for the UI to decide between download and save)
    pub fn file_ready(&self, hash: Id) -> bool {
        self.0.store.file(&hash).ok().flatten().is_some_and(|(_, m)| m.done)
    }

    /// Download a message's file from the author or anyone else in the channel.
    pub fn fetch_file(&self, space: Id, msg: Id, hash: Id) -> Result<()> {
        let i = &self.0;
        let (f, ram, relay, sources) = {
            let st = i.st.lock();
            let (f, ram, relay) = lookup(i, &st, &i.me, space, msg, hash)?;
            let author = i.store.msg_view(&msg)?.context("mesaj yok")?.msg.author;
            let channel = i.store.msg_view(&msg)?.context("mesaj yok")?.msg.channel;
            let log = &st.spaces[&space];
            let mut sources: Vec<Id> = st
                .peers
                .iter()
                .filter(|(m, p)| {
                    p.joining.is_none() && p.spaces.contains(&space) && log.state.can_view(m, &channel)
                })
                .map(|(m, _)| *m)
                .collect();
            sources.sort_by_key(|m| *m != author);
            (f, ram, relay, sources)
        };
        if self.file_ready(hash) {
            return Ok(());
        }
        ensure!(f.size <= tier(relay).max_file, "bu halkada bu boyutta dosya alınmaz");
        ensure!(!sources.is_empty(), "dosyayı gönderebilecek kimse çevrimiçi değil");
        {
            let mut st = i.st.lock();
            if !st.fetching.insert(hash) {
                return Ok(());
            }
        }
        let weak = Arc::downgrade(&self.0);
        i.rt.spawn(async move {
            let mut ok = false;
            for src in sources {
                let Some(i) = weak.upgrade() else { return };
                let (tx, mut rx) = oneshot::channel();
                let (started_tx, started) = oneshot::channel();
                let conn = {
                    let mut st = i.st.lock();
                    let Some(p) = st.peers.get(&src) else { continue };
                    let conn = p.conn.clone();
                    st.downloads.insert(
                        (src, hash),
                        Download { f: f.clone(), ram, done: Some(tx), started: Some(started_tx) },
                    );
                    conn
                };
                let sent = match send_packet(&conn, &Packet::Want { space, msg, hash }).await {
                    Ok(mut s) => s.finish().is_ok(),
                    Err(_) => false,
                };
                drop(i);
                let r = if sent {
                    // a busy source queues us; one that never answers (or refuses) is skipped
                    let early = tokio::select! {
                        s = tokio::time::timeout(START_WAIT, started) => match s {
                            Ok(Ok(())) => None,
                            _ => Some(Err(anyhow::anyhow!("source did not start"))),
                        },
                        // refused, or a small file that finished before we looked
                        r = &mut rx => Some(r.unwrap_or_else(|_| Err(anyhow::anyhow!("dropped")))),
                    };
                    match early {
                        None => tokio::time::timeout(Duration::from_secs(30 * 60), rx).await,
                        Some(res) => Ok(Ok(res)),
                    }
                } else {
                    Ok(Ok(Err(anyhow::anyhow!("send failed"))))
                };
                let Some(i) = weak.upgrade() else { return };
                i.st.lock().downloads.remove(&(src, hash));
                match r {
                    Ok(Ok(Ok(()))) => {
                        ok = true;
                        break;
                    }
                    Ok(Ok(Err(e))) => tracing::debug!("file from {src:?} failed: {e:#}"),
                    _ => tracing::debug!("file from {src:?} timed out"),
                }
            }
            if let Some(i) = weak.upgrade() {
                i.st.lock().fetching.remove(&hash);
                if !ok {
                    i.notice(true, "Dosya indirilemedi");
                    i.emit(Event::FileProgress { hash, have: 0, size: 0 });
                }
            }
        });
        Ok(())
    }

    /// Decrypt a downloaded file into the user's Downloads folder, marked as coming from the
    /// internet (Mark of the Web) so Windows SmartScreen checks it before it runs.
    pub fn save_file(&self, space: Id, msg: Id, hash: Id, dir: &Path) -> Result<PathBuf> {
        let i = &self.0;
        let (f, _, _) = lookup(i, &i.st.lock(), &i.me, space, msg, hash)?;
        let (slot, meta) = i.store.file(&hash)?.filter(|(_, m)| m.done).context("dosya henüz inmedi")?;
        let name = safe_name(&f.name);
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
            _ => (name.clone(), String::new()),
        };
        let mut path = dir.join(&name);
        let mut out = None;
        for n in 1..1000 {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    out = Some(file);
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    path = dir.join(format!("{stem} ({n}){ext}"));
                }
                Err(e) => return Err(e.into()),
            }
        }
        let mut out = out.context("dosya kaydedilemedi")?;
        let r = (|| {
            let mut src = File::open(i.store.blob_path(&hash))?;
            for c in 0..chunks(meta.size) {
                out.write_all(&read_chunk(&i.store, &mut src, slot, meta.size, c)?)?;
            }
            out.sync_all()?;
            Ok::<(), anyhow::Error>(())
        })();
        if let Err(e) = r {
            drop(out);
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
        #[cfg(windows)]
        {
            let mut ads = path.clone().into_os_string();
            ads.push(":Zone.Identifier");
            let _ = std::fs::write(ads, "[ZoneTransfer]\r\nZoneId=3\r\n");
        }
        Ok(path)
    }
}

pub(crate) struct Download {
    f: FileRef,
    ram: bool,
    done: Option<oneshot::Sender<Result<()>>>,
    started: Option<oneshot::Sender<()>>,
}

/// Re-seal a staged file under a RAM key (timed message in a relay-required space).
pub(crate) fn move_to_ram(i: &Inner, hash: &Id) -> Result<()> {
    let (slot, meta) = i.store.file(hash)?.filter(|(_, m)| m.done).context("dosya yok")?;
    if slot & crate::vault::RAM != 0 {
        return Ok(());
    }
    let mut w = Writer::new(&i.store, true, meta.size, String::new(), String::new())?;
    let mut src = File::open(i.store.blob_path(hash))?;
    for c in 0..chunks(meta.size) {
        let plain = read_chunk(&i.store, &mut src, slot, meta.size, c)?;
        if let Err(e) = w.push(&i.store, &plain) {
            w.abort(&i.store);
            return Err(e);
        }
    }
    drop(src);
    // finish() would see the done copy and keep it, so swap it in by hand
    if !w.buf.is_empty() {
        w.flush(&i.store)?;
    }
    w.file.sync_all()?;
    let Writer { slot: new, file, tmp, .. } = w;
    drop(file);
    std::fs::rename(&tmp, i.store.blob_path(hash))?;
    i.store.file_set(hash, new, &FileMeta { done: true, ..meta })?;
    i.store.vault().shred(slot)?;
    Ok(())
}

async fn send_packet(conn: &Connection, p: &Packet) -> Result<iroh::endpoint::SendStream> {
    let b = postcard::to_stdvec(p)?;
    ensure!(b.len() <= u8::MAX as usize, "header too large");
    let mut s = conn.open_uni().await?;
    s.write_all(&[TAG, b.len() as u8]).await?;
    s.write_all(&b).await?;
    Ok(s)
}

/// One incoming `F` stream: a request for one of our files, or the file we asked for.
pub(crate) async fn receive(i: &Arc<Inner>, conn: &Connection, r: &mut RecvStream, remote: Id) -> Result<()> {
    let mut len = [0u8; 1];
    tokio::time::timeout(IDLE, r.read_exact(&mut len)).await??;
    let len = len[0] as usize;
    ensure!(len <= MAX_HEADER, "bad header");
    let mut h = vec![0u8; len];
    tokio::time::timeout(IDLE, r.read_exact(&mut h)).await??;
    match postcard::from_bytes::<Packet>(&h)? {
        Packet::Want { space, msg, hash } => serve(i, conn, remote, space, msg, hash).await,
        Packet::Data { hash } => download(i, r, remote, hash).await,
        Packet::Refuse { hash } => {
            if let Some(d) = i.st.lock().downloads.get_mut(&(remote, hash))
                && let Some(done) = d.done.take()
            {
                let _ = done.send(Err(anyhow::anyhow!("refused")));
            }
            Ok(())
        }
    }
}

async fn serve(i: &Arc<Inner>, conn: &Connection, remote: Id, space: Id, msg: Id, hash: Id) -> Result<()> {
    let checked = (|| {
        let mut st = i.st.lock();
        let p = st.peers.get(&remote).context("not connected")?;
        ensure!(
            p.conn.stable_id() == conn.stable_id() && p.joining.is_none() && p.spaces.contains(&space),
            "file access denied"
        );
        lookup(i, &st, &remote, space, msg, hash)?;
        let (slot, meta) = i.store.file(&hash)?.filter(|(_, m)| m.done).context("no file")?;
        let gate = st
            .serving
            .entry(remote)
            .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(MAX_SERVING)))
            .clone();
        Ok((slot, meta.size, gate))
    })();
    let (slot, size, gate) = match checked {
        Ok(v) => v,
        Err(e) => {
            if let Ok(mut s) = send_packet(conn, &Packet::Refuse { hash }).await {
                let _ = s.finish();
            }
            return Err(e);
        }
    };
    // more requests than upload slots wait their turn instead of failing
    let Ok(Ok(_permit)) = tokio::time::timeout(QUEUE_WAIT, gate.acquire_owned()).await else {
        if let Ok(mut s) = send_packet(conn, &Packet::Refuse { hash }).await {
            let _ = s.finish();
        }
        bail!("upload queue full");
    };
    async {
        let mut s = send_packet(conn, &Packet::Data { hash }).await?;
        let mut f = File::open(i.store.blob_path(&hash))?;
        for c in 0..chunks(size) {
            let plain = read_chunk(&i.store, &mut f, slot, size, c)?;
            tokio::time::timeout(IDLE, s.write_all(&plain)).await??;
            if c % 64 == 0 && i.store.msg_view(&msg)?.is_none() {
                bail!("message gone mid-transfer");
            }
        }
        s.finish()?;
        Ok(())
    }
    .await
}

async fn download(i: &Arc<Inner>, r: &mut RecvStream, remote: Id, hash: Id) -> Result<()> {
    // only streams we asked this peer for, at the size the signed message promised
    let (f, ram, done) = {
        let mut st = i.st.lock();
        let d = st.downloads.get_mut(&(remote, hash)).context("unrequested file")?;
        if let Some(s) = d.started.take() {
            let _ = s.send(());
        }
        (d.f.clone(), d.ram, d.done.take().context("duplicate file stream")?)
    };
    let res = async {
        let mut w = Writer::new(&i.store, ram, f.size, String::new(), f.mime.clone())?;
        let mut buf = vec![0u8; CHUNK];
        let mut last = 0;
        let r = async {
            loop {
                match tokio::time::timeout(IDLE, r.read(&mut buf)).await?? {
                    None => break,
                    Some(n) => w.push(&i.store, &buf[..n])?,
                }
                if w.len - last >= PROGRESS_STEP {
                    last = w.len;
                    i.emit(Event::FileProgress { hash, have: w.len, size: f.size });
                }
            }
            ensure!(w.len == f.size, "dosya eksik geldi");
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(e) = r {
            w.abort(&i.store);
            return Err(e);
        }
        w.finish(&i.store, Some(hash))?;
        // the message may have been deleted or expired while we were downloading
        if i.store.file_refs(&hash)?.is_empty() {
            i.store.file_drop(&hash)?;
            bail!("message gone");
        }
        i.emit(Event::FileProgress { hash, have: f.size, size: f.size });
        Ok(())
    }
    .await;
    let out = match &res {
        Ok(()) => Ok(()),
        Err(e) => Err(anyhow::anyhow!("{e:#}")),
    };
    let _ = done.send(out);
    res
}
