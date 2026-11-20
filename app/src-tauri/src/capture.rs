//! Windows Graphics Capture producer for the existing Halka stream protocol.
mod audio;
mod encode;
mod feedback;
mod sources;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use halka_core::{Node, id::Id};
use tauri::ipc::{Channel, InvokeResponseBody, JavaScriptChannelId};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureSession};
use windows::Graphics::DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::{MF_VERSION, MFSTARTUP_LITE, MFShutdown, MFStartup};
use windows::Win32::System::WinRT::{
    Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
    RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize,
};
use windows::core::Interface;

use encode::{Device, Encoder, Mode};
use feedback::Feedback;
use sources::{Source, Target};

#[derive(Default, Clone)]
pub struct CaptureState(Arc<Mutex<CaptureSlot>>);

#[derive(Default)]
struct CaptureSlot {
    session: Option<Arc<Session>>,
    cancelled: std::collections::VecDeque<String>,
}

#[derive(Default)]
struct Session {
    id: String,
    cancelled: AtomicBool,
    key: AtomicBool,
    congested: AtomicBool,
    preview: Mutex<Option<Channel<InvokeResponseBody>>>,
}

impl CaptureState {
    pub fn cancel(&self) -> bool {
        if let Some(session) = &self.0.lock().unwrap().session {
            session.cancelled.store(true, Relaxed);
            return true;
        }
        false
    }

    pub fn feedback(&self, congestion: bool) {
        if let Some(session) = &self.0.lock().unwrap().session {
            session.key.store(true, Relaxed);
            if congestion {
                session.congested.store(true, Relaxed);
            }
        }
    }
}

#[tauri::command]
pub async fn capture_sources() -> super::R<Vec<Source>> {
    tauri::async_runtime::spawn_blocking(|| {
        let _runtime = Runtime::winrt().map_err(super::e)?;
        if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
            return Err("Bu Windows sürümünde ekran yakalama desteklenmiyor.".into());
        }
        sources::list().map_err(super::e)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn capture_start(
    app: AppHandle,
    node: State<'_, Node>,
    state: State<'_, CaptureState>,
    id: String,
    source: String,
    preset: String,
) -> super::R<()> {
    spawn_capture(
        app,
        node.inner(),
        state.inner(),
        id,
        Target::Listed(source),
        preset,
        false,
    )?
    .await
    .map_err(|_| "Ekran paylaşımı başlatılamadı.".to_owned())?
}

pub fn quick_share(app: &AppHandle, node: &Node) {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let state = app.state::<CaptureState>();
    if state.cancel() {
        return;
    }
    // Take both handles in the shortcut callback, before any background work or focus change.
    let result = sources::foreground()
        .map_err(super::e)
        .and_then(|foreground| {
            let target = foreground.target(node.settings().quick_share_full_screen);
            let id = format!("hotkey-{}", SEQUENCE.fetch_add(1, Relaxed));
            spawn_capture(
                app.clone(),
                node,
                &state,
                id,
                target,
                "balanced".into(),
                true,
            )
        });
    match result {
        Ok(ready) => {
            // The worker reports quick-share completion via capture_ended.
            drop(ready);
        }
        Err(text) => {
            let _ = app.emit(
                "notice",
                serde_json::json!({ "kind": "error", "text": text }),
            );
        }
    }
}

fn spawn_capture(
    app: AppHandle,
    node: &Node,
    state: &CaptureState,
    id: String,
    target: Target,
    preset: String,
    quick: bool,
) -> super::R<tokio::sync::oneshot::Receiver<super::R<()>>> {
    let room = node.stream_room().map_err(super::e)?;
    let node = node.clone();
    let state = state.clone();
    let session = Arc::new(Session {
        id,
        ..Default::default()
    });
    {
        let mut slot = state.0.lock().unwrap();
        if let Some(index) = slot.cancelled.iter().position(|id| id == &session.id) {
            slot.cancelled.remove(index);
            return Err("Ekran paylaşımı iptal edildi.".into());
        }
        if slot.session.is_some() {
            return Err("Önceki ekran paylaşımı kapanıyor. Biraz sonra tekrar dene.".into());
        }
        slot.session = Some(session.clone());
    }
    if quick {
        let _ = app.emit(
            "capture_quick_started",
            serde_json::json!({ "id": session.id }),
        );
    }
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let mut ready = Some(ready_tx);
        let mut live = false;
        let mut feedback = Feedback {
            app: &app,
            monitor: None,
        };
        let result = run(
            &session,
            &node,
            room,
            &target,
            &preset,
            &mut ready,
            &mut live,
            &mut feedback,
        );
        if live {
            node.stream_stop_in(Some(room));
        }
        if ready.is_none() {
            feedback.send(false);
        }
        state.0.lock().unwrap().session = None;
        let error = result.err().map(|error| super::e(error));
        if let Some(ready) = ready.filter(|_| !quick) {
            let _ = ready.send(Err(
                error.unwrap_or_else(|| "Ekran paylaşımı iptal edildi.".into())
            ));
        } else {
            let _ = app.emit(
                "capture_ended",
                serde_json::json!({ "id": session.id, "error": error }),
            );
        }
    });
    Ok(ready_rx)
}

#[tauri::command]
pub fn capture_stop(state: State<'_, CaptureState>, id: String) {
    let mut slot = state.0.lock().unwrap();
    if let Some(session) = slot.session.as_ref().filter(|session| session.id == id) {
        session.cancelled.store(true, Relaxed);
    } else if !slot.cancelled.contains(&id) {
        // A synchronous stop command can reach Tauri before its asynchronous start command.
        if slot.cancelled.len() >= 32 {
            slot.cancelled.pop_front();
        }
        slot.cancelled.push_back(id);
    }
}

#[tauri::command]
pub fn capture_preview(
    state: State<'_, CaptureState>,
    webview: Webview,
    id: String,
    preview: Option<JavaScriptChannelId>,
) {
    if let Some(session) = state
        .0
        .lock()
        .unwrap()
        .session
        .as_ref()
        .filter(|session| session.id == id)
    {
        let enabled = preview.is_some();
        *session.preview.lock().unwrap() = preview.map(|preview| preview.channel_on(webview));
        if enabled {
            session.key.store(true, Relaxed);
        }
    }
}

struct Runtime(bool);

impl Runtime {
    fn winrt() -> Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
        Ok(Self(false))
    }

    fn media() -> Result<Self> {
        let mut runtime = Self::winrt()?;
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE)? };
        runtime.0 = true;
        Ok(runtime)
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            if self.0 {
                let _ = MFShutdown();
            }
            RoUninitialize();
        }
    }
}

fn packet(kind: u8, timestamp: i64, payload: &[u8]) -> Vec<u8> {
    let mut data = Vec::with_capacity(9 + payload.len());
    data.push(kind);
    data.extend_from_slice(&(timestamp.max(0) as u64 / 10).to_le_bytes());
    data.extend_from_slice(payload);
    data
}

fn latest(
    pool: &Direct3D11CaptureFramePool,
) -> windows::core::Result<Option<windows::Graphics::Capture::Direct3D11CaptureFrame>> {
    let mut current = None;
    for _ in 0..2 {
        match pool.TryGetNextFrame() {
            Ok(frame) => current = Some(frame),
            // The windows binding maps a successful call with no frame to an empty error.
            Err(error) if error.code().is_ok() => break,
            Err(error) => return Err(error),
        }
    }
    Ok(current)
}

struct Capture {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

fn run(
    state: &Session,
    node: &Node,
    room: Id,
    target: &Target,
    preset: &str,
    ready: &mut Option<tokio::sync::oneshot::Sender<super::R<()>>>,
    live: &mut bool,
    feedback: &mut Feedback<'_>,
) -> Result<()> {
    let _runtime = Runtime::media().context("Windows yakalama bileşenleri hazırlanamadı")?;
    let (item, refresh, monitor) = sources::resolve(target)?;
    feedback.monitor = monitor;
    if state.cancelled.load(Relaxed) {
        return Ok(());
    }
    let device = Device::new().context("Grafik aygıtı hazırlanamadı")?;
    let capture_device: IDirect3DDevice = unsafe {
        CreateDirect3D11DeviceFromDXGIDevice(&device.raw.cast::<IDXGIDevice>()?)?.cast()?
    };
    let closed = Arc::new(AtomicBool::new(false));
    let closed_event = closed.clone();
    item.Closed(&windows::Foundation::TypedEventHandler::new(move |_, _| {
        closed_event.store(true, Relaxed);
        Ok(())
    }))?;
    let mut size = item.Size()?;
    let mut modes = Mode::candidates(size, refresh, preset)?;
    let format = DirectXPixelFormat::B8G8R8A8UIntNormalized;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&capture_device, format, 2, size)?;
    let capture = Capture {
        session: pool.CreateCaptureSession(&item)?,
        pool,
    };
    // Request full-rate capture where this newer Windows property is available.
    let _ = capture
        .session
        .SetMinUpdateInterval(windows::Foundation::TimeSpan { Duration: 0 });
    let (wake, frames) = std::sync::mpsc::sync_channel(1);
    capture
        .pool
        .FrameArrived(&windows::Foundation::TypedEventHandler::new(move |_, _| {
            let _ = wake.try_send(());
            Ok(())
        }))?;
    if state.cancelled.load(Relaxed) {
        return Ok(());
    }
    let mut borderless = feedback::borderless_allowed();
    if borderless {
        let _ = capture.session.SetIsBorderRequired(false);
    }
    capture.session.StartCapture()?;
    let _audio = sources::window_pid(target).map(|pid| audio::start(node.clone(), pid));
    // The frame pool can get the first image while Media Foundation opens the encoder.
    let (mut rung, mut encoder) = Encoder::select(&device, size, &modes, 0)?;

    let start = Instant::now();
    let mut changed = start;
    let mut checked_room = start;
    let mut config = None;
    let mut last_key = None;
    let mut awaiting_key = true;
    let mut key_attempt = None;
    let mut next_frame_due = None;
    let mut saved_frame = None;
    let mut captured_at = None;
    let mut sent_frames = 0u32;
    let mut overloaded = 0u32;
    let mut rate = encoder.mode.bitrate;
    while !state.cancelled.load(Relaxed) && !closed.load(Relaxed) {
        if !borderless && feedback::borderless_allowed() {
            borderless = true;
            let _ = capture.session.SetIsBorderRequired(false);
        }
        if checked_room.elapsed() >= Duration::from_millis(250) {
            if node.stream_room().ok() != Some(room) {
                return Ok(());
            }
            checked_room = Instant::now();
        }
        ensure!(
            *live || start.elapsed() < Duration::from_secs(8),
            "İlk görüntü alınamadı. Kaynağın görünür olduğunu kontrol et."
        );

        // Coalesce congestion from multiple watchers and leave time for each adjustment to take effect.
        let mut next_rung = rung;
        let mut next_rate = rate;
        let busy = overloaded > 8 && overloaded > sent_frames / 4;
        if changed.elapsed() >= Duration::from_secs(2)
            && (state.congested.swap(false, Relaxed) || busy)
        {
            let floor = encoder.mode.bitrate / 3;
            if rate > floor && !busy {
                next_rate = (rate * 7 / 10).max(floor);
            } else if rung + 1 < modes.len() {
                next_rung += 1;
                next_rate = modes[next_rung].bitrate.min(rate);
            }
            changed = Instant::now();
            overloaded = 0;
            sent_frames = 0;
        } else if changed.elapsed() >= Duration::from_secs(8) {
            if rate < encoder.mode.bitrate {
                next_rate = (rate * 115 / 100).min(encoder.mode.bitrate);
            } else if rung > 0 {
                next_rung -= 1;
                next_rate = modes[next_rung].bitrate.min(rate);
            }
            changed = Instant::now();
            overloaded = 0;
            sent_frames = 0;
        }
        if next_rung != rung || next_rate != rate {
            if next_rung == rung && encoder.set_rate(next_rate) {
                rate = next_rate;
            } else if let Ok(replacement) = Encoder::new(&device, size, modes[next_rung], next_rate)
            {
                encoder = replacement;
                rung = next_rung;
                rate = next_rate;
                config = None;
                last_key = None;
                key_attempt = None;
            }
        }

        for chunk in encoder.output()? {
            if state.cancelled.load(Relaxed) {
                return Ok(());
            }
            if chunk.data.len() > 4 * 1024 * 1024 - 9 {
                last_key = None;
                config = None;
                key_attempt = None;
                state.congested.store(true, Relaxed);
                continue;
            }
            let preview = state.preview.lock().unwrap().clone();
            if chunk.key {
                last_key = Some(chunk.timestamp);
                awaiting_key = false;
                let codec = chunk
                    .codec
                    .context("Kodlayıcı H.264 akış bilgisi üretmedi")?;
                let mode = encoder.mode;
                let header = serde_json::to_vec(&serde_json::json!({
                    "codec": codec, "width": mode.width, "height": mode.height
                }))?;
                if !*live {
                    node.stream_start_in(Some(room))?;
                    *live = true;
                }
                if config.as_ref() != Some(&header) {
                    node.stream_packet(packet(0, 0, &header))?;
                }
                if let Some(preview) = &preview {
                    let _ = preview.send(InvokeResponseBody::Raw(packet(0, 0, &header)));
                }
                config = Some(header);
            } else if config.is_none() {
                continue;
            }
            let data = packet(if chunk.key { 1 } else { 2 }, chunk.timestamp, &chunk.data);
            if let Some(preview) = &preview {
                let _ = preview.send(InvokeResponseBody::Raw(data.clone()));
            }
            node.stream_packet(data)?;
            if let Some(tx) = ready.take() {
                feedback.send(true);
                let _ = tx.send(Ok(()));
                feedback::request_borderless();
            }
        }

        // The callback has capacity for one wake-up. The encoder always takes the newest frame.
        let _ = frames.recv_timeout(Duration::from_millis(if encoder.pending() {
            2
        } else {
            20
        }));
        let frame = latest(&capture.pool)?;
        let time = if let Some(captured) = &frame {
            let next_size = captured.ContentSize()?;
            if next_size.Width < 2 || next_size.Height < 2 {
                continue;
            }
            if next_size != size {
                drop(frame);
                size = next_size;
                capture.pool.Recreate(&capture_device, format, 2, size)?;
                modes = Mode::candidates(size, refresh, preset)?;
                (rung, encoder) =
                    Encoder::select(&device, size, &modes, rung.min(modes.len() - 1))?;
                rate = encoder.mode.bitrate;
                config = None;
                last_key = None;
                key_attempt = None;
                saved_frame = None;
                captured_at = None;
                next_frame_due = None;
                continue;
            }
            captured.SystemRelativeTime()?.Duration
        } else if let Some((timestamp, instant)) = captured_at {
            // A static desktop may not generate another frame for a late watcher.
            if !state.key.load(Relaxed) && !awaiting_key && config.is_some() {
                continue;
            }
            timestamp + (Instant::now().duration_since(instant).as_nanos() / 100) as i64
        } else {
            continue;
        };
        let interval = 10_000_000 / i64::from(encoder.mode.fps);
        if next_frame_due.is_some_and(|due| time + interval / 10 < due) {
            continue;
        }
        if !encoder.accepts_input() {
            if frame.is_some() {
                overloaded = overloaded.saturating_add(1);
            }
            continue;
        }
        if let Some(frame) = frame {
            let texture: ID3D11Texture2D = unsafe {
                frame
                    .Surface()?
                    .cast::<IDirect3DDxgiInterfaceAccess>()?
                    .GetInterface()?
            };
            device.save_frame(&texture, &mut saved_frame)?;
            captured_at = Some((time, Instant::now()));
        }
        let periodic_key = last_key.is_none_or(|last| time - last >= 20_000_000);
        awaiting_key |= state.key.swap(false, Relaxed) || periodic_key;
        let key = awaiting_key && key_attempt.is_none_or(|last| time - last >= 2_500_000);
        if key {
            key_attempt = Some(time);
        }
        let submitting = Instant::now();
        encoder.submit(
            saved_frame.as_ref().context("Yakalanan video yüzeyi yok")?,
            time,
            key,
        )?;
        if submitting.elapsed().as_nanos() > interval as u128 * 100 {
            overloaded = overloaded.saturating_add(1);
        }
        let due = next_frame_due.unwrap_or(time);
        next_frame_due = Some((due + interval).max(time + interval / 10));
        sent_frames += 1;
    }
    ensure!(
        *live || !closed.load(Relaxed),
        "Seçilen ekran veya pencere kapandı."
    );
    Ok(())
}
