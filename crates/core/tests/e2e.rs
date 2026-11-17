//! End-to-end: real iroh endpoints in one process (direct LAN/loopback paths).
use std::time::Duration;

use halka_core::Node;
use halka_core::id::Id;
use halka_core::op::{ChannelKind, OpBody};

async fn node(dir: &tempfile::TempDir, name: &str) -> Node {
    let (n, mut rx) = Node::start(&dir.path().join(name)).await.unwrap();
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    n.set_name(name).unwrap();
    n
}

async fn until(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..300 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for: {what}");
}

fn text_channel(n: &Node, s: Id) -> Id {
    n.snapshot()
        .spaces
        .iter()
        .find(|x| x.id == s)
        .unwrap()
        .channels
        .iter()
        .find(|c| c.kind == ChannelKind::Text)
        .unwrap()
        .id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn space_lifecycle() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("halka_core=debug")
        .try_init();
    let dir = tempfile::tempdir().unwrap();
    let (a, b, c) = (
        node(&dir, "ayse").await,
        node(&dir, "berk").await,
        node(&dir, "cem").await,
    );

    let s = a.create_space("Kanka").unwrap();
    let ch = text_channel(&a, s);
    a.send_message(s, ch, "selam", None).unwrap();

    let code = a.create_invite(s, Some(3_600_000), Some(5)).unwrap();
    assert_eq!(b.join_space(&code).await.unwrap(), s);
    until("b sees history", || {
        b.messages(s, ch, None, 50)
            .map(|m| m.len() == 1)
            .unwrap_or(false)
    })
    .await;

    // live chat both ways
    b.send_message(s, ch, "naber", None).unwrap();
    until("a gets b's message", || {
        a.messages(s, ch, None, 50).unwrap().len() == 2
    })
    .await;

    // b lacks manage_channels
    assert!(
        b.op(
            s,
            OpBody::CreateChannel {
                name: "x".into(),
                kind: ChannelKind::Text,
                private_roles: None
            }
        )
        .is_err()
    );

    // c joins through the same code even with a offline-capable path via b
    assert_eq!(c.join_space(&code).await.unwrap(), s);
    until("c synced", || {
        c.messages(s, ch, None, 50)
            .map(|m| m.len() == 2)
            .unwrap_or(false)
    })
    .await;
    until("b knows c", || {
        b.snapshot().spaces[0]
            .members
            .iter()
            .any(|m| m.id == c.id())
    })
    .await;

    // kick c: c loses the space, others drop it
    a.op(s, OpBody::Kick { member: c.id() }).unwrap();
    until("c removed locally", || c.snapshot().spaces.is_empty()).await;
    until("b sees kick", || {
        !b.snapshot().spaces[0]
            .members
            .iter()
            .any(|m| m.id == c.id())
    })
    .await;

    // edit + delete propagate
    let id = a.send_message(s, ch, "yanlis", None).unwrap();
    a.edit_message(s, id, "dogru").unwrap();
    until("edit arrives", || {
        b.messages(s, ch, None, 50)
            .unwrap()
            .iter()
            .any(|m| m.id == id && m.text == "dogru" && m.edited)
    })
    .await;
    // b can't delete a's message
    assert!(b.delete_message(s, id).is_err());
    a.delete_message(s, id).unwrap();
    until("delete arrives", || {
        b.messages(s, ch, None, 50)
            .unwrap()
            .iter()
            .any(|m| m.id == id && m.deleted)
    })
    .await;

    for n in [a, b, c] {
        n.shutdown().await;
    }
}

fn voice_channel(n: &Node, s: Id) -> Id {
    n.snapshot()
        .spaces
        .iter()
        .find(|x| x.id == s)
        .unwrap()
        .channels
        .iter()
        .find(|c| c.kind == ChannelKind::Voice)
        .unwrap()
        .id
}

fn pkt(kind: u8, ts: u64, body: &[u8]) -> Vec<u8> {
    let mut v = vec![kind];
    v.extend_from_slice(&ts.to_le_bytes());
    v.extend_from_slice(body);
    v
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn screen_share_flows_to_watcher() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (node(&dir, "ayse").await, node(&dir, "berk").await);
    let s = a.create_space("Yayin").unwrap();
    let code = a.create_invite(s, None, None).unwrap();
    b.join_space(&code).await.unwrap();
    let vc = voice_channel(&a, s);
    a.voice_join(s, vc).unwrap();
    b.voice_join(s, vc).unwrap();
    until("both in room", || {
        a.snapshot().spaces[0]
            .channels
            .iter()
            .any(|c| c.id == vc && c.voice.len() == 2)
    })
    .await;

    a.stream_start().unwrap();
    until("b sees stream", || {
        b.snapshot().spaces[0]
            .channels
            .iter()
            .any(|c| c.id == vc && c.streams == vec![a.id()])
    })
    .await;
    let got = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<Vec<u8>>::new()));
    let g = got.clone();
    b.watch(a.id(), std::sync::Arc::new(move |p| g.lock().push(p)))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    a.stream_packet(pkt(0, 0, br#"{"codec":"vp8","width":2,"height":2}"#))
        .unwrap();
    a.stream_packet(pkt(2, 1, b"orphan-delta")).unwrap(); // before any key frame: must be skipped
    a.stream_packet(pkt(1, 2, b"key")).unwrap();
    a.stream_packet(pkt(2, 3, b"d1")).unwrap();
    a.stream_packet(pkt(1, 4, &vec![7u8; 300_000])).unwrap(); // big key frame, new GOP
    for _ in 0..100 {
        if got.lock().len() >= 5 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    eprintln!(
        "got kinds: {:?}",
        got.lock().iter().map(|p| p[0]).collect::<Vec<_>>()
    );
    let kinds: Vec<u8> = got.lock().iter().map(|p| p[0]).collect();
    assert_eq!(
        kinds,
        vec![0, 1, 2, 0, 1],
        "config+key+delta, then config+key of next GOP"
    );
    assert_eq!(got.lock()[4].len(), 9 + 300_000);

    a.stream_stop();
    until("stream gone", || {
        b.snapshot().spaces[0]
            .channels
            .iter()
            .all(|c| c.streams.is_empty())
    })
    .await;
    a.shutdown().await;
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn survives_restart_and_relay_only() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (node(&dir, "ayse").await, node(&dir, "berk").await);
    let s = a.create_space("Kalici").unwrap();
    let ch = text_channel(&a, s);
    b.join_space(&a.create_invite(s, None, None).unwrap())
        .await
        .unwrap();
    a.send_message(s, ch, "unutma beni", None).unwrap();
    until("b got it", || {
        b.messages(s, ch, None, 10).unwrap().len() == 1
    })
    .await;
    let (aid, bid) = (a.id(), b.id());
    // b turns on relay-only (exercises the privacy path on restart)
    let mut set = b.settings();
    set.relay_only = true;
    b.set_settings(set).unwrap();
    a.shutdown().await;
    b.shutdown().await;
    drop((a, b));

    // background tasks notice the closed endpoint within a tick and release the database
    async fn restart(p: std::path::PathBuf) -> Node {
        for _ in 0..50 {
            if let Ok((n, mut rx)) = Node::start(&p).await {
                tokio::spawn(async move { while rx.recv().await.is_some() {} });
                return n;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        panic!("database never released");
    }
    let a = restart(dir.path().join("ayse")).await;
    let b = restart(dir.path().join("berk")).await;
    assert_eq!((a.id(), b.id()), (aid, bid), "identity survives");
    assert!(b.settings().relay_only);
    assert_eq!(b.snapshot().me.name, "berk");
    assert_eq!(b.messages(s, ch, None, 10).unwrap()[0].text, "unutma beni");
    // peers find each other again from persisted addresses and keep chatting
    b.send_message(s, ch, "geri geldim", None).unwrap();
    until("a gets post-restart message", || {
        a.messages(s, ch, None, 10).unwrap().len() == 2
    })
    .await;
    a.shutdown().await;
    b.shutdown().await;
}
