//! Connections: admission gate, dialing, reconciliation, live fan-out, voice datagrams and
//! screen-share GOP streams.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use tokio::sync::mpsc;

use crate::api::{ConnKind, Event};
use crate::id::{self, Id};
use crate::msg::{self, MsgBody, SignedMsg};
use crate::node::{Inner, Peer, St, WatchPacket, Watcher, msg_view};
use crate::op::{self, OpBody, SignedOp};
use crate::perm::Perms;
use crate::wire::{self, Frame, MAX_FRAME, MAX_HELLO};

const OP_BUCKET: u64 = 32;
const MSG_BUCKET: u64 = 86_400_000;
const SEND_QUEUE: usize = 1024;
const RESYNC_EVERY: Duration = Duration::from_secs(90);
const MAX_OPS_PER_FRAME: usize = 256;
const MAX_MSGS_PER_FRAME: usize = 256;

/// Token bucket for per-peer flood protection.
struct Rate {
    tokens: f64,
    last: Instant,
    per_sec: f64,
    burst: f64,
}

impl Rate {
    fn new(per_sec: f64, burst: f64) -> Rate {
        Rate {
            tokens: burst,
            last: Instant::now(),
            per_sec,
            burst,
        }
    }
    fn allow(&mut self, cost: f64) -> bool {
        let now = Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * self.per_sec)
            .min(self.burst);
        self.last = now;
        if self.tokens >= cost {
            self.tokens -= cost;
            true
        } else {
            false
        }
    }
}

pub(crate) fn spawn_background(i: &Arc<Inner>) {
    // accept loop
    let a = i.clone();
    tokio::spawn(async move {
        // bound concurrent handshakes so strangers can't exhaust us with half-open connections
        let gate = Arc::new(tokio::sync::Semaphore::new(32));
        while let Some(inc) = a.ep.accept().await {
            let Ok(permit) = gate.clone().try_acquire_owned() else {
                inc.refuse();
                continue;
            };
            let a = a.clone();
            tokio::spawn(async move {
                if let Err(e) = accept(a, inc, permit).await {
                    tracing::debug!("incoming rejected: {e:#}");
                }
            });
        }
    });
    // online flag
    let o = i.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = o.ep.online() => {}
            _ = o.ep.closed() => return,
        }
        o.st.lock().online = true;
        o.emit(Event::Changed);
    });
    // dialer with per-member exponential backoff
    let d = i.clone();
    tokio::spawn(async move {
        let mut backoff: HashMap<Id, (Instant, Duration)> = HashMap::new();
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        loop {
            tick.tick().await;
            if d.ep.is_closed() {
                return; // releases Inner (and the database) after shutdown
            }
            let targets: Vec<Id> = {
                let st = d.st.lock();
                let mut t = BTreeSet::new();
                for log in st.spaces.values() {
                    t.extend(
                        log.state
                            .members
                            .keys()
                            .filter(|m| **m != d.me && !st.peers.contains_key(m))
                            .copied(),
                    );
                }
                t.into_iter().collect()
            };
            let now = Instant::now();
            for m in targets {
                let (next, wait) = backoff
                    .get(&m)
                    .copied()
                    .unwrap_or((now, Duration::from_secs(3)));
                if now < next {
                    continue;
                }
                backoff.insert(m, (now + wait, (wait * 2).min(Duration::from_secs(120))));
                let d = d.clone();
                tokio::spawn(async move {
                    let _ = dial(&d, m, None).await;
                });
            }
            backoff.retain(|m, _| !d.st.lock().peers.contains_key(m));
        }
    });
    // periodic: resync, voice levels, connection-quality refresh
    let p = i.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(50));
        let mut n: u64 = 0;
        loop {
            tick.tick().await;
            if p.ep.is_closed() {
                return;
            }
            n += 1;
            let levels = {
                let st = p.st.lock();
                st.voice
                    .as_ref()
                    .and_then(|v| v.engine.as_ref())
                    .or(st.mic_test.as_ref())
                    .map(|e| e.levels(p.me))
            };
            if let Some(l) = levels {
                p.emit(Event::Levels(l));
            }
            if n % 40 == 0 && !p.st.lock().peers.is_empty() {
                p.emit(Event::Changed); // rtt / path type updates
            }
            if n % (RESYNC_EVERY.as_millis() as u64 / 50) == 0 {
                let mut st = p.st.lock();
                let ids: Vec<Id> = st.peers.keys().copied().collect();
                for m in ids {
                    send_summaries(&p, &mut st, m);
                }
            }
        }
    });
}

pub(crate) fn remote_addr(c: &Connection) -> iroh::EndpointAddr {
    let mut a = iroh::EndpointAddr::new(c.remote_id());
    for p in c.paths().iter() {
        a.addrs.insert(p.remote_addr().clone());
    }
    a
}

pub(crate) fn path_info(c: &Connection) -> (ConnKind, Option<u32>) {
    match c.paths().iter().find(|p| p.is_selected()) {
        Some(p) => (
            if p.is_relay() {
                ConnKind::Relay
            } else {
                ConnKind::Direct
            },
            Some(p.rtt().as_millis() as u32),
        ),
        None => (ConnKind::Relay, None),
    }
}

/// Spaces where `m` is a member in our view.
fn shared_spaces(st: &St, m: &Id) -> Vec<Id> {
    st.spaces
        .iter()
        .filter(|(_, l)| l.state.is_member(m))
        .map(|(s, _)| *s)
        .collect()
}

pub(crate) async fn dial(i: &Arc<Inner>, m: Id, join: Option<wire::JoinReq>) -> Result<()> {
    let spaces = {
        let st = i.st.lock();
        if st.peers.contains_key(&m) && join.is_none() {
            return Ok(());
        }
        shared_spaces(&st, &m)
    };
    let conn = tokio::time::timeout(Duration::from_secs(15), i.ep.connect(m.key()?, wire::ALPN))
        .await
        .context("timeout")??;
    let (mut send, mut recv) = conn.open_bi().await?;
    wire::write_frame(
        &mut send,
        &Frame::Hello {
            spaces,
            join: join.clone(),
        },
    )
    .await?;
    let spaces = loop {
        match tokio::time::timeout(
            Duration::from_secs(10),
            wire::read_frame(&mut recv, MAX_FRAME),
        )
        .await??
        {
            Some(Frame::Welcome { spaces }) => break spaces,
            Some(Frame::Ops { space, ops }) if ops.len() <= MAX_OPS_PER_FRAME => {
                apply_removal_proof(i, space, ops)
            }
            _ => bail!("no welcome"),
        }
    };
    ensure!(!spaces.is_empty(), "remote shares no space with us");
    if let Some(j) = &join {
        ensure!(spaces.len() == 1, "join refused");
        // now we know which space the invite opens: file the pending join under it
        // before any of its ops can arrive
        let mut st = i.st.lock();
        if let Some(p) = st.joins.remove(&j.invite) {
            st.joins.insert(spaces[0], p);
        }
    }
    let i2 = i.clone();
    tokio::spawn(async move {
        run_peer(
            i2,
            conn,
            send,
            recv,
            spaces.into_iter().collect(),
            None,
            true,
        )
        .await
    });
    Ok(())
}

async fn accept(
    i: Arc<Inner>,
    inc: iroh::endpoint::Incoming,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<()> {
    let conn = tokio::time::timeout(Duration::from_secs(10), inc).await??;
    let remote: Id = conn.remote_id().into();
    ensure!(remote != i.me, "self");
    let (mut send, mut recv) =
        tokio::time::timeout(Duration::from_secs(5), conn.accept_bi()).await??;
    let hello = tokio::time::timeout(
        Duration::from_secs(5),
        wire::read_frame(&mut recv, MAX_HELLO),
    )
    .await??;
    let Some(Frame::Hello { spaces, join }) = hello else {
        bail!("expected hello")
    };
    let (allowed, joining) = {
        let st = i.st.lock();
        let mut allowed: Vec<Id> = spaces
            .iter()
            .filter(|s| st.spaces.get(s).is_some_and(|l| l.state.is_member(&remote)))
            .copied()
            .collect();
        allowed.truncate(256);
        let mut joining = None;
        if let Some(j) = join {
            let space = check_join(&st, &remote, &j)?;
            allowed = vec![space];
            joining = Some(space);
        }
        (allowed, joining)
    };
    if allowed.is_empty() {
        // An ex-member who missed their removal gets the proof, so they stop retrying.
        let proof = {
            let st = i.st.lock();
            spaces.iter().find_map(|s| {
                st.spaces
                    .get(s)
                    .and_then(|l| l.removal_proof(&remote))
                    .map(|ops| (*s, ops))
            })
        };
        if let Some((space, ops)) = proof {
            for chunk in ops.chunks(MAX_OPS_PER_FRAME) {
                wire::write_frame(
                    &mut send,
                    &Frame::Ops {
                        space,
                        ops: chunk.to_vec(),
                    },
                )
                .await?;
            }
            let _ = send.finish();
            let _ = tokio::time::timeout(Duration::from_secs(3), conn.closed()).await;
        }
        conn.close(1u32.into(), b"not a member");
        bail!("{remote:?} shares no space with us");
    }
    wire::write_frame(
        &mut send,
        &Frame::Welcome {
            spaces: allowed.clone(),
        },
    )
    .await?;
    drop(permit);
    run_peer(
        i,
        conn,
        send,
        recv,
        allowed.into_iter().collect(),
        joining,
        false,
    )
    .await;
    Ok(())
}

/// Ops a remote sent instead of a welcome: only ever useful if they prove we were removed.
fn apply_removal_proof(i: &Inner, space: Id, ops: Vec<SignedOp>) {
    let mut st = i.st.lock();
    let Some(log) = st.spaces.get_mut(&space) else {
        return;
    };
    let added = log.insert_many(ops);
    if added.is_empty() {
        return;
    }
    let new: Vec<SignedOp> = added
        .iter()
        .filter_map(|id| log.get(id))
        .map(|e| e.signed.clone())
        .collect();
    let _ = i.store.put_ops(&space, &new);
    if !log.state.is_member(&i.me) {
        let name = log.state.name.clone();
        if st.voice.as_ref().is_some_and(|v| v.space == space) {
            crate::node::leave_voice_locked(i, &mut st);
        }
        crate::node::drop_space_locked(i, &mut st, space);
        i.notice(true, format!("“{name}” halkasından çıkarıldın."));
        i.emit(Event::Changed);
    }
}

/// Admission check for an invite holder; returns the space the invite opens.
fn check_join(st: &St, joiner: &Id, j: &wire::JoinReq) -> Result<Id> {
    let log = st
        .spaces
        .values()
        .find(|l| l.state.invites.contains_key(&j.invite))
        .context("unknown invite")?;
    let s = &log.state;
    ensure!(!s.is_member(joiner), "already a member");
    ensure!(!s.bans.contains(joiner), "banned");
    let inv = s.invites.get(&j.invite).context("unknown invite")?;
    ensure!(inv.expires.is_none_or(|x| id::now_ms() <= x), "expired");
    ensure!(inv.max_uses.is_none_or(|m| inv.uses < m), "used up");
    ensure!(
        id::verify(
            &j.invite,
            op::DOMAIN_ADMIT,
            &op::join_proof_msg(&j.invite, joiner),
            &j.proof
        ),
        "bad proof"
    );
    Ok(log.id)
}

async fn run_peer(
    i: Arc<Inner>,
    conn: Connection,
    send: SendStream,
    recv: RecvStream,
    spaces: BTreeSet<Id>,
    joining: Option<Id>,
    we_dialed: bool,
) {
    let remote: Id = conn.remote_id().into();
    let dialer = if we_dialed { i.me } else { remote };
    let (tx, rx) = mpsc::channel(SEND_QUEUE);
    {
        let mut st = i.st.lock();
        if let Some(old) = st.peers.get(&remote) {
            // Two simultaneous connections: keep the one dialed by the smaller id.
            let keep_old = old.dialer == i.me.min(remote) || joining.is_some();
            if keep_old && old.conn.stable_id() != conn.stable_id() && joining.is_none() {
                conn.close(0u32.into(), b"duplicate");
                return;
            }
            old.conn.close(0u32.into(), b"replaced");
        }
        st.peers.insert(
            remote,
            Peer {
                conn: conn.clone(),
                tx,
                spaces,
                joining,
                dialer,
            },
        );
        let _ = i.store.put_peer_addr(
            &remote,
            &postcard::to_stdvec(&remote_addr(&conn)).unwrap_or_default(),
        );
        if let Some(sp) = joining {
            // a joiner needs the whole log first
            let ops: Vec<SignedOp> = st.spaces[&sp].entries().map(|e| e.signed.clone()).collect();
            send_ops(&st, remote, sp, ops);
        } else {
            send_summaries(&i, &mut st, remote);
            announce_presence(&st, remote);
            if !we_dialed {
                crate::profile::announce(&i, &st, remote, true);
            }
        }
        if st.voice.is_some() {
            voice_changed(&i, &mut st);
        }
    }
    i.emit(Event::Changed);

    let writer = tokio::spawn(write_loop(send, rx));
    let dg = tokio::spawn(datagram_loop(i.clone(), conn.clone(), remote));
    let uni = tokio::spawn(uni_loop(i.clone(), conn.clone(), remote));
    if let Err(e) = read_loop(&i, &conn, recv, remote).await {
        tracing::debug!("peer {remote:?}: {e:#}");
    }
    conn.close(0u32.into(), b"bye");
    writer.abort();
    dg.abort();
    uni.abort();

    let mut st = i.st.lock();
    if st
        .peers
        .get(&remote)
        .is_some_and(|p| p.conn.stable_id() == conn.stable_id())
    {
        st.peers.remove(&remote);
        st.presence.retain(|(_, m), _| *m != remote);
        st.watchers.remove(&remote);
        if st.watching.remove(&remote).is_some() {
            i.emit(Event::StreamEnded(remote));
        }
        if st.voice.is_some() {
            voice_changed(&i, &mut st);
        }
    }
    drop(st);
    i.emit(Event::Changed);
}

async fn write_loop(mut send: SendStream, mut rx: mpsc::Receiver<Frame>) {
    while let Some(f) = rx.recv().await {
        if wire::write_frame(&mut send, &f).await.is_err() {
            break;
        }
    }
    let _ = send.finish();
}

async fn read_loop(
    i: &Arc<Inner>,
    conn: &Connection,
    mut recv: RecvStream,
    remote: Id,
) -> Result<()> {
    let mut frames = Rate::new(400.0, 2000.0);
    let mut bytes = Rate::new(4.0 * 1024.0 * 1024.0, 16.0 * 1024.0 * 1024.0);
    // each ops frame triggers a replay; bound how hard one peer can make us work
    let mut op_frames = Rate::new(20.0, 200.0);
    let join_deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let f = tokio::select! {
            f = wire::read_frame(&mut recv, MAX_FRAME) => f?,
            _ = conn.closed() => return Ok(()),
        };
        let Some(f) = f else { return Ok(()) };
        let size = postcard::experimental::serialized_size(&f).unwrap_or(0) as f64;
        ensure!(
            frames.allow(1.0) && bytes.allow(size),
            "rate limit exceeded"
        );
        if matches!(f, Frame::Ops { .. }) {
            ensure!(op_frames.allow(1.0), "op rate limit exceeded");
        }
        let joining =
            i.st.lock()
                .peers
                .get(&remote)
                .is_some_and(|p| p.joining.is_some());
        if joining {
            ensure!(Instant::now() < join_deadline, "join took too long");
            if !matches!(f, Frame::Ops { .. }) {
                continue; // a joiner may only send its join op; ignore its early sync chatter
            }
        }
        handle(i, remote, f)?;
    }
}

fn peer_has(st: &St, remote: &Id, space: &Id) -> bool {
    st.peers
        .get(remote)
        .is_some_and(|p| p.spaces.contains(space))
}

fn send_to(st: &St, to: Id, f: Frame) {
    if let Some(p) = st.peers.get(&to)
        && p.tx.try_send(f).is_err()
    {
        // queue full: drop the connection; reconnect + reconciliation will repair state
        p.conn.close(2u32.into(), b"slow");
    }
}

fn send_ops(st: &St, to: Id, space: Id, mut ops: Vec<SignedOp>) {
    // parents first so the receiver can insert without parking
    ops.sort_by_key(|o| o.verify().map(|e| e.op.clock).unwrap_or(u64::MAX));
    for chunk in ops.chunks(MAX_OPS_PER_FRAME) {
        send_to(
            st,
            to,
            Frame::Ops {
                space,
                ops: chunk.to_vec(),
            },
        );
    }
}

/// Send to every connected member of `space` except `skip`.
pub(crate) fn broadcast(st: &St, space: Id, skip: Option<Id>, f: impl Fn() -> Frame) {
    let targets: Vec<Id> = st
        .peers
        .iter()
        .filter(|(m, p)| Some(**m) != skip && p.spaces.contains(&space) && p.joining.is_none())
        .map(|(m, _)| *m)
        .collect();
    for m in targets {
        send_to(st, m, f());
    }
}

fn op_items(st: &St, space: &Id) -> Vec<(u64, Id)> {
    st.spaces
        .get(space)
        .map(|l| l.entries().map(|e| (e.op.clock, e.id)).collect())
        .unwrap_or_default()
}

fn msg_items(i: &Inner, space: &Id, channel: &Id, from: u64, to: u64) -> Vec<(u64, Id)> {
    i.store
        .sync_items(space, channel, from, to)
        .unwrap_or_default()
}

/// Channels whose messages both we and `remote` may read.
fn shared_channels(i: &Inner, st: &St, space: &Id, remote: &Id) -> Vec<Id> {
    let Some(l) = st.spaces.get(space) else {
        return vec![];
    };
    l.state
        .channels
        .keys()
        .filter(|c| l.state.can_view(&i.me, c) && l.state.can_view(remote, c))
        .copied()
        .collect()
}

pub(crate) fn send_summaries(i: &Inner, st: &mut St, remote: Id) {
    let Some(p) = st.peers.get(&remote) else {
        return;
    };
    if p.joining.is_some() {
        return;
    }
    let spaces: Vec<Id> = p.spaces.iter().copied().collect();
    for s in spaces {
        let buckets = wire::summarize(op_items(st, &s), OP_BUCKET);
        send_to(st, remote, Frame::OpSummary { space: s, buckets });
        for c in shared_channels(i, st, &s, &remote) {
            let buckets = wire::summarize(msg_items(i, &s, &c, 0, u64::MAX), MSG_BUCKET);
            send_to(
                st,
                remote,
                Frame::MsgSummary {
                    space: s,
                    channel: c,
                    buckets,
                },
            );
        }
    }
}

fn announce_presence(st: &St, remote: Id) {
    if let Some(v) = &st.voice
        && peer_has(st, &remote, &v.space)
    {
        send_to(
            st,
            remote,
            Frame::Presence {
                space: v.space,
                voice: Some(my_presence(v)),
            },
        );
    }
}

fn my_presence(v: &crate::node::MyVoice) -> wire::Presence {
    wire::Presence {
        channel: v.channel,
        muted: v.muted,
        deafened: v.deafened,
        streaming: v.streaming,
    }
}

fn handle(i: &Arc<Inner>, remote: Id, f: Frame) -> Result<()> {
    let mut st = i.st.lock();
    match f {
        Frame::Hello { .. } | Frame::Welcome { .. } => bail!("unexpected handshake frame"),
        Frame::OpSummary { space, buckets } => {
            if !peer_has(&st, &remote, &space) {
                return Ok(());
            }
            let ours = op_items(&st, &space);
            let mine = wire::summarize(ours.iter().copied(), OP_BUCKET);
            for b in wire::diff(&mine, &buckets) {
                let ids = ours
                    .iter()
                    .filter(|(k, _)| k / OP_BUCKET == b)
                    .map(|(_, id)| *id)
                    .collect();
                send_to(
                    &st,
                    remote,
                    Frame::OpIds {
                        space,
                        bucket: b,
                        ids,
                    },
                );
            }
        }
        Frame::OpIds { space, bucket, ids } => {
            ensure!(ids.len() <= 100_000, "bad op ids");
            if !peer_has(&st, &remote, &space) {
                return Ok(());
            }
            let theirs: BTreeSet<Id> = ids.into_iter().collect();
            let log = st.spaces.get(&space).context("space")?;
            let missing: Vec<SignedOp> = log
                .entries()
                .filter(|e| e.op.clock / OP_BUCKET == bucket && !theirs.contains(&e.id))
                .map(|e| e.signed.clone())
                .collect();
            send_ops(&st, remote, space, missing);
        }
        Frame::WantOps { space, ids } => {
            if !peer_has(&st, &remote, &space) {
                return Ok(());
            }
            let log = st.spaces.get(&space).context("space")?;
            let ops: Vec<SignedOp> = ids
                .iter()
                .take(4096)
                .filter_map(|id| log.get(id))
                .map(|e| e.signed.clone())
                .collect();
            send_ops(&st, remote, space, ops);
        }
        Frame::Ops { space, ops } => {
            if !peer_has(&st, &remote, &space) {
                return Ok(());
            }
            ensure!(ops.len() <= MAX_OPS_PER_FRAME, "too many ops");
            ingest_ops(i, &mut st, remote, space, ops)?;
        }
        Frame::MsgSummary {
            space,
            channel,
            buckets,
        } => {
            if !peer_has(&st, &remote, &space) {
                return Ok(());
            }
            if !shared_channels(i, &st, &space, &remote).contains(&channel) {
                return Ok(());
            }
            let ours = msg_items(i, &space, &channel, 0, u64::MAX);
            let mine = wire::summarize(ours.iter().copied(), MSG_BUCKET);
            for b in wire::diff(&mine, &buckets) {
                let ids = ours
                    .iter()
                    .filter(|(k, _)| k / MSG_BUCKET == b)
                    .map(|(_, id)| *id)
                    .collect();
                send_to(
                    &st,
                    remote,
                    Frame::MsgIds {
                        space,
                        channel,
                        bucket: b,
                        ids,
                    },
                );
            }
        }
        Frame::MsgIds {
            space,
            channel,
            bucket,
            ids,
        } => {
            ensure!(ids.len() <= 100_000, "bad msg ids");
            if !peer_has(&st, &remote, &space) {
                return Ok(());
            }
            if !shared_channels(i, &st, &space, &remote).contains(&channel) {
                return Ok(());
            }
            let theirs: BTreeSet<Id> = ids.into_iter().collect();
            let from = bucket.saturating_mul(MSG_BUCKET);
            let mine: Vec<Id> =
                msg_items(i, &space, &channel, from, from.saturating_add(MSG_BUCKET))
                    .into_iter()
                    .map(|(_, id)| id)
                    .filter(|id| !theirs.contains(id))
                    .collect();
            let msgs = i.store.get_msgs(&mine)?;
            for chunk in msgs.chunks(MAX_MSGS_PER_FRAME) {
                send_to(
                    &st,
                    remote,
                    Frame::Msgs {
                        space,
                        msgs: chunk.to_vec(),
                        live: false,
                    },
                );
            }
        }
        Frame::Msgs { space, msgs, live } => {
            ensure!(msgs.len() <= MAX_MSGS_PER_FRAME, "bad msgs");
            if !peer_has(&st, &remote, &space) {
                return Ok(());
            }
            for m in msgs {
                if let Err(e) = ingest_msg(i, &mut st, Some(remote), m, live) {
                    tracing::debug!("msg from {remote:?} dropped: {e:#}");
                }
            }
        }
        Frame::Presence { space, voice } => {
            if !peer_has(&st, &remote, &space) {
                return Ok(());
            }
            match voice {
                Some(mut p) => {
                    // a modified client can claim to stream without the permission: don't believe it
                    p.streaming &= may_stream(&st, space, remote, p.channel);
                    let ok = st.spaces.get(&space).is_some_and(|l| {
                        l.state
                            .channels
                            .get(&p.channel)
                            .is_some_and(|c| c.kind == op::ChannelKind::Voice)
                            && l.state.can_view(&remote, &p.channel)
                    });
                    if !ok {
                        return Ok(());
                    }
                    // one voice room at a time per member
                    st.presence.retain(|(_, m), _| *m != remote);
                    if !p.streaming {
                        st.watchers.remove(&remote);
                    }
                    st.presence.insert((space, remote), p);
                }
                None => {
                    st.presence.remove(&(space, remote));
                    st.watchers.remove(&remote);
                }
            }
            // a sharer that stopped (or left) ends our view
            let still = st
                .presence
                .get(&(space, remote))
                .is_some_and(|p| p.streaming);
            if !still && st.watching.remove(&remote).is_some() {
                i.emit(Event::StreamEnded(remote));
            }
            voice_changed_quiet(i, &mut st);
            drop(st);
            i.emit(Event::Changed);
        }
        Frame::Watch { on } => {
            if !on {
                st.watchers.remove(&remote);
                return Ok(());
            }
            let v = st
                .voice
                .as_ref()
                .filter(|v| v.streaming)
                .context("not streaming")?;
            let same_room = st
                .presence
                .get(&(v.space, remote))
                .is_some_and(|p| p.channel == v.channel);
            ensure!(same_room, "watcher not in our room");
            ensure!(st.watchers.len() < 16, "too many watchers");
            let conn = st.peers.get(&remote).context("peer")?.conn.clone();
            let (tx, rx) = mpsc::channel(240);
            st.watchers.insert(remote, Watcher { tx, skipping: true });
            tokio::spawn(gop_sender(conn, rx, i.clone()));
            drop(st);
            i.emit(Event::StreamKeyframe);
        }
        Frame::Keyframe => {
            if st.watchers.contains_key(&remote) {
                drop(st);
                i.emit(Event::StreamKeyframe);
            }
        }
    }
    Ok(())
}

fn ingest_ops(
    i: &Arc<Inner>,
    st: &mut St,
    remote: Id,
    space: Id,
    ops: Vec<SignedOp>,
) -> Result<()> {
    // Joiner side: the acceptor streams us the whole log for a space we don't have yet.
    if !st.spaces.contains_key(&space) {
        ensure!(st.joins.contains_key(&space), "unsolicited space");
        let g = ops
            .iter()
            .find(|o| o.id() == space)
            .cloned()
            .context("genesis missing")?;
        let mut log = crate::space::SpaceLog::new(g)?;
        log.insert_many(ops.iter().cloned());
        st.spaces.insert(space, log);
        i.store.put_ops(&space, &ops)?;
        maybe_finish_join(i, st, space, remote);
        return Ok(());
    }
    let joiner = st.peers.get(&remote).and_then(|p| p.joining);
    if let Some(js) = joiner {
        ensure!(
            js == space && ops.len() <= 4,
            "joining peer sent unexpected ops"
        );
        ensure!(
            ops.iter()
                .all(|o| o.verify().is_ok_and(|e| e.op.author == remote)),
            "joining peer may only send its own ops"
        );
    }
    let log = st.spaces.get_mut(&space).expect("checked");
    let was_member = log.state.is_member(&remote);
    let added = log.insert_many(ops);
    let missing = log.missing_parents();
    if !missing.is_empty() {
        send_to(
            st,
            remote,
            Frame::WantOps {
                space,
                ids: missing,
            },
        );
    }
    if added.is_empty() {
        maybe_finish_join(i, st, space, remote);
        return Ok(());
    }
    let log = &st.spaces[&space];
    let new: Vec<SignedOp> = added
        .iter()
        .filter_map(|id| log.get(id))
        .map(|e| e.signed.clone())
        .collect();
    i.store.put_ops(&space, &new)?;
    broadcast(st, space, Some(remote), || Frame::Ops {
        space,
        ops: new.clone(),
    });
    // joiner became a member: promote the connection to a full one
    if joiner.is_some() && !was_member && st.spaces[&space].state.is_member(&remote) {
        if let Some(p) = st.peers.get_mut(&remote) {
            p.joining = None;
        }
        send_summaries(i, st, remote);
        crate::profile::announce(i, st, remote, true);
        // they missed our voice presence while joining; without this they'd never hear the room
        announce_presence(st, remote);
    }
    if !st.spaces[&space].state.is_member(&i.me) && !st.joins.contains_key(&space) {
        let name = st.spaces[&space].state.name.clone();
        if st.voice.as_ref().is_some_and(|v| v.space == space) {
            crate::node::leave_voice_locked(i, st);
        }
        crate::node::drop_space_locked(i, st, space);
        i.notice(true, format!("“{name}” halkasından çıkarıldın."));
    } else {
        enforce_access(i, st);
    }
    maybe_finish_join(i, st, space, remote);
    if st.voice.is_some() {
        voice_changed_quiet(i, st);
    }
    i.emit(Event::Changed);
    Ok(())
}

/// Joiner side: once we hold the log, author our Join op and push it.
fn maybe_finish_join(i: &Arc<Inner>, st: &mut St, space: Id, remote: Id) {
    let Some(j) = st.joins.get(&space) else {
        return;
    };
    if j.done.is_none()
        || st
            .spaces
            .get(&space)
            .is_none_or(|l| l.state.is_member(&i.me))
    {
        return;
    }
    let invite = j.invite.clone();
    let name = if st.name.is_empty() {
        "Yeni üye".to_string()
    } else {
        st.name.clone()
    };
    let proof = id::sign(&invite, op::DOMAIN_JOIN, &op::join_proof_msg(&space, &i.me));
    let log = st.spaces.get_mut(&space).expect("checked");
    // may fail until the chunk carrying our invite arrives; we retry on every ops frame
    let Ok(s) = log.author(
        &i.key,
        OpBody::Join {
            invite: invite.public().into(),
            proof,
            name,
        },
    ) else {
        return;
    };
    let _ = i.store.put_ops(&space, std::slice::from_ref(&s));
    send_to(
        st,
        remote,
        Frame::Ops {
            space,
            ops: vec![s],
        },
    );
    if let Some(d) = st.joins.get_mut(&space).and_then(|j| j.done.take()) {
        let _ = d.send(Ok(()));
    }
    // the acceptor promotes us; ask for history right away
    send_summaries(i, st, remote);
    i.emit(Event::Changed);
}

/// Drop spaces from connections whose remote is no longer a member (kick/ban/leave), and
/// close connections that share nothing anymore.
pub(crate) fn enforce_access(i: &Inner, st: &mut St) {
    let me = i.me;
    let mut close = Vec::new();
    for (m, p) in st.peers.iter_mut() {
        if p.joining.is_some() {
            continue;
        }
        p.spaces.retain(|s| {
            st.spaces
                .get(s)
                .is_some_and(|l| l.state.is_member(m) && l.state.is_member(&me))
        });
        if p.spaces.is_empty() {
            close.push(*m);
        }
    }
    for m in close {
        if let Some(p) = st.peers.get(&m) {
            // give the writer a moment to flush the op that revoked access, so they learn of it
            let conn = p.conn.clone();
            i.rt.spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                conn.close(3u32.into(), b"access revoked");
            });
        }
    }
    let spaces = &st.spaces;
    st.presence
        .retain(|(s, m), _| spaces.get(s).is_some_and(|l| l.state.is_member(m)));
}

pub(crate) fn ingest_msg(
    i: &Inner,
    st: &mut St,
    from: Option<Id>,
    s: SignedMsg,
    live: bool,
) -> Result<()> {
    let m = s.verify()?;
    let log = st.spaces.get(&m.space).context("unknown space")?;
    let state = &log.state;
    msg::authorized(state, &m, id::now_ms())?;
    if let Some(f) = from {
        // live pushes must come from current members; ex-members' history only via reconciliation
        ensure!(
            !live || state.is_member(&m.author),
            "ex-member live message"
        );
        ensure!(
            state.can_view(&f, &m.channel),
            "sender can't see this channel"
        );
    }
    match &m.body {
        MsgBody::Text { .. } => {}
        MsgBody::Edit { target, .. } | MsgBody::Delete { target } => {
            let t = i.store.msg_view(target)?.context("unknown target")?;
            ensure!(t.msg.channel == m.channel, "target in another channel");
            match m.body {
                MsgBody::Edit { .. } => {
                    ensure!(t.msg.author == m.author, "only the author may edit")
                }
                _ => ensure!(
                    msg::can_delete(state, &m.author, &t.msg.author, &m.channel),
                    "not allowed to delete"
                ),
            }
        }
    }
    if !i.store.put_msg(&s, &m)? {
        return Ok(());
    }
    let channel = m.channel;
    let target = match &m.body {
        MsgBody::Text { .. } => s.id(),
        MsgBody::Edit { target, .. } | MsgBody::Delete { target } => *target,
    };
    // fan out to members who can read the channel
    let space = m.space;
    let targets: Vec<Id> = st
        .peers
        .iter()
        .filter(|(pm, p)| {
            Some(**pm) != from
                && p.spaces.contains(&space)
                && p.joining.is_none()
                && state.can_view(pm, &channel)
        })
        .map(|(pm, _)| *pm)
        .collect();
    if live {
        for t in targets {
            send_to(
                st,
                t,
                Frame::Msgs {
                    space,
                    msgs: vec![s.clone()],
                    live: true,
                },
            );
        }
    }
    if let Some(v) = i.store.msg_view(&target)? {
        i.emit(Event::Message(msg_view(v)));
    }
    if from.is_some() {
        i.emit(Event::Changed); // unread counts
    }
    Ok(())
}

/// Our voice presence changed (or the room's membership did): tell peers and re-layout.
pub(crate) fn voice_changed(i: &Inner, st: &mut St) {
    if let Some(v) = &st.voice {
        let (space, p) = (v.space, my_presence(v));
        broadcast(st, space, None, || Frame::Presence {
            space,
            voice: Some(p.clone()),
        });
    }
    voice_changed_quiet(i, st);
}

/// Recompute who we exchange audio with and where they sit (stereo pan = seat angle).
fn voice_changed_quiet(i: &Inner, st: &mut St) {
    let Some(v) = &st.voice else {
        i.voice_targets.write().clear();
        return;
    };
    let (space, channel) = (v.space, v.channel);
    let mut others: Vec<Id> = st
        .presence
        .iter()
        .filter(|((s, m), p)| *s == space && p.channel == channel && st.peers.contains_key(m))
        .map(|((_, m), _)| *m)
        .collect();
    others.sort();
    // seats: self at 6 o'clock, others clockwise; pan = sin(angle from 12 o'clock)
    let n = others.len() as f32 + 1.0;
    let pans: HashMap<Id, f32> = others
        .iter()
        .enumerate()
        .map(|(k, m)| {
            let angle = std::f32::consts::PI + (k as f32 + 1.0) * std::f32::consts::TAU / n;
            (
                *m,
                if st.settings.spatial_audio {
                    angle.sin() * 0.8
                } else {
                    0.0
                },
            )
        })
        .collect();
    let log = &st.spaces[&space];
    // only exchange audio with people allowed to speak/listen in this room
    let targets: Vec<Connection> = others
        .iter()
        .filter(|m| log.state.can_view(m, &channel))
        .filter_map(|m| st.peers.get(m).map(|p| p.conn.clone()))
        .collect();
    let speakers: HashMap<Id, f32> = pans
        .into_iter()
        .filter(|(m, _)| log.state.can_in(m, &channel, Perms::SPEAK))
        .collect();
    if let Some(e) = &v.engine {
        e.set_layout(speakers);
    }
    *i.voice_targets.write() = targets;
}

async fn datagram_loop(i: Arc<Inner>, conn: Connection, remote: Id) {
    let mut rate = Rate::new(120.0, 240.0);
    while let Ok(dg) = conn.read_datagram().await {
        if !rate.allow(1.0) || dg.first() != Some(&wire::DG_VOICE) {
            continue;
        }
        let st = i.st.lock();
        let Some(v) = &st.voice else { continue };
        let in_room = st
            .presence
            .get(&(v.space, remote))
            .is_some_and(|p| p.channel == v.channel);
        if in_room && let Some(e) = &v.engine {
            e.receive(remote, &dg); // engine drops peers not in its speaker layout
        }
    }
}

/// Video bytes a sharer may push us: the "maximum" preset tops out at 80 Mbit/s, so this leaves
/// headroom for key frames while a modified client can't flood a watcher's link.
const VIDEO_BYTES_PER_SEC: f64 = 12.0 * 1024.0 * 1024.0;
const VIDEO_BURST_BYTES: f64 = 24.0 * 1024.0 * 1024.0;

/// The sharer is in that voice channel of the space with the stream permission.
fn may_stream(st: &St, space: Id, remote: Id, channel: Id) -> bool {
    st.spaces
        .get(&space)
        .is_some_and(|l| l.state.can_in(&remote, &channel, Perms::STREAM))
}

async fn uni_loop(i: Arc<Inner>, conn: Connection, remote: Id) {
    let profile_reads = Arc::new(tokio::sync::Semaphore::new(4));
    let profile_rate = Arc::new(parking_lot::Mutex::new(Rate::new(8.0, 24.0)));
    let video_rate = Arc::new(parking_lot::Mutex::new(Rate::new(
        VIDEO_BYTES_PER_SEC,
        VIDEO_BURST_BYTES,
    )));
    while let Ok(mut r) = conn.accept_uni().await {
        let i = i.clone();
        let conn = conn.clone();
        let profile_reads = profile_reads.clone();
        let profile_rate = profile_rate.clone();
        let video_rate = video_rate.clone();
        tokio::spawn(async move {
            let mut tag = [0u8; 1];
            if matches!(tokio::time::timeout(Duration::from_secs(5), r.read_exact(&mut tag)).await, Ok(Ok(_))) {
                match tag[0] {
                    wire::UNI_STREAM => { let _ = read_gop(&i, &mut r, remote, &video_rate).await; }
                    crate::profile::TAG => {
                        let allowed = profile_rate.lock().allow(1.0);
                        if allowed && let Ok(_permit) = profile_reads.try_acquire() {
                            let _ = crate::profile::receive(&i, &conn, &mut r, remote).await;
                        }
                    }
                    _ => {}
                }
            }
            let _ = r.stop(0u32.into());
        });
    }
}

/// One GOP stream from a sharer we're watching. Supersede the old GOP once the new key arrives.
/// Each GOP rechecks the stream permission, so revoking it ends the stream at the next key frame;
/// going over the byte budget drops the rest of the GOP (a partial GOP can't be decoded anyway).
async fn read_gop(
    i: &Inner,
    r: &mut RecvStream,
    remote: Id,
    rate: &parking_lot::Mutex<Rate>,
) -> Result<()> {
    let (sink, current) = {
        let st = i.st.lock();
        let v = st.voice.as_ref().context("not in voice")?;
        ensure!(
            may_stream(&st, v.space, remote, v.channel),
            "sharer may not stream here"
        );
        st.watching.get(&remote).cloned().context("not watching")?
    };
    let index = r.id().index();
    let packet = async |r: &mut RecvStream| -> Result<Option<Vec<u8>>> {
        let p = read_stream_packet(r).await?;
        if let Some(p) = &p {
            ensure!(rate.lock().allow(p.len() as f64), "video rate limit exceeded");
        }
        Ok(p)
    };
    let Some(first) = packet(r).await? else { return Ok(()) };
    let (config, key) = if first[0] == 0 {
        let Some(key) = packet(r).await? else { return Ok(()) };
        (Some(first), key)
    } else {
        (None, first)
    };
    ensure!(key[0] == 1, "GOP has no key frame");
    {
        let mut current = current.lock();
        if current.is_some_and(|active| active >= index) {
            return Ok(());
        }
        *current = Some(index);
        if let Some(config) = config {
            sink(config);
        }
        sink(key);
    }
    while let Some(pkt) = packet(r).await? {
        let current = current.lock();
        if *current != Some(index) {
            break;
        }
        ensure!(pkt[0] == 2, "unexpected packet in GOP");
        sink(pkt);
    }
    Ok(())
}

async fn read_stream_packet(r: &mut RecvStream) -> Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    if r.read_exact(&mut len).await.is_err() {
        return Ok(None);
    }
    let len = u32::from_le_bytes(len) as usize;
    ensure!((9..=4 * 1024 * 1024).contains(&len), "bad packet length");
    let mut packet = vec![0u8; len];
    r.read_exact(&mut packet).await?;
    Ok(Some(packet))
}

/// Sharer side, one task per watcher: each key frame opens a fresh uni stream.
async fn gop_sender(
    conn: Connection,
    mut rx: mpsc::Receiver<WatchPacket>,
    i: Arc<Inner>,
) {
    let mut cur: Option<SendStream> = None;
    async fn put(s: &mut SendStream, p: &[u8]) -> Result<()> {
        s.write_all(&(p.len() as u32).to_le_bytes()).await?;
        s.write_all(p).await?;
        Ok(())
    }
    while let Some(WatchPacket { at, data: pkt, config }) = rx.recv().await {
        match pkt[0] {
            1 => {
                if let Some(mut s) = cur.take() {
                    let _ = s.finish();
                }
                let Ok(mut s) = conn.open_uni().await else {
                    return;
                };
                // video yields to voice datagrams and control frames on a congested link
                let _ = s.set_priority(-10);
                let ok = async {
                    s.write_all(&[wire::UNI_STREAM]).await?;
                    if let Some(c) = &config {
                        put(&mut s, c).await?;
                    }
                    put(&mut s, &pkt).await
                }
                .await;
                if ok.is_ok() {
                    cur = Some(s);
                }
            }
            _ => {
                // stale delta: this watcher is behind; abandon the GOP and wait for a key frame
                if at.elapsed() > Duration::from_millis(600) {
                    if let Some(mut s) = cur.take() {
                        let _ = s.reset(0u32.into());
                    }
                    i.emit(Event::StreamCongested);
                    i.emit(Event::StreamKeyframe);
                    continue;
                }
                if let Some(s) = cur.as_mut()
                    && put(s, &pkt).await.is_err()
                {
                    cur = None;
                }
            }
        }
    }
    if let Some(mut s) = cur {
        let _ = s.finish();
    }
}
