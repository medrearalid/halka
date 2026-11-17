//! The node: owns identity, storage, the iroh endpoint and all spaces, and exposes the
//! command surface used by the shell. Connection handling lives in `net.rs`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Arc, Weak};

use anyhow::{Context, Result, bail, ensure};
use iroh::address_lookup::MemoryLookup;
use iroh::endpoint::{Connection, presets};
use iroh::{Endpoint, RelayMode};
use parking_lot::{Mutex, RwLock};
use tokio::sync::{mpsc, oneshot};

use crate::api::{self, ConnKind, Event, Settings, Snapshot};
use crate::id::{self, Id};
use crate::invite::InviteCode;
use crate::msg::{self, Msg, MsgBody, SignedMsg};
use crate::op::{self, ChannelKind, OpBody, SignedOp};
use crate::perm::Perms;
use crate::space::{SpaceLog, create_genesis};
use crate::store::{Store, StoredMsg};
use crate::voice::{Voice, VoiceOptions};
use crate::wire::{self, Frame, Presence};

pub type StreamSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

pub(crate) struct Peer {
    pub conn: Connection,
    pub tx: mpsc::Sender<Frame>,
    /// Spaces this connection may talk about (both sides members).
    pub spaces: BTreeSet<Id>,
    /// Remote is joining this space with an invite and isn't a member yet.
    pub joining: Option<Id>,
    /// Who dialed (for deterministic duplicate-connection resolution).
    pub dialer: Id,
}

pub(crate) struct MyVoice {
    pub space: Id,
    pub channel: Id,
    pub muted: bool,
    pub deafened: bool,
    pub streaming: bool,
    pub engine: Option<Voice>,
}

pub(crate) struct Watcher {
    pub tx: mpsc::Sender<(std::time::Instant, Arc<Vec<u8>>)>,
    pub skipping: bool,
}

pub(crate) struct PendingJoin {
    pub invite: iroh::SecretKey,
    pub done: Option<oneshot::Sender<Result<()>>>,
}

pub(crate) struct St {
    pub name: String,
    pub settings: Settings,
    pub spaces: BTreeMap<Id, SpaceLog>,
    pub peers: HashMap<Id, Peer>,
    /// (space, member) -> remote voice presence
    pub presence: HashMap<(Id, Id), Presence>,
    pub voice: Option<MyVoice>,
    pub joins: HashMap<Id, PendingJoin>,
    pub watchers: HashMap<Id, Watcher>,
    pub stream_config: Option<Arc<Vec<u8>>>,
    pub watching: HashMap<Id, (StreamSink, Arc<std::sync::atomic::AtomicU64>)>,
    pub online: bool,
    /// Local mic test outside rooms (settings meter); sends nothing.
    pub mic_test: Option<Voice>,
}

pub(crate) struct Inner {
    pub key: iroh::SecretKey,
    pub me: Id,
    pub store: Store,
    pub ep: Endpoint,
    pub ev: mpsc::UnboundedSender<Event>,
    pub st: Mutex<St>,
    /// Connections that should receive our voice datagrams.
    pub voice_targets: RwLock<Vec<Connection>>,
    pub last_keyframe: Mutex<std::time::Instant>,
    pub last_congestion: Mutex<std::time::Instant>,
    /// Commands may run on a non-runtime thread (Tauri sync commands): spawn through this.
    pub rt: tokio::runtime::Handle,
}

#[derive(Clone)]
pub struct Node(pub(crate) Arc<Inner>);

impl Inner {
    pub fn emit(&self, e: Event) {
        if matches!(e, Event::StreamCongested) {
            let mut last = self.last_congestion.lock();
            if last.elapsed() < std::time::Duration::from_millis(1500) {
                return;
            }
            *last = std::time::Instant::now();
        }
        if matches!(e, Event::StreamKeyframe) {
            // watchers can ask for key frames; never let them turn the encoder into all-intra
            let mut last = self.last_keyframe.lock();
            if last.elapsed() < std::time::Duration::from_millis(700) {
                return;
            }
            *last = std::time::Instant::now();
        }
        let _ = self.ev.send(e);
    }
    pub fn notice(&self, error: bool, text: impl Into<String>) {
        self.emit(Event::Notice {
            error,
            text: text.into(),
        });
    }
}

impl Node {
    pub async fn start(data_dir: &Path) -> Result<(Node, mpsc::UnboundedReceiver<Event>)> {
        std::fs::create_dir_all(data_dir)?;
        let store = Store::open(&data_dir.join("halka.redb"))?;
        let key = crate::identity::load_or_create(&store)?;
        let me: Id = key.public().into();
        let settings: Settings = store
            .meta("settings")?
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let name = store
            .meta("name")?
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();

        let mut spaces = BTreeMap::new();
        for (sid, ops) in store.load_spaces()? {
            let Some(g) = ops.iter().find(|o| o.id() == sid).cloned() else {
                continue;
            };
            let mut log = SpaceLog::new(g)?;
            log.insert_many(ops);
            if log.state.is_member(&me) {
                spaces.insert(sid, log);
            }
        }

        let lookup = MemoryLookup::new();
        for (m, addr) in store.peer_addrs()? {
            if let Ok(a) = postcard::from_bytes::<iroh::EndpointAddr>(&addr)
                && Id::from(a.id) == m
            {
                lookup.add_endpoint_info(a);
            }
        }
        let custom = settings.relay_only || !settings.relays.is_empty();
        let ep = match bind(&key, &lookup, &settings).await {
            Ok(ep) => ep,
            // a bad privacy/relay setting must never brick the app: fall back to defaults
            Err(e) if custom => {
                tracing::warn!("bind with custom network settings failed: {e:#}");
                bind(&key, &lookup, &Settings::default())
                    .await
                    .context("ağ başlatılamadı")?
            }
            Err(e) => return Err(e.context("ağ başlatılamadı")),
        };

        let (tx, rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            key,
            me,
            store,
            ep,
            ev: tx,
            st: Mutex::new(St {
                name,
                settings,
                spaces,
                peers: HashMap::new(),
                presence: HashMap::new(),
                voice: None,
                joins: HashMap::new(),
                watchers: HashMap::new(),
                stream_config: None,
                watching: HashMap::new(),
                online: false,
                mic_test: None,
            }),
            voice_targets: RwLock::new(Vec::new()),
            rt: tokio::runtime::Handle::current(),
            last_congestion: Mutex::new(std::time::Instant::now()),
            last_keyframe: Mutex::new(
                std::time::Instant::now() - std::time::Duration::from_secs(5),
            ),
        });
        crate::net::spawn_background(&inner);
        Ok((Node(inner), rx))
    }

    pub fn id(&self) -> Id {
        self.0.me
    }

    pub async fn shutdown(&self) {
        {
            let mut st = self.0.st.lock();
            st.voice = None;
            st.mic_test = None;
            st.peers.clear();
            st.watchers.clear();
            st.watching.clear();
        }
        self.0.voice_targets.write().clear();
        self.0.ep.close().await;
    }

    // ------------------------------------------------------------------ snapshot

    pub fn snapshot(&self) -> Snapshot {
        let i = &self.0;
        let st = i.st.lock();
        let spaces = st
            .spaces
            .values()
            .map(|log| space_view(i, &st, log))
            .collect();
        Snapshot {
            me: api::Me {
                id: i.me,
                name: st.name.clone(),
                code: api::safety_code(&i.me),
            },
            spaces,
            settings: st.settings.clone(),
            voice: st.voice.as_ref().map(|v| api::MyVoice {
                space: v.space,
                channel: v.channel,
                muted: v.muted,
                deafened: v.deafened,
            }),
            online: st.online,
        }
    }

    // ------------------------------------------------------------------ identity

    pub fn set_name(&self, name: &str) -> Result<()> {
        let name = name.trim();
        op::check_name(name)?;
        let i = &self.0;
        i.store.set_meta("name", name.as_bytes())?;
        let mut st = i.st.lock();
        st.name = name.to_string();
        let ids: Vec<Id> = st.spaces.keys().copied().collect();
        for s in ids {
            if st.spaces[&s]
                .state
                .members
                .get(&i.me)
                .is_some_and(|m| m.name != name)
            {
                let _ = author(i, &mut st, s, OpBody::SetName { name: name.into() });
            }
        }
        drop(st);
        i.emit(Event::Changed);
        Ok(())
    }

    // ------------------------------------------------------------------ spaces

    pub fn create_space(&self, name: &str) -> Result<Id> {
        let i = &self.0;
        let name = name.trim();
        let g = create_genesis(&i.key, name)?;
        let mut log = SpaceLog::new(g.clone())?;
        let sid = log.id;
        let mut ops = vec![g];
        let my_name = i.st.lock().name.clone();
        let my_name = if my_name.is_empty() {
            "Kurucu".to_string()
        } else {
            my_name
        };
        for body in [
            OpBody::SetName { name: my_name },
            OpBody::CreateChannel {
                name: "genel".into(),
                kind: ChannelKind::Text,
                private_roles: None,
            },
            OpBody::CreateChannel {
                name: "Sohbet".into(),
                kind: ChannelKind::Voice,
                private_roles: None,
            },
        ] {
            ops.push(log.author(&i.key, body)?);
        }
        i.store.put_ops(&sid, &ops)?;
        i.st.lock().spaces.insert(sid, log);
        i.emit(Event::Changed);
        Ok(sid)
    }

    pub async fn join_space(&self, code: &str) -> Result<Id> {
        let i = self.0.clone();
        let c = InviteCode::decode(code)?;
        let key = c.key();
        let invite: Id = key.public().into();
        let find = |st: &St| {
            st.spaces
                .iter()
                .find(|(_, l)| l.state.invites.contains_key(&invite))
                .map(|(s, _)| *s)
        };
        {
            let st = i.st.lock();
            if let Some(s) = find(&st).filter(|s| st.spaces[s].state.is_member(&i.me)) {
                return Ok(s);
            }
        }
        ensure!(c.peer != i.me, "bu davet kodunu sen oluşturdun");
        let (done_tx, done_rx) = oneshot::channel();
        // filed under the invite key until the dialed member tells us the space (net::dial)
        i.st.lock().joins.insert(
            invite,
            PendingJoin {
                invite: key.clone(),
                done: Some(done_tx),
            },
        );
        let proof = id::sign(&key, op::DOMAIN_ADMIT, &op::join_proof_msg(&invite, &i.me));
        let req = wire::JoinReq { invite, proof };
        let dialer = i.clone();
        let peer = c.peer;
        tokio::spawn(async move {
            if let Err(e) = crate::net::dial(&dialer, peer, Some(req)).await {
                tracing::debug!("join dial failed: {e:#}");
                let mut st = dialer.st.lock();
                if let Some(d) = st
                    .joins
                    .values_mut()
                    .find(|j| Id::from(j.invite.public()) == invite)
                    .and_then(|j| j.done.take())
                {
                    let _ = d.send(Err(anyhow::anyhow!(
                        "davet edene ulaşılamadı; çevrimiçi olduğundan emin olup tekrar dene"
                    )));
                }
            }
        });
        let r = tokio::time::timeout(std::time::Duration::from_secs(45), done_rx).await;
        let mut st = i.st.lock();
        st.joins
            .retain(|_, j| Id::from(j.invite.public()) != invite);
        let sid = find(&st);
        if let Some(s) = sid.filter(|s| !st.spaces[s].state.is_member(&i.me)) {
            drop_space_locked(&i, &mut st, s);
        }
        match r {
            Ok(Ok(Ok(()))) => sid.context("halka bulunamadı"),
            Ok(Ok(Err(e))) => Err(e),
            _ => bail!("katılma zaman aşımına uğradı"),
        }
    }

    pub fn leave_space(&self, space: Id) -> Result<()> {
        let i = &self.0;
        let mut st = i.st.lock();
        let log = st.spaces.get(&space).context("halka yok")?;
        ensure!(log.state.owner != i.me, "kurucu halkadan ayrılamaz");
        author(i, &mut st, space, OpBody::Leave)?;
        if st.voice.as_ref().is_some_and(|v| v.space == space) {
            leave_voice_locked(i, &mut st);
        }
        drop_space_locked(i, &mut st, space);
        drop(st);
        i.emit(Event::Changed);
        Ok(())
    }

    /// Generic control-op command (rename, channels, roles, members, invites).
    pub fn op(&self, space: Id, body: OpBody) -> Result<Id> {
        let i = &self.0;
        let mut st = i.st.lock();
        let id = author(i, &mut st, space, body)?;
        crate::net::enforce_access(i, &mut st);
        drop(st);
        i.emit(Event::Changed);
        Ok(id)
    }

    pub fn create_invite(
        &self,
        space: Id,
        expires_in_ms: Option<u64>,
        max_uses: Option<u32>,
    ) -> Result<String> {
        let i = &self.0;
        let code = InviteCode::new(i.me);
        let inv = code.key();
        let expires = expires_in_ms.map(|ms| id::now_ms().saturating_add(ms));
        let mut st = i.st.lock();
        author(
            i,
            &mut st,
            space,
            OpBody::CreateInvite {
                key: inv.public().into(),
                expires,
                max_uses,
            },
        )?;
        drop(st);
        i.emit(Event::Changed);
        Ok(code.encode())
    }

    // ------------------------------------------------------------------ messages

    pub fn messages(
        &self,
        space: Id,
        channel: Id,
        before: Option<u64>,
        limit: usize,
    ) -> Result<Vec<api::MessageView>> {
        let i = &self.0;
        {
            let st = i.st.lock();
            let log = st.spaces.get(&space).context("halka yok")?;
            ensure!(log.state.can_view(&i.me, &channel), "bu kanalı göremezsin");
        }
        let page = i
            .store
            .page(&space, &channel, before, limit.clamp(1, 200))?;
        if before.is_none()
            && let Some(last) = page.last()
        {
            i.store.mark_read(&space, &channel, last.msg.ts)?;
            i.emit(Event::Changed);
        }
        Ok(page.into_iter().map(msg_view).collect())
    }

    pub fn send_message(
        &self,
        space: Id,
        channel: Id,
        text: &str,
        reply_to: Option<Id>,
    ) -> Result<Id> {
        msg::check_text(text)?;
        self.author_msg(
            space,
            channel,
            MsgBody::Text {
                text: text.to_string(),
                reply_to,
            },
        )
    }

    pub fn edit_message(&self, space: Id, message: Id, text: &str) -> Result<()> {
        msg::check_text(text)?;
        let t = self.0.store.msg_view(&message)?.context("mesaj yok")?;
        ensure!(
            t.msg.author == self.0.me,
            "yalnızca kendi mesajını düzenleyebilirsin"
        );
        self.author_msg(
            space,
            t.msg.channel,
            MsgBody::Edit {
                target: message,
                text: text.to_string(),
            },
        )
        .map(|_| ())
    }

    pub fn delete_message(&self, space: Id, message: Id) -> Result<()> {
        let t = self.0.store.msg_view(&message)?.context("mesaj yok")?;
        self.author_msg(space, t.msg.channel, MsgBody::Delete { target: message })
            .map(|_| ())
    }

    fn author_msg(&self, space: Id, channel: Id, body: MsgBody) -> Result<Id> {
        let i = &self.0;
        let m = Msg {
            space,
            channel,
            author: i.me,
            ts: id::now_ms(),
            body,
        };
        let s = SignedMsg::sign(&i.key, &m)?;
        let id = s.id();
        let mut st = i.st.lock();
        crate::net::ingest_msg(i, &mut st, None, s, true)?;
        Ok(id)
    }

    // ------------------------------------------------------------------ voice

    pub fn voice_join(&self, space: Id, channel: Id) -> Result<()> {
        let i = &self.0;
        let mut st = i.st.lock();
        let log = st.spaces.get(&space).context("halka yok")?;
        let c = log.state.channels.get(&channel).context("oda yok")?;
        ensure!(c.kind == ChannelKind::Voice, "bu bir sesli oda değil");
        ensure!(log.state.can_view(&i.me, &channel), "bu odaya giremezsin");
        let can_speak = log.state.can_in(&i.me, &channel, Perms::SPEAK);
        leave_voice_locked(i, &mut st);
        st.mic_test = None;
        let weak: Weak<Inner> = Arc::downgrade(&self.0);
        let send = Box::new(move |dg: Vec<u8>| {
            let Some(i) = weak.upgrade() else { return };
            let dg = bytes::Bytes::from(dg);
            for c in i.voice_targets.read().iter() {
                let _ = c.send_datagram(dg.clone());
            }
        });
        let opts = voice_opts(&st.settings);
        let engine = match Voice::start(&opts, send) {
            Ok(e) => Some(e),
            Err(e) => {
                i.notice(
                    true,
                    format!("Ses aygıtı açılamadı: {e:#}. Dinleyici olarak katıldın."),
                );
                None
            }
        };
        if let Some(e) = &engine {
            e.set_muted(!can_speak);
        }
        st.voice = Some(MyVoice {
            space,
            channel,
            muted: !can_speak,
            deafened: false,
            streaming: false,
            engine,
        });
        crate::net::voice_changed(i, &mut st);
        drop(st);
        i.emit(Event::Changed);
        Ok(())
    }

    pub fn voice_leave(&self) {
        let i = &self.0;
        let mut st = i.st.lock();
        leave_voice_locked(i, &mut st);
        drop(st);
        i.emit(Event::Changed);
    }

    pub fn set_muted(&self, muted: bool) -> Result<()> {
        let i = &self.0;
        let mut st = i.st.lock();
        let (space, channel) = st
            .voice
            .as_ref()
            .map(|v| (v.space, v.channel))
            .context("sesli odada değilsin")?;
        if !muted {
            ensure!(
                st.spaces[&space]
                    .state
                    .can_in(&i.me, &channel, Perms::SPEAK),
                "bu odada konuşma yetkin yok"
            );
        }
        let v = st.voice.as_mut().expect("checked");
        v.muted = muted;
        if let Some(e) = &v.engine {
            e.set_muted(muted);
        }
        crate::net::voice_changed(i, &mut st);
        drop(st);
        i.emit(Event::Changed);
        Ok(())
    }

    pub fn set_deafened(&self, deafened: bool) -> Result<()> {
        let i = &self.0;
        let mut st = i.st.lock();
        let v = st.voice.as_mut().context("sesli odada değilsin")?;
        v.deafened = deafened;
        if let Some(e) = &v.engine {
            e.set_deafened(deafened);
        }
        crate::net::voice_changed(i, &mut st);
        drop(st);
        i.emit(Event::Changed);
        Ok(())
    }

    /// Current voice levels (what the UI receives as `levels`), for tests and diagnostics.
    pub fn debug_levels(&self) -> Vec<(Id, f32)> {
        let st = self.0.st.lock();
        st.voice
            .as_ref()
            .and_then(|v| v.engine.as_ref())
            .map(|e| e.levels(self.0.me))
            .unwrap_or_default()
    }

    /// Unclamped received loudness of `member` in dBFS (diagnostics).
    pub fn debug_peer_db(&self, member: Id) -> Option<f32> {
        self.0
            .st
            .lock()
            .voice
            .as_ref()
            .and_then(|v| v.engine.as_ref())
            .and_then(|e| e.peer_db(member))
    }

    pub fn set_ptt(&self, down: bool) {
        if let Some(e) = self
            .0
            .st
            .lock()
            .voice
            .as_ref()
            .and_then(|v| v.engine.as_ref())
        {
            e.set_ptt(down);
        }
    }

    pub fn set_peer_volume(&self, member: Id, volume: f32) {
        if let Some(e) = self
            .0
            .st
            .lock()
            .voice
            .as_ref()
            .and_then(|v| v.engine.as_ref())
        {
            e.set_volume(member, volume);
        }
    }

    pub fn mic_test(&self, on: bool) -> Result<()> {
        let mut st = self.0.st.lock();
        st.mic_test = None; // close the device before reopening
        if on && st.voice.is_none() {
            let v = Voice::start(&voice_opts(&st.settings), Box::new(|_| {}))?;
            v.set_deafened(true); // no playback, no transmit
            st.mic_test = Some(v);
        }
        Ok(())
    }

    pub fn audio_devices(&self) -> api::AudioDevices {
        let (inputs, outputs) = crate::voice::devices();
        let st = self.0.st.lock();
        api::AudioDevices {
            inputs,
            outputs,
            input: st.settings.input.clone(),
            output: st.settings.output.clone(),
        }
    }

    pub fn set_audio_devices(&self, input: Option<String>, output: Option<String>) -> Result<()> {
        let mut s = self.settings();
        s.input = input;
        s.output = output;
        self.set_settings(s)?;
        // reopen devices if in a room
        let cur = self
            .0
            .st
            .lock()
            .voice
            .as_ref()
            .map(|v| (v.space, v.channel, v.muted, v.deafened));
        if let Some((sp, ch, muted, deaf)) = cur {
            self.voice_join(sp, ch)?;
            let _ = self.set_muted(muted);
            let _ = self.set_deafened(deaf);
        }
        Ok(())
    }

    pub fn settings(&self) -> Settings {
        self.0.st.lock().settings.clone()
    }

    pub fn set_settings(&self, mut s: Settings) -> Result<()> {
        s.vad_threshold = s.vad_threshold.clamp(0.0, 1.0);
        s.relays.retain(|r| r.parse::<iroh::RelayUrl>().is_ok());
        s.relays.truncate(8);
        ensure!(s.ptt_key.len() <= 32, "geçersiz tuş");
        let i = &self.0;
        i.store.set_meta("settings", &serde_json::to_vec(&s)?)?;
        let mut st = i.st.lock();
        if let Some(e) = st.voice.as_ref().and_then(|v| v.engine.as_ref()) {
            e.apply(&voice_opts(&s));
        }
        st.settings = s;
        if st.voice.is_some() {
            crate::net::voice_changed(i, &mut st); // re-pan for the spatial audio switch
        }
        drop(st);
        i.emit(Event::Changed);
        Ok(())
    }

    // ------------------------------------------------------------------ screen share

    pub fn stream_start(&self) -> Result<()> {
        let i = &self.0;
        let mut st = i.st.lock();
        let v = st.voice.as_ref().context("önce bir sesli odaya katıl")?;
        ensure!(
            st.spaces[&v.space]
                .state
                .can_in(&i.me, &v.channel, Perms::STREAM),
            "bu odada yayın yetkin yok"
        );
        st.voice.as_mut().expect("checked").streaming = true;
        st.stream_config = None;
        crate::net::voice_changed(i, &mut st);
        drop(st);
        i.emit(Event::Changed);
        Ok(())
    }

    pub fn stream_packet(&self, pkt: Vec<u8>) -> Result<()> {
        ensure!(pkt.len() >= 9 && pkt.len() <= 4 * 1024 * 1024, "bad packet");
        let mut st = self.0.st.lock();
        ensure!(
            st.voice.as_ref().is_some_and(|v| v.streaming),
            "yayın yapmıyorsun"
        );
        let pkt = Arc::new(pkt);
        let now = std::time::Instant::now();
        if pkt[0] == 0 {
            st.stream_config = Some(pkt.clone());
        }
        let key = pkt[0] == 1;
        let mut want_key = false;
        for w in st.watchers.values_mut() {
            if w.skipping && !key && pkt[0] != 0 {
                continue;
            }
            match w.tx.try_send((now, pkt.clone())) {
                Ok(()) => w.skipping = false,
                Err(_) => {
                    w.skipping = true;
                    want_key = true;
                }
            }
        }
        drop(st);
        if want_key {
            self.0.emit(Event::StreamCongested);
            self.0.emit(Event::StreamKeyframe);
        }
        Ok(())
    }

    pub fn stream_stop(&self) {
        let i = &self.0;
        let mut st = i.st.lock();
        stop_stream_locked(&mut st);
        crate::net::voice_changed(i, &mut st);
        drop(st);
        i.emit(Event::Changed);
    }

    pub fn watch(&self, member: Id, sink: StreamSink) -> Result<()> {
        let i = &self.0;
        let mut st = i.st.lock();
        let v = st.voice.as_ref().context("önce sesli odaya katıl")?;
        let p = st
            .presence
            .get(&(v.space, member))
            .context("bu kişi odada değil")?;
        ensure!(
            p.channel == v.channel && p.streaming,
            "bu kişi şu an yayın yapmıyor"
        );
        let peer = st.peers.get(&member).context("bu kişiye bağlı değilsin")?;
        peer.tx
            .try_send(Frame::Watch { on: true })
            .ok()
            .context("bağlantı meşgul")?;
        st.watching.insert(member, (sink, Arc::new(0.into())));
        Ok(())
    }

    pub fn unwatch(&self, member: Id) {
        let mut st = self.0.st.lock();
        if st.watching.remove(&member).is_some()
            && let Some(p) = st.peers.get(&member)
        {
            let _ = p.tx.try_send(Frame::Watch { on: false });
        }
    }
}

// ---------------------------------------------------------------------- helpers

async fn bind(
    key: &iroh::SecretKey,
    lookup: &MemoryLookup,
    settings: &Settings,
) -> Result<Endpoint> {
    let mut b = Endpoint::builder(presets::N0)
        .secret_key(key.clone())
        .alpns(vec![wire::ALPN.to_vec()])
        .address_lookup(lookup.clone());
    let relays: Vec<iroh::RelayUrl> = settings
        .relays
        .iter()
        .filter_map(|u| u.parse().ok())
        .collect();
    if !relays.is_empty() {
        b = b.relay_mode(RelayMode::custom(relays));
    }
    if settings.relay_only {
        b = b.clear_ip_transports();
    } else {
        // LAN discovery: friends on the same network connect with no internet at all
        b = b.address_lookup(
            iroh_mdns_address_lookup::MdnsAddressLookup::builder().service_name("halka"),
        );
    }
    Ok(b.bind().await?)
}

pub(crate) fn voice_opts(s: &Settings) -> VoiceOptions {
    VoiceOptions {
        input: s.input.clone(),
        output: s.output.clone(),
        noise_suppression: s.noise_suppression,
        echo_cancellation: s.echo_cancellation,
        push_to_talk: s.push_to_talk,
        ptt_key: s.ptt_key.clone(),
        vad_threshold: s.vad_threshold,
    }
}

/// Author a control op, persist it and push it to peers.
pub(crate) fn author(i: &Inner, st: &mut St, space: Id, body: OpBody) -> Result<Id> {
    let log = st.spaces.get_mut(&space).context("halka yok")?;
    let s: SignedOp = log.author(&i.key, body)?;
    let id = s.id();
    i.store.put_ops(&space, std::slice::from_ref(&s))?;
    crate::net::broadcast(st, space, None, || Frame::Ops {
        space,
        ops: vec![s.clone()],
    });
    Ok(id)
}

pub(crate) fn stop_stream_locked(st: &mut St) {
    if let Some(v) = st.voice.as_mut() {
        v.streaming = false;
    }
    st.watchers.clear();
    st.stream_config = None;
}

pub(crate) fn leave_voice_locked(i: &Inner, st: &mut St) {
    if st.voice.is_none() {
        return;
    }
    stop_stream_locked(st);
    let watching: Vec<Id> = st.watching.keys().copied().collect();
    for m in watching {
        st.watching.remove(&m);
        i.emit(Event::StreamEnded(m));
    }
    let space = st.voice.as_ref().map(|v| v.space);
    st.voice = None;
    i.voice_targets.write().clear();
    if let Some(space) = space {
        crate::net::broadcast(st, space, None, || Frame::Presence { space, voice: None });
    }
}

pub(crate) fn drop_space_locked(i: &Inner, st: &mut St, space: Id) {
    st.spaces.remove(&space);
    st.presence.retain(|(s, _), _| *s != space);
    let _ = i.store.delete_space(&space);
    crate::net::enforce_access(i, st);
}

pub(crate) fn msg_view(m: StoredMsg) -> api::MessageView {
    api::MessageView {
        id: m.id,
        space: m.msg.space,
        channel: m.msg.channel,
        author: m.msg.author,
        ts: m.msg.ts,
        text: m.text,
        reply_to: m.reply_to,
        edited: m.edited,
        deleted: m.deleted,
    }
}

fn space_view(i: &Inner, st: &St, log: &SpaceLog) -> api::SpaceView {
    let s = &log.state;
    let me = i.me;
    let mut channels: Vec<_> = s
        .channels
        .iter()
        .filter(|(cid, _)| s.can_view(&me, cid))
        .collect();
    channels.sort_by_key(|(_, c)| c.order);
    let in_voice = |cid: &Id| -> (Vec<Id>, Vec<Id>) {
        let mut voice = Vec::new();
        let mut streams = Vec::new();
        if let Some(v) = st
            .voice
            .as_ref()
            .filter(|v| v.space == s.id && v.channel == *cid)
        {
            voice.push(me);
            if v.streaming {
                streams.push(me);
            }
        }
        for ((sp, m), p) in &st.presence {
            if *sp == s.id && p.channel == *cid && st.peers.contains_key(m) {
                voice.push(*m);
                if p.streaming {
                    streams.push(*m);
                }
            }
        }
        voice.sort();
        streams.sort();
        (voice, streams)
    };
    let channels = channels
        .into_iter()
        .map(|(cid, c)| {
            let (voice, streams) = if c.kind == ChannelKind::Voice {
                in_voice(cid)
            } else {
                (vec![], vec![])
            };
            api::ChannelView {
                id: *cid,
                name: c.name.clone(),
                kind: c.kind,
                private_roles: c
                    .private_roles
                    .as_ref()
                    .map(|r| r.iter().copied().collect()),
                voice,
                streams,
                unread: if c.kind == ChannelKind::Text {
                    i.store.unread(&s.id, cid, &me).unwrap_or(0)
                } else {
                    0
                },
            }
        })
        .collect();
    let mut roles: Vec<api::RoleView> = s
        .roles
        .iter()
        .map(|(id, r)| api::RoleView {
            id: *id,
            name: r.name.clone(),
            color: r.color,
            perms: r.perms.names(),
            rank: r.rank,
        })
        .collect();
    roles.sort_by_key(|r| std::cmp::Reverse(r.rank));
    let members = s
        .members
        .iter()
        .map(|(m, mm)| {
            let (online, conn, rtt) = if *m == me {
                (true, ConnKind::Me, None)
            } else if let Some(p) = st.peers.get(m).filter(|p| p.spaces.contains(&s.id)) {
                let (kind, rtt) = crate::net::path_info(&p.conn);
                (true, kind, rtt)
            } else {
                (false, ConnKind::None, None)
            };
            let voice = if *m == me {
                st.voice
                    .as_ref()
                    .filter(|v| v.space == s.id)
                    .map(|v| api::VoiceState {
                        channel: v.channel,
                        muted: v.muted,
                        deafened: v.deafened,
                        streaming: v.streaming,
                    })
            } else if online {
                st.presence.get(&(s.id, *m)).map(|p| api::VoiceState {
                    channel: p.channel,
                    muted: p.muted,
                    deafened: p.deafened,
                    streaming: p.streaming,
                })
            } else {
                None
            };
            api::MemberView {
                id: *m,
                name: mm.name.clone(),
                roles: mm.roles.iter().copied().collect(),
                is_owner: *m == s.owner,
                online,
                conn,
                rtt_ms: rtt,
                voice,
            }
        })
        .collect();
    api::SpaceView {
        id: s.id,
        name: s.name.clone(),
        owner: s.owner,
        my_perms: s.perms(&me).names(),
        channels,
        roles,
        members,
        bans: s.bans.iter().copied().collect(),
        invites: s
            .invites
            .iter()
            .map(|(k, v)| api::InviteView {
                id: *k,
                created_by: v.created_by,
                expires: v.expires,
                max_uses: v.max_uses,
                uses: v.uses,
            })
            .collect(),
    }
}
