use anyhow::{Context, Result, ensure};
use serde::Serialize;
use windows::Graphics::Capture::GraphicsCaptureItem;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::{Dwm::*, Gdi::*};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{BOOL, PCWSTR, factory};

#[derive(Serialize)]
pub struct Source {
    id: String,
    kind: &'static str,
    title: String,
    width: u32,
    height: u32,
    fps: u32,
}

pub enum Target {
    Listed(String),
    Window { handle: usize, pid: u32, tid: u32 },
    Monitor(usize),
}

pub struct Foreground {
    window: Target,
    monitor: Target,
}

impl Foreground {
    pub fn target(self, full_screen: bool) -> Target {
        if full_screen {
            self.monitor
        } else {
            self.window
        }
    }
}

pub fn foreground() -> Result<Foreground> {
    let window = unsafe { GetForegroundWindow() };
    ensure!(
        !window.0.is_null(),
        "Önde paylaşılabilecek bir pencere bulunamadı."
    );
    let mut pid = 0;
    let tid = unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    let monitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) };
    Ok(Foreground {
        window: Target::Window {
            handle: window.0 as usize,
            pid,
            tid,
        },
        monitor: Target::Monitor(monitor.0 as usize),
    })
}

pub fn foreground_monitor() -> Option<RECT> {
    let window = unsafe { GetForegroundWindow() };
    if window.0.is_null() {
        return None;
    }
    let monitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) };
    display(monitor).map(|info| info.monitorInfo.rcMonitor)
}

fn display(monitor: HMONITOR) -> Option<MONITORINFOEXW> {
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }
        .as_bool()
        .then_some(info)
}

fn refresh(info: &MONITORINFOEXW) -> u32 {
    let mut mode = DEVMODEW {
        dmSize: size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };
    if unsafe {
        EnumDisplaySettingsW(
            PCWSTR(info.szDevice.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut mode,
        )
    }
    .as_bool()
        && mode.dmDisplayFrequency > 1
    {
        mode.dmDisplayFrequency
    } else {
        60
    }
}

unsafe extern "system" fn enum_monitor(
    monitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let displays = unsafe { &mut *(data.0 as *mut Vec<Source>) };
    if let Some(info) = display(monitor) {
        let rect = info.monitorInfo.rcMonitor;
        displays.push(Source {
            id: format!("monitor:{:x}", monitor.0 as usize),
            kind: "monitor",
            title: format!("Ekran {}", displays.len() + 1),
            width: (rect.right - rect.left) as u32,
            height: (rect.bottom - rect.top) as u32,
            fps: refresh(&info),
        });
    }
    true.into()
}

fn window_identity(window: HWND) -> Option<(u32, u32)> {
    let mut pid = 0;
    let tid = unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    if tid == 0
        || !unsafe { IsWindowVisible(window) }.as_bool()
        || unsafe { IsIconic(window) }.as_bool()
    {
        return None;
    }
    let mut cloaked = 0u32;
    let _ = unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED,
            (&mut cloaked as *mut u32).cast(),
            size_of::<u32>() as u32,
        )
    };
    let mut affinity = 0;
    let _ = unsafe { GetWindowDisplayAffinity(window, &mut affinity) };
    (cloaked == 0 && affinity == 0).then_some((pid, tid))
}

unsafe extern "system" fn enum_window(window: HWND, data: LPARAM) -> BOOL {
    let windows = unsafe { &mut *(data.0 as *mut Vec<Source>) };
    let Some((pid, tid)) = window_identity(window) else {
        return true.into();
    };
    if pid == std::process::id()
        || (unsafe { GetWindowLongW(window, GWL_EXSTYLE) } as u32 & WS_EX_TOOLWINDOW.0) != 0
    {
        return true.into();
    }
    let mut title = [0; 512];
    let length = unsafe { GetWindowTextW(window, &mut title) } as usize;
    let title = String::from_utf16_lossy(&title[..length]);
    if !title.trim().is_empty() {
        windows.push(Source {
            id: format!("window:{:x}:{pid}:{tid}", window.0 as usize),
            kind: "window",
            title,
            width: 0,
            height: 0,
            fps: 0,
        });
    }
    true.into()
}

pub fn list() -> Result<Vec<Source>> {
    let mut sources = Vec::new();
    let data = LPARAM((&mut sources as *mut Vec<Source>) as isize);
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(enum_monitor), data);
        EnumWindows(Some(enum_window), data)?;
    }
    Ok(sources)
}

pub fn resolve(target: &Target) -> Result<(GraphicsCaptureItem, u32, Option<RECT>)> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    match target {
        Target::Listed(id) => {
            let source = list()?
                .into_iter()
                .find(|source| source.id == *id)
                .context("Seçilen ekran veya pencere artık kullanılabilir değil.")?;
            let mut parts = source.id.split(':').skip(1);
            let handle =
                usize::from_str_radix(parts.next().context("Kaynak kimliği geçersiz.")?, 16)?;
            let target = if source.kind == "monitor" {
                Target::Monitor(handle)
            } else {
                let pid = parts.next().context("Kaynak kimliği geçersiz.")?.parse()?;
                let tid = parts.next().context("Kaynak kimliği geçersiz.")?.parse()?;
                Target::Window { handle, pid, tid }
            };
            resolve(&target)
        }
        Target::Monitor(handle) => {
            let monitor = HMONITOR(*handle as _);
            let info = display(monitor).context("Seçilen ekran artık kullanılabilir değil.")?;
            Ok((
                unsafe { interop.CreateForMonitor(monitor)? },
                refresh(&info),
                Some(info.monitorInfo.rcMonitor),
            ))
        }
        Target::Window { handle, pid, tid } => {
            let window = HWND(*handle as _);
            ensure!(
                window_identity(window) == Some((*pid, *tid)),
                "Seçilen pencere artık paylaşılabilir değil."
            );
            let monitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) };
            let info = display(monitor);
            let fps = info.as_ref().map_or(60, refresh);
            Ok((
                unsafe { interop.CreateForWindow(window)? },
                fps,
                info.map(|info| info.monitorInfo.rcMonitor),
            ))
        }
    }
}
