// Test engine âm thanh của CAPO (đúng code extension dùng: audio/engine.js + bộ tách lớp Rust/WASM
// + bộ ghi WAV), chạy trong OfflineAudioContext dưới cùng CSP với extension.

import { createEngine } from '../audio/engine.js';
import { createSeparatorNode } from '../audio/separator-node.js';
import { DEFAULT_OPTIONS, KARAOKE_CENTER_WIDTH, STEM_NAMES, effectiveCenterWidth, mergeOptions, separatorParams, separatorPreset, stretchProfile } from '../presets.js';

const SR = 48000;
const DRUMS = 0, BASS = 1, VOCALS = 2, OTHER = 3;

// ---------- tín hiệu ----------
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}
const sine = (len, f, a) => Float32Array.from({ length: len }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / SR));
/** Tổng `count` bồi âm của `f0`, biên độ a/h. */
const harmonics = (len, f0, count, a) => mix(...Array.from({ length: count }, (_, h) => sine(len, f0 * (h + 1), a / (h + 1))));
function clicks(len, period, a = 1) {
  const x = new Float32Array(len);
  for (let i = period; i < len; i += period) x[i] = a;
  return x;
}
function noise(len, a, seed) {
  const r = lcg(seed);
  return Float32Array.from({ length: len }, () => a * r());
}
/** Bandpass RBJ (biquad). */
function bandpass(x, f0, q) {
  const w = (2 * Math.PI * f0) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
/** "Snare": tiếng ồn băng hẹp quanh 2 kHz, tắt dần 40 ms, lặp mỗi `period` mẫu. */
function snare(len, period, seed = 1) {
  const r = lcg(seed);
  const x = new Float32Array(len);
  for (let start = period; start < len; start += period) {
    for (let i = 0; i < 0.25 * SR && start + i < len; i++) x[start + i] = r() * Math.exp(-i / (0.04 * SR));
  }
  const y = bandpass(x, 2000, 2);
  const peak = y.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return y.map((v) => (v / peak) * 0.6);
}
const mix = (...xs) => xs[0].map((_, i) => xs.reduce((s, x) => s + x[i], 0));
const stereo = (l, r = l) => ({ l, r });

// ---------- phân tích ----------
function goertzelPower(x, f) {
  const k = 2 * Math.cos((2 * Math.PI * f) / SR);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + k * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}
function dominantFreq(x, fmin = 100, fmax = 1000) {
  let best = fmin, bestP = -1;
  for (let f = fmin; f <= fmax; f += 1) {
    const p = goertzelPower(x, f);
    if (p > bestP) { bestP = p; best = f; }
  }
  for (let f = best - 1; f <= best + 1; f += 0.05) {
    const p = goertzelPower(x, f);
    if (p > bestP) { bestP = p; best = f; }
  }
  return best;
}
/** Trọng tâm phổ (Hz) trong dải [fLo, fHi] của đoạn 2048 mẫu (cửa sổ Hann). */
function centroid(x, start, fLo = 1000, fHi = 8000, n = 2048) {
  const seg = new Float32Array(n);
  for (let i = 0; i < n; i++) seg[i] = (x[start + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  let num = 0, den = 0;
  for (let b = Math.ceil((fLo * n) / SR); b <= Math.floor((fHi * n) / SR); b++) {
    const f = (b * SR) / n;
    const p = goertzelPower(seg, f);
    num += f * p; den += p;
  }
  return num / den;
}
const energy = (x, a, b) => { let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i]; return e; };
const db = (r) => 10 * Math.log10(r);
/** Tỉ lệ năng lượng của `src` (trễ `lat`) nằm trong `y`, ước lượng bằng phép chiếu. */
function share(y, src, lat) {
  let num = 0, den = 0;
  for (let i = SR; i < src.length - lat; i++) { num += y[i + lat] * src[i]; den += src[i] * src[i]; }
  return num / den;
}

// ---------- render ----------
function sourceOf(ctx, signal) {
  const { l, r } = signal instanceof Float32Array ? stereo(signal) : signal;
  const b = new AudioBuffer({ length: l.length, numberOfChannels: 2, sampleRate: SR });
  b.copyToChannel(l, 0);
  b.copyToChannel(r, 1);
  return new AudioBufferSourceNode(ctx, { buffer: b });
}
const lengthOf = (signal) => (signal instanceof Float32Array ? signal : signal.l).length;

async function renderEngine(signal, { semitones = 0, options = {}, record = false } = {}) {
  const ctx = new OfflineAudioContext(2, lengthOf(signal), SR);
  const src = sourceOf(ctx, signal);
  const input = new GainNode(ctx);
  src.connect(input);
  const engine = await createEngine(ctx, input, ctx.destination, { semitones, options });
  const latency = Math.round((await engine.latency()) * SR);
  if (record) await engine.startRecording();
  src.start(0);
  const t0 = performance.now();
  const out = await ctx.startRendering();
  const ms = performance.now() - t0;
  const files = record ? await engine.stopRecording() : null;
  engine.dispose();
  return { y: out.getChannelData(0), yr: out.getChannelData(1), latency, ms, files };
}

/** Render một hoặc tất cả output của bộ tách. which: số output hoặc 'sum'. */
async function renderSeparator(signal, which, quality = 'default', params = {}) {
  const ctx = new OfflineAudioContext(2, lengthOf(signal), SR);
  const src = sourceOf(ctx, signal);
  const node = await createSeparatorNode(ctx, separatorPreset(quality, SR), params);
  src.connect(node);
  for (let i = 0; i < 4; i++) if (which === 'sum' || which === i) node.connect(ctx.destination, i);
  src.start(0);
  const t0 = performance.now();
  const out = await ctx.startRendering();
  return { y: out.getChannelData(0), yr: out.getChannelData(1), latency: node.latencySamples, ms: performance.now() - t0 };
}

// ---------- test ----------
const results = { sections: {}, ok: true };
function record(section, row) {
  (results.sections[section] ??= []).push(row);
  if (row.pass === false) results.ok = false;
}
const SEP = (extra = {}) => ({ separate: true, ...extra });

async function testSeparatorCore() {
  const len = SR * 3;
  const center = mix(sine(len, 440, 0.3), clicks(len, SR / 4));
  const x = stereo(mix(center, noise(len, 0.05, 9)), mix(center, noise(len, 0.05, 10)));
  for (const quality of ['default', 'cheaper', 'lowLatency']) {
    const preset = separatorPreset(quality, SR);
    const expected = preset.fftSize + preset.timeHalf * preset.hop;
    const { y, yr, latency } = await renderSeparator(x, 'sum', quality);
    let maxErr = 0;
    for (let i = latency; i < len; i++) {
      maxErr = Math.max(maxErr, Math.abs(y[i] - x.l[i - latency]), Math.abs(yr[i] - x.r[i - latency]));
    }
    record('separator', {
      test: 'tổng 4 lớp == input trễ', quality, latency, expectedLatency: expected,
      maxErr: +maxErr.toExponential(2), pass: maxErr < 1e-4 && latency === expected,
    });
  }
}

async function testStemRouting() {
  const len = SR * 4;
  const vocal = sine(len, 440, 0.3); // giữa
  const guitar = sine(len, 660, 0.3); // chỉ bên trái
  const bass = sine(len, 70, 0.3); // giữa
  const drums = clicks(len, SR / 4);
  const zero = new Float32Array(len);
  const x = stereo(mix(vocal, guitar, bass, drums), mix(vocal, zero, bass, drums));
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push(await renderSeparator(x, i));
  const lat = outs[0].latency;
  const d2 = (y, at) => { let e = 0; for (let i = at - 64; i < at + 64; i++) { const d = y[i + 1] - 2 * y[i] + y[i - 1]; e += d * d; } return e; };
  let ed = 0, eall = 0;
  for (let at = SR / 4 + lat; at + 65 < len; at += SR / 4) {
    ed += d2(outs[DRUMS].yr, at);
    eall += outs.reduce((s, o) => s + d2(o.yr, at), 0);
  }
  const rows = [
    ['giọng (giữa) → Giọng hát', share(outs[VOCALS].yr, vocal, lat), (v) => v > 0.9],
    ['guitar (trái) → Nhạc cụ khác', share(outs[OTHER].y, guitar, lat), (v) => v > 0.9],
    ['guitar (trái) lọt vào Giọng hát', share(outs[VOCALS].y, guitar, lat), (v) => v < 0.05],
    ['bass (giữa) → Bass', share(outs[BASS].y, bass, lat), (v) => v > 0.9],
    ['click → Trống', ed / eall, (v) => v > 0.85],
  ];
  for (const [test, v, ok] of rows) record('stemRouting', { test, share: +v.toFixed(3), pass: ok(v) });
}

async function testAlignment() {
  // Click thưa; semitones = 0. Độ trễ đo được (tương quan tại vị trí click) phải == độ trễ báo cáo.
  const len = SR * 4, period = SR / 2;
  const x = clicks(len, period);
  const positions = [];
  for (let i = period; i < len - SR / 2; i += period) positions.push(i);
  const corrAt = (y, lag) => positions.reduce((s, i) => s + y[i + lag], 0);
  const cases = [
    ['không tách lớp, 0 (Delay)', {}, 0],
    ['không tách lớp, +0.01 (Stretch)', {}, 0.01],
    ['tách lớp, 0 (Delay)', SEP(), 0],
    ['tách lớp, +0.01, trống giữ nguyên', SEP(), 0.01],
    ['tách lớp, +0.01, mọi lớp đổi tông', SEP({ stems: { drums: { transpose: true } } }), 0.01],
  ];
  for (const [label, options, semitones] of cases) {
    const { y, latency } = await renderEngine(x, { semitones, options });
    let bestLag = 0, best = -Infinity;
    for (let lag = 0; lag < period; lag++) {
      const v = corrAt(y, lag);
      if (v > best) { best = v; bestLag = lag; }
    }
    record('alignment', {
      case: label, reportedLatency: latency, measuredLatency: bestLag, diff: bestLag - latency,
      peakGain: +(best / positions.length).toFixed(3), pass: Math.abs(bestLag - latency) <= 2,
    });
  }
}

async function testBypassAndSharing() {
  const len = SR * 2;
  const x = stereo(mix(sine(len, 440, 0.3), noise(len, 0.1, 3)), mix(sine(len, 330, 0.3), noise(len, 0.1, 4)));
  for (const [label, options] of [['không tách lớp', {}], ['tách lớp', SEP()]]) {
    const { y, yr, latency } = await renderEngine(x, { semitones: 0, options });
    let maxErr = 0;
    for (let i = latency; i < len; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - x.l[i - latency]), Math.abs(yr[i] - x.r[i - latency]));
    record('bypassAndSharing', { test: `0 bán cung, ${label}: output == input trễ (maxErr)`, value: +maxErr.toExponential(2), pass: maxErr < 1e-5 });
  }
  const cases = [
    ['không tách lớp, 0 bán cung', 0, {}, 0],
    ['không tách lớp, +3', 3, {}, 1],
    // Lớp cùng profile dùng chung Stretch: bass (khối dài) + nhóm chuẩn; formant bật ⇒ thêm nhóm giọng.
    ['tách lớp (3 lớp đổi tông), +3', 3, SEP(), 2],
    ['tách lớp (4 lớp đổi tông), +3', 3, SEP({ stems: { drums: { transpose: true } } }), 2],
    ['tách lớp, formant, +3', 3, SEP({ formant: true }), 3],
    ['tách lớp, cheaper (bass dùng chung), +3', 3, SEP({ quality: 'cheaper' }), 1],
    ['tách lớp, 0 bán cung', 0, SEP(), 0],
  ];
  for (const [label, semitones, options, expected] of cases) {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const engine = await createEngine(ctx, new GainNode(ctx), ctx.destination, { semitones, options });
    const n = engine.debug().activeStretches;
    record('bypassAndSharing', { test: `Stretch đang chạy — ${label}`, value: n, expected, pass: n === expected });
    if (label.startsWith('tách lớp (3')) {
      await engine.startRecording();
      const rec = engine.debug().activeStretches;
      record('bypassAndSharing', { test: '… khi đang ghi từng lớp (Stretch riêng)', value: rec, expected: 3, pass: rec === 3 });
      await engine.stopRecording();
      const after = engine.debug().activeStretches;
      record('bypassAndSharing', { test: '… sau khi dừng ghi (về Stretch chung)', value: after, expected: 2, pass: after === 2 });
    }
    engine.dispose();
  }
}

async function testPitch() {
  const cases = [
    { semitones: 12 }, { semitones: -12 }, { semitones: 7 }, { semitones: 2 },
    { semitones: -5 }, { semitones: 0 }, { semitones: 0.5 },
    { semitones: 3, quality: 'lowLatency' }, { semitones: -7, quality: 'lowLatency' }, { semitones: 3, quality: 'cheaper' },
    { semitones: 5, separate: true }, { semitones: -7, separate: true, quality: 'lowLatency' },
  ];
  const x = sine(SR * 3, 440, 0.5);
  for (const c of cases) {
    const { y, latency } = await renderEngine(x, {
      semitones: c.semitones,
      options: { quality: c.quality || 'default', separate: !!c.separate },
    });
    const measured = dominantFreq(y.subarray(SR * 1.5, SR * 2.5), 100, 2000);
    const expected = 440 * 2 ** (c.semitones / 12);
    const errPct = (Math.abs(measured - expected) / expected) * 100;
    record('pitch', {
      semitones: c.semitones, quality: c.quality || 'default', separate: !!c.separate,
      expectedHz: +expected.toFixed(2), measuredHz: +measured.toFixed(2),
      errPct: +errPct.toFixed(3), latencyMs: Math.round((latency / SR) * 1000), pass: errPct < 0.5,
    });
  }
}

async function testTempo() {
  const period = SR / 2;
  const x = snare(SR * 6, period);
  for (const [label, options] of [['không tách lớp', {}], ['tách lớp', SEP()]]) {
    const { y, latency } = await renderEngine(x, { semitones: 5, options });
    const win = 240, env = [];
    for (let i = 0; i + win <= y.length; i += win) env.push(Math.sqrt(energy(y, i, i + win) / win));
    const max = Math.max(...env);
    const on = [];
    let above = false;
    env.forEach((v, i) => {
      if (!above && v > max * 0.5) { on.push((i * win) / SR); above = true; }
      else if (above && v < max * 0.2) above = false;
    });
    const gaps = on.slice(1).map((t, i) => t - on[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    record('tempo', {
      case: label, inputPeriodS: 0.5, outputPeriodS: +mean.toFixed(4), beats: on.length,
      firstOnsetS: +on[0].toFixed(3), expectedFirstS: +(0.5 + latency / SR).toFixed(3),
      pass: on.length >= 8 && Math.abs(mean - 0.5) < 0.006,
    });
  }
}

async function testDrumsKeepPitch() {
  const len = SR * 4, period = SR / 2;
  const drums = snare(len, period, 3);
  const x = mix(sine(len, 440, 0.2), drums);
  const onsets = [];
  for (let i = period; i + 2048 < len - SR / 2; i += period) onsets.push(i);
  const refCentroid = onsets.reduce((s, at) => s + centroid(drums, at), 0) / onsets.length;
  const expectedSine = 440 * 2 ** (7 / 12);
  const rows = {};
  for (const [label, options] of [
    ['không tách lớp', {}],
    ['tách lớp, trống đổi tông', SEP({ stems: { drums: { transpose: true } } })],
    ['tách lớp, trống giữ nguyên', SEP()],
  ]) {
    const { y, latency } = await renderEngine(x, { semitones: 7, options });
    const c = onsets.reduce((s, at) => s + centroid(y, at + latency), 0) / onsets.length;
    const f = dominantFreq(y.subarray(onsets[2] + latency + 0.25 * SR, onsets[2] + latency + 0.48 * SR), 300, 1000);
    rows[label] = { ratio: c / refCentroid, f };
    record('drumsKeepPitch', {
      case: label, drumCentroidHz: Math.round(c), refCentroidHz: Math.round(refCentroid),
      centroidRatio: +(c / refCentroid).toFixed(3), sineHz: +f.toFixed(1), expectedSineHz: +expectedSine.toFixed(1),
    });
  }
  const sineOk = Object.values(rows).every((r) => Math.abs(r.f - expectedSine) / expectedSine < 0.01);
  const keep = rows['tách lớp, trống giữ nguyên'].ratio;
  record('drumsKeepPitch', {
    case: 'kiểm tra: trống giữ nguyên ×0.9–1.1, khi đổi tông > ×1.3; sine luôn đổi tông',
    pass: keep > 0.9 && keep < 1.1 && rows['không tách lớp'].ratio > 1.3 && rows['tách lớp, trống đổi tông'].ratio > 1.3 && sineOk,
  });
}

async function testStemControls() {
  const len = SR * 3;
  const vocal = sine(len, 440, 0.3); // giữa → Giọng hát
  const guitar = sine(len, 660, 0.3); // trái → Nhạc cụ khác
  const x = stereo(mix(vocal, guitar), vocal);
  const seg = (y) => y.subarray(SR * 1.5, SR * 2.5);
  const p = (y, f) => goertzelPower(seg(y), f);

  const base = await renderEngine(x, { options: SEP() });
  const muted = await renderEngine(x, { options: SEP({ stems: { vocals: { mute: true } } }) });
  const solo = await renderEngine(x, { options: SEP({ stems: { vocals: { solo: true } } }) });
  const half = await renderEngine(x, { options: SEP({ stems: { other: { gain: 0.5 } } }) });

  const vocalCut = db(p(base.y, 440) / p(muted.y, 440));
  const guitarKept = db(p(base.y, 660) / p(muted.y, 660));
  record('stemControls', { test: 'mute giọng: 440 Hz giảm (dB)', value: +vocalCut.toFixed(1), pass: vocalCut > 15 });
  record('stemControls', { test: 'mute giọng: 660 Hz giữ nguyên (dB lệch)', value: +guitarKept.toFixed(2), pass: Math.abs(guitarKept) < 1 });
  const guitarCut = db(p(base.y, 660) / p(solo.y, 660));
  record('stemControls', { test: 'solo giọng: 660 Hz giảm (dB)', value: +guitarCut.toFixed(1), pass: guitarCut > 15 });
  const halfDb = db(p(base.y, 660) / p(half.y, 660));
  record('stemControls', { test: 'nhạc cụ khác 50%: 660 Hz giảm ≈ 6 dB', value: +halfDb.toFixed(2), pass: Math.abs(halfDb - 6.02) < 1 });

  // Giọng có độ rộng stereo: R nhỏ hơn L 6 dB ⇒ ψ = 0.8. Lớp giọng nhận ψ^γ, phần còn lại ở "nhạc cụ khác".
  // Tắt giọng ⇒ engine dùng γ = min(thanh trượt, KARAOKE_CENTER_WIDTH) để giọng sót lại ít hơn (chế độ karaoke của
  // bộ tách chia một nguồn đơn lẻ đúng như mask: ψ^γ); solo giọng ⇒ vẫn dùng γ của thanh trượt (lớp giọng sạch).
  const wide = { l: vocal, r: vocal.map((v) => 0.5 * v) };
  const wideBase = await renderEngine(wide, { options: SEP() });
  const wideMuted = await renderEngine(wide, { options: SEP({ stems: { vocals: { mute: true } } }) });
  const wideSolo = await renderEngine(wide, { options: SEP({ stems: { vocals: { solo: true } } }) });
  const cutAt = (gamma) => -20 * Math.log10(1 - 0.8 ** gamma);
  const wideCut = db(p(wideBase.y, 440) / p(wideMuted.y, 440));
  const wantCut = cutAt(Math.min(DEFAULT_OPTIONS.centerWidth, KARAOKE_CENTER_WIDTH));
  record('stemControls', {
    test: `mute giọng rộng (ψ=0.8): 440 Hz giảm ≈ ${wantCut.toFixed(1)} dB (γ karaoke)`, value: +wideCut.toFixed(2),
    pass: Math.abs(wideCut - wantCut) < 1,
  });
  const soloKeep = db(p(wideBase.y, 440) / p(wideSolo.y, 440));
  const wantKeep = -20 * Math.log10(0.8 ** DEFAULT_OPTIONS.centerWidth);
  record('stemControls', {
    test: `solo giọng rộng (ψ=0.8): 440 Hz giảm ≈ ${wantKeep.toFixed(1)} dB (γ thanh trượt)`, value: +soloKeep.toFixed(2),
    pass: Math.abs(soloKeep - wantKeep) < 1,
  });
  const cw = (patch) => effectiveCenterWidth(mergeOptions(undefined, patch));
  record('stemControls', {
    test: 'γ thực tế: bình thường / mute giọng / solo lớp khác / âm lượng giọng 0 / thanh trượt 1 + mute',
    value: [cw({}), cw({ stems: { vocals: { mute: true } } }), cw({ stems: { other: { solo: true } } }), cw({ stems: { vocals: { gain: 0 } } }), cw({ centerWidth: 1, stems: { vocals: { mute: true } } })].join(' / '),
    pass: cw({}) === DEFAULT_OPTIONS.centerWidth && cw({ stems: { vocals: { mute: true } } }) === KARAOKE_CENTER_WIDTH
      && cw({ stems: { other: { solo: true } } }) === KARAOKE_CENTER_WIDTH && cw({ stems: { vocals: { gain: 0 } } }) === KARAOKE_CENTER_WIDTH
      && cw({ centerWidth: 1, stems: { vocals: { mute: true } } }) === 1,
  });
  const kar = (patch) => separatorParams(mergeOptions(undefined, patch)).karaoke;
  record('stemControls', {
    test: 'chế độ karaoke của bộ tách: bình thường / mute giọng / solo lớp khác / solo giọng',
    value: [kar({}), kar({ stems: { vocals: { mute: true } } }), kar({ stems: { other: { solo: true } } }), kar({ stems: { vocals: { solo: true } } })].join(' / '),
    pass: kar({}) === false && kar({ stems: { vocals: { mute: true } } }) === true && kar({ stems: { other: { solo: true } } }) === true
      && kar({ stems: { vocals: { solo: true } } }) === false,
  });

  // Karaoke: giọng (giữa) nằm dưới một hợp âm stereo rộng (L/R lệch tần số ⇒ không tương quan). Bộ lọc không gian
  // phải lấy được nhiều giọng hơn mask với cùng γ, mà không lấy thêm hợp âm.
  const len4 = SR * 4;
  const voice = harmonics(len4, 220, 8, 0.2);
  const chord = (detune) => mix(...[220, 277.18, 329.63].map((f) => harmonics(len4, f * detune, 8, 0.1)));
  const chordL = chord(1.004);
  const under = stereo(mix(voice, chordL), mix(voice, chord(0.996)));
  const asMask = await renderSeparator(under, VOCALS, 'default', { centerWidth: KARAOKE_CENTER_WIDTH, karaoke: false });
  const asKaraoke = await renderSeparator(under, VOCALS, 'default', { centerWidth: KARAOKE_CENTER_WIDTH, karaoke: true });
  const lat = asMask.latency;
  const voiceMask = share(asMask.y, voice, lat), voiceKaraoke = share(asKaraoke.y, voice, lat);
  const chordMask = share(asMask.y, chordL, lat), chordKaraoke = share(asKaraoke.y, chordL, lat);
  record('stemControls', {
    test: 'karaoke: giọng dưới hợp âm rộng — phần giọng lấy ra được (mask → karaoke)',
    value: `${voiceMask.toFixed(3)} → ${voiceKaraoke.toFixed(3)}`, pass: voiceKaraoke > voiceMask + 0.1,
  });
  record('stemControls', {
    test: 'karaoke: giọng dưới hợp âm rộng — phần hợp âm bị lấy theo (mask → karaoke)',
    value: `${chordMask.toFixed(3)} → ${chordKaraoke.toFixed(3)}`, pass: chordKaraoke < chordMask + 0.02,
  });

  // Đổi tông riêng: giọng +5, nhạc cụ khác giữ nguyên.
  const per = await renderEngine(x, { semitones: 5, options: SEP({ stems: { other: { transpose: false } } }) });
  const f5 = 440 * 2 ** (5 / 12);
  const shifted = db(p(per.y, f5) / p(per.y, 440));
  const guitarStays = db(p(per.y, 660) / p(per.y, 660 * 2 ** (5 / 12)));
  record('stemControls', { test: 'giọng +5: năng lượng 587 Hz so với 440 Hz (dB)', value: +shifted.toFixed(1), pass: shifted > 15 });
  record('stemControls', { test: 'nhạc cụ khác giữ nguyên: 660 Hz so với 881 Hz (dB)', value: +guitarStays.toFixed(1), pass: guitarStays > 15 });
}

// ---------- chuyển trạng thái giữa lúc đang phát (A1: crossfade) ----------
/** Năng lượng sai phân bậc 3 (≈ thành phần cao tần, nơi click hiện ra) trên mỗi mẫu. */
function hfEnergy(y, a, b) {
  let e = 0;
  for (let i = a + 3; i < b; i++) { const d = y[i] - 3 * y[i - 1] + 3 * y[i - 2] - y[i - 3]; e += d * d; }
  return e / (b - a);
}
function rmsEnvelope(y, a, b, w = 480) {
  const r = [];
  for (let i = a; i + w <= b; i += w) r.push(Math.sqrt(energy(y, i, i + w) / w));
  return r;
}

/** Render, tại giây T gọi `change(engine)`; trả về output và độ trễ engine sau thay đổi. */
async function renderWithChange(signal, { semitones = 0, options = {}, T = 2, change }) {
  const ctx = new OfflineAudioContext(2, lengthOf(signal), SR);
  const src = sourceOf(ctx, signal);
  const input = new GainNode(ctx);
  src.connect(input);
  const engine = await createEngine(ctx, input, ctx.destination, { semitones, options });
  ctx.suspend(T).then(async () => {
    await change(engine);
    ctx.resume();
  });
  src.start(0);
  const out = await ctx.startRendering();
  const latency = Math.round((await engine.latency()) * SR);
  engine.dispose();
  return { y: out.getChannelData(0), latency };
}

async function testSwitching() {
  const len = SR * 4, T = 2;
  const x = harmonics(len, 220, 4, 0.3);
  const cases = [
    ['0 → +1', 0, {}, (e) => e.setSemitones(1)],
    ['+1 → 0', 1, {}, (e) => e.setSemitones(0)],
    ['0 → +0.01', 0, {}, (e) => e.setSemitones(0.01)],
    ['+3 → 0', 3, {}, (e) => e.setSemitones(0)],
    ['tách lớp, 0 → +1', 0, SEP(), (e) => e.setSemitones(1)],
    ['tách lớp, +1 → 0', 1, SEP(), (e) => e.setSemitones(0)],
    ['tách lớp, +3: tắt đổi tông lớp khác', 3, SEP(), (e) => e.setOptions({ stems: { other: { transpose: false } } })],
    ['tách lớp, +3: bật formant', 3, SEP(), (e) => e.setOptions({ formant: true })],
    ['tách lớp, +3: bắt đầu ghi từng lớp', 3, SEP(), (e) => e.startRecording()],
    // Đổi chất lượng làm độ trễ nhảy (120 → 140 ms): hai nhánh lệch nhau nên crossfade không khớp hoàn toàn —
    // chỉ yêu cầu không có khoảng lặng (trước đây mất tiếng ~120 ms).
    ['+3: đổi chất lượng (độ trễ đổi)', 3, {}, (e) => e.setOptions({ quality: 'cheaper' }), { hf: Infinity, min: -10 }],
  ];
  for (const [label, semitones, options, change, limit = { hf: 6, min: -4 }] of cases) {
    const { y, latency } = await renderWithChange(x, { semitones, options, T, change });
    const t0 = T * SR + latency;
    const base = hfEnergy(y, SR * 1.2, SR * 1.8);
    const hfDb = db(hfEnergy(y, t0 - 0.05 * SR, t0 + 0.4 * SR) / base);
    const ref = rmsEnvelope(y, SR * 1.2, SR * 1.8);
    const refMean = ref.reduce((a, b) => a + b) / ref.length;
    const env = rmsEnvelope(y, t0 - 0.2 * SR, t0 + 0.4 * SR);
    const minDb = 20 * Math.log10(Math.max(1e-9, Math.min(...env)) / refMean);
    record('switching', {
      case: label, hfDb: +hfDb.toFixed(1), envMinDb: +minDb.toFixed(1),
      pass: hfDb < limit.hf && minDb > limit.min,
    });
  }
}

// ---------- profile Stretch theo lớp (A2) ----------
/** Bassline E1–B1, mỗi nốt 0.5 s, 8 bồi âm. */
function bassline(notes) {
  const noteLen = SR / 2;
  const x = new Float32Array(noteLen * notes.length + SR);
  notes.forEach((f, n) => {
    const s = harmonics(noteLen, f, 8, 0.3);
    for (let i = 0; i < noteLen; i++) x[SR / 2 + n * noteLen + i] = s[i] * Math.min(1, i / 240, (noteLen - i) / 240);
  });
  return x;
}
/** Tỉ lệ năng lượng nằm đúng các bồi âm đã đổi tông (giữa mỗi nốt). */
function harmonicPurity(y, notes, k, latency) {
  const noteLen = SR / 2;
  let sum = 0;
  notes.forEach((f, n) => {
    const a = SR / 2 + n * noteLen + latency + 0.15 * SR;
    const seg = y.subarray(a, a + 0.25 * SR);
    const tot = energy(seg, 0, seg.length);
    let good = 0;
    for (let h = 1; h <= 8; h++) for (let d = -1; d <= 1; d += 0.5) good += goertzelPower(seg, f * k * h + d);
    sum += (2 * good) / seg.length / 5 / tot;
  });
  return sum / notes.length;
}

/** Bật/tắt nhiều lần trong một phiên: Stretch được dùng lại, số instance không tăng theo số lần đổi. */
async function testInstanceReuse() {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const engine = await createEngine(ctx, new GainNode(ctx), ctx.destination, { semitones: 3, options: SEP() });
  const wait = () => new Promise((r) => setTimeout(r, 700)); // > LINGER_S: cleanup đã trả node về pool
  const counts = [];
  for (let i = 0; i < 4; i++) {
    await engine.setOptions({ quality: 'cheaper', formant: true });
    await engine.startRecording();
    await engine.stopRecording();
    await engine.setOptions({ quality: 'default', formant: false, separate: false });
    await engine.setOptions({ separate: true });
    await wait();
    counts.push(engine.debug().stretchInstances);
  }
  engine.dispose();
  record('instanceReuse', {
    test: 'số Stretch đã tạo sau mỗi vòng (đổi chất lượng/formant, ghi từng lớp, tắt/bật tách lớp)', value: counts.join(' / '),
    pass: counts.every((c) => c === counts[0]) && counts[0] <= 8,
  });
}

async function testStemProfiles() {
  const p = (patch, stem) => stretchProfile(mergeOptions(undefined, patch), stem);
  const key = (x) => JSON.stringify(x);
  record('stemProfiles', {
    test: 'profile: bass khối dài (default) / dùng chung (cheaper, lowLatency); formant chỉ cho giọng khi tách lớp',
    pass: p({}, 'bass').config.blockMs > 120 && key(p({ quality: 'cheaper' }, 'bass')) === key(p({ quality: 'cheaper' }, 'other'))
      && key(p({ quality: 'lowLatency' }, 'bass')) === key(p({ quality: 'lowLatency' }, 'other'))
      && p({ formant: true }, 'vocals').formant && !p({ formant: true }, 'other').formant && !p({ formant: true }, 'bass').formant
      && p({ formant: true }, null).formant && !p({}, 'vocals').formant,
  });

  // Bass: khối 180 ms tách các bồi âm của nốt thấp sạch hơn khối 120 ms.
  const notes = [41.2, 55, 49, 61.7, 41.2, 55, 49, 61.7];
  const x = bassline(notes);
  const k = 2 ** (5 / 12);
  const mixed = await renderEngine(x, { semitones: 5 });
  const sep = await renderEngine(x, { semitones: 5, options: SEP() });
  const pm = harmonicPurity(mixed.y, notes, k, mixed.latency), ps = harmonicPurity(sep.y, notes, k, sep.latency);
  record('stemProfiles', {
    test: 'bassline E1–B1 +5: độ sạch bồi âm (không tách → tách lớp, bass khối dài)',
    value: `${pm.toFixed(3)} → ${ps.toFixed(3)}`, pass: ps > pm + 0.05,
  });

  // Formant chỉ áp cho lớp giọng: nguồn có formant ~1 kHz; đổi tông +7.
  const len = SR * 3;
  const voiced = (() => { const h = harmonics(len, 150, 40, 0.5); const y = bandpass(h, 1000, 1.5); const pk = y.reduce((m, v) => Math.max(m, Math.abs(v)), 0); return y.map((v) => (v / pk) * 0.4); })();
  const zero = new Float32Array(len);
  const at = [SR * 1.2, SR * 1.5, SR * 1.8, SR * 2.1];
  const ratio = (y, lat) => at.reduce((s, a) => s + centroid(y, a + lat, 200, 6000), 0) / at.reduce((s, a) => s + centroid(voiced, a, 200, 6000), 0);
  const rows = {};
  for (const [label, signal] of [['giữa → Giọng hát', voiced], ['trái → Nhạc cụ khác', stereo(voiced, zero)]]) {
    const off = await renderEngine(signal, { semitones: 7, options: SEP() });
    const on = await renderEngine(signal, { semitones: 7, options: SEP({ formant: true }) });
    rows[label] = { off: ratio(off.y, off.latency), on: ratio(on.y, on.latency) };
  }
  const v = rows['giữa → Giọng hát'], o = rows['trái → Nhạc cụ khác'];
  record('stemProfiles', {
    test: 'formant +7: trọng tâm phổ / gốc — giọng (tắt → bật formant)', value: `${v.off.toFixed(2)} → ${v.on.toFixed(2)}`,
    pass: v.off > 1.25 && v.on < 1.12,
  });
  record('stemProfiles', {
    test: 'formant +7: trọng tâm phổ / gốc — nhạc cụ khác không đổi khi bật formant', value: `${o.off.toFixed(2)} → ${o.on.toFixed(2)}`,
    pass: o.off > 1.25 && Math.abs(o.on - o.off) < 0.03,
  });
}

function parseWav(buf) {
  const v = new DataView(buf);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
  return {
    riff: str(0, 4), wave: str(8, 4), fmt: v.getUint16(20, true), channels: v.getUint16(22, true),
    sampleRate: v.getUint32(24, true), bits: v.getUint16(34, true), dataBytes: v.getUint32(40, true),
    samples: new Int16Array(buf, 44),
  };
}

async function testRecording() {
  const len = SR * 3;
  const x = stereo(mix(sine(len, 440, 0.3), sine(len, 660, 0.2), clicks(len, SR / 4, 0.5)), mix(sine(len, 440, 0.3), clicks(len, SR / 4, 0.5)));
  const { files } = await renderEngine(x, { semitones: 3, options: SEP(), record: true });
  const names = files.map((f) => f.name);
  record('recording', { test: 'các file', value: names.join(', '), pass: ['mix', ...STEM_NAMES].every((n) => names.includes(n)) });
  const wavs = Object.fromEntries(await Promise.all(files.map(async (f) => [f.name, parseWav(await f.file.arrayBuffer())])));
  for (const [name, w] of Object.entries(wavs)) {
    const frames = w.samples.length / 2;
    record('recording', {
      test: `${name}.wav`, value: `${w.channels}ch ${w.sampleRate}Hz ${w.bits}bit ${(frames / SR).toFixed(2)}s`,
      pass: w.riff === 'RIFF' && w.wave === 'WAVE' && w.fmt === 1 && w.channels === 2 && w.sampleRate === SR &&
        w.bits === 16 && w.dataBytes === w.samples.byteLength && Math.abs(frames - len) <= 256,
    });
  }
  // Mọi lớp âm lượng 100% ⇒ tổng các file lớp == file mix (chỉ lệch do làm tròn 16-bit).
  let maxDiff = 0, peak = 0;
  const mixS = wavs.mix.samples;
  for (let i = 0; i < mixS.length; i++) {
    const sum = STEM_NAMES.reduce((s, n) => s + wavs[n].samples[i], 0);
    maxDiff = Math.max(maxDiff, Math.abs(sum - mixS[i]));
    peak = Math.max(peak, Math.abs(mixS[i]));
  }
  record('recording', { test: 'tổng các lớp == mix (lệch tối đa, LSB)', value: maxDiff, pass: peak > 1000 && maxDiff <= 4 });
}

async function benchmark() {
  const x = stereo(mix(sine(SR * 20, 440, 0.3), snare(SR * 20, SR / 2)), mix(sine(SR * 20, 330, 0.3), snare(SR * 20, SR / 2)));
  for (const [label, run] of [
    ['Bộ tách lớp (Rust/WASM) riêng', () => renderSeparator(x, 'sum')],
    ['Engine, không tách lớp', () => renderEngine(x, { semitones: 3 })],
    ['Engine, không tách lớp, 0 bán cung', () => renderEngine(x, { semitones: 0 })],
    ['Engine, tách lớp, 0 bán cung', () => renderEngine(x, { semitones: 0, options: SEP() })],
    ['Engine, tách lớp (3 lớp đổi tông)', () => renderEngine(x, { semitones: 3, options: SEP() })],
    ['Engine, tách lớp (4 lớp đổi tông)', () => renderEngine(x, { semitones: 3, options: SEP({ stems: { drums: { transpose: true } } }) })],
  ]) {
    const { ms } = await run();
    record('benchmark', { label, audioSeconds: 20, renderMs: Math.round(ms), realtimeFactor: +((20 * 1000) / ms).toFixed(1) });
  }
}

const TESTS = [testSeparatorCore, testStemRouting, testAlignment, testBypassAndSharing, testPitch, testTempo, testDrumsKeepPitch, testStemControls, testSwitching, testInstanceReuse, testStemProfiles, testRecording, benchmark];

// ?list: chỉ trả danh sách test. ?only=a,b: chỉ chạy các test đó (tests/run.mjs chạy mỗi test trong một tab riêng:
// OfflineAudioContext không đóng được nên bộ nhớ WASM của worklet chỉ được trả khi tiến trình trang kết thúc, mà
// mỗi tiến trình chứa được ~125 WASM memory).
async function main() {
  const query = new URLSearchParams(location.search);
  if (query.has('list')) return { tests: TESTS.map((t) => t.name), sections: {}, ok: true };
  const only = query.get('only')?.split(',');
  for (const t of TESTS.filter((t) => !only || only.includes(t.name))) {
    try {
          await t();
    } catch (e) {
      record(t.name, { error: String(e?.stack || e), pass: false });
    }
  }
  return results;
}

main().then(
  (r) => {
    window.__result = r;
    document.getElementById('out').textContent = JSON.stringify(r, null, 2);
  },
  (e) => {
    window.__result = { ok: false, error: String(e?.stack || e) };
    document.getElementById('out').textContent = String(e?.stack || e);
  },
);
