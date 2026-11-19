// Cấu hình + tùy chọn mặc định (dùng chung cho background.js, popup.js, audio/engine.js và tests/).

// Signalsmith Stretch (pitch shift)
export const QUALITY_PRESETS = {
  default: { blockMs: 0, preset: 'default' }, // chất lượng tốt nhất
  cheaper: { blockMs: 0, preset: 'cheaper' }, // ít CPU hơn
  lowLatency: { blockMs: 60, intervalMs: 10 }, // trễ thấp hơn, hợp xem video (interval 10 ms: sai số cao độ < 0.5%)
};

// Bộ tách lớp (Rust/WASM) — giá trị cho 44.1/48 kHz. Latency = fftSize + timeHalf·hop mẫu.
// Chọn bằng `dsp/build.sh tune` (dsp/examples/tune.rs).
// default/lowLatency dùng FFT dài, chồng lấp 75 %: bin hẹp gấp đôi (23/47 Hz) nên nốt bass, kick và bồi âm tách
// nhau rõ hơn mà độ trễ không đổi; đổi lại bộ tách tốn CPU ≈ 1,5 lần → `cheaper` giữ FFT ngắn, chồng lấp 50 %.
export const SEPARATOR_PRESETS = {
  default: { fftSize: 2048, hop: 512, timeHalf: 4, freqHalf: 24, margin: 0.92, sharpness: 3 }, // ≈ 85 ms
  cheaper: { fftSize: 1024, hop: 512, timeHalf: 6, freqHalf: 32, margin: 1.0, sharpness: 3 }, // ≈ 85 ms
  lowLatency: { fftSize: 1024, hop: 256, timeHalf: 6, freqHalf: 32, margin: 0.95, sharpness: 3 }, // ≈ 53 ms
};

/** Preset đã nhân đôi kích thước khi sample rate cao (88.2/96 kHz) để giữ cùng độ phân giải theo Hz/ms. */
export function separatorPreset(quality, sampleRate) {
  const p = { ...(SEPARATOR_PRESETS[quality] ?? SEPARATOR_PRESETS.default) };
  if (sampleRate > 64000) {
    p.fftSize *= 2;
    p.hop *= 2;
  }
  return p;
}

// Thứ tự = thứ tự output của bộ tách (dsp/src/lib.rs: DRUMS, BASS, VOCALS, OTHER).
export const STEM_NAMES = ['drums', 'bass', 'vocals', 'other'];

const stem = (transpose) => ({ gain: 1, mute: false, solo: false, transpose });

export const DEFAULT_OPTIONS = {
  quality: 'default',
  formant: false,
  separate: false,
  /** γ: càng lớn thì lớp giọng càng chỉ lấy phần thật sự ở giữa stereo. */
  centerWidth: 4,
  stems: { drums: stem(false), bass: stem(true), vocals: stem(true), other: stem(true) },
};

const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

/** Gộp `patch` vào `base` (gộp sâu cho `stems`) và chuẩn hóa giá trị. */
export function mergeOptions(base = DEFAULT_OPTIONS, patch = {}) {
  const o = { ...DEFAULT_OPTIONS, ...base, ...patch };
  // Tương thích bản trước: drumKeep > 0 ⇒ bật tách lớp, trống không đổi tông.
  const legacyDrumKeep = patch.drumKeep ?? base.drumKeep;
  delete o.drumKeep;
  const stems = {};
  for (const name of STEM_NAMES) {
    const s = { ...DEFAULT_OPTIONS.stems[name], ...base.stems?.[name], ...patch.stems?.[name] };
    stems[name] = {
      gain: clamp(s.gain, 0, 2, 1),
      mute: !!s.mute,
      solo: !!s.solo,
      transpose: !!s.transpose,
    };
  }
  o.stems = stems;
  if (legacyDrumKeep > 0 && base.separate === undefined && patch.separate === undefined) o.separate = true;
  o.separate = !!o.separate;
  o.formant = !!o.formant;
  o.centerWidth = clamp(o.centerWidth, 1, 32, DEFAULT_OPTIONS.centerWidth);
  if (!QUALITY_PRESETS[o.quality]) o.quality = DEFAULT_OPTIONS.quality;
  return o;
}

/** γ dùng khi lớp giọng không phát ra (tắt giọng kiểu karaoke): ưu tiên lấy hết giọng khỏi nhạc nền. */
export const KARAOKE_CENTER_WIDTH = 2;

/**
 * γ thực tế đưa cho bộ tách. Khi lớp giọng không nghe được (mute, âm lượng 0, hoặc lớp khác đang solo) thì
 * không còn lý do giữ lớp giọng "sạch": γ lớn chỉ làm giọng có vang/bè stereo sót lại trong các lớp đang phát.
 */
export function effectiveCenterWidth(options) {
  const vocalsAudible = effectiveGains(options.stems).vocals > 0;
  return vocalsAudible ? options.centerWidth : Math.min(options.centerWidth, KARAOKE_CENTER_WIDTH);
}

/**
 * Tham số đưa cho bộ tách. `karaoke` (lớp giọng không nghe được): bộ tách trích phần giữa bằng lọc không gian
 * trước khi áp mask — lấy được nhiều giọng hơn khỏi các lớp đang phát (dsp/src/lib.rs).
 */
export function separatorParams(options) {
  return { centerWidth: effectiveCenterWidth(options), karaoke: !(effectiveGains(options.stems).vocals > 0) };
}

/** Gain thực tế của từng lớp sau khi áp mute/solo. */
export function effectiveGains(stems) {
  const anySolo = STEM_NAMES.some((n) => stems[n].solo);
  return Object.fromEntries(
    STEM_NAMES.map((n) => {
      const s = stems[n];
      const audible = anySolo ? s.solo : !s.mute;
      return [n, audible ? s.gain : 0];
    }),
  );
}
