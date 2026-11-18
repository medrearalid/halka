use std::sync::Mutex;
use tauri::State;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SW_RESTORE, SetForegroundWindow,
    ShowWindowAsync,
};

#[derive(Default)]
pub struct WatchFocus(Mutex<Option<PreviousWindow>>);

struct PreviousWindow {
    handle: usize,
    process: u32,
    thread: u32,
}

fn window_identity(window: HWND) -> (u32, u32) {
    let mut process = 0;
    let thread = unsafe { GetWindowThreadProcessId(window, Some(&mut process)) };
    (process, thread)
}

impl WatchFocus {
    pub fn remember(&self) {
        let window = unsafe { GetForegroundWindow() };
        let (process, thread) = window_identity(window);
        if thread != 0 && process != std::process::id() {
            // Pressing the shortcut again must not replace the original game window.
            self.0.lock().unwrap().get_or_insert(PreviousWindow {
                handle: window.0 as usize,
                process,
                thread,
            });
        }
    }
}

#[tauri::command]
pub fn return_watch_focus(state: State<'_, WatchFocus>) {
    let Some(previous) = state.0.lock().unwrap().take() else {
        return;
    };
    let current = unsafe { GetForegroundWindow() };
    // A stream can end after the user already switched apps on their own.
    if window_identity(current).0 != std::process::id() {
        return;
    }
    let window = HWND(previous.handle as _);
    if window_identity(window) != (previous.process, previous.thread) {
        return;
    }
    unsafe {
        if IsIconic(window).as_bool() {
            let _ = ShowWindowAsync(window, SW_RESTORE);
        }
        let _ = SetForegroundWindow(window);
    }
}
