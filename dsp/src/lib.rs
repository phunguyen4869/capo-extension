//! capo-dsp — tách 4 lớp nhạc cụ theo thời gian thực: trống, bass, giọng hát, nhạc cụ khác.
//!
//! Một STFT duy nhất; mỗi bin được chia bằng các mask có tổng = 1:
//!   d = mask percussive (HPSS, lọc trung vị — Fitzgerald 2010, margin kiểu Driedger 2014)
//!       H = median theo thời gian (2K+1 frame), P = median theo tần số (2M+1 bin)
//!       d = 1 / (1 + (β²·H / P)^s)
//!   h = 1 − d                                  (phần có cao độ)
//!   bass   = h · low(f)                        (dải thấp, crossover mềm quanh bass_cutoff)
//!   vocals = h · band(f) · ψ^γ                 (dải trên, chỉ phần nằm GIỮA stereo)
//!   other  = phần còn lại
//! ψ = 2·Re(S_LR) / (S_LL + S_RR) là độ giống nhau L/R (biến thể cùng pha của Avendano & Jot 2002),
//! S là phổ chéo làm mượt theo thời gian: ψ = 1 khi L = R (giữa), giảm khi lệch trái/phải hoặc lệch pha.
//!
//! Tối ưu:
//! - mọi mask dùng chung cho 2 kênh → median chỉ tính 1 lần, giữ ảnh stereo;
//! - chỉ IFFT 3 lớp; lớp "other" = input trễ − 3 lớp kia ⇒ tổng 4 lớp == input trễ (tái tạo hoàn hảo);
//! - mọi bộ nhớ cấp phát trong `new`, `process` không cấp phát;
//! - FFT realfft/rustfft, build wasm32 với SIMD128.
//!
//! Latency cố định = fft_size + time_half·hop mẫu.

use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub const CHANNELS: usize = 2;
pub const STEMS: usize = 4;
pub const DRUMS: usize = 0;
pub const BASS: usize = 1;
pub const VOCALS: usize = 2;
pub const OTHER: usize = 3;
/// Số lớp được tổng hợp bằng IFFT (lớp OTHER dựng bằng phép trừ).
const SYNTH_STEMS: usize = 3;
/// Kích thước block tối đa cho mỗi lần gọi `process` (AudioWorklet thường là 128).
pub const MAX_BLOCK: usize = 2048;

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub sample_rate: f32,
    pub fft_size: usize,
    pub hop: usize,
    /// K: số frame mỗi bên cho median theo thời gian (cửa sổ 2K+1).
    pub time_half: usize,
    /// M: số bin mỗi bên cho median theo tần số (cửa sổ 2M+1).
    pub freq_half: usize,
    /// > 1 thì càng "khó" bị xếp vào trống.
    pub margin: f32,
    /// Độ sắc của mask trống: 1 = Wiener (mềm), lớn hơn → gần nhị phân.
    pub sharpness: f32,
}

impl Config {
    pub fn is_valid(&self) -> bool {
        self.sample_rate.is_finite()
            && (8000.0..=384000.0).contains(&self.sample_rate)
            && self.fft_size.is_power_of_two()
            && (64..=16384).contains(&self.fft_size)
            && self.hop > 0
            && self.fft_size % self.hop == 0
            && self.fft_size / self.hop >= 2
            && (1..=32).contains(&self.time_half)
            && (1..=128).contains(&self.freq_half)
            && self.margin.is_finite()
            && self.margin > 0.0
            && self.sharpness.is_finite()
            && (0.25..=8.0).contains(&self.sharpness)
    }

    pub fn latency(&self) -> usize {
        self.fft_size + self.time_half * self.hop
    }
}

/// Tham số chia lớp có thể đổi lúc đang chạy.
#[derive(Clone, Copy, Debug)]
pub struct StemParams {
    /// Tần số crossover bass ↔ phần trên (Hz).
    pub bass_cutoff_hz: f32,
    /// Mép trên của dải giọng hát (Hz).
    pub vocal_high_hz: f32,
    /// γ: càng lớn thì chỉ những gì thật sự ở giữa mới vào lớp giọng.
    pub center_width: f32,
    /// Hằng số thời gian làm mượt phổ chéo L/R (ms).
    pub center_smoothing_ms: f32,
}

impl Default for StemParams {
    fn default() -> Self {
        Self { bass_cutoff_hz: 180.0, vocal_high_hz: 12000.0, center_width: 12.0, center_smoothing_ms: 50.0 }
    }
}

pub struct Separator {
    cfg: Config,
    params: StemParams,
    bins: usize,
    slots: usize,
    window: Vec<f32>,
    ola_scale: f32,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    fwd_scratch: Vec<Complex32>,
    inv_scratch: Vec<Complex32>,
    frame: Vec<f32>,
    time_out: Vec<f32>,
    spec_tmp: Vec<Complex32>,

    /// N mẫu gần nhất cho mỗi kênh (khung phân tích).
    in_buf: Vec<Vec<f32>>,
    /// Số mẫu đã nhận trong hop hiện tại.
    fill: usize,
    /// Delay line để dựng lớp OTHER = input trễ − các lớp khác.
    delay: Vec<Vec<f32>>,
    delay_pos: usize,

    /// Phổ phức: [slot][kênh][bin]
    spec: Vec<Complex32>,
    /// Tổng công suất các kênh: [slot][bin]
    power: Vec<f32>,
    write_slot: usize,

    harm_med: Vec<f32>,
    perc_med: Vec<f32>,
    median_tmp: Vec<f32>,

    /// Phổ chéo làm mượt cho độ giống nhau L/R.
    s_ll: Vec<f32>,
    s_rr: Vec<f32>,
    s_lr: Vec<Complex32>,
    smooth_a: f32,
    band_low: Vec<f32>,
    band_vocal: Vec<f32>,
    /// Tỉ lệ năng lượng "nằm giữa" (0..1), làm mượt ~1 s — cho UI cảnh báo bài mono.
    center_ratio: f32,

    /// Gain cho các lớp tổng hợp bằng IFFT: [stem][bin]
    gains: Vec<Vec<f32>>,
    /// Overlap-add: [stem][kênh][N]
    ola: Vec<Vec<Vec<f32>>>,
    /// Hop sẵn sàng để phát: [stem][kênh][hop]
    ready: Vec<Vec<Vec<f32>>>,

    pub io_in: Vec<Vec<f32>>,
    /// [stem][kênh][MAX_BLOCK]
    pub io_out: Vec<Vec<Vec<f32>>>,
}

impl Separator {
    pub fn new(cfg: Config) -> Option<Self> {
        if !cfg.is_valid() {
            return None;
        }
        let n = cfg.fft_size;
        let hop = cfg.hop;
        let bins = n / 2 + 1;
        let slots = 2 * cfg.time_half + 1;

        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(n);
        let inv = planner.plan_fft_inverse(n);

        // sqrt-Hann (periodic) cho cả phân tích và tổng hợp → tích là Hann.
        let window: Vec<f32> = (0..n)
            .map(|i| {
                let hann = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos();
                hann.sqrt() as f32
            })
            .collect();
        let overlap_sum: f64 = (0..n / hop)
            .map(|j| {
                let w = window[j * hop] as f64;
                w * w
            })
            .sum();
        // IFFT của realfft không chuẩn hóa → chia thêm N.
        let ola_scale = (1.0 / (overlap_sum * n as f64)) as f32;

        let zeros = |len: usize| vec![0.0f32; len];
        let per_channel = |len: usize| (0..CHANNELS).map(|_| zeros(len)).collect::<Vec<_>>();
        let per_stem = |count: usize, len: usize| (0..count).map(|_| per_channel(len)).collect::<Vec<_>>();

        let mut sep = Self {
            cfg,
            params: StemParams::default(),
            bins,
            slots,
            fwd_scratch: fwd.make_scratch_vec(),
            inv_scratch: inv.make_scratch_vec(),
            frame: zeros(n),
            time_out: zeros(n),
            spec_tmp: inv.make_input_vec(),
            fwd,
            inv,
            window,
            ola_scale,
            in_buf: per_channel(n),
            fill: 0,
            delay: per_channel(cfg.latency() + hop),
            delay_pos: 0,
            spec: vec![Complex32::new(0.0, 0.0); slots * CHANNELS * bins],
            power: zeros(slots * bins),
            write_slot: 0,
            harm_med: zeros(bins),
            perc_med: zeros(bins),
            median_tmp: zeros(slots.max(2 * cfg.freq_half + 1)),
            s_ll: zeros(bins),
            s_rr: zeros(bins),
            s_lr: vec![Complex32::new(0.0, 0.0); bins],
            smooth_a: 0.0,
            band_low: zeros(bins),
            band_vocal: zeros(bins),
            center_ratio: 0.0,
            gains: (0..SYNTH_STEMS).map(|_| zeros(bins)).collect(),
            ola: per_stem(SYNTH_STEMS, n),
            ready: per_stem(STEMS, hop),
            io_in: per_channel(MAX_BLOCK),
            io_out: per_stem(STEMS, MAX_BLOCK),
        };
        sep.set_params(StemParams::default());
        Some(sep)
    }

    pub fn latency(&self) -> usize {
        self.cfg.latency()
    }

    pub fn center_ratio(&self) -> f32 {
        self.center_ratio
    }

    pub fn set_params(&mut self, p: StemParams) {
        let nyquist = self.cfg.sample_rate * 0.5;
        let fix = |v: f32, lo: f32, hi: f32, default: f32| if v.is_finite() { v.clamp(lo, hi) } else { default };
        let d = StemParams::default();
        let p = StemParams {
            bass_cutoff_hz: fix(p.bass_cutoff_hz, 40.0, 1000.0, d.bass_cutoff_hz),
            vocal_high_hz: fix(p.vocal_high_hz, 1000.0, nyquist, d.vocal_high_hz),
            center_width: fix(p.center_width, 0.5, 64.0, d.center_width),
            center_smoothing_ms: fix(p.center_smoothing_ms, 0.0, 1000.0, d.center_smoothing_ms),
        };
        self.params = p;
        let frame_ms = self.cfg.hop as f32 / self.cfg.sample_rate * 1000.0;
        self.smooth_a = if p.center_smoothing_ms > 0.0 { (-frame_ms / p.center_smoothing_ms).exp() } else { 0.0 };
        let df = self.cfg.sample_rate / self.cfg.fft_size as f32;
        for k in 0..self.bins {
            let f = k as f32 * df;
            let low = 1.0 / (1.0 + (f / p.bass_cutoff_hz).powi(6));
            let high_roll = 1.0 / (1.0 + (f / p.vocal_high_hz).powi(4));
            self.band_low[k] = low;
            self.band_vocal[k] = (1.0 - low) * high_roll;
        }
    }

    pub fn reset(&mut self) {
        let clear = |v: &mut Vec<Vec<f32>>| v.iter_mut().for_each(|c| c.fill(0.0));
        clear(&mut self.in_buf);
        clear(&mut self.delay);
        self.ola.iter_mut().for_each(clear);
        self.ready.iter_mut().for_each(clear);
        self.spec.fill(Complex32::new(0.0, 0.0));
        self.power.fill(0.0);
        self.s_ll.fill(0.0);
        self.s_rr.fill(0.0);
        self.s_lr.fill(Complex32::new(0.0, 0.0));
        self.center_ratio = 0.0;
        self.fill = 0;
        self.delay_pos = 0;
        self.write_slot = 0;
    }

    /// Xử lý `n` mẫu từ `io_in` → `io_out[stem]` (trễ `latency()` mẫu).
    pub fn process(&mut self, n: usize) {
        let n = n.min(MAX_BLOCK);
        let hop = self.cfg.hop;
        let fft = self.cfg.fft_size;
        let delay_len = self.delay[0].len();
        let mut pos = 0;
        while pos < n {
            let chunk = (n - pos).min(hop - self.fill);
            let base = fft - hop + self.fill;
            for c in 0..CHANNELS {
                let src = &self.io_in[c][pos..pos + chunk];
                self.in_buf[c][base..base + chunk].copy_from_slice(src);
                let mut d = self.delay_pos;
                for &x in src {
                    self.delay[c][d] = x;
                    d += 1;
                    if d == delay_len {
                        d = 0;
                    }
                }
                for s in 0..STEMS {
                    self.io_out[s][c][pos..pos + chunk]
                        .copy_from_slice(&self.ready[s][c][self.fill..self.fill + chunk]);
                }
            }
            self.delay_pos = (self.delay_pos + chunk) % delay_len;
            self.fill += chunk;
            pos += chunk;
            if self.fill == hop {
                self.fill = 0;
                self.process_frame();
            }
        }
    }

    fn process_frame(&mut self) {
        let Config { fft_size: n, hop, time_half, freq_half, margin, sharpness, .. } = self.cfg;
        let bins = self.bins;
        let slots = self.slots;
        let ws = self.write_slot;

        // 1) Phân tích frame mới nhất.
        for c in 0..CHANNELS {
            for ((f, &x), &w) in self.frame.iter_mut().zip(&self.in_buf[c]).zip(&self.window) {
                *f = x * w;
            }
            let off = (ws * CHANNELS + c) * bins;
            // Kích thước buffer luôn đúng nên không thể lỗi.
            let _ = self.fwd.process_with_scratch(&mut self.frame, &mut self.spec[off..off + bins], &mut self.fwd_scratch);
            self.in_buf[c].copy_within(hop.., 0);
        }
        {
            let power = &mut self.power[ws * bins..(ws + 1) * bins];
            power.fill(0.0);
            for c in 0..CHANNELS {
                let off = (ws * CHANNELS + c) * bins;
                for (p, x) in power.iter_mut().zip(&self.spec[off..off + bins]) {
                    *p += x.norm_sqr();
                }
            }
        }
        self.write_slot = (ws + 1) % slots;
        // Frame trung tâm: cách frame mới nhất K frame (cần K frame "tương lai" cho median thời gian).
        let center = (ws + slots - time_half) % slots;

        // 2) Median theo thời gian (harmonic) và theo tần số (percussive).
        let tmp = &mut self.median_tmp;
        for k in 0..bins {
            for s in 0..slots {
                tmp[s] = self.power[s * bins + k];
            }
            let (_, m, _) = tmp[..slots].select_nth_unstable_by(time_half, f32::total_cmp);
            self.harm_med[k] = *m;
        }
        let cp = &self.power[center * bins..(center + 1) * bins];
        for k in 0..bins {
            let lo = k.saturating_sub(freq_half);
            let hi = (k + freq_half + 1).min(bins);
            let len = hi - lo;
            tmp[..len].copy_from_slice(&cp[lo..hi]);
            let (_, m, _) = tmp[..len].select_nth_unstable_by(len / 2, f32::total_cmp);
            self.perc_med[k] = *m;
        }

        // 3) Mask cho từng lớp.
        let m2 = margin * margin;
        // powf trên wasm là hàm phần mềm (chậm) → nhánh nhanh cho các giá trị nguyên hay dùng.
        let shape: fn(f32, f32) -> f32 = if sharpness == 1.0 {
            |r, _| r
        } else if sharpness == 2.0 {
            |r, _| r * r
        } else if sharpness == 3.0 {
            |r, _| r * r * r
        } else {
            f32::powf
        };
        let gamma = self.params.center_width;
        let gamma_int = (gamma.fract() == 0.0).then_some(gamma as i32);
        let center_pow = |psi: f32| match gamma_int {
            Some(g) => psi.powi(g),
            None => psi.powf(gamma),
        };
        let a = self.smooth_a;
        let l_off = (center * CHANNELS) * bins;
        let r_off = (center * CHANNELS + 1) * bins;
        let (mut centered, mut total) = (0.0f32, 0.0f32);
        for k in 0..bins {
            let p = self.perc_med[k];
            let h_med = self.harm_med[k] * m2;
            let drums = if p > 1e-30 { 1.0 / (1.0 + shape(h_med / p, sharpness)) } else { 0.0 };
            let harmonic = 1.0 - drums;

            let l = self.spec[l_off + k];
            let r = self.spec[r_off + k];
            self.s_ll[k] = a * self.s_ll[k] + (1.0 - a) * l.norm_sqr();
            self.s_rr[k] = a * self.s_rr[k] + (1.0 - a) * r.norm_sqr();
            self.s_lr[k] = self.s_lr[k] * a + l * r.conj() * (1.0 - a);
            let denom = self.s_ll[k] + self.s_rr[k];
            // Dùng phần thực (cùng pha) thay vì |S_LR|: hai kênh tương quan nhưng lệch pha
            // (stereo rộng, chorus, detune) không được tính là "ở giữa".
            let psi = if denom > 1e-30 { (2.0 * self.s_lr[k].re / denom).clamp(0.0, 1.0) } else { 0.0 };

            let vband = self.band_vocal[k];
            self.gains[DRUMS][k] = drums;
            self.gains[BASS][k] = harmonic * self.band_low[k];
            self.gains[VOCALS][k] = harmonic * vband * center_pow(psi);

            let e = (l.norm_sqr() + r.norm_sqr()) * harmonic * vband;
            centered += e * psi;
            total += e;
        }
        if total > 1e-20 {
            // làm mượt ~1 s
            let frame_s = hop as f32 / self.cfg.sample_rate;
            let b = (-frame_s / 1.0).exp();
            self.center_ratio = b * self.center_ratio + (1.0 - b) * (centered / total);
        }

        // 4) Tổng hợp 3 lớp bằng IFFT + overlap-add; lớp OTHER = input trễ − 3 lớp.
        let delay_len = self.delay[0].len();
        // Mẫu đầu tiên của hop sắp phát ra ứng với input cách đây `latency` mẫu.
        let start = (self.delay_pos + delay_len - (n + time_half * hop)) % delay_len;
        let scale = self.ola_scale;
        for c in 0..CHANNELS {
            let off = (center * CHANNELS + c) * bins;
            for s in 0..SYNTH_STEMS {
                for ((y, x), &g) in self.spec_tmp.iter_mut().zip(&self.spec[off..off + bins]).zip(&self.gains[s]) {
                    *y = x * g;
                }
                self.spec_tmp[0].im = 0.0;
                self.spec_tmp[bins - 1].im = 0.0;
                let _ = self.inv.process_with_scratch(&mut self.spec_tmp, &mut self.time_out, &mut self.inv_scratch);
                let ola = &mut self.ola[s][c];
                for ((o, &t), &w) in ola.iter_mut().zip(&self.time_out).zip(&self.window) {
                    *o += t * w * scale;
                }
            }
            let delay = &self.delay[c];
            for i in 0..hop {
                let mut rest = delay[(start + i) % delay_len];
                for s in 0..SYNTH_STEMS {
                    let v = self.ola[s][c][i];
                    self.ready[s][c][i] = v;
                    rest -= v;
                }
                self.ready[OTHER][c][i] = rest;
            }
            for s in 0..SYNTH_STEMS {
                let ola = &mut self.ola[s][c];
                ola.copy_within(hop.., 0);
                ola[n - hop..].fill(0.0);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// C ABI cho JS (AudioWorklet). Không dùng wasm-bindgen để không cần glue/TextDecoder trong worklet.
// ---------------------------------------------------------------------------

/// Trả về con trỏ tới Separator, hoặc null nếu cấu hình không hợp lệ.
#[unsafe(no_mangle)]
pub extern "C" fn sep_new(
    sample_rate: f32,
    fft_size: u32,
    hop: u32,
    time_half: u32,
    freq_half: u32,
    margin: f32,
    sharpness: f32,
) -> *mut Separator {
    let cfg = Config {
        sample_rate,
        fft_size: fft_size as usize,
        hop: hop as usize,
        time_half: time_half as usize,
        freq_half: freq_half as usize,
        margin,
        sharpness,
    };
    match Separator::new(cfg) {
        Some(s) => Box::into_raw(Box::new(s)),
        None => std::ptr::null_mut(),
    }
}

/// # Safety
/// `s` phải là con trỏ do `sep_new` trả về và chưa bị free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sep_free(s: *mut Separator) {
    if !s.is_null() {
        drop(unsafe { Box::from_raw(s) });
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn sep_max_block() -> u32 {
    MAX_BLOCK as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn sep_num_stems() -> u32 {
    STEMS as u32
}

/// # Safety
/// `s` hợp lệ (xem `sep_free`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sep_latency(s: *const Separator) -> u32 {
    unsafe { s.as_ref() }.map_or(0, |s| s.latency() as u32)
}

/// # Safety
/// `s` hợp lệ (xem `sep_free`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sep_center_ratio(s: *const Separator) -> f32 {
    unsafe { s.as_ref() }.map_or(0.0, |s| s.center_ratio())
}

/// # Safety
/// `s` hợp lệ (xem `sep_free`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sep_input_ptr(s: *mut Separator, ch: u32) -> *mut f32 {
    unsafe { s.as_mut() }.map_or(std::ptr::null_mut(), |s| s.io_in[(ch as usize).min(CHANNELS - 1)].as_mut_ptr())
}

/// # Safety
/// `s` hợp lệ (xem `sep_free`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sep_output_ptr(s: *mut Separator, stem: u32, ch: u32) -> *mut f32 {
    unsafe { s.as_mut() }.map_or(std::ptr::null_mut(), |s| {
        s.io_out[(stem as usize).min(STEMS - 1)][(ch as usize).min(CHANNELS - 1)].as_mut_ptr()
    })
}

/// # Safety
/// `s` hợp lệ (xem `sep_free`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sep_set_params(
    s: *mut Separator,
    bass_cutoff_hz: f32,
    vocal_high_hz: f32,
    center_width: f32,
    center_smoothing_ms: f32,
) {
    if let Some(s) = unsafe { s.as_mut() } {
        s.set_params(StemParams { bass_cutoff_hz, vocal_high_hz, center_width, center_smoothing_ms });
    }
}

/// # Safety
/// `s` hợp lệ (xem `sep_free`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sep_reset(s: *mut Separator) {
    if let Some(s) = unsafe { s.as_mut() } {
        s.reset();
    }
}

/// # Safety
/// `s` hợp lệ (xem `sep_free`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sep_process(s: *mut Separator, n: u32) {
    if let Some(s) = unsafe { s.as_mut() } {
        s.process(n as usize);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48000.0;
    const CFG: Config = Config {
        sample_rate: SR,
        fft_size: 1024,
        hop: 512,
        time_half: 6,
        freq_half: 32,
        margin: 1.0,
        sharpness: 3.0,
    };

    /// Chạy tín hiệu stereo qua Separator theo block 128 mẫu; trả về [stem][kênh][mẫu].
    fn run(cfg: Config, left: &[f32], right: &[f32]) -> Vec<Vec<Vec<f32>>> {
        let mut s = Separator::new(cfg).unwrap();
        let mut out = vec![vec![Vec::new(); CHANNELS]; STEMS];
        for (bl, br) in left.chunks(128).zip(right.chunks(128)) {
            let len = bl.len();
            s.io_in[0][..len].copy_from_slice(bl);
            s.io_in[1][..len].copy_from_slice(br);
            s.process(len);
            for st in 0..STEMS {
                for c in 0..CHANNELS {
                    out[st][c].extend_from_slice(&s.io_out[st][c][..len]);
                }
            }
        }
        out
    }

    fn noise(len: usize, seed: u32) -> Vec<f32> {
        let mut s = seed;
        (0..len)
            .map(|_| {
                s = s.wrapping_mul(1664525).wrapping_add(1013904223);
                (s >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
            })
            .collect()
    }

    fn tone(len: usize, f: f32, a: f32) -> Vec<f32> {
        (0..len).map(|i| a * (2.0 * std::f32::consts::PI * f * i as f32 / SR).sin()).collect()
    }

    fn add(a: &[f32], b: &[f32]) -> Vec<f32> {
        a.iter().zip(b).map(|(x, y)| x + y).collect()
    }

    /// Tỉ lệ năng lượng của `src` (trễ `lat`) nằm trong `stem`, ước lượng bằng phép chiếu.
    fn share(out: &[Vec<f32>], src: &[f32], lat: usize, ch: usize) -> f32 {
        let (mut num, mut den) = (0.0f64, 0.0f64);
        for i in SR as usize..src.len() - lat {
            num += out[ch][i + lat] as f64 * src[i] as f64;
            den += src[i] as f64 * src[i] as f64;
        }
        (num / den) as f32
    }

    #[test]
    fn rejects_invalid_config() {
        assert!(Separator::new(Config { fft_size: 1000, ..CFG }).is_none());
        assert!(Separator::new(Config { hop: 3000, ..CFG }).is_none());
        assert!(Separator::new(Config { margin: 0.0, ..CFG }).is_none());
        assert!(Separator::new(Config { sharpness: 0.0, ..CFG }).is_none());
        assert!(Separator::new(Config { sample_rate: 0.0, ..CFG }).is_none());
    }

    #[test]
    fn latency_is_exact() {
        let lat = CFG.latency();
        let mut x = vec![0.0; 48000];
        x[1000] = 1.0;
        let out = run(CFG, &x, &x);
        let sum: Vec<f32> = (0..x.len()).map(|i| (0..STEMS).map(|s| out[s][0][i]).sum()).collect();
        let peak = sum.iter().enumerate().max_by(|a, b| a.1.abs().total_cmp(&b.1.abs())).unwrap().0;
        assert_eq!(peak, 1000 + lat);
    }

    #[test]
    fn stems_sum_to_input() {
        let len = 96000;
        let center = tone(len, 600.0, 0.3);
        let left = add(&noise(len, 7), &center);
        let right = add(&noise(len, 8), &center);
        let lat = CFG.latency();
        let out = run(CFG, &left, &right);
        for (c, x) in [&left, &right].into_iter().enumerate() {
            let max_err = (lat..len)
                .map(|i| ((0..STEMS).map(|s| out[s][c][i]).sum::<f32>() - x[i - lat]).abs())
                .fold(0.0f32, f32::max);
            assert!(max_err < 1e-5, "channel {c}: max_err={max_err}");
        }
    }

    #[test]
    fn routes_sources_to_expected_stems() {
        let len = 48000 * 4;
        let lat = CFG.latency();
        // giọng: 440 Hz ở giữa; guitar: 660 Hz chỉ bên trái; bass: 70 Hz ở giữa; trống: click.
        let vocal = tone(len, 440.0, 0.3);
        let guitar = tone(len, 660.0, 0.3);
        let bass = tone(len, 70.0, 0.3);
        let mut clicks = vec![0.0; len];
        for i in (6000..len).step_by(12000) {
            clicks[i] = 1.0;
        }
        let zero = vec![0.0; len];
        let left: Vec<f32> = (0..len).map(|i| vocal[i] + guitar[i] + bass[i] + clicks[i]).collect();
        let right: Vec<f32> = (0..len).map(|i| vocal[i] + bass[i] + clicks[i]).collect();
        let out = run(CFG, &left, &right);

        let v = share(&out[VOCALS], &vocal, lat, 1);
        let g_other = share(&out[OTHER], &guitar, lat, 0);
        let g_vocal = share(&out[VOCALS], &guitar, lat, 0);
        let b = share(&out[BASS], &bass, lat, 0);
        assert!(v > 0.9, "vocal → vocals: {v}");
        assert!(g_other > 0.9, "guitar (trái) → other: {g_other}");
        assert!(g_vocal < 0.05, "guitar (trái) lọt vào vocals: {g_vocal}");
        assert!(b > 0.9, "bass → bass: {b}");
        let _ = zero;

        // click → trống: so năng lượng sai phân bậc 2 quanh click
        let hp = |y: &[f32], at: usize| -> f32 {
            (at - 64..at + 64)
                .map(|i| {
                    let d = y[i + 1] - 2.0 * y[i] + y[i - 1];
                    d * d
                })
                .sum()
        };
        let (mut e_d, mut e_all) = (0.0, 0.0);
        for at in (6000..len - lat - 100).step_by(12000) {
            e_d += hp(&out[DRUMS][1], at + lat);
            e_all += (0..STEMS).map(|s| hp(&out[s][1], at + lat)).sum::<f32>();
        }
        assert!(e_d / e_all > 0.85, "clicks → drums: {}", e_d / e_all);
    }

    #[test]
    fn center_ratio_detects_mono() {
        let len = 48000 * 3;
        let x = add(&tone(len, 440.0, 0.3), &tone(len, 1250.0, 0.2));
        let mut s = Separator::new(CFG).unwrap();
        for b in x.chunks(128) {
            s.io_in[0][..b.len()].copy_from_slice(b);
            s.io_in[1][..b.len()].copy_from_slice(b);
            s.process(b.len());
        }
        assert!(s.center_ratio() > 0.9, "mono → {}", s.center_ratio());

        let l = noise(len, 1);
        let r = noise(len, 2);
        let mut s = Separator::new(CFG).unwrap();
        for (bl, br) in l.chunks(128).zip(r.chunks(128)) {
            s.io_in[0][..bl.len()].copy_from_slice(bl);
            s.io_in[1][..br.len()].copy_from_slice(br);
            s.process(bl.len());
        }
        assert!(s.center_ratio() < 0.5, "stereo rộng → {}", s.center_ratio());
    }
}
