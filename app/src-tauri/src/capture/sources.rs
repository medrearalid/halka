use anyhow::{Context, Result};
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

unsafe extern "system" fn enum_window(window: HWND, data: LPARAM) -> BOOL {
    let windows = unsafe { &mut *(data.0 as *mut Vec<Source>) };
    let mut pid = 0;
    let tid = unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    if pid == std::process::id()
        || tid == 0
        || !unsafe { IsWindowVisible(window) }.as_bool()
        || unsafe { IsIconic(window) }.as_bool()
        || (unsafe { GetWindowLongW(window, GWL_EXSTYLE) } as u32 & WS_EX_TOOLWINDOW.0) != 0
    {
        return true.into();
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
    if cloaked != 0 || affinity != 0 {
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

pub fn resolve(id: &str) -> Result<(GraphicsCaptureItem, u32)> {
    let source = list()?
        .into_iter()
        .find(|source| source.id == id)
        .context("Seçilen ekran veya pencere artık kullanılabilir değil.")?;
    let handle = source
        .id
        .split(':')
        .nth(1)
        .context("Kaynak kimliği geçersiz.")?;
    let handle = usize::from_str_radix(handle, 16)? as *mut core::ffi::c_void;
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    unsafe {
        if source.kind == "monitor" {
            Ok((interop.CreateForMonitor(HMONITOR(handle))?, source.fps))
        } else {
            let window = HWND(handle);
            let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
            let fps = display(monitor).as_ref().map_or(60, refresh);
            Ok((interop.CreateForWindow(window)?, fps))
        }
    }
}
