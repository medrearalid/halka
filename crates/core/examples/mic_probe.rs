//! Diagnostic: prints raw RMS (dBFS) of every input device for 2 s. `cargo run --example mic_probe`
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};

fn main() {
    let host = cpal::default_host();
    for d in host.input_devices().expect("input devices") {
        let name = d.description().map(|x| x.name().to_string()).unwrap_or_default();
        let Ok(cfg) = d.default_input_config() else { continue };
        let acc = Arc::new(Mutex::new((0f64, 0usize, 0usize)));
        let a = acc.clone();
        let s = match cfg.sample_format() {
            cpal::SampleFormat::F32 => d.build_input_stream(cfg.config(), move |x: &[f32], _: &_| {
                let mut g = a.lock().unwrap();
                g.0 += x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
                g.1 += x.len();
                g.2 += 1;
            }, |e| eprintln!("err {e}"), None),
            f => { println!("{name}: format {f:?} skipped"); continue }
        };
        let Ok(s) = s else { println!("{name}: cannot open"); continue };
        s.play().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(2));
        drop(s);
        let g = acc.lock().unwrap();
        let rms = (g.0 / g.1.max(1) as f64).sqrt();
        println!("{name}: {} Hz {} ch, callbacks={}, samples={}, rms={:.1} dBFS", cfg.sample_rate(), cfg.channels(), g.2, g.1, 20.0 * rms.max(1e-9).log10());
    }
}
