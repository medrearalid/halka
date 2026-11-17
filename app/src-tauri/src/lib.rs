//! Tauri shell: thin command/event bridge over `halka_core::Node`. No logic lives here.

use std::sync::Arc;
use std::time::Duration;

use halka_core::{Node, PhotoEdit};
use halka_core::api::{AudioDevices, Event, MessageView, Settings, Snapshot};
use halka_core::id::Id;
use halka_core::op::{ChannelKind, OpBody};
use halka_core::perm::Perms;
use serde_json::json;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Emitter, Manager, State};

type R<T> = Result<T, String>;

fn e(err: anyhow::Error) -> String {
    format!("{err:#}")
}

#[tauri::command(async)]
fn snapshot(n: State<Node>) -> Snapshot {
    n.snapshot()
}

#[tauri::command(async)]
fn set_name(n: State<Node>, name: String) -> R<()> {
    n.set_name(&name).map_err(e)
}

#[tauri::command(async)]
fn update_profile(n: State<Node>, name: String, orb_color: u32, bio: String, photo: PhotoEdit) -> R<()> {
    n.update_profile(&name, orb_color, &bio, photo).map_err(e)
}

#[tauri::command(async)]
fn profile_photo(n: State<Node>, member: Id, hash: Id) -> R<String> {
    n.profile_photo(member, hash).map_err(e)
}

#[tauri::command(async)]
fn create_space(n: State<Node>, name: String) -> R<Id> {
    n.create_space(&name).map_err(e)
}

#[tauri::command]
async fn join_space(n: State<'_, Node>, code: String) -> R<Id> {
    let n = n.inner().clone();
    n.join_space(&code).await.map_err(e)
}

#[tauri::command(async)]
fn leave_space(n: State<Node>, space: Id) -> R<()> {
    n.leave_space(space).map_err(e)
}

#[tauri::command(async)]
fn rename_space(n: State<Node>, space: Id, name: String) -> R<()> {
    n.op(
        space,
        OpBody::RenameSpace {
            name: name.trim().into(),
        },
    )
    .map(|_| ())
    .map_err(e)
}

#[tauri::command(async)]
fn create_invite(
    n: State<Node>,
    space: Id,
    expires_in_ms: Option<u64>,
    max_uses: Option<u32>,
) -> R<String> {
    n.create_invite(space, expires_in_ms, max_uses).map_err(e)
}

#[tauri::command(async)]
fn revoke_invite(n: State<Node>, space: Id, invite: Id) -> R<()> {
    n.op(space, OpBody::RevokeInvite { key: invite })
        .map(|_| ())
        .map_err(e)
}

#[tauri::command(async)]
fn create_channel(
    n: State<Node>,
    space: Id,
    name: String,
    kind: ChannelKind,
    private_roles: Option<Vec<Id>>,
) -> R<Id> {
    n.op(
        space,
        OpBody::CreateChannel {
            name: name.trim().into(),
            kind,
            private_roles,
        },
    )
    .map_err(e)
}

#[tauri::command(async)]
fn update_channel(
    n: State<Node>,
    space: Id,
    channel: Id,
    name: String,
    private_roles: Option<Vec<Id>>,
) -> R<()> {
    n.op(
        space,
        OpBody::UpdateChannel {
            channel,
            name: name.trim().into(),
            private_roles,
        },
    )
    .map(|_| ())
    .map_err(e)
}

#[tauri::command(async)]
fn delete_channel(n: State<Node>, space: Id, channel: Id) -> R<()> {
    n.op(space, OpBody::DeleteChannel { channel })
        .map(|_| ())
        .map_err(e)
}

#[tauri::command(async)]
fn create_role(
    n: State<Node>,
    space: Id,
    name: String,
    color: u32,
    perms: Vec<String>,
    rank: u32,
) -> R<Id> {
    let perms = Perms::from_names(&perms).map_err(e)?;
    n.op(
        space,
        OpBody::CreateRole {
            name: name.trim().into(),
            color,
            perms,
            rank,
        },
    )
    .map_err(e)
}

#[tauri::command(async)]
fn update_role(
    n: State<Node>,
    space: Id,
    role: Id,
    name: String,
    color: u32,
    perms: Vec<String>,
    rank: u32,
) -> R<()> {
    let perms = Perms::from_names(&perms).map_err(e)?;
    n.op(
        space,
        OpBody::UpdateRole {
            role,
            name: name.trim().into(),
            color,
            perms,
            rank,
        },
    )
    .map(|_| ())
    .map_err(e)
}

#[tauri::command(async)]
fn delete_role(n: State<Node>, space: Id, role: Id) -> R<()> {
    n.op(space, OpBody::DeleteRole { role })
        .map(|_| ())
        .map_err(e)
}

#[tauri::command(async)]
fn assign_role(n: State<Node>, space: Id, member: Id, role: Id, on: bool) -> R<()> {
    n.op(space, OpBody::AssignRole { member, role, on })
        .map(|_| ())
        .map_err(e)
}

#[tauri::command(async)]
fn kick(n: State<Node>, space: Id, member: Id) -> R<()> {
    n.op(space, OpBody::Kick { member }).map(|_| ()).map_err(e)
}

#[tauri::command(async)]
fn ban(n: State<Node>, space: Id, member: Id, on: bool) -> R<()> {
    n.op(space, OpBody::Ban { member, on })
        .map(|_| ())
        .map_err(e)
}

#[tauri::command(async)]
fn messages(
    n: State<Node>,
    space: Id,
    channel: Id,
    before: Option<u64>,
    limit: usize,
) -> R<Vec<MessageView>> {
    n.messages(space, channel, before, limit).map_err(e)
}

#[tauri::command(async)]
fn send_message(
    n: State<Node>,
    space: Id,
    channel: Id,
    text: String,
    reply_to: Option<Id>,
) -> R<Id> {
    n.send_message(space, channel, &text, reply_to).map_err(e)
}

#[tauri::command(async)]
fn edit_message(n: State<Node>, space: Id, message: Id, text: String) -> R<()> {
    n.edit_message(space, message, &text).map_err(e)
}

#[tauri::command(async)]
fn delete_message(n: State<Node>, space: Id, message: Id) -> R<()> {
    n.delete_message(space, message).map_err(e)
}

#[tauri::command(async)]
fn voice_join(n: State<Node>, space: Id, channel: Id) -> R<()> {
    n.voice_join(space, channel).map_err(e)
}

#[tauri::command(async)]
fn voice_leave(n: State<Node>) {
    n.voice_leave()
}

#[tauri::command(async)]
fn set_muted(n: State<Node>, muted: bool) -> R<()> {
    n.set_muted(muted).map_err(e)
}

#[tauri::command(async)]
fn set_deafened(n: State<Node>, deafened: bool) -> R<()> {
    n.set_deafened(deafened).map_err(e)
}

#[tauri::command(async)]
fn set_ptt(n: State<Node>, down: bool) {
    n.set_ptt(down)
}

#[tauri::command(async)]
fn set_peer_volume(n: State<Node>, member: Id, volume: f32) {
    n.set_peer_volume(member, volume)
}

#[tauri::command(async)]
fn mic_test(n: State<Node>, on: bool) -> R<()> {
    n.mic_test(on).map_err(e)
}

#[tauri::command(async)]
fn audio_devices(n: State<Node>) -> AudioDevices {
    n.audio_devices()
}

#[tauri::command(async)]
fn set_audio_devices(n: State<Node>, input: Option<String>, output: Option<String>) -> R<()> {
    n.set_audio_devices(input, output).map_err(e)
}

#[tauri::command(async)]
fn get_settings(n: State<Node>) -> Settings {
    n.settings()
}

#[tauri::command(async)]
fn set_settings(n: State<Node>, mut settings: Settings) -> R<()> {
    // devices are owned by set_audio_devices; the UI's Settings shape doesn't carry them
    let cur = n.settings();
    (settings.input, settings.output) = (cur.input, cur.output);
    n.set_settings(settings).map_err(e)
}

#[tauri::command(async)]
fn stream_start(n: State<Node>) -> R<()> {
    n.stream_start().map_err(e)
}

/// Raw binary body (no JSON): one stream packet from the encoder.
#[tauri::command(async)]
fn stream_packet(n: State<Node>, request: Request<'_>) -> R<()> {
    match request.body() {
        InvokeBody::Raw(b) => n.stream_packet(b.clone()).map_err(e),
        InvokeBody::Json(_) => Err("stream_packet expects a raw ArrayBuffer body".into()),
    }
}

#[tauri::command(async)]
fn stream_stop(n: State<Node>) {
    n.stream_stop()
}

#[tauri::command(async)]
fn watch(n: State<Node>, member: Id, channel: Channel<InvokeResponseBody>) -> R<()> {
    let sink = Arc::new(move |pkt: Vec<u8>| {
        let _ = channel.send(InvokeResponseBody::Raw(pkt));
    });
    n.watch(member, sink).map_err(e)
}

#[tauri::command(async)]
fn unwatch(n: State<Node>, member: Id) {
    n.unwatch(member)
}

/// Forward core events to the webview. `Changed` bursts collapse into one snapshot per 60 ms.
async fn pump(app: AppHandle, node: Node, mut rx: tokio::sync::mpsc::UnboundedReceiver<Event>) {
    let mut dirty = true;
    loop {
        let ev = if dirty {
            match tokio::time::timeout(Duration::from_millis(60), rx.recv()).await {
                Ok(ev) => ev,
                Err(_) => {
                    let _ = app.emit("snapshot", node.snapshot());
                    dirty = false;
                    continue;
                }
            }
        } else {
            rx.recv().await
        };
        let Some(ev) = ev else { return };
        let _ = match ev {
            Event::Changed => {
                dirty = true;
                Ok(())
            }
            Event::Message(m) => app.emit("message", m),
            Event::Levels(l) => {
                let map: serde_json::Map<String, serde_json::Value> =
                    l.into_iter().map(|(id, v)| (id.hex(), json!(v))).collect();
                app.emit("levels", map)
            }
            Event::Notice { error, text } => app.emit(
                "notice",
                json!({ "kind": if error { "error" } else { "info" }, "text": text }),
            ),
            Event::StreamEnded(m) => app.emit("stream_ended", json!({ "member": m })),
            Event::StreamKeyframe => app.emit("stream_keyframe", json!({})),
            Event::StreamCongested => app.emit("stream_congestion", json!({})),
        };
    }
}

/// `--profile <name>` or HALKA_PROFILE gives an isolated identity/data dir (two instances on one PC).
fn profile() -> Option<String> {
    let mut args = std::env::args();
    while let Some(a) = args.next() {
        if a == "--profile" {
            return args.next();
        }
        if let Some(p) = a.strip_prefix("--profile=") {
            return Some(p.to_string());
        }
    }
    std::env::var("HALKA_PROFILE").ok()
}

/// Keep capture/encode alive while the window is hidden or occluded (sharing a game, etc.).
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Checks GitHub Releases at launch and every 6 h, installs silently, never in the middle of a call.
async fn auto_update(app: AppHandle, node: Node) {
    loop {
        if let Err(err) = try_update(&app, &node).await {
            tracing::warn!("update check failed: {err:#}");
        }
        tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
    }
}

async fn try_update(app: &AppHandle, node: &Node) -> anyhow::Result<()> {
    use tauri_plugin_updater::UpdaterExt;
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    tracing::info!("downloading update {}", update.version);
    let bytes = update.download(|_, _| {}, || {}).await?;
    while node.snapshot().voice.is_some() {
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
    // install() exits the process on Windows (the installer relaunches Halka), so flush first
    node.shutdown().await;
    update.install(bytes)?;
    app.restart();
}

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "warn,halka_core=info".into()),
        )
        .try_init();
    let mut builder = tauri::Builder::default();
    if profile().is_none() {
        // launching Halka again brings the (possibly tray-hidden) window back
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main(app)
        }));
    }
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|w, e| {
            // the close button keeps Halka running in the tray (voice stays connected)
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .setup(|app| {
            let mut dir = app.path().app_data_dir()?;
            if let Some(p) = profile().filter(|p| {
                p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                    && !p.is_empty()
            }) {
                dir = dir.join("profiles").join(p);
            }
            let (node, rx) = match tauri::async_runtime::block_on(Node::start(&dir)) {
                Ok(v) => v,
                // this profile is already running: the open window stays, the duplicate leaves quietly
                Err(err) if format!("{err:#}").contains("already open") => std::process::exit(0),
                Err(err) => return Err(err.into()),
            };
            // per-profile WebView2 data: two profiles can run side by side and never share storage
            // open comfortably inside the work area (never under the taskbar)
            let (mut w, mut h) = (1240.0, 800.0);
            if let Ok(Some(m)) = app.primary_monitor() {
                let (wa, sf) = (m.work_area().size, m.scale_factor());
                w = f64::min(w, wa.width as f64 / sf * 0.9);
                h = f64::min(h, wa.height as f64 / sf * 0.86);
            }
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("Halka")
                .inner_size(w, h)
                .center()
                // our own title bar (window controls live in the web UI)
                .decorations(false)
                .shadow(true)
                .min_inner_size(860.0, 560.0)
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::window::Color(13, 15, 18, 255))
                .data_directory(dir.join("webview"))
                .additional_browser_args(BROWSER_ARGS)
                .build()?;
            let menu = tauri::menu::Menu::with_items(
                app,
                &[
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "show",
                        "Halka'yı aç",
                        true,
                        None::<&str>,
                    )?,
                    &tauri::menu::PredefinedMenuItem::separator(app)?,
                    &tauri::menu::MenuItem::with_id(app, "quit", "Çıkış", true, None::<&str>)?,
                ],
            )?;
            let mut tray = tauri::tray::TrayIconBuilder::with_id("main")
                .tooltip("Halka")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|t, e| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = e
                    {
                        show_main(t.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            app.manage(node.clone());
            // dev builds and side-by-side test profiles never self-update
            if !cfg!(debug_assertions) && profile().is_none() {
                tauri::async_runtime::spawn(auto_update(app.handle().clone(), node.clone()));
            }
            tauri::async_runtime::spawn(pump(app.handle().clone(), node, rx));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            set_name,
            update_profile,
            profile_photo,
            create_space,
            join_space,
            leave_space,
            rename_space,
            create_invite,
            revoke_invite,
            create_channel,
            update_channel,
            delete_channel,
            create_role,
            update_role,
            delete_role,
            assign_role,
            kick,
            ban,
            messages,
            send_message,
            edit_message,
            delete_message,
            voice_join,
            voice_leave,
            set_muted,
            set_deafened,
            set_ptt,
            set_peer_volume,
            mic_test,
            audio_devices,
            set_audio_devices,
            get_settings,
            set_settings,
            stream_start,
            stream_packet,
            stream_stop,
            watch,
            unwatch,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build app")
        .run(|app, ev| {
            if let tauri::RunEvent::Exit = ev {
                let n = app.state::<Node>().inner().clone();
                tauri::async_runtime::block_on(n.shutdown());
            }
        });
}
