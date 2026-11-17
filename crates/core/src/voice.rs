//! Native voice engine.
//!
//! capture (cpal, any rate) -> 48 kHz mono -> sonora (AEC3 + NS + AGC2, 10 ms frames)
//!   -> VAD / push-to-talk gate -> Opus 20 ms -> datagram callback
//! datagram -> per-peer Opus decode (+PLC) -> jitter buffer -> stereo mix with seat panning
//!   -> playback (cpal) and the AEC render reference.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;
use ringbuf::HeapRb;
use ringbuf::traits::{Consumer, Producer, Split};

use crate::id::Id;
use crate::wire::DG_VOICE;

const RATE: u32 = 48_000;
const FRAME10: usize = 480;
const FRAME20: usize = 960;
/// Jitter buffer: start playing once this much is queued, cap queue at MAX to bound latency.
const PRIME: usize = FRAME20 * 2;
const MAX_QUEUE: usize = FRAME20 * 10;
/// Voice-activity hangover so word endings aren't clipped.
const HANGOVER_FRAMES: u32 = 20;

pub type SendFn = Box<dyn Fn(Vec<u8>) + Send + Sync>;

#[derive(Clone, Debug)]
pub struct VoiceOptions {
    pub input: Option<String>,
    pub output: Option<String>,
    pub noise_suppression: bool,
    pub echo_cancellation: bool,
    pub push_to_talk: bool,
    /// KeyboardEvent.code (or "Mouse4"/"Mouse5"); polled globally so PTT works while gaming.
    pub ptt_key: String,
    pub vad_threshold: f32,
}

struct Peer {
    dec: opus::Decoder,
    queue: VecDeque<f32>,
    last_seq: Option<u16>,
    primed: bool,
    volume: f32,
    pan: f32,
    level: f32,
    /// Raw received loudness (dBFS), unclamped: diagnostics and tests.
    db: f32,
}

#[derive(Default)]
struct Mixer {
    peers: HashMap<Id, Peer>,
    volumes: HashMap<Id, f32>,
    pans: HashMap<Id, f32>,
}

struct Shared {
    running: AtomicBool,
    muted: AtomicBool,
    deafened: AtomicBool,
    ptt_down: AtomicBool,
    push_to_talk: AtomicBool,
    ptt_vk: AtomicU32,
    vad_threshold: AtomicU32,
    ns: AtomicBool,
    aec: AtomicBool,
    self_level: AtomicU32,
    transmitting: AtomicBool,
    mixer: Mutex<Mixer>,
}

/// A running voice session. Dropping it stops audio.
pub struct Voice {
    sh: Arc<Shared>,
    _input: cpal::Stream,
    _output: cpal::Stream,
}

impl Drop for Voice {
    fn drop(&mut self) {
        self.sh.running.store(false, Relaxed);
    }
}

fn find_device(host: &cpal::Host, name: &Option<String>, input: bool) -> Result<cpal::Device> {
    if let Some(n) = name {
        let mut devs = if input {
            host.input_devices()?
        } else {
            host.output_devices()?
        };
        if let Some(d) = devs.find(|d| d.description().map(|x| x.name() == n).unwrap_or(false)) {
            return Ok(d);
        }
        tracing::warn!("audio device {n:?} not found, using default");
    }
    let d = if input {
        host.default_input_device()
    } else {
        host.default_output_device()
    };
    d.context(if input {
        "mikrofon bulunamadı"
    } else {
        "hoparlör bulunamadı"
    })
}

pub fn devices() -> (Vec<String>, Vec<String>) {
    let host = cpal::default_host();
    let name = |d: cpal::Device| d.description().ok().map(|x| x.name().to_string());
    let inputs = host
        .input_devices()
        .map(|it| it.filter_map(name).collect())
        .unwrap_or_default();
    let outputs = host
        .output_devices()
        .map(|it| it.filter_map(name).collect())
        .unwrap_or_default();
    (inputs, outputs)
}

/// Windows virtual-key code for a KeyboardEvent.code; 0 = unsupported (UI focus-only PTT).
fn virtual_key(code: &str) -> u32 {
    let b = code.as_bytes();
    match code {
        _ if code.len() == 4 && code.starts_with("Key") && b[3].is_ascii_uppercase() => b[3] as u32,
        _ if code.len() == 6 && code.starts_with("Digit") && b[5].is_ascii_digit() => b[5] as u32,
        _ if code.starts_with('F')
            && code[1..]
                .parse::<u32>()
                .is_ok_and(|n| (1..=24).contains(&n)) =>
        {
            0x6F + code[1..].parse::<u32>().unwrap_or(0)
        }
        "Mouse4" => 0x05,
        "Mouse5" => 0x06,
        "Space" => 0x20,
        "Tab" => 0x09,
        "CapsLock" => 0x14,
        "ShiftLeft" => 0xA0,
        "ShiftRight" => 0xA1,
        "ControlLeft" => 0xA2,
        "ControlRight" => 0xA3,
        "AltLeft" => 0xA4,
        "AltRight" => 0xA5,
        "Backquote" => 0xC0,
        _ => 0,
    }
}

#[cfg(windows)]
fn key_down(vk: u32) -> bool {
    // SAFETY: plain Win32 query of one key's state; no hooks, no input interception.
    vk != 0
        && unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk as i32) }
            < 0
}

#[cfg(not(windows))]
fn key_down(_: u32) -> bool {
    false // shortcut: global PTT is Windows-only; other OSes rely on focused-window PTT
}

/// Streaming linear resampler (fine for speech; keeps CPU near zero).
struct Resampler {
    step: f64,
    pos: f64,
    prev: f32,
}

impl Resampler {
    fn new(from: u32, to: u32) -> Self {
        Resampler {
            step: from as f64 / to as f64,
            pos: 0.0,
            prev: 0.0,
        }
    }
    /// Feed input samples; emits output samples.
    fn push(&mut self, input: &[f32], mut out: impl FnMut(f32)) {
        if self.step == 1.0 {
            input.iter().for_each(|s| out(*s));
            return;
        }
        for &s in input {
            while self.pos < 1.0 {
                out(self.prev + (s - self.prev) * self.pos as f32);
                self.pos += self.step;
            }
            self.pos -= 1.0;
            self.prev = s;
        }
    }
}

fn level_of(frame: &[f32]) -> f32 {
    let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
    let db = 20.0 * rms.max(1e-6).log10();
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

fn apm_config(ns: bool, aec: bool) -> sonora::Config {
    sonora::Config {
        echo_canceller: aec.then(Default::default),
        noise_suppression: ns.then(Default::default),
        gain_controller2: Some(Default::default()),
        high_pass_filter: Some(Default::default()),
        ..Default::default()
    }
}

impl Voice {
    pub fn start(opts: &VoiceOptions, send: SendFn) -> Result<Voice> {
        let sh = Arc::new(Shared {
            running: AtomicBool::new(true),
            muted: AtomicBool::new(false),
            deafened: AtomicBool::new(false),
            ptt_down: AtomicBool::new(false),
            push_to_talk: AtomicBool::new(opts.push_to_talk),
            ptt_vk: AtomicU32::new(virtual_key(&opts.ptt_key)),
            vad_threshold: AtomicU32::new(opts.vad_threshold.to_bits()),
            ns: AtomicBool::new(opts.noise_suppression),
            aec: AtomicBool::new(opts.echo_cancellation),
            self_level: AtomicU32::new(0),
            transmitting: AtomicBool::new(false),
            mixer: Mutex::new(Mixer::default()),
        });
        let host = cpal::default_host();
        let idev = find_device(&host, &opts.input, true)?;
        let odev = find_device(&host, &opts.output, false)?;
        let icfg = idev.default_input_config()?;
        let ocfg = odev.default_output_config()?;

        let (mut cap_tx, cap_rx) = HeapRb::<f32>::new(RATE as usize).split();
        let (mut ref_tx, ref_rx) = HeapRb::<f32>::new(RATE as usize).split();

        // ---- capture: downmix + resample to 48k, push into the processing ring
        let ich = icfg.channels() as usize;
        let mut rs = Resampler::new(icfg.sample_rate(), RATE);
        let mut mono = Vec::new();
        // test builds only: replace the mic with a 440 Hz tone, clocked by the real capture device
        let tone = cfg!(feature = "test-tone") && opts.input.as_deref() == Some("test-tone");
        let (mut phase, step) = (
            0f32,
            std::f32::consts::TAU * 440.0 / icfg.sample_rate() as f32,
        );
        // test builds only: "wav:<path>" plays a 16-bit mono WAV (at the device rate) as the mic
        #[allow(unused_mut)]
        let mut wav: Option<(Vec<f32>, usize)> = None;
        #[cfg(feature = "test-tone")]
        if let Some(path) = opts.input.as_deref().and_then(|i| i.strip_prefix("wav:")) {
            wav = Some((test_support::load_wav(path, icfg.sample_rate())?, 0));
        }
        let mut on_input = move |data: &[f32]| {
            mono.clear();
            mono.extend(data.chunks(ich).map(|c| c.iter().sum::<f32>() / ich as f32));
            if tone {
                for s in mono.iter_mut() {
                    *s = phase.sin() * 0.3;
                    phase = (phase + step) % std::f32::consts::TAU;
                }
            }
            if let Some((samples, pos)) = wav.as_mut() {
                for s in mono.iter_mut() {
                    *s = samples.get(*pos).copied().unwrap_or(0.0);
                    *pos += 1;
                }
            }
            rs.push(&mono, |s| {
                let _ = cap_tx.try_push(s);
            });
        };
        let err = |e| tracing::warn!("audio stream error: {e}");
        let input = match icfg.sample_format() {
            cpal::SampleFormat::F32 => idev.build_input_stream(
                icfg.config(),
                move |d: &[f32], _: &_| on_input(d),
                err,
                None,
            )?,
            cpal::SampleFormat::I16 => {
                let mut buf = Vec::new();
                idev.build_input_stream(
                    icfg.config(),
                    move |d: &[i16], _: &_| {
                        buf.clear();
                        buf.extend(d.iter().map(|s| *s as f32 / 32768.0));
                        on_input(&buf)
                    },
                    err,
                    None,
                )?
            }
            f => bail!("desteklenmeyen mikrofon formatı: {f:?}"),
        };

        // ---- playback: mix at 48k stereo, resample to device rate
        let och = ocfg.channels() as usize;
        let orate = ocfg.sample_rate();
        let sh_out = sh.clone();
        let mut mixbuf: Vec<f32> = Vec::new();
        let mut rs_l = Resampler::new(RATE, orate);
        let mut rs_r = Resampler::new(RATE, orate);
        let mut pending: VecDeque<(f32, f32)> = VecDeque::new();
        let mut on_output = move |out: &mut [f32]| {
            let frames = out.len() / och;
            let need48 = ((frames as f64) * RATE as f64 / orate as f64).ceil() as usize + 2;
            if pending.len() < frames {
                mixbuf.clear();
                mix(&sh_out, need48, &mut mixbuf, &mut ref_tx);
                let (mut l, mut r) = (
                    Vec::with_capacity(frames + 4),
                    Vec::with_capacity(frames + 4),
                );
                let left: Vec<f32> = mixbuf.chunks(2).map(|c| c[0]).collect();
                let right: Vec<f32> = mixbuf.chunks(2).map(|c| c[1]).collect();
                rs_l.push(&left, |s| l.push(s));
                rs_r.push(&right, |s| r.push(s));
                pending.extend(l.into_iter().zip(r));
            }
            for f in out.chunks_mut(och) {
                let (l, r) = pending.pop_front().unwrap_or((0.0, 0.0));
                match f.len() {
                    1 => f[0] = (l + r) * 0.5,
                    _ => {
                        f[0] = l;
                        f[1] = r;
                        f[2..].fill(0.0);
                    }
                }
            }
            pending.truncate(frames * 4);
        };
        let output = match ocfg.sample_format() {
            cpal::SampleFormat::F32 => odev.build_output_stream(
                ocfg.config(),
                move |d: &mut [f32], _: &_| on_output(d),
                err,
                None,
            )?,
            cpal::SampleFormat::I16 => {
                let mut buf = Vec::new();
                odev.build_output_stream(
                    ocfg.config(),
                    move |d: &mut [i16], _: &_| {
                        buf.resize(d.len(), 0.0);
                        on_output(&mut buf);
                        for (o, s) in d.iter_mut().zip(&buf) {
                            *o = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                        }
                    },
                    err,
                    None,
                )?
            }
            f => bail!("desteklenmeyen hoparlör formatı: {f:?}"),
        };

        // ---- processing thread: APM + gate + encode
        let sh_p = sh.clone();
        std::thread::Builder::new()
            .name("halka-voice".into())
            .spawn(move || process(sh_p, cap_rx, ref_rx, send))?;

        input.play()?;
        output.play()?;
        Ok(Voice {
            sh,
            _input: input,
            _output: output,
        })
    }

    pub fn set_muted(&self, v: bool) {
        self.sh.muted.store(v, Relaxed)
    }
    pub fn set_deafened(&self, v: bool) {
        self.sh.deafened.store(v, Relaxed)
    }
    pub fn set_ptt(&self, down: bool) {
        self.sh.ptt_down.store(down, Relaxed)
    }
    pub fn apply(&self, o: &VoiceOptions) {
        self.sh.push_to_talk.store(o.push_to_talk, Relaxed);
        self.sh.ptt_vk.store(virtual_key(&o.ptt_key), Relaxed);
        self.sh
            .vad_threshold
            .store(o.vad_threshold.to_bits(), Relaxed);
        self.sh.ns.store(o.noise_suppression, Relaxed);
        self.sh.aec.store(o.echo_cancellation, Relaxed);
    }
    pub fn set_volume(&self, peer: Id, v: f32) {
        let mut m = self.sh.mixer.lock();
        m.volumes.insert(peer, v.clamp(0.0, 2.0));
        if let Some(p) = m.peers.get_mut(&peer) {
            p.volume = v.clamp(0.0, 2.0);
        }
    }
    /// -1 (left) .. 1 (right) for each peer; peers not listed are dropped from the mix.
    pub fn set_layout(&self, pans: HashMap<Id, f32>) {
        let mut m = self.sh.mixer.lock();
        m.peers.retain(|id, _| pans.contains_key(id));
        for (id, p) in m.peers.iter_mut() {
            p.pan = pans[id];
        }
        m.pans = pans;
    }

    /// Levels (0..1) of self and every peer, for the UI.
    pub fn levels(&self, me: Id) -> Vec<(Id, f32)> {
        let m = self.sh.mixer.lock();
        let mut v: Vec<(Id, f32)> = m.peers.iter().map(|(id, p)| (*id, p.level)).collect();
        let raw = f32::from_bits(self.sh.self_level.load(Relaxed));
        // the mic test (deafened, no peers) shows the raw level so the threshold can be tuned
        let test = self.sh.deafened.load(Relaxed) && m.peers.is_empty();
        let tx = self.sh.transmitting.load(Relaxed);
        v.push((me, if tx || test { raw } else { 0.0 }));
        v
    }

    /// Unclamped dBFS of what we last mixed from `peer` (diagnostics).
    pub fn peer_db(&self, peer: Id) -> Option<f32> {
        self.sh.mixer.lock().peers.get(&peer).map(|p| p.db)
    }

    /// Incoming voice datagram from `peer` (already authorized by the node).
    pub fn receive(&self, peer: Id, dg: &[u8]) {
        receive_into(&self.sh, peer, dg)
    }
}

fn receive_into(sh: &Shared, peer: Id, dg: &[u8]) {
    {
        if dg.len() < 4 || dg[0] != DG_VOICE {
            return;
        }
        let seq = u16::from_le_bytes([dg[1], dg[2]]);
        let pkt = &dg[3..];
        let mut m = sh.mixer.lock();
        let Some(&pan) = m.pans.get(&peer) else {
            return;
        };
        let volume = m.volumes.get(&peer).copied().unwrap_or(1.0);
        let p = match m.peers.entry(peer) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(v) => {
                let Ok(dec) = opus::Decoder::new(RATE, opus::Channels::Mono) else {
                    return;
                };
                v.insert(Peer {
                    dec,
                    queue: VecDeque::new(),
                    last_seq: None,
                    primed: false,
                    volume,
                    pan,
                    level: 0.0,
                    db: -200.0,
                })
            }
        };
        let mut pcm = [0f32; FRAME20 * 3];
        if let Some(last) = p.last_seq {
            let gap = seq.wrapping_sub(last) as i16;
            if gap <= 0 {
                return; // duplicate or late
            }
            // conceal short losses; longer gaps are a talk-spurt restart
            if (2..=4).contains(&gap) {
                for i in 0..(gap - 1) {
                    let fec = i == gap - 2;
                    let input: &[u8] = if fec { pkt } else { &[] };
                    if let Ok(n) = p.dec.decode_float(input, &mut pcm[..FRAME20], fec) {
                        p.queue.extend(&pcm[..n]);
                    }
                }
            }
        }
        p.last_seq = Some(seq);
        if let Ok(n) = p.dec.decode_float(pkt, &mut pcm, false) {
            p.queue.extend(&pcm[..n]);
            #[cfg(feature = "test-tone")]
            test_support::RECORDING.lock().extend_from_slice(&pcm[..n]);
        }
        if p.queue.len() > MAX_QUEUE {
            let drop = p.queue.len() - PRIME;
            p.queue.drain(..drop);
        }
    }
}

/// Pull `frames` 48 kHz stereo frames from all peers into `out` (interleaved L,R).
fn mix(sh: &Shared, frames: usize, out: &mut Vec<f32>, reference: &mut impl Producer<Item = f32>) {
    out.resize(frames * 2, 0.0);
    out.fill(0.0);
    let deaf = sh.deafened.load(Relaxed);
    let mut mono = vec![0f32; frames];
    {
        let mut m = sh.mixer.lock();
        for p in m.peers.values_mut() {
            if !p.primed {
                p.primed = p.queue.len() >= PRIME;
                if !p.primed {
                    p.level *= 0.8;
                    continue;
                }
            }
            let theta = (p.pan.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
            let (gl, gr) = (theta.cos() * p.volume, theta.sin() * p.volume);
            let mut energy = 0.0;
            for i in 0..frames {
                let Some(s) = p.queue.pop_front() else {
                    p.primed = false;
                    break;
                };
                energy += s * s;
                out[i * 2] += s * gl;
                out[i * 2 + 1] += s * gr;
                mono[i] += s * p.volume;
            }
            let rms = (energy / frames as f32).sqrt();
            p.db = 20.0 * rms.max(1e-10).log10();
            let lvl = level_of(&[rms]);
            p.level = if lvl > p.level {
                lvl
            } else {
                p.level * 0.85 + lvl * 0.15
            };
        }
    }
    for s in out.iter_mut() {
        // soft knee limiter: transparent below 0.8, never exceeds 1.0
        let a = s.abs();
        if a > 0.8 {
            *s = s.signum() * (0.8 + 0.2 * ((a - 0.8) / 0.2).tanh());
        }
    }
    if deaf {
        out.fill(0.0);
        mono.fill(0.0);
    }
    for s in mono {
        let _ = reference.try_push(s);
    }
}

fn process(
    sh: Arc<Shared>,
    mut cap: impl Consumer<Item = f32>,
    mut reference: impl Consumer<Item = f32>,
    send: SendFn,
) {
    let (mut ns, mut aec) = (sh.ns.load(Relaxed), sh.aec.load(Relaxed));
    let mut apm = sonora::AudioProcessing::builder()
        .config(apm_config(ns, aec))
        .capture_config(sonora::StreamConfig::new(RATE, 1))
        .render_config(sonora::StreamConfig::new(RATE, 1))
        .build();
    let mut enc = match opus::Encoder::new(RATE, opus::Channels::Mono, opus::Application::Voip) {
        Ok(e) => e,
        Err(e) => return tracing::error!("opus: {e}"),
    };
    let _ = enc.set_bitrate(opus::Bitrate::Bits(40_000));
    let _ = enc.set_inband_fec(true);
    let _ = enc.set_packet_loss_perc(8);
    let (mut inp, mut rf, mut outp) = ([0f32; FRAME10], [0f32; FRAME10], [0f32; FRAME10]);
    let mut frame20 = Vec::with_capacity(FRAME20);
    let mut seq: u16 = 0;
    let mut hang = 0u32;
    let mut pkt = vec![0u8; 1200];
    while sh.running.load(Relaxed) {
        if cap.occupied_len() < FRAME10 {
            std::thread::sleep(Duration::from_millis(3));
            continue;
        }
        // stay realtime: if capture backed up (thread starved), skip ahead
        while cap.occupied_len() > FRAME10 * 8 {
            cap.skip(FRAME10);
        }
        let (n2, a2) = (sh.ns.load(Relaxed), sh.aec.load(Relaxed));
        if (n2, a2) != (ns, aec) {
            (ns, aec) = (n2, a2);
            apm.apply_config(apm_config(ns, aec));
        }
        cap.pop_slice(&mut inp);
        let got = reference.pop_slice(&mut rf);
        rf[got..].fill(0.0);
        while reference.occupied_len() > FRAME10 * 20 {
            reference.skip(FRAME10);
        }
        let _ = apm.process_render_f32(&[&rf], &mut [&mut [0f32; FRAME10][..]]);
        if apm.process_capture_f32(&[&inp], &mut [&mut outp]).is_err() {
            outp = inp;
        }
        frame20.extend_from_slice(&outp);
        if frame20.len() < FRAME20 {
            continue;
        }
        let level = level_of(&frame20);
        sh.self_level.store(level.to_bits(), Relaxed);
        let open = if sh.muted.load(Relaxed) || sh.deafened.load(Relaxed) {
            false
        } else if sh.push_to_talk.load(Relaxed) {
            sh.ptt_down.load(Relaxed) || key_down(sh.ptt_vk.load(Relaxed))
        } else {
            if level >= f32::from_bits(sh.vad_threshold.load(Relaxed)) {
                hang = HANGOVER_FRAMES;
            }
            hang = hang.saturating_sub(1);
            hang > 0
        };
        sh.transmitting.store(open, Relaxed);
        if open && let Ok(n) = enc.encode_float(&frame20, &mut pkt[3..]) {
            pkt[0] = DG_VOICE;
            pkt[1..3].copy_from_slice(&seq.to_le_bytes());
            seq = seq.wrapping_add(1);
            send(pkt[..3 + n].to_vec());
        } else if !open {
            // keep sequence moving so receivers see a gap > 4 (talk-spurt restart), not loss
            seq = seq.wrapping_add(1);
        }
        frame20.clear();
    }
}

/// Test-build helpers: WAV in, received audio out.
#[cfg(feature = "test-tone")]
pub mod test_support {
    use parking_lot::Mutex;

    /// Every decoded voice sample (48 kHz mono) received by any engine in this process.
    pub static RECORDING: Mutex<Vec<f32>> = Mutex::new(Vec::new());

    pub fn load_wav(path: &str, rate: u32) -> anyhow::Result<Vec<f32>> {
        let b = std::fs::read(path)?;
        let at = b
            .windows(4)
            .position(|w| w == b"data")
            .ok_or_else(|| anyhow::anyhow!("no data chunk"))?;
        let file_rate = u32::from_le_bytes(b[24..28].try_into()?);
        anyhow::ensure!(
            file_rate == rate && u16::from_le_bytes([b[22], b[23]]) == 1,
            "need mono {rate} Hz WAV"
        );
        Ok(b[at + 8..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect())
    }

    pub fn write_wav(path: &str, samples: &[f32]) -> std::io::Result<()> {
        let data: Vec<u8> = samples
            .iter()
            .flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())
            .collect();
        let mut h = Vec::with_capacity(44 + data.len());
        h.extend_from_slice(b"RIFF");
        h.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        h.extend_from_slice(b"WAVEfmt ");
        h.extend_from_slice(&[16, 0, 0, 0, 1, 0, 1, 0]);
        h.extend_from_slice(&48_000u32.to_le_bytes());
        h.extend_from_slice(&96_000u32.to_le_bytes());
        h.extend_from_slice(&[2, 0, 16, 0]);
        h.extend_from_slice(b"data");
        h.extend_from_slice(&(data.len() as u32).to_le_bytes());
        h.extend_from_slice(&data);
        std::fs::write(path, h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_ratio() {
        let mut r = Resampler::new(44_100, 48_000);
        let mut n = 0;
        r.push(&vec![0.5; 44_100], |_| n += 1);
        assert!((n as i32 - 48_000).abs() < 3, "{n}");
    }

    fn shared() -> Shared {
        Shared {
            running: AtomicBool::new(true),
            muted: AtomicBool::new(false),
            deafened: AtomicBool::new(false),
            ptt_down: AtomicBool::new(false),
            push_to_talk: AtomicBool::new(false),
            ptt_vk: AtomicU32::new(0),
            vad_threshold: AtomicU32::new(0),
            ns: AtomicBool::new(true),
            aec: AtomicBool::new(true),
            self_level: AtomicU32::new(0),
            transmitting: AtomicBool::new(false),
            mixer: Mutex::new(Mixer::default()),
        }
    }

    #[test]
    fn decode_jitter_and_pan() {
        let sh = shared();
        let peer = Id([9; 32]);
        sh.mixer.lock().pans.insert(peer, 1.0); // hard right
        let mut enc =
            opus::Encoder::new(RATE, opus::Channels::Mono, opus::Application::Voip).unwrap();
        let sine: Vec<f32> = (0..FRAME20)
            .map(|i| (i as f32 * 0.06).sin() * 0.5)
            .collect();
        for seq in 0u16..6 {
            if seq == 3 {
                continue; // lost packet: must be concealed, not a hole
            }
            let mut dg = vec![DG_VOICE];
            dg.extend_from_slice(&seq.to_le_bytes());
            dg.extend(enc.encode_vec_float(&sine, 1000).unwrap());
            receive_into(&sh, peer, &dg);
        }
        receive_into(&sh, peer, &[DG_VOICE, 1, 0, 0xff]); // late duplicate: ignored
        assert_eq!(sh.mixer.lock().peers[&peer].queue.len(), FRAME20 * 6);
        let (mut rb_tx, _rb_rx) = HeapRb::<f32>::new(RATE as usize).split();
        let mut out = Vec::new();
        mix(&sh, FRAME20 * 4, &mut out, &mut rb_tx);
        let (l, r): (f32, f32) = out
            .chunks(2)
            .fold((0.0, 0.0), |(l, r), c| (l + c[0].abs(), r + c[1].abs()));
        assert!(r > 10.0 && l < r * 0.01, "panned right: l={l} r={r}");
        assert!(out.iter().all(|s| s.abs() <= 1.0));
    }

    /// The far end plays through our speaker and leaks back into the mic (delayed, quieter).
    /// With AEC on, that echo must be strongly suppressed; with it off, it passes through.
    fn echo_residual_db(aec: bool) -> f32 {
        let mut apm = sonora::AudioProcessing::builder()
            .config(apm_config(false, aec))
            .capture_config(sonora::StreamConfig::new(RATE, 1))
            .render_config(sonora::StreamConfig::new(RATE, 1))
            .build();
        // speech-like: broadband noise with a syllable-rate envelope (deterministic LCG)
        let mut seed = 12345u32;
        let far: Vec<f32> = (0..RATE as usize * 8)
            .map(|i| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let n = (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0;
                let t = i as f32 / RATE as f32;
                n * 0.3 * (0.3 + 0.7 * (t * 4.0 * std::f32::consts::TAU).sin().abs())
            })
            .collect();
        let delay = 30 * RATE as usize / 1000;
        let (mut out, mut sink) = ([0f32; FRAME10], [0f32; FRAME10]);
        let (mut e_in, mut e_out) = (0f64, 0f64);
        for (k, chunk) in far.chunks(FRAME10).enumerate() {
            let mic: Vec<f32> = (0..FRAME10)
                .map(|j| {
                    let i = k * FRAME10 + j;
                    if i >= delay {
                        far[i - delay] * 0.5
                    } else {
                        0.0
                    }
                })
                .collect();
            apm.process_render_f32(&[chunk], &mut [&mut sink[..]])
                .unwrap();
            apm.process_capture_f32(&[&mic], &mut [&mut out]).unwrap();
            if k > 400 {
                // after 4 s of convergence
                e_in += mic.iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
                e_out += out.iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
            }
        }
        (10.0 * (e_out.max(1e-12) / e_in).log10()) as f32
    }

    #[test]
    fn echo_cancellation_removes_speaker_leak() {
        let (on, off) = (echo_residual_db(true), echo_residual_db(false));
        eprintln!("echo residual: aec on {on:.1} dB, off {off:.1} dB");
        assert!(
            on < -20.0,
            "AEC should remove >20 dB of echo, got {on:.1} dB"
        );
        assert!(on < off - 15.0);
    }

    #[test]
    fn ptt_key_map() {
        assert_eq!(virtual_key("KeyV"), 0x56);
        assert_eq!(virtual_key("Digit1"), 0x31);
        assert_eq!(virtual_key("F13"), 0x7C);
        assert_eq!(virtual_key("Mouse4"), 0x05);
        assert_eq!(virtual_key("Keyv"), 0);
    }

    #[test]
    fn level_scale() {
        assert_eq!(level_of(&[0.0; 10]), 0.0);
        assert!(level_of(&[1.0; 10]) > 0.99);
    }
}
