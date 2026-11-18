//! End-to-end: real iroh endpoints in one process (direct LAN/loopback paths).
use std::time::Duration;

use halka_core::{Node, PhotoEdit};
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn member_profiles_sync_and_survive_offline() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b, outsider) = (node(&dir, "ayse").await, node(&dir, "berk").await, node(&dir, "cem").await);
    let (aid, bid) = (a.id(), b.id());
    let mut photo = Vec::new();
    image_webp::WebPEncoder::new(&mut photo)
        .encode(&[95; 192 * 192 * 3], 192, 192, image_webp::ColorType::Rgb8)
        .unwrap();
    let encoded = data_encoding::BASE64.encode(&photo);
    let hash = Id(*blake3::hash(&photo).as_bytes());
    assert!(a.update_profile("degismemeli", 0x1000000, "", PhotoEdit::Keep).is_err());
    assert!(a.update_profile("degismemeli", 0, "", PhotoEdit::Replace("AAAA".into())).is_err());
    assert_eq!(a.snapshot().me.name, "ayse");

    a.update_profile("Ayşe", 0x81a1ff, "Merhaba", PhotoEdit::Replace(encoded.clone())).unwrap();
    b.update_profile("Berk", 0xefab71, "", PhotoEdit::Keep).unwrap();
    let space = a.create_space("Profil").unwrap();
    b.join_space(&a.create_invite(space, None, None).unwrap()).await.unwrap();
    until("both members see independent profiles and the photo", || {
        b.snapshot().profiles.get(&aid).is_some_and(|p| p.photo == Some(hash) && p.orb_color == 0x81a1ff && p.bio == "Merhaba")
            && a.snapshot().profiles.get(&bid).is_some_and(|p| p.orb_color == 0xefab71)
    }).await;
    assert_eq!(b.profile_photo(aid, hash).unwrap(), encoded);
    assert!(outsider.profile_photo(aid, hash).is_err());
    assert!(!outsider.snapshot().profiles.contains_key(&aid));

    a.update_profile("Ayşe", 0x72c4a1, "Güncel", PhotoEdit::Keep).unwrap();
    until("color and bio change without replacing the cached photo", || {
        b.snapshot().profiles.get(&aid).is_some_and(|p| p.photo == Some(hash) && p.orb_color == 0x72c4a1 && p.bio == "Güncel")
    }).await;

    b.shutdown().await;
    drop(b);
    a.update_profile("Ayşe", 0x72c4a1, "", PhotoEdit::Remove).unwrap();
    a.shutdown().await;
    drop(a);
    let b = restart(dir.path().join("berk")).await;
    assert_eq!(b.profile_photo(aid, hash).unwrap(), encoded);
    assert_eq!(b.snapshot().profiles[&aid].bio, "Güncel");

    let a = restart(dir.path().join("ayse")).await;
    until("reconnect supplies the latest profile and clears the former photo", || {
        b.snapshot().profiles.get(&aid).is_some_and(|p| p.photo.is_none() && p.bio.is_empty())
    }).await;
    assert!(b.profile_photo(aid, hash).is_err());
    assert_eq!(a.snapshot().me.name, "Ayşe");
    for n in [a, b, outsider] {
        n.shutdown().await;
    }
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
    let voice = voice_channel(&a, s);
    a.send_message(s, ch, "selam", None).unwrap();
    a.send_message(s, voice, "odayı açtım", None).unwrap();

    let code = a.create_invite(s, Some(3_600_000), Some(5)).unwrap();
    assert_eq!(b.join_space(&code).await.unwrap(), s);
    until("b sees history", || {
        b.messages(s, ch, None, 50)
            .map(|m| m.len() == 1)
            .unwrap_or(false)
    })
    .await;
    until("b sees voice chat history without joining voice", || {
        b.messages(s, voice, None, 50)
            .is_ok_and(|m| m.len() == 1 && m[0].text == "odayı açtım")
    })
    .await;

    // live chat both ways
    b.send_message(s, ch, "naber", None).unwrap();
    b.send_message(s, voice, "birazdan geliyorum", None).unwrap();
    until("a gets b's message", || {
        a.messages(s, ch, None, 50).unwrap().len() == 2
    })
    .await;
    until("a gets b's voice chat message", || {
        a.messages(s, voice, None, 50)
            .is_ok_and(|m| m.len() == 2 && m.iter().any(|m| m.text == "birazdan geliyorum"))
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
    // Tauri runs sync commands on the main thread, outside the runtime: do the same here
    let (a2, cid) = (a.clone(), c.id());
    std::thread::spawn(move || a2.op(s, OpBody::Kick { member: cid }).unwrap())
        .join()
        .unwrap();
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
    a.stream_packet(pkt(0, 0, br#"{"codec":"vp8","width":4,"height":2}"#))
        .unwrap();
    a.stream_packet(pkt(2, 4, b"delta-before-resized-key")).unwrap();
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
    assert_eq!(&got.lock()[3][9..], br#"{"codec":"vp8","width":4,"height":2}"#);
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

/// Real audio over the network: a's mic is a 440 Hz tone, b (deafened, so nothing is played
/// aloud) must measure a's voice level. Run once over any path and once forced through the
/// public relays (relay_only on both ends), which exercises the internet path from this host.
async fn tone_reaches_peer(relay_only: bool) {
    voice_reaches_peer(relay_only, "test-tone").await;
}

async fn voice_reaches_peer(relay_only: bool, mic: &'static str) -> f32 {
    voice_reaches_peer_for(relay_only, mic, 0.0).await
}

async fn voice_reaches_peer_for(relay_only: bool, mic: &'static str, listen_secs: f32) -> f32 {
    let dir = tempfile::tempdir().unwrap();
    let mk = move |name: &'static str| {
        let p = dir.path().join(name);
        async move {
            // settings are read at start: write them first through a throwaway node
            let (n, mut rx) = Node::start(&p).await.unwrap();
            tokio::spawn(async move { while rx.recv().await.is_some() {} });
            n.set_name(name).unwrap();
            let mut s = n.settings();
            s.relay_only = relay_only;
            s.vad_threshold = 0.0;
            if name == "ayse" {
                s.input = Some(mic.into());
                // a steady sine is exactly what noise suppression is built to remove;
                // anything else runs through the full production pipeline
                let synthetic_tone = mic == "test-tone";
                s.noise_suppression = !synthetic_tone;
                s.echo_cancellation = !synthetic_tone;
            }
            n.set_settings(s).unwrap();
            n.shutdown().await;
            drop(n);
            for _ in 0..50 {
                if let Ok((n, mut rx)) = Node::start(&p).await {
                    tokio::spawn(async move { while rx.recv().await.is_some() {} });
                    return n;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            panic!("restart failed");
        }
    };
    let a = mk("ayse").await;
    let b = mk("berk").await;
    let s = a.create_space("Ton").unwrap();
    b.join_space(&a.create_invite(s, None, None).unwrap())
        .await
        .unwrap();
    let vc = voice_channel(&a, s);
    a.voice_join(s, vc).unwrap();
    b.voice_join(s, vc).unwrap();
    b.set_deafened(true).unwrap();
    until("both in room", || {
        a.snapshot().spaces[0]
            .channels
            .iter()
            .any(|c| c.id == vc && c.voice.len() == 2)
    })
    .await;
    if relay_only {
        let m = b.snapshot().spaces[0]
            .members
            .iter()
            .find(|m| m.id == a.id())
            .unwrap()
            .clone();
        assert_eq!(
            m.conn,
            halka_core::api::ConnKind::Relay,
            "relay_only must not go direct"
        );
        eprintln!("relay rtt: {:?} ms", m.rtt_ms);
    }
    if listen_secs > 0.0 {
        // restart a's room so the file plays from the top while b is already listening
        a.voice_leave();
        halka_core::voice::test_support::RECORDING.lock().clear();
        a.voice_join(s, vc).unwrap();
        tokio::time::sleep(Duration::from_secs_f32(listen_secs)).await;
    }
    let mut best = 0f32;
    for _ in 0..100 {
        best = best.max(
            b.debug_levels()
                .into_iter()
                .find(|(id, _)| *id == a.id())
                .map(|(_, l)| l)
                .unwrap_or(0.0),
        );
        if best > 0.5 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let own = a
        .debug_levels()
        .into_iter()
        .find(|(id, _)| *id == a.id())
        .map(|(_, l)| l)
        .unwrap_or(0.0);
    let db = b.debug_peer_db(a.id()).unwrap_or(-200.0);
    eprintln!(
        "a's own level {own:.2}; b hears a at level {best:.2}, {db:.1} dBFS (relay_only={relay_only}, mic={mic})"
    );
    if mic == "test-tone" {
        assert!(best > 0.5, "tone did not arrive: {best}");
    }
    a.shutdown().await;
    b.shutdown().await;
    db
}

/// A real microphone (not synthetic) captured, encoded, sent and decoded on the other side.
/// Hardware-dependent: `HALKA_TEST_MIC="<device name>" cargo test --test e2e real_mic -- --ignored`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn real_mic_reaches_peer() {
    let mic: &'static str = Box::leak(
        std::env::var("HALKA_TEST_MIC")
            .expect("set HALKA_TEST_MIC")
            .into_boxed_str(),
    );
    let db = voice_reaches_peer(false, mic).await;
    assert!(
        db > -120.0,
        "no real signal arrived ({db:.1} dBFS); is the mic muted?"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn audio_tone_direct() {
    tone_reaches_peer(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn audio_tone_over_public_relay() {
    tone_reaches_peer(true).await;
}

/// Machine "listening test": synthesized speech is the mic (full pipeline: AEC, NS, AGC, Opus,
/// network, jitter buffer); the received audio is written to a WAV for speech recognition.
/// `HALKA_TEST_WAV=in.wav HALKA_TEST_OUT=out.wav cargo test --test e2e speech -- --ignored`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn speech_roundtrip_recording() {
    let input = std::env::var("HALKA_TEST_WAV").expect("HALKA_TEST_WAV");
    let out = std::env::var("HALKA_TEST_OUT").expect("HALKA_TEST_OUT");
    let mic: &'static str = Box::leak(format!("wav:{input}").into_boxed_str());
    let secs = std::fs::metadata(&input).unwrap().len() as f32 / 96_000.0;
    voice_reaches_peer_for(false, mic, secs + 1.5).await;
    let rec = std::mem::take(&mut *halka_core::voice::test_support::RECORDING.lock());
    eprintln!(
        "recorded {:.1} s of received audio",
        rec.len() as f32 / 48_000.0
    );
    halka_core::voice::test_support::write_wav(&out, &rec).unwrap();
    assert!(rec.len() > 48_000);
}
