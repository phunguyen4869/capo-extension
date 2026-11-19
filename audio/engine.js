// Engine âm thanh của CAPO — dùng chung cho offscreen.js và tests/.
//
// Không tách lớp:   input ─▶ [Stretch | Delay] ─▶ out
// Tách lớp:         input ─▶ Separator ─┬─ lớp i ─▶ âm lượng ─┬─▶ Stretch DÙNG CHUNG ─▶ out   (lớp đổi tông)
//                                       │                     └─▶ Delay chung        ─▶ out   (lớp giữ nguyên)
// Đang ghi từng lớp: input ─▶ Separator ─▶ lớp i ─▶ [Stretch riêng | Delay] ─▶ tap ─▶ âm lượng ─▶ out
//
// - Ở 0 bán cung dùng Delay thay cho Stretch: âm thanh giữ nguyên bản gốc, Stretch nghỉ không tốn CPU.
// - Mọi lớp đổi tông có cùng số bán cung nên dùng chung 1 Stretch; chỉ khi ghi file từng lớp (cần từng lớp
//   SAU khi đổi tông) mới tạo Stretch riêng, và bỏ đi khi dừng ghi.
// - Stretch và Delay có cùng độ trễ ⇒ chuyển qua lại không lệch nhịp. Node bị ngưng được giữ đầu ra thêm
//   LINGER_S giây để phát nốt phần đuôi; Delay dùng lại sau khi nghỉ được thay mới (bộ đệm cũ còn âm thanh cũ);
//   Stretch được reset khi bật lại.

import SignalsmithStretch from '../lib/SignalsmithStretch.mjs';
import { QUALITY_PRESETS, STEM_NAMES, effectiveGains, mergeOptions, separatorParams, separatorPreset } from '../presets.js';
import { capoError } from '../i18n.js';
import { createRecorder } from './recorder.js';
import { createSeparatorNode } from './separator-node.js';

// Thư viện mặc định nạp worklet qua Blob URL, mà CSP của extension chặn blob: →
// cho nó nạp chính file .mjs trong gói (file này tự đăng ký processor khi chạy trong worklet).
SignalsmithStretch.moduleUrl = new URL('../lib/SignalsmithStretch.mjs', import.meta.url).href;

/** Thời gian giữ đầu ra của node vừa bị ngưng (≥ tổng độ trễ lớn nhất của chuỗi xử lý). */
const LINGER_S = 0.5;

const nodeIds = new WeakMap();
let nextNodeId = 0;
const idOf = (n) => {
  if (!nodeIds.has(n)) nodeIds.set(n, ++nextNodeId);
  return nodeIds.get(n);
};
const edgeKey = ([from, to, output]) => `${idOf(from)}:${output}>${idOf(to)}`;

/** Nối/tháo theo kiểu khai báo: chỉ đụng tới các kết nối khác với lần trước. */
class Wiring {
  edges = new Map();
  apply(desired) {
    const next = new Map(desired.map((e) => [edgeKey(e), e]));
    for (const [k, [from, to, output]] of this.edges) {
      if (next.has(k)) continue;
      try {
        from.disconnect(to, output);
      } catch {}
    }
    for (const [k, [from, to, output]] of next) if (!this.edges.has(k)) from.connect(to, output, 0);
    this.edges = next;
  }
  list() {
    return [...this.edges.values()];
  }
}

/**
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} input      node nguồn (engine sở hữu các kết nối đầu ra của nó)
 * @param {AudioNode} destination
 */
export async function createEngine(ctx, input, destination, { semitones = 0, options = {} } = {}) {
  let opts = mergeOptions(undefined, options);
  let pitch = semitones;
  const out = new GainNode(ctx);
  out.connect(destination);

  const wiring = new Wiring();
  let desiredEdges = [];
  let lingering = []; // [{ edges, until }]
  let fed = new Set(); // node đang được cấp tín hiệu (theo lần route trước)
  let cleanupTimer = null;
  let disposed = false;

  const stretchParams = () => ({ semitones: pitch, formantCompensation: !!opts.formant, formantBaseHz: 0 });
  const stretches = new Set();
  async function newStretch(active = true) {
    const node = await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    await node.configure(QUALITY_PRESETS[opts.quality]);
    await node.schedule({ active, ...stretchParams() });
    stretches.add(node);
    return node;
  }
  function dropStretch(node) {
    node.disconnect();
    stretches.delete(node);
  }

  const shared = await newStretch(pitch !== 0);
  let sharedActive = pitch !== 0;
  let stretchLatency = await shared.latency();
  const newDelay = () => new DelayNode(ctx, { maxDelayTime: 1, delayTime: stretchLatency });

  const holders = { sharedDelay: newDelay() };
  const stems = STEM_NAMES.map((name) => ({
    name,
    svol: new GainNode(ctx), // âm lượng ở chế độ dùng chung (trước Stretch)
    pvol: new GainNode(ctx), // âm lượng ở chế độ từng lớp (sau tap)
    tap: new GainNode(ctx), // điểm ghi file của lớp
    delay: newDelay(),
    stretch: null,
  }));

  let sep = null;
  let sepKey = null;
  let separated = false;
  let perStem = false;
  let recorder = null;

  async function ensureSeparator() {
    const preset = separatorPreset(opts.quality, ctx.sampleRate);
    const key = JSON.stringify(preset);
    if (sep && sepKey === key) return false;
    const old = sep;
    sep = await createSeparatorNode(ctx, preset, separatorParams(opts));
    sepKey = key;
    if (old) {
      old.disconnect();
      old.port.postMessage('free');
    }
    return true;
  }

  function applyVolumes(immediate = false) {
    const gains = effectiveGains(opts.stems);
    for (const s of stems) {
      for (const g of [s.svol.gain, s.pvol.gain]) {
        if (immediate) {
          g.cancelScheduledValues(0);
          g.setValueAtTime(gains[s.name], ctx.currentTime);
        } else {
          g.setTargetAtTime(gains[s.name], ctx.currentTime, 0.015);
        }
      }
    }
  }

  /** Các cạnh đi ra từ `start` (và các node phía sau nó) trong tập `edges`. */
  function downstream(start, edges) {
    const result = [];
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
      const n = queue.shift();
      if (seen.has(n)) continue;
      seen.add(n);
      for (const e of edges) {
        if (e[0] !== n) continue;
        result.push(e);
        if (e[1] !== out) queue.push(e[1]);
      }
    }
    return result;
  }

  function applyWiring() {
    const now = ctx.currentTime;
    lingering = lingering.filter((l) => l.until > now);
    wiring.apply([...desiredEdges, ...lingering.flatMap((l) => l.edges)]);
  }

  /** Sau thời gian giữ: tháo cạnh đuôi, bỏ Stretch/Separator không còn dùng. */
  function cleanup() {
    cleanupTimer = null;
    if (disposed) return;
    applyWiring();
    if (lingering.length) return scheduleCleanup();
    const inUse = new Set(desiredEdges.flatMap(([a, b]) => [a, b]));
    for (const s of stems) {
      if (s.stretch && !inUse.has(s.stretch)) {
        dropStretch(s.stretch);
        s.stretch = null;
      }
    }
    if (sep && !inUse.has(sep)) {
      sep.disconnect();
      sep.port.postMessage('free');
      sep = null;
      sepKey = null;
    }
  }
  function scheduleCleanup() {
    if (cleanupTimer || disposed) return;
    cleanupTimer = setTimeout(cleanup, (LINGER_S + 0.1) * 1000);
  }

  async function route() {
    const now = ctx.currentTime;
    const want = opts.separate;
    const bypass = pitch === 0;
    const per = want && perStem;
    const transposed = (name) => opts.stems[name].transpose && !bypass;
    if (want && (await ensureSeparator())) sep.port.postMessage('reset');

    for (const s of stems) {
      if (per && transposed(s.name) && !s.stretch) s.stretch = await newStretch();
    }
    const useShared = !bypass && (!want || (!per && STEM_NAMES.some((n) => opts.stems[n].transpose)));
    if (useShared && !sharedActive) {
      await shared.configure(QUALITY_PRESETS[opts.quality]); // reset: bỏ âm thanh cũ còn trong bộ đệm
      await shared.schedule({ active: true, ...stretchParams() });
      sharedActive = true;
    } else if (!useShared && sharedActive) {
      // Nghỉ sau khi đã phát hết phần đuôi.
      await shared.schedule({ active: false, outputTime: now + LINGER_S });
      sharedActive = false;
    }

    const edges = [];
    const feeds = new Set();
    const edge = (a, b, o = 0) => edges.push([a, b, o]);
    const feed = (a, b, o = 0) => {
      edge(a, b, o);
      feeds.add(b);
    };
    // Delay được dùng lại sau khi nghỉ còn giữ âm thanh cũ → thay bằng node mới.
    const fresh = (holder, key) => {
      if (!fed.has(holder[key])) {
        holder[key] = newDelay();
        fed.add(holder[key]);
      }
      return holder[key];
    };

    if (!want) {
      const proc = bypass ? fresh(holders, 'sharedDelay') : shared;
      feed(input, proc);
      edge(proc, out);
    } else {
      feed(input, sep);
      stems.forEach((s, i) => {
        if (per) {
          const proc = transposed(s.name) ? s.stretch : fresh(s, 'delay');
          feed(sep, proc, i);
          edge(proc, s.tap);
          edge(s.tap, s.pvol);
          edge(s.pvol, out);
        } else {
          feed(sep, s.svol, i);
          const proc = transposed(s.name) ? shared : fresh(holders, 'sharedDelay');
          feed(s.svol, proc);
          edge(proc, out);
        }
      });
    }

    // Node vừa thôi được cấp tín hiệu: giữ các cạnh phía sau nó thêm LINGER_S giây cho hết phần đuôi.
    const previous = wiring.list();
    const tails = [];
    for (const n of fed) if (!feeds.has(n)) tails.push(...downstream(n, previous));
    if (tails.length) lingering.push({ edges: tails, until: now + LINGER_S });

    desiredEdges = edges;
    fed = feeds;
    separated = want;
    applyWiring();
    scheduleCleanup();
  }

  async function configureStretches() {
    for (const st of stretches) await st.configure(QUALITY_PRESETS[opts.quality]);
    stretchLatency = await shared.latency();
    for (const d of [holders.sharedDelay, ...stems.map((s) => s.delay)]) d.delayTime.value = stretchLatency;
  }

  await route();
  applyVolumes(true);

  return {
    async setSemitones(value) {
      const wasBypass = pitch === 0;
      pitch = value;
      await Promise.all([...stretches].map((st) => st.schedule({ semitones: value })));
      if (wasBypass !== (pitch === 0)) await route();
    },

    async setOptions(patch) {
      const prev = opts;
      opts = mergeOptions(opts, patch);
      if (opts.quality !== prev.quality) await configureStretches();
      if (opts.formant !== prev.formant) {
        await Promise.all([...stretches].map((st) => st.schedule({ formantCompensation: !!opts.formant })));
      }
      await route();
      const params = separatorParams(opts);
      if (sep && JSON.stringify(params) !== JSON.stringify(separatorParams(prev))) sep.setParams(params);
      applyVolumes();
    },

    options: () => mergeOptions(opts),

    /** Tổng độ trễ xử lý (giây), chưa tính độ trễ thiết bị. */
    async latency() {
      return stretchLatency + (separated ? sep.latencySamples / ctx.sampleRate : 0);
    },

    /** centerRatio ≈ 1 ⇒ bài gần như mono (lớp giọng sẽ lẫn nhiều nhạc cụ). */
    stats: () => ({ centerRatio: separated ? sep.stats.centerRatio : null }),

    /** Cho test: số Stretch đang tồn tại / đang chạy. */
    debug: () => ({
      stretchNodes: stretches.size,
      activeStretches: (sharedActive ? 1 : 0) + stems.filter((s) => s.stretch && fed.has(s.stretch)).length,
      separated,
      perStem: separated && perStem,
      separatorAlive: !!sep,
    }),

    /** Ghi mix + (nếu đang tách lớp) từng lớp ra WAV. */
    async startRecording() {
      if (recorder) throw capoError('alreadyRecording');
      const taps = { mix: out };
      let startAt = 0;
      if (separated) {
        perStem = true;
        await route();
        for (const s of stems) taps[s.name] = s.tap;
        // Bỏ đoạn đầu trong lúc chuỗi xử lý từng lớp vừa được tạo còn đang "làm đầy" bộ đệm.
        if (ctx.currentTime > 0) startAt = ctx.currentTime + stretchLatency + 0.05;
      }
      recorder = await createRecorder(ctx, taps, { startAt });
    },
    /** @returns {Promise<{name:string, file:File}[]>} */
    async stopRecording() {
      if (!recorder) throw capoError('notRecording');
      const r = recorder;
      recorder = null;
      const files = await r.stop();
      if (perStem) {
        perStem = false;
        await route();
      }
      return files;
    },
    recording: () => (recorder ? { active: true, seconds: recorder.seconds() } : { active: false, seconds: 0 }),

    dispose() {
      disposed = true;
      clearTimeout(cleanupTimer);
      recorder?.abort();
      recorder = null;
      input.disconnect();
      if (sep) {
        sep.disconnect();
        sep.port.postMessage('free');
      }
      for (const st of stretches) st.disconnect();
      for (const n of [holders.sharedDelay, ...stems.flatMap((s) => [s.svol, s.pvol, s.tap, s.delay])]) n.disconnect();
      out.disconnect();
    },
  };
}
