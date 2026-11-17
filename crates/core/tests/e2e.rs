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
    n.snapshot().spaces.iter().find(|x| x.id == s).unwrap().channels.iter().find(|c| c.kind == ChannelKind::Text).unwrap().id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn space_lifecycle() {
    let _ = tracing_subscriber::fmt().with_env_filter("halka_core=debug").try_init();
    let dir = tempfile::tempdir().unwrap();
    let (a, b, c) = (node(&dir, "ayse").await, node(&dir, "berk").await, node(&dir, "cem").await);

    let s = a.create_space("Kanka").unwrap();
    let ch = text_channel(&a, s);
    a.send_message(s, ch, "selam", None).unwrap();

    let code = a.create_invite(s, Some(3_600_000), Some(5)).unwrap();
    assert_eq!(b.join_space(&code).await.unwrap(), s);
    until("b sees history", || b.messages(s, ch, None, 50).map(|m| m.len() == 1).unwrap_or(false)).await;

    // live chat both ways
    b.send_message(s, ch, "naber", None).unwrap();
    until("a gets b's message", || a.messages(s, ch, None, 50).unwrap().len() == 2).await;

    // b lacks manage_channels
    assert!(b.op(s, OpBody::CreateChannel { name: "x".into(), kind: ChannelKind::Text, private_roles: None }).is_err());

    // c joins through the same code even with a offline-capable path via b
    assert_eq!(c.join_space(&code).await.unwrap(), s);
    until("c synced", || c.messages(s, ch, None, 50).map(|m| m.len() == 2).unwrap_or(false)).await;
    until("b knows c", || b.snapshot().spaces[0].members.iter().any(|m| m.id == c.id())).await;

    // kick c: c loses the space, others drop it
    a.op(s, OpBody::Kick { member: c.id() }).unwrap();
    until("c removed locally", || c.snapshot().spaces.is_empty()).await;
    until("b sees kick", || !b.snapshot().spaces[0].members.iter().any(|m| m.id == c.id())).await;

    // edit + delete propagate
    let id = a.send_message(s, ch, "yanlis", None).unwrap();
    a.edit_message(s, id, "dogru").unwrap();
    until("edit arrives", || b.messages(s, ch, None, 50).unwrap().iter().any(|m| m.id == id && m.text == "dogru" && m.edited)).await;
    // b can't delete a's message
    assert!(b.delete_message(s, id).is_err());
    a.delete_message(s, id).unwrap();
    until("delete arrives", || b.messages(s, ch, None, 50).unwrap().iter().any(|m| m.id == id && m.deleted)).await;

    for n in [a, b, c] {
        n.shutdown().await;
    }
}
