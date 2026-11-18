//! Self-update: checks GitHub Releases, downloads in the background, installs when not in a call.
//! Every step is mirrored to the UI as an `update` event so the title-bar pill can show it.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use halka_core::Node;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Notify;

#[derive(Clone, Serialize, Default)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Status {
    #[default]
    Idle,
    Checking,
    Downloading { version: String, pct: Option<u8> },
    Ready { version: String },
    /// `detail` is the raw error, shown on hover so a failure can be diagnosed without a console.
    Error { message: String, detail: String },
}

#[derive(Default)]
pub struct Updater {
    status: Mutex<Status>,
    retry: Notify,
    now: Notify,
    /// the next attempt was asked for by the user, so a failed check is worth showing
    manual: AtomicBool,
}

fn set(app: &AppHandle, s: Status) {
    *app.state::<Updater>().status.lock().unwrap() = s.clone();
    let _ = app.emit("update", s);
}

#[tauri::command]
pub fn update_status(u: State<Updater>) -> Status {
    u.status.lock().unwrap().clone()
}

/// Check again right away (also cuts a failure back-off short).
#[tauri::command]
pub fn update_retry(u: State<Updater>) {
    u.manual.store(true, Ordering::Relaxed);
    u.retry.notify_one();
}

/// Install the downloaded update now instead of waiting for the call to end.
#[tauri::command]
pub fn update_restart_now(u: State<Updater>) {
    u.now.notify_one();
}

/// Waits after a failed attempt: short at first so a flaky network doesn't cost 6 h.
fn backoff(fails: u32) -> Duration {
    match fails {
        0 => Duration::from_secs(6 * 3600),
        1 => Duration::from_secs(5 * 60),
        2 => Duration::from_secs(30 * 60),
        _ => Duration::from_secs(6 * 3600),
    }
}

/// Runs at launch and every 6 h (sooner after a failure). Never returns.
pub async fn run(app: AppHandle, node: Node) {
    let mut fails = 0;
    loop {
        let u = app.state::<Updater>();
        let manual = u.manual.swap(false, Ordering::Relaxed);
        match attempt(&app, &node).await {
            Ok(()) => fails = 0,
            Err(err) => {
                tracing::warn!("update failed: {err:#}");
                fails += 1;
                let checking = matches!(*u.status.lock().unwrap(), Status::Checking);
                if checking && !manual {
                    // a background check that fails is retried soon; nothing to bother the user with
                    set(&app, Status::Idle);
                } else {
                    let message = if checking { "Güncellemeler denetlenemedi".into() } else { friendly(&err) };
                    set(&app, Status::Error { message, detail: format!("{err:#}") });
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff(fails)) => {}
            _ = u.retry.notified() => {}
        }
    }
}

fn friendly(err: &anyhow::Error) -> String {
    let s = format!("{err:#}").to_lowercase();
    if s.contains("signature") {
        "Güncelleme doğrulanamadı".into()
    } else if s.contains("network") || s.contains("request") || s.contains("connect") || s.contains("dns") {
        "Güncelleme sunucusuna ulaşılamadı".into()
    } else {
        "Güncelleme indirilemedi".into()
    }
}

async fn attempt(app: &AppHandle, node: &Node) -> anyhow::Result<()> {
    set(app, Status::Checking);
    let Some(update) = app.updater()?.check().await? else {
        set(app, Status::Idle);
        return Ok(());
    };
    let version = update.version.clone();
    tracing::info!("downloading update {version}");
    set(app, Status::Downloading { version: version.clone(), pct: None });
    let (mut got, mut last) = (0u64, Instant::now());
    // download() also verifies the minisign signature, so a bad file never reaches install()
    let bytes = update
        .download(
            |chunk, total| {
                got += chunk as u64;
                if last.elapsed() >= Duration::from_millis(250) {
                    last = Instant::now();
                    let pct = total.filter(|t| *t > 0).map(|t| (got * 100 / t).min(100) as u8);
                    set(app, Status::Downloading { version: version.clone(), pct });
                }
            },
            || {},
        )
        .await?;
    set(app, Status::Ready { version: version.clone() });

    let u = app.state::<Updater>();
    while node.snapshot().voice.is_some() {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(30)) => {}
            _ = u.now.notified() => break,
        }
    }
    // install() exits the process on Windows (the installer relaunches Halka), so flush first
    node.shutdown().await;
    if let Err(err) = update.install(bytes) {
        // the node is already shut down: start fresh rather than limp on without a network
        tracing::error!("update install failed: {err:#}");
        app.restart();
    }
    app.restart();
}
