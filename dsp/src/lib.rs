//! capo-dsp — tách 4 lớp nhạc cụ theo thời gian thực: trống, bass, giọng hát, nhạc cụ khác.
//!
//! Một STFT duy nhất; mỗi bin được chia bằng các mask có tổng = 1:
//!   d = mask percussive (HPSS, lọc trung vị — Fitzgerald 2010, margin kiểu Driedger 2014)
//!       H = median theo thời gian (2K+1 frame), P = median theo tần số (2M+1 bin)
//!       Dải thấp: P = max(P, low(f)·X̄ / κ²), X̄ = công suất quanh frame đó (trung bình ~30 ms). Thân kick chỉ
//!       rộng vài bin nên median theo tần số không thấy nó; ở đây "vượt hẳn median theo thời gian" = percussive.
//!       d = 1 / (1 + (β²·H / P)^s)
//!   h = 1 − d                                  (phần có cao độ)
//!   bass   = h · low(f)                        (dải thấp, crossover mềm quanh bass_cutoff)
//!   vocals = h · band(f) · ψ^γ                 (dải trên, chỉ phần nằm GIỮA stereo)
//!   other  = phần còn lại
//! ψ = 2·Re(S_LR) / (S_LL + S_RR) là độ giống nhau L/R (biến thể cùng pha của Avendano & Jot 2002),
//! S là phổ chéo làm mượt theo thời gian: ψ = 1 khi L = R (giữa), giảm khi lệch trái/phải hoặc lệch pha.
//! Cửa sổ làm mượt là hàm mũ HAI PHÍA quanh frame đang xử lý — dùng luôn K frame "tương lai" đã phải chờ
//! cho median theo thời gian, nên ψ không bị trễ so với tín hiệu và không tốn thêm latency.
//!
//! Chế độ karaoke (lớp giọng không được phát ra → ưu tiên lấy hết giọng khỏi các lớp còn lại): mask ψ^γ loại cả bin
//! khi giọng nằm chung bin với nhạc cụ lệch/rộng, nên giọng sót lại trong "other". Vì vậy trước khi áp mask, phần
//! giữa được trích ra bằng bộ lọc không gian MVDR hướng vào giữa (dùng cùng các phổ làm mượt S_LL, S_RR, S_LR):
//!   C = w_L·L + w_R·R,  w_L + w_R = 1 (phần ở giữa đi qua nguyên vẹn), w chọn để công suất đầu ra nhỏ nhất:
//!   w_L = (S_RR − S_LR + δ) / (S_LL + S_RR − 2·S_LR + 2δ),  δ = λ·(S_LL + S_RR)   (diagonal loading)
//!   vocals = h · band(f) · [ g·C + ψ'^γ · (X − g·C) ],  g = P_C / P_out (hậu lọc Wiener, xem `center_split`)
//! Một nhạc cụ lệch trái/phải nằm chung bin với giọng bị triệt tiêu thay vì kéo cả bin sang "other". ψ' là độ giống
//! nhau L/R của phần CÒN LẠI sau khi bỏ g·C: một nguồn đơn lẻ (không có gì để triệt) vẫn được chia bằng ψ^γ như thường.
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
    /// Hằng số thời gian làm mượt phổ chéo L/R (ms), mỗi phía; cửa sổ bị cắt ở ±K frame.
    pub center_smoothing_ms: f32,
    /// κ: ở dải thấp, công suất phải vượt median theo thời gian bao nhiêu lần (biên độ) thì tính là trống.
    pub transient_margin: f32,
    /// Lớp giọng không được phát ra: trích phần giữa bằng MVDR trước khi áp mask ψ^γ (xem đầu file).
    pub karaoke: bool,
    /// λ: diagonal loading của MVDR. Lớn hơn → ít triệt nhạc cụ lệch hơn nhưng giọng hơi lệch khỏi giữa vẫn được lấy.
    pub center_loading: f32,
}

impl Default for StemParams {
    fn default() -> Self {
        Self {
            bass_cutoff_hz: 180.0,
            vocal_high_hz: 12000.0,
            center_width: 4.0,
            center_smoothing_ms: 50.0,
            transient_margin: 2.0,
            karaoke: false,
            center_loading: 0.1,
        }
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

    /// Re(L·conj(R)) của từng frame: [slot][bin] — tử số của độ giống nhau L/R.
    cross: Vec<f32>,
    /// Trọng số làm mượt theo khoảng cách (số frame) tới frame trung tâm: [0..=K]
    smooth_w: Vec<f32>,
    psi_num: Vec<f32>,
    psi_den: Vec<f32>,
    /// |L|² làm mượt như `psi_num`/`psi_den` (S_RR = psi_den − s_ll) — chỉ dùng ở chế độ karaoke.
    s_ll: Vec<f32>,
    /// MVDR cho từng bin: w_L (w_R = 1 − w_L) và gain của đầu ra MVDR trong lớp giọng — chỉ dùng ở chế độ karaoke.
    beam_l: Vec<f32>,
    beam_gain: Vec<f32>,
    /// J: công suất dải thấp được lấy trung bình trên 2J+1 frame (≈ 30 ms) trước khi so với median.
    trans_half: usize,
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
            cross: zeros(slots * bins),
            smooth_w: zeros(cfg.time_half + 1),
            psi_num: zeros(bins),
            psi_den: zeros(bins),
            s_ll: zeros(bins),
            beam_l: zeros(bins),
            beam_gain: zeros(bins),
            trans_half: ((0.015 * cfg.sample_rate / hop as f32).round() as usize).clamp(1, cfg.time_half),
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
            transient_margin: fix(p.transient_margin, 1.0, 16.0, d.transient_margin),
            karaoke: p.karaoke,
            center_loading: fix(p.center_loading, 0.01, 1.0, d.center_loading),
        };
        self.params = p;
        let frame_ms = self.cfg.hop as f32 / self.cfg.sample_rate * 1000.0;
        let a = if p.center_smoothing_ms > 0.0 { (-frame_ms / p.center_smoothing_ms).exp() } else { 0.0 };
        let mut w = 1.0;
        for v in self.smooth_w.iter_mut() {
            *v = w;
            w *= a;
        }
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
        self.cross.fill(0.0);
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
                let mut d = self.delay_pos;
                for (dst, &x) in self.in_buf[c][base..base + chunk].iter_mut().zip(src) {
                    // NaN/Inf sẽ làm hỏng mọi frame chứa nó (và cả lớp OTHER) → coi như im lặng.
                    let x = if x.is_finite() { x } else { 0.0 };
                    *dst = x;
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
            let (l, r) = self.spec[ws * CHANNELS * bins..(ws * CHANNELS + 2) * bins].split_at(bins);
            for ((x, l), r) in self.cross[ws * bins..(ws + 1) * bins].iter_mut().zip(l).zip(r) {
                *x = l.re * r.re + l.im * r.im;
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
        // Phổ chéo làm mượt hai phía quanh frame trung tâm: ψ = 2·Σw·Re(L·R*) / Σw·(|L|² + |R|²).
        let karaoke = self.params.karaoke;
        self.psi_num.fill(0.0);
        self.psi_den.fill(0.0);
        self.s_ll.fill(0.0);
        for j in 0..slots {
            let w = self.smooth_w[j.abs_diff(time_half)];
            if w == 0.0 {
                continue;
            }
            let s = (center + slots - time_half + j) % slots;
            let cross = &self.cross[s * bins..(s + 1) * bins];
            let power = &self.power[s * bins..(s + 1) * bins];
            for (((num, den), &x), &p) in self.psi_num.iter_mut().zip(self.psi_den.iter_mut()).zip(cross).zip(power) {
                *num += w * x;
                *den += w * p;
            }
            if karaoke {
                let left = &self.spec[s * CHANNELS * bins..s * CHANNELS * bins + bins];
                for (acc, x) in self.s_ll.iter_mut().zip(left) {
                    *acc += w * x.norm_sqr();
                }
            }
        }
        let loading = self.params.center_loading;
        let kappa = 1.0 / (self.params.transient_margin * self.params.transient_margin);
        let th = self.trans_half;
        let trans_norm = kappa / (2 * th + 1) as f32;
        let (mut centered, mut total) = (0.0f32, 0.0f32);
        for k in 0..bins {
            let x = cp[k];
            let low = self.band_low[k];
            // Dải thấp: công suất vượt hẳn median theo thời gian cũng là bằng chứng percussive (kick).
            // Lấy trung bình ~30 ms: frame ngắn hơn chu kỳ nốt bass thấy từng xung của sóng, không phải transient.
            let mut p = self.perc_med[k];
            if low > 1e-3 {
                let mut acc = 0.0;
                for j in 0..=2 * th {
                    acc += self.power[((center + slots - th + j) % slots) * bins + k];
                }
                p = p.max(low * acc * trans_norm);
            }
            let h_med = self.harm_med[k] * m2;
            let drums = if p > 1e-30 { 1.0 / (1.0 + shape(h_med / p, sharpness)) } else { 0.0 };
            let harmonic = 1.0 - drums;

            let den = self.psi_den[k];
            // Dùng phần thực (cùng pha) thay vì |S_LR|: hai kênh tương quan nhưng lệch pha
            // (stereo rộng, chorus, detune) không được tính là "ở giữa".
            let psi = if den > 1e-30 { (2.0 * self.psi_num[k] / den).clamp(0.0, 1.0) } else { 0.0 };

            let vband = self.band_vocal[k];
            let mut vocal = center_pow(psi);
            if karaoke {
                let (mut w_left, mut beam) = (0.5, 0.0);
                if den > 1e-30 {
                    let sll = self.s_ll[k];
                    let (w, g, psi_rest) = center_split(sll, (den - sll).max(0.0), self.psi_num[k], loading);
                    // lớp giọng = g·C + ψ'^γ·(X − g·C) = ψ'^γ·X + (1 − ψ'^γ)·g·C
                    vocal = center_pow(psi_rest);
                    (w_left, beam) = (w, (1.0 - vocal) * g);
                }
                self.beam_l[k] = w_left;
                self.beam_gain[k] = harmonic * vband * beam;
            }
            self.gains[DRUMS][k] = drums;
            self.gains[BASS][k] = harmonic * low;
            self.gains[VOCALS][k] = harmonic * vband * vocal;

            let e = x * harmonic * vband;
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
                if karaoke && s == VOCALS {
                    // + phần giữa do MVDR trích ra (giống nhau ở hai kênh)
                    let (l, r) = self.spec[center * CHANNELS * bins..(center * CHANNELS + 2) * bins].split_at(bins);
                    let beam = self.beam_l.iter().zip(&self.beam_gain);
                    for (((y, l), r), (&wl, &g)) in self.spec_tmp.iter_mut().zip(l).zip(r).zip(beam) {
                        *y += (l * wl + r * (1.0 - wl)) * g;
                    }
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

/// Tách phần ở giữa stereo của một bin bằng MVDR + hậu lọc Wiener (chế độ karaoke).
/// `sll`, `srr`, `slr`: S_LL, S_RR, Re(S_LR) đã làm mượt, sll + srr > 0.
/// Trả về (w_L, g, ψ'): phần giữa ≈ g · (w_L·L + (1 − w_L)·R); ψ' = độ giống nhau L/R của phần còn lại.
#[inline]
fn center_split(sll: f32, srr: f32, slr: f32, loading: f32) -> (f32, f32, f32) {
    let total = sll + srr;
    // u, v: công suất "không nằm giữa" của kênh trái / phải; u + v = công suất của L − R (≥ 0).
    let (u, v) = (sll - slr, srr - slr);
    let delta = loading * total;
    let wl = (v + delta) / (u + v + 2.0 * delta);
    let wr = 1.0 - wl;
    let p_out = wl * wl * sll + wr * wr * srr + 2.0 * wl * wr * slr;
    // Công suất phần giữa = giá trị nhỏ hơn trong hai ước lượng:
    //   det / (u + v): phần còn lại sau khi triệt hoàn toàn MỘT nguồn lệch — đúng khi nhiễu là một nhạc cụ pan lệch;
    //   S_LR:          đúng khi nhiễu ở hai kênh không tương quan (pad, reverb rộng).
    // Một nguồn đơn lẻ lệch khỏi giữa (ma trận hạng 1) cho det = 0 ⇒ không có "phần giữa", để cửa sổ ψ'^γ quyết định.
    let uv = u + v;
    let nulled = if uv > 1e-6 * total { ((sll * srr - slr * slr) / uv).max(0.0) } else { p_out };
    let center = nulled.min(slr).clamp(0.0, p_out.max(0.0));
    let g = if p_out > 1e-30 { center / p_out } else { 0.0 };
    // Phần còn lại: bỏ công suất phần giữa khỏi cả S_LL, S_RR và S_LR.
    let rest = total - 2.0 * center;
    let psi_rest = if rest > 1e-6 * total { (2.0 * (slr - center) / rest).clamp(0.0, 1.0) } else { 0.0 };
    (wl, g, psi_rest)
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
    karaoke: u32,
) {
    if let Some(s) = unsafe { s.as_mut() } {
        s.set_params(StemParams {
            bass_cutoff_hz,
            vocal_high_hz,
            center_width,
            center_smoothing_ms,
            karaoke: karaoke != 0,
            ..StemParams::default()
        });
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
    /// = SEPARATOR_PRESETS.default trong presets.js
    const CFG: Config = Config {
        sample_rate: SR,
        fft_size: 2048,
        hop: 512,
        time_half: 4,
        freq_half: 24,
        margin: 0.92,
        sharpness: 3.0,
    };
    const KARAOKE: StemParams =
        StemParams { bass_cutoff_hz: 180.0, vocal_high_hz: 12000.0, center_width: 2.0, center_smoothing_ms: 50.0, transient_margin: 2.0, karaoke: true, center_loading: 0.1 };

    /// Chạy tín hiệu stereo qua Separator theo block 128 mẫu; trả về [stem][kênh][mẫu].
    fn run(cfg: Config, left: &[f32], right: &[f32]) -> Vec<Vec<Vec<f32>>> {
        run_with(cfg, StemParams::default(), left, right)
    }

    fn run_with(cfg: Config, params: StemParams, left: &[f32], right: &[f32]) -> Vec<Vec<Vec<f32>>> {
        let mut s = Separator::new(cfg).unwrap();
        s.set_params(params);
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

    /// Kick tổng hợp: thân quét 160 → 50 Hz tắt trong ~50 ms + tiếng "tách", mỗi 0.5 s.
    fn kick(len: usize) -> Vec<f32> {
        let mut rnd = noise(len, 5).into_iter();
        let mut phase = 0.0f32;
        (0..len)
            .map(|i| {
                let t = (i as f32 / SR) % 0.5;
                if t < 1.0 / SR {
                    phase = 0.0;
                }
                phase = (phase + (50.0 + 110.0 * (-t / 0.03).exp()) / SR).fract();
                let body = (2.0 * std::f32::consts::PI * phase).sin() * (-t / 0.05).exp() * 0.6;
                body + rnd.next().unwrap() * (-t / 0.004).exp() * 0.3
            })
            .collect()
    }

    #[test]
    fn kick_goes_to_drums_and_bass_stays() {
        let len = 48000 * 4;
        let lat = CFG.latency();
        let k = kick(len);
        let out = run(CFG, &k, &k);
        let d = share(&out[DRUMS], &k, lat, 0);
        assert!(d > 0.5, "kick → drums: {d}");

        // bass răng cưa (40 bồi âm), đổi nốt mỗi 0.5 s
        let notes = [55.0, 73.42, 82.41, 61.74];
        let mut phase = 0.0f32;
        let bass: Vec<f32> = (0..len)
            .map(|i| {
                phase = (phase + notes[i / 24000 % 4] / SR).fract();
                (1..=40).map(|h| (2.0 * std::f32::consts::PI * phase * h as f32).sin() / h as f32).sum::<f32>() * 0.25
            })
            .collect();
        let out = run(CFG, &bass, &bass);
        let (b, d) = (share(&out[BASS], &bass, lat, 0), share(&out[DRUMS], &bass, lat, 0));
        assert!(b > 0.72, "bass → bass: {b}");
        assert!(d < 0.05, "bass lọt vào drums: {d}");
    }

    #[test]
    fn vocals_follow_pan_change_quickly() {
        // 440 Hz chỉ bên trái, sau 2 s chuyển vào giữa: lớp giọng phải đạt −6 dB trong ≤ 50 ms.
        let (len, switch) = (48000 * 4, 48000 * 2);
        let lat = CFG.latency();
        let l = tone(len, 440.0, 0.3);
        let r: Vec<f32> = (0..len).map(|i| if i >= switch { l[i] } else { 0.0 }).collect();
        let out = run(CFG, &l, &r);
        let y = &out[VOCALS][0];
        let rms = |from: usize| (y[from..from + 480].iter().map(|v| v * v).sum::<f32>() / 480.0).sqrt();
        let steady = rms(len - 4800);
        assert!(rms(switch + lat - 4800) < 0.05 * steady, "trước khi chuyển: {}", rms(switch + lat - 4800) / steady);
        // cửa sổ RMS 10 ms có tâm ở switch + 50 ms
        let at = rms(switch + lat + 2400 - 240);
        assert!(at > 0.5 * steady, "50 ms sau khi chuyển: {}", at / steady);
    }

    #[test]
    fn recovers_from_non_finite_input() {
        let len = 48000 * 2;
        let clean = tone(len, 440.0, 0.3);
        let mut bad = clean.clone();
        bad[1000] = f32::NAN;
        bad[1001] = f32::INFINITY;
        let ok = run(CFG, &clean, &clean);
        let out = run(CFG, &bad, &bad);
        for s in 0..STEMS {
            assert!(out[s][0].iter().all(|v| v.is_finite()), "lớp {s} có mẫu không hữu hạn");
        }
        let energy = |o: &[Vec<Vec<f32>>]| o[VOCALS][0][len - 48000..].iter().map(|v| v * v).sum::<f32>();
        let ratio = energy(&out) / energy(&ok);
        assert!((0.99..1.01).contains(&ratio), "năng lượng lớp giọng sau NaN / bình thường = {ratio}");
    }

    #[test]
    fn synthesis_gain_is_unity() {
        // OTHER = input − 3 lớp kia nên `stems_sum_to_input` không thấy được sai hệ số tổng hợp:
        // một tone ở giữa phải nằm trọn trong lớp giọng với gain 1, OTHER gần như rỗng.
        let len = 48000 * 2;
        let lat = CFG.latency();
        let x = tone(len, 440.0, 0.3);
        let out = run(CFG, &x, &x);
        let v = share(&out[VOCALS], &x, lat, 0);
        assert!((0.97..1.01).contains(&v), "tone giữa → vocals: {v}");
        let energy = |y: &[f32]| y[48000..].iter().map(|v| v * v).sum::<f32>();
        let rest = energy(&out[OTHER][0]) / energy(&x);
        assert!(rest < 1e-3, "năng lượng OTHER / input = {rest}");
    }

    #[test]
    fn karaoke_keeps_sum_and_routing() {
        // Tổng 4 lớp vẫn bằng input.
        let len = 96000;
        let lat = CFG.latency();
        let center = tone(len, 600.0, 0.3);
        let left = add(&noise(len, 7), &center);
        let right = add(&noise(len, 8), &center);
        let out = run_with(CFG, KARAOKE, &left, &right);
        for (c, x) in [&left, &right].into_iter().enumerate() {
            let max_err = (lat..len)
                .map(|i| ((0..STEMS).map(|s| out[s][c][i]).sum::<f32>() - x[i - lat]).abs())
                .fold(0.0f32, f32::max);
            assert!(max_err < 1e-5, "channel {c}: max_err={max_err}");
        }

        // Tone ở giữa → trọn trong lớp giọng; tone chỉ bên trái → không vào lớp giọng.
        let len = 48000 * 2;
        let vocal = tone(len, 440.0, 0.3);
        let guitar = tone(len, 660.0, 0.3);
        let out = run_with(CFG, KARAOKE, &add(&vocal, &guitar), &vocal);
        let v = share(&out[VOCALS], &vocal, lat, 1);
        assert!((0.97..1.01).contains(&v), "tone giữa → vocals: {v}");
        let g_vocal = share(&out[VOCALS], &guitar, lat, 0);
        let g_other = share(&out[OTHER], &guitar, lat, 0);
        assert!(g_vocal < 0.05, "tone trái lọt vào vocals: {g_vocal}");
        assert!(g_other > 0.9, "tone trái → other: {g_other}");

        // Nguồn đơn lẻ hơi lệch khỏi giữa (R nhỏ hơn L 6 dB, ψ = 0.8): không có gì để triệt ⇒ chia bằng ψ^γ như mask.
        let wide_r: Vec<f32> = vocal.iter().map(|x| 0.5 * x).collect();
        let out = run_with(CFG, KARAOKE, &vocal, &wide_r);
        let w = share(&out[VOCALS], &vocal, lat, 0);
        assert!((w - 0.8f32.powf(KARAOKE.center_width)).abs() < 0.03, "nguồn lệch (ψ = 0.8) → vocals: {w}");
    }

    /// Tổng `harmonics` bồi âm của `f0`, biên độ 1/h.
    fn harmonic(len: usize, f0: f32, harmonics: usize, a: f32) -> Vec<f32> {
        (1..=harmonics).fold(vec![0.0; len], |acc, h| add(&acc, &tone(len, f0 * h as f32, a / h as f32)))
    }

    #[test]
    fn karaoke_pulls_vocal_from_under_other_instruments() {
        let len = 48000 * 4;
        let lat = CFG.latency();
        let mask = StemParams { karaoke: false, ..KARAOKE };
        let vocal = harmonic(len, 220.0, 8, 0.2);

        // 1) Hợp âm stereo rộng (L/R lệch tần số → không tương quan) phủ lên các bồi âm của giọng.
        let (mut wide_l, mut wide_r) = (vec![0.0; len], vec![0.0; len]);
        for f0 in [220.0f32, 277.18, 329.63] {
            wide_l = add(&wide_l, &harmonic(len, f0 * 1.004, 8, 0.1));
            wide_r = add(&wide_r, &harmonic(len, f0 * 0.996, 8, 0.1));
        }
        let (left, right) = (add(&vocal, &wide_l), add(&vocal, &wide_r));
        let m = run_with(CFG, mask, &left, &right);
        let k = run_with(CFG, KARAOKE, &left, &right);
        let (v_mask, v_kar) = (share(&m[VOCALS], &vocal, lat, 0), share(&k[VOCALS], &vocal, lat, 0));
        let (w_mask, w_kar) = (share(&m[VOCALS], &wide_l, lat, 0), share(&k[VOCALS], &wide_l, lat, 0));
        assert!(v_kar > v_mask + 0.1, "hợp âm rộng — giọng lấy ra được: karaoke {v_kar}, mask {v_mask}");
        assert!(w_kar < w_mask + 0.02, "hợp âm rộng — nhạc đệm bị mất: karaoke {w_kar}, mask {w_mask}");

        // 2) Nhạc cụ pan lệch trái (0.9 / 0.3) có bồi âm nằm chung bin với bồi âm của giọng.
        let guitar = harmonic(len, 226.0, 8, 0.2);
        let left = add(&vocal, &guitar.iter().map(|x| x * 0.9).collect::<Vec<_>>());
        let right = add(&vocal, &guitar.iter().map(|x| x * 0.3).collect::<Vec<_>>());
        let m = run_with(CFG, mask, &left, &right);
        let k = run_with(CFG, KARAOKE, &left, &right);
        let (v_mask, v_kar) = (share(&m[VOCALS], &vocal, lat, 1), share(&k[VOCALS], &vocal, lat, 1));
        let (g_mask, g_kar) = (share(&m[VOCALS], &guitar, lat, 0), share(&k[VOCALS], &guitar, lat, 0));
        assert!(v_kar > v_mask, "nhạc cụ lệch — giọng lấy ra được: karaoke {v_kar}, mask {v_mask}");
        assert!(g_kar < 0.9 * g_mask, "nhạc cụ lệch — nhạc đệm bị mất: karaoke {g_kar}, mask {g_mask}");
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
