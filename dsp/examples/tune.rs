//! Dò tham số tách lớp trên một bản mix tổng hợp (stereo):
//!   giọng (giữa, vibrato) · guitar (lệch trái) · pad (stereo rộng) · bass (giữa) · trống (snare giữa, hi-hat lệch phải)
//! In ra tỉ lệ năng lượng mỗi nguồn rơi vào lớp mong đợi, và phần lọt vào lớp giọng.
//!
//!   ./build.sh tune     (hoặc: cargo run --release --example tune)

use capo_dsp::{BASS, CHANNELS, Config, DRUMS, OTHER, STEMS, Separator, StemParams, VOCALS};

const SR: f32 = 48000.0;
const LEN: usize = 48000 * 8;
const TAU: f32 = 2.0 * std::f32::consts::PI;

fn lcg(seed: u32) -> impl FnMut() -> f32 {
    let mut s = seed;
    move || {
        s = s.wrapping_mul(1664525).wrapping_add(1013904223);
        (s >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
    }
}

fn high_pass(x: &mut [f32], fc: f32) {
    let a = (-TAU * fc / SR).exp();
    let (mut px, mut py) = (0.0, 0.0);
    for v in x.iter_mut() {
        let y = a * (py + *v - px);
        px = *v;
        py = y;
        *v = y;
    }
}

/// Nguồn có cao độ: tổng `harmonics` bồi âm, biên độ 1/h, tần số theo `freq(t)`.
fn harmonic(freq: impl Fn(f32) -> f32, harmonics: usize, env: impl Fn(f32) -> f32, amp: f32) -> Vec<f32> {
    let mut phase = 0.0f32;
    (0..LEN)
        .map(|i| {
            let t = i as f32 / SR;
            let f = freq(t);
            phase = (phase + f / SR).fract();
            let mut v = 0.0;
            for h in 1..=harmonics {
                if f * h as f32 > 10000.0 {
                    break;
                }
                v += (TAU * phase * h as f32).sin() / h as f32;
            }
            amp * env(t) * v
        })
        .collect()
}

struct Source {
    name: &'static str,
    expected: usize,
    left: Vec<f32>,
    right: Vec<f32>,
}

fn sources() -> Vec<Source> {
    // Giọng: 4 nốt, vibrato 5.5 Hz ±25 cent, ở giữa.
    let notes = [220.0, 246.94, 293.66, 261.63];
    let vocal = harmonic(
        |t| notes[(t / 1.0) as usize % 4] * 2f32.powf(0.25 / 12.0 * (TAU * 5.5 * t).sin()),
        10,
        |t| 0.6 + 0.4 * (TAU * 0.5 * t).sin().abs(),
        0.18,
    );
    // Guitar gảy: 330/392 Hz, tắt dần, lệch trái.
    let guitar = harmonic(|t| if (t / 0.5) as usize % 2 == 0 { 329.63 } else { 392.0 }, 12, |t| (-(t % 0.5) / 0.25).exp(), 0.2);
    // Pad stereo rộng: L và R lệch nhau 2.5 Hz → gần như không tương quan.
    let pad_l = harmonic(|_| 164.81, 6, |_| 1.0, 0.08);
    let pad_r = harmonic(|_| 167.31, 6, |_| 1.0, 0.08);
    // Bass răng cưa, đổi nốt mỗi 0.5 s, ở giữa.
    let bass_notes = [55.0, 73.42, 82.41, 61.74];
    let bass = harmonic(|t| bass_notes[(t / 0.5) as usize % 4], 40, |_| 1.0, 0.25);
    // Snare băng rộng (giữa) + hi-hat (lệch phải).
    let mut r = lcg(1);
    let mut snare = vec![0.0; LEN];
    let mut r2 = lcg(2);
    let mut hat = vec![0.0; LEN];
    for i in 0..LEN {
        let t = i as f32 / SR;
        let ts = (t + 0.25) % 0.5;
        snare[i] = r() * (-ts / 0.06).exp() * 0.4;
        let th = t % 0.125;
        hat[i] = r2() * (-th / 0.015).exp() * 0.3;
    }
    high_pass(&mut snare, 300.0);
    high_pass(&mut hat, 6000.0);
    let drums_l: Vec<f32> = snare.iter().zip(&hat).map(|(s, h)| s + 0.5 * h).collect();
    let drums_r: Vec<f32> = snare.iter().zip(&hat).map(|(s, h)| s + h).collect();

    vec![
        Source { name: "giọng (giữa)", expected: VOCALS, left: vocal.clone(), right: vocal },
        Source { name: "guitar (trái)", expected: OTHER, left: guitar.iter().map(|v| v * 0.9).collect(), right: guitar.iter().map(|v| v * 0.3).collect() },
        Source { name: "pad (rộng)", expected: OTHER, left: pad_l, right: pad_r },
        Source { name: "bass (giữa)", expected: BASS, left: bass.clone(), right: bass },
        Source { name: "trống", expected: DRUMS, left: drums_l, right: drums_r },
    ]
}

fn run(cfg: Config, p: StemParams, left: &[f32], right: &[f32]) -> Vec<Vec<Vec<f32>>> {
    let mut s = Separator::new(cfg).unwrap();
    s.set_params(p);
    let mut out = vec![vec![Vec::with_capacity(LEN); CHANNELS]; STEMS];
    for (bl, br) in left.chunks(128).zip(right.chunks(128)) {
        s.io_in[0][..bl.len()].copy_from_slice(bl);
        s.io_in[1][..br.len()].copy_from_slice(br);
        s.process(bl.len());
        for st in 0..STEMS {
            for c in 0..CHANNELS {
                out[st][c].extend_from_slice(&s.io_out[st][c][..bl.len()]);
            }
        }
    }
    out
}

/// Tỉ lệ năng lượng nguồn (cả 2 kênh) nằm trong lớp `stem` — ước lượng bằng phép chiếu.
fn share(out: &[Vec<Vec<f32>>], stem: usize, src: &Source, lat: usize) -> f32 {
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for (c, x) in [&src.left, &src.right].into_iter().enumerate() {
        for i in SR as usize..LEN - lat {
            num += out[stem][c][i + lat] as f64 * x[i] as f64;
            den += x[i] as f64 * x[i] as f64;
        }
    }
    (num / den) as f32
}

fn main() {
    let srcs = sources();
    let left: Vec<f32> = (0..LEN).map(|i| srcs.iter().map(|s| s.left[i]).sum()).collect();
    let right: Vec<f32> = (0..LEN).map(|i| srcs.iter().map(|s| s.right[i]).sum()).collect();
    let cfg = Config { sample_rate: SR, fft_size: 1024, hop: 512, time_half: 6, freq_half: 32, margin: 1.0, sharpness: 3.0 };
    let p = |bass_cutoff_hz, center_width, center_smoothing_ms| StemParams {
        bass_cutoff_hz,
        center_width,
        center_smoothing_ms,
        ..StemParams::default()
    };
    let cases = [
        ("γ8  smooth30", p(180.0, 8.0, 30.0)),
        ("γ8  smooth50", p(180.0, 8.0, 50.0)),
        ("γ12 smooth50", p(180.0, 12.0, 50.0)),
        ("γ12 smooth80", p(180.0, 12.0, 80.0)),
        ("γ16 smooth30", p(180.0, 16.0, 30.0)),
    ];

    print!("{:<34}", "tham số");
    for s in &srcs {
        print!("{:>16}", s.name);
    }
    println!("{:>18}{:>8}", "lọt vào giọng", "score");
    for (label, params) in cases {
        let lat = cfg.latency();
        let out = run(cfg, params, &left, &right);
        print!("{label:<34}");
        let mut score = 0.0;
        let mut leak = 0.0;
        for s in &srcs {
            let ok = share(&out, s.expected, s, lat);
            score += ok;
            if s.expected != VOCALS {
                leak += share(&out, VOCALS, s, lat);
            }
            print!("{:>15.1}%", ok * 100.0);
        }
        let leak = leak / (srcs.len() - 1) as f32;
        println!("{:>17.1}%{:>8.2}", leak * 100.0, score - 2.0 * leak);
    }
}
