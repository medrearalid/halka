use std::sync::Mutex;
use tauri::{State, WebviewWindow};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SW_RESTORE, SetForegroundWindow,
    ShowWindowAsync,
};

#[derive(Default)]
pub struct WatchFocus(Mutex<Option<WatchSession>>);

struct WatchSession {
    previous: Option<PreviousWindow>,
}

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
    pub fn is_watching(&self) -> bool {
        self.0.lock().unwrap().is_some()
    }

    pub fn begin(&self) {
        let window = unsafe { GetForegroundWindow() };
        let (process, thread) = window_identity(window);
        self.0.lock().unwrap().get_or_insert_with(|| WatchSession {
            previous: (thread != 0 && process != std::process::id()).then_some(PreviousWindow {
                handle: window.0 as usize,
                process,
                thread,
            }),
        });
    }
}

#[tauri::command]
pub fn return_watch_focus(
    window: WebviewWindow,
    state: State<'_, WatchFocus>,
    user_initiated: bool,
) {
    let Some(session) = state.0.lock().unwrap().take() else {
        return;
    };
    let _ = window.set_fullscreen(false);
    let Some(previous) = session.previous else {
        return;
    };
    let current = unsafe { GetForegroundWindow() };
    // A stream can end after the user already switched apps on their own.
    if !user_initiated && window_identity(current).0 != std::process::id() {
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
