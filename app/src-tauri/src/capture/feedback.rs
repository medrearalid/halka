use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use anyhow::{Result, ensure};
use tauri::{AppHandle, Emitter};
use windows::Graphics::Capture::{GraphicsCaptureAccess, GraphicsCaptureAccessKind};
use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{PCWSTR, w};

static ACCESS_REQUESTED: AtomicBool = AtomicBool::new(false);
static BORDERLESS_ALLOWED: AtomicBool = AtomicBool::new(false);
static LAST_PULSE: AtomicU64 = AtomicU64::new(0);
const CLASS: PCWSTR = w!("HalkaCaptureFeedback");
const PULSE: Duration = Duration::from_millis(460);
const HOLD: Duration = Duration::from_millis(110);

pub fn request_borderless() {
    if ACCESS_REQUESTED.swap(true, Relaxed) {
        return;
    }
    // A system consent prompt must never delay the encoder or the first published frame.
    tauri::async_runtime::spawn_blocking(|| {
        let Ok(_runtime) = super::Runtime::winrt() else {
            return;
        };
        if let Ok(request) =
            GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)
        {
            BORDERLESS_ALLOWED.store(
                request.join().ok() == Some(AppCapabilityAccessStatus::Allowed),
                Relaxed,
            );
        }
    });
}

pub fn borderless_allowed() -> bool {
    BORDERLESS_ALLOWED.load(Relaxed)
}

pub struct Feedback<'a> {
    pub app: &'a AppHandle,
    pub monitor: Option<RECT>,
}

impl Feedback<'_> {
    pub fn send(&self, live: bool) {
        let _ = self
            .app
            .emit("capture_feedback", serde_json::json!({ "live": live }));
        let pulse = LAST_PULSE.fetch_add(1, Relaxed) + 1;
        let monitor = if live {
            self.monitor
        } else {
            super::sources::foreground_monitor().or(self.monitor)
        };
        if let Some(rect) = monitor {
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = show_frame(rect, live, pulse) {
                    tracing::debug!("capture feedback frame: {error:#}");
                }
            });
        }
    }
}

struct FrameWindow(HWND);

impl Drop for FrameWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

fn show_frame(rect: RECT, live: bool, pulse: u64) -> Result<()> {
    if LAST_PULSE.load(Relaxed) != pulse {
        return Ok(());
    }
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    let thickness = (height / 180).clamp(4, 8);
    ensure!(
        width > thickness * 2 && height > thickness * 2,
        "Invalid monitor bounds"
    );
    unsafe {
        let module = HINSTANCE(GetModuleHandleW(None)?.0);
        static REGISTERED: OnceLock<u16> = OnceLock::new();
        let class = REGISTERED.get_or_init(|| {
            RegisterClassW(&WNDCLASSW {
                lpfnWndProc: Some(frame_proc),
                hInstance: module,
                lpszClassName: CLASS,
                ..Default::default()
            })
        });
        ensure!(*class != 0, "Could not register the frame window");
        let window = FrameWindow(CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            CLASS,
            None,
            WS_POPUP,
            rect.left,
            rect.top,
            width,
            height,
            None,
            None,
            Some(module),
            None,
        )?);
        let hwnd = window.0;
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)?;
        // COLORREF uses BGR byte order. These are the sRGB values of --live and --danger.
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, if live { 0x8acc6e } else { 0x5d68e7 });
        let outer = CreateRectRgn(0, 0, width, height);
        let inner = CreateRectRgn(thickness, thickness, width - thickness, height - thickness);
        let shaped = !outer.0.is_null()
            && !inner.0.is_null()
            && CombineRgn(Some(outer), Some(outer), Some(inner), RGN_DIFF).0 != 0
            && SetWindowRgn(hwnd, Some(outer), false) != 0;
        let _ = DeleteObject(inner.into());
        if !shaped {
            let _ = DeleteObject(outer.into());
            anyhow::bail!("Could not shape the frame window");
        }
        // Windows owns the outer region after SetWindowRgn succeeds.
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 235, LWA_ALPHA)?;
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )?;

        let shown = Instant::now();
        while shown.elapsed() < PULSE && LAST_PULSE.load(Relaxed) == pulse {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                DispatchMessageW(&message);
            }
            let fade =
                shown.elapsed().saturating_sub(HOLD).as_secs_f32() / (PULSE - HOLD).as_secs_f32();
            let alpha = (235.0 * (1.0 - fade).clamp(0.0, 1.0).powi(2)) as u8;
            SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA)?;
            std::thread::sleep(Duration::from_millis(16));
        }
    }
    Ok(())
}

unsafe extern "system" fn frame_proc(
    window: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        match msg {
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let dc = BeginPaint(window, &mut paint);
                let brush =
                    CreateSolidBrush(COLORREF(GetWindowLongPtrW(window, GWLP_USERDATA) as u32));
                FillRect(dc, &paint.rcPaint, brush);
                let _ = DeleteObject(brush.into());
                let _ = EndPaint(window, &paint);
                LRESULT(0)
            }
            WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
            _ => DefWindowProcW(window, msg, wparam, lparam),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires an interactive Windows desktop"]
    fn capture_feedback_windows_open_and_close() -> Result<()> {
        let rect = RECT {
            left: 20,
            top: 20,
            right: 220,
            bottom: 140,
        };
        for live in [true, false] {
            let pulse = LAST_PULSE.fetch_add(1, Relaxed) + 1;
            show_frame(rect, live, pulse)?;
            assert!(unsafe { FindWindowW(CLASS, None) }.is_err());
        }
        Ok(())
    }
}
