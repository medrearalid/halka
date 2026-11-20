//! Shared audio for a window share: WASAPI process loopback (Windows 10 2004+) of that app's
//! process tree only, so watchers never get the voice chat echoed back.
//! shortcut: screen shares carry no audio; EXCLUDE_TARGET_PROCESS_TREE did not exclude Halka's own
//! cpal output in testing (Windows 26300), so "everything but Halka" needs per-session include
//! captures instead.
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use anyhow::{Context, Result};
use halka_core::Node;
use halka_core::voice::StreamAudioEncoder;
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{BLOB, COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows::core::{HRESULT, IUnknown, Interface, Ref, implement};

const RATE: u32 = 48_000;

const FRAME20: usize = RATE as usize / 50 * 2; // interleaved stereo samples

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Activated(mpsc::SyncSender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(
        &self,
        _: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.0.try_send(());
        Ok(())
    }
}

/// Captures until dropped.
pub struct ShareAudio(Arc<AtomicBool>);

impl Drop for ShareAudio {
    fn drop(&mut self) {
        self.0.store(true, Relaxed);
    }
}

pub fn start(node: Node, window_pid: u32) -> ShareAudio {
    let stop = Arc::new(AtomicBool::new(false));
    let handle = ShareAudio(stop.clone());
    let _ = std::thread::Builder::new()
        .name("halka-share-audio".into())
        .spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            if let Err(e) = run(&node, window_pid, &stop) {
                // video still works; the stream is just silent (e.g. Windows older than 2004)
                tracing::warn!("share audio unavailable: {e:#}");
            }
            unsafe { CoUninitialize() };
        });
    handle
}

fn client(pid: u32) -> Result<IAudioClient> {
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // Never PropVariantClear'ed (the windows crate does on drop): the blob points at `params` on this stack.
    let prop = std::mem::ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: &params as *const _ as *mut u8,
                    },
                },
                ..Default::default()
            }),
        },
    });
    let (tx, rx) = mpsc::sync_channel(1);
    let handler: IActivateAudioInterfaceCompletionHandler = Activated(tx).into();
    let op = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*prop),
            &handler,
        )?
    };
    rx.recv_timeout(Duration::from_secs(5))
        .context("process loopback activation timed out")?;
    let (mut hr, mut unknown) = (HRESULT(0), None::<IUnknown>);
    unsafe { op.GetActivateResult(&mut hr, &mut unknown)? };
    hr.ok()?;
    Ok(unknown.context("no audio client")?.cast()?)
}

fn run(node: &Node, window_pid: u32, stop: &AtomicBool) -> Result<()> {
    let mut enc = StreamAudioEncoder::new()?;
    capture(window_pid, stop, |frame| {
        if let Some(dg) = enc.encode(frame) {
            node.stream_audio(dg);
        }
    })
}

/// Hands 20 ms frames of 48 kHz interleaved stereo to `on_frame` until `stop`.
fn capture(window_pid: u32, stop: &AtomicBool, mut on_frame: impl FnMut(&[f32])) -> Result<()> {
    let client = client(window_pid)?;
    // The process-loopback device has no mix format; it converts to the format we ask for.
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: 2,
        nSamplesPerSec: RATE,
        nAvgBytesPerSec: RATE * 4,
        nBlockAlign: 4,
        wBitsPerSample: 16,
        cbSize: 0,
    };
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            200_000, // 20 ms, in 100 ns units
            0,
            &format,
            None,
        )?;
    }
    let event = unsafe { CreateEventW(None, false, false, None)? };
    let result = (|| -> Result<()> {
        unsafe { client.SetEventHandle(event)? };
        let capture: IAudioCaptureClient = unsafe { client.GetService()? };
        let mut pcm: Vec<f32> = Vec::with_capacity(FRAME20 * 4);
        unsafe { client.Start()? };
        while !stop.load(Relaxed) {
            // nothing playing = no packets; the wait just times out
            if unsafe { WaitForSingleObject(event, 100) } != WAIT_OBJECT_0 {
                continue;
            }
            while unsafe { capture.GetNextPacketSize()? } > 0 {
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)? };
                let n = frames as usize * 2;
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    pcm.resize(pcm.len() + n, 0.0);
                } else {
                    let samples = unsafe { std::slice::from_raw_parts(data as *const i16, n) };
                    pcm.extend(samples.iter().map(|s| *s as f32 / 32768.0));
                }
                unsafe { capture.ReleaseBuffer(frames)? };
            }
            let mut sent = 0;
            while pcm.len() - sent >= FRAME20 {
                on_frame(&pcm[sent..sent + FRAME20]);
                sent += FRAME20;
            }
            pcm.drain(..sent);
        }
        unsafe { client.Stop()? };
        Ok(())
    })();
    unsafe {
        let _ = CloseHandle(event);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const HZ: f64 = 1234.0;

    /// Mean amplitude (dBFS) of the 1234 Hz tone over 2 s of `pid`'s loopback audio.
    fn tone_db(pid: u32) -> f64 {
        let stop = AtomicBool::new(false);
        let (mut amp, mut frames) = (0f64, 0);
        let started = std::time::Instant::now();
        capture(pid, &stop, |f| {
            let w = 2.0 * std::f64::consts::PI * HZ / RATE as f64;
            let (mut s1, mut s2) = (0f64, 0f64);
            for x in f.iter().step_by(2) {
                let s0 = *x as f64 + 2.0 * w.cos() * s1 - s2;
                (s2, s1) = (s1, s0);
            }
            let power = s1 * s1 + s2 * s2 - 2.0 * w.cos() * s1 * s2;
            amp += power.max(0.0).sqrt() * 4.0 / f.len() as f64;
            frames += 1;
            if started.elapsed() > Duration::from_secs(2) {
                stop.store(true, Relaxed);
            }
        })
        .unwrap();
        20.0 * (amp / frames.max(1) as f64).max(1e-9).log10()
    }

    fn powershell(command: &str) -> std::process::Child {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", command])
            .spawn()
            .unwrap()
    }

    /// A window share hears its app and nothing else. Needs a 1234 Hz mono WAV of 10 s or more:
    /// `HALKA_TEST_WAV=<tone.wav> cargo test -p halka share_audio -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn share_audio_hears_only_the_shared_app() {
        let wav = std::env::var("HALKA_TEST_WAV").expect("HALKA_TEST_WAV");
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap() };
        let mut app = powershell(&format!(
            "(New-Object Media.SoundPlayer '{wav}').PlaySync()"
        ));
        let mut other = powershell("Start-Sleep 30");
        std::thread::sleep(Duration::from_millis(500));
        let (shared, unrelated) = (tone_db(app.id()), tone_db(other.id()));
        for child in [&mut app, &mut other] {
            let _ = child.kill();
            let _ = child.wait();
        }
        eprintln!("tone: shared app {shared:.1} dBFS, other app {unrelated:.1} dBFS");
        assert!(shared > -50.0, "shared app's audio not captured");
        assert!(
            unrelated < shared - 40.0,
            "another app's audio leaked into the share"
        );
    }
}
