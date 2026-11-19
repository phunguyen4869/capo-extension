// Engine âm thanh của CAPO — dùng chung cho offscreen.js và tests/.
//
// Không tách lớp:   input ─▷ [Stretch | Delay] ─▶ out
// Tách lớp:         input ─▶ Separator ─┬─ lớp i ─▶ âm lượng ─┬─▷ Stretch theo profile ─▶ out   (lớp đổi tông)
//                                       │                     └─▷ Delay chung          ─▶ out   (lớp giữ nguyên)
// Đang ghi từng lớp: input ─▶ Separator ─▶ lớp i ─▷ [Stretch riêng | Delay] ─▶ tap ─▶ âm lượng ─▶ out
//                   (─▷ = qua một "cổng" GainNode)
//
// - Ở 0 bán cung dùng Delay thay cho Stretch: âm thanh giữ nguyên bản gốc, Stretch nghỉ không tốn CPU.
// - Profile Stretch (presets.js: stretchProfile): bass dùng khối dài hơn, bù formant chỉ cho giọng. Các lớp cùng
//   profile dùng chung 1 Stretch; chỉ khi ghi file từng lớp mới tạo Stretch riêng, và bỏ đi khi dừng ghi.
// - Mọi nhánh (Stretch + Delay bù, hoặc Delay) có cùng độ trễ `target` = độ trễ của profile chậm nhất trong chế độ
//   hiện tại ⇒ chuyển nhánh không lệch nhịp. Đổi `target` (bật/tắt tách lớp) tạo nhánh mới thay vì sửa nhánh cũ.
// - Chuyển nhánh = crossfade equal-power XF_S giây ở CỔNG đầu vào, nhánh cũ vẫn được nối LINGER_S giây cho hết phần
//   đuôi. Không được tháo đầu vào của Stretch khi nó còn phát: không còn input, worklet chuyển sang chế độ phát từ
//   bộ đệm (rỗng) và cắt mất đuôi. Stretch nhận toàn số 0 sau khi cổng đóng ⇒ bộ đệm sạch, bật lại không cần reset.

import SignalsmithStretch from '../lib/SignalsmithStretch.mjs';
import { STEM_NAMES, effectiveGains, mergeOptions, separatorParams, separatorPreset, stretchProfile } from '../presets.js';
import { capoError } from '../i18n.js';
import { createRecorder } from './recorder.js';
import { createSeparatorNode } from './separator-node.js';

// Thư viện mặc định nạp worklet qua Blob URL, mà CSP của extension chặn blob: →
// cho nó nạp chính file .mjs trong gói (file này tự đăng ký processor khi chạy trong worklet).
SignalsmithStretch.moduleUrl = new URL('../lib/SignalsmithStretch.mjs', import.meta.url).href;

/** Thời gian giữ nhánh vừa bị ngưng (≥ XF_S + độ trễ lớn nhất của chuỗi xử lý). */
const LINGER_S = 0.5;
/** Thời gian crossfade khi chuyển nhánh. */
const XF_S = 0.03;

const nodeIds = new WeakMap();
let nextNodeId = 0;
const idOf = (n) => {
  if (!nodeIds.has(n)) nodeIds.set(n, ++nextNodeId);
  return nodeIds.get(n);
};
const edgeKey = ([from, to, output]) => `${idOf(from)}:${output}>${idOf(to)}`;

/** `${sampleRate}|JSON(config)` → độ trễ Stretch (mẫu). Chỉ phụ thuộc cấu hình nên dùng chung cho mọi engine. */
const latencyCache = new Map();

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
 * Mức của cổng theo thời gian, tính lại từ lịch fade (không đọc AudioParam.value: giá trị đó không phản ánh
 * automation một cách tin cậy). Fade equal-power: gain = sin(góc), góc chạy tuyến tính từ a0 tới a1.
 */
const gateFades = new WeakMap(); // GainNode → { a0, a1, t0, dur }
function gateAngle(g, now) {
  const f = gateFades.get(g);
  if (!f) return 0;
  if (f.dur <= 0 || now >= f.t0 + f.dur) return f.a1;
  return f.a0 + (f.a1 - f.a0) * Math.max(0, (now - f.t0) / f.dur);
}

/**
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} input      node nguồn (engine sở hữu các kết nối đầu ra của nó)
 * @param {AudioNode} destination
 */
export async function createEngine(ctx, input, destination, { semitones = 0, options = {} } = {}) {
  const SR = ctx.sampleRate;
  let opts = mergeOptions(undefined, options);
  let pitch = semitones;
  const out = new GainNode(ctx);
  out.connect(destination);

  const wiring = new Wiring();
  let desiredEdges = [];
  let lingering = []; // [{ edges, until }]
  let fed = new Set(); // node (không qua cổng) đang được cấp tín hiệu theo lần route trước
  let gatesOpen = new Set(); // cổng đang mở theo lần route trước
  let cleanupTimer = null;
  let disposed = false;
  let target = 0; // độ trễ chung của mọi nhánh (mẫu)

  // ---------- nhánh xử lý: Stretch (+ Delay bù trễ) hoặc Delay ----------
  /** key → { key, kind, input, output, internal: edges, node?, profile?, active } */
  const procs = new Map();
  // Stretch rảnh (đã ngắt, không active) để dùng lại: bộ nhớ WASM của worklet chỉ được trả khi AudioContext đóng
  // (mỗi tiến trình chứa được ~125 instance), nên tạo mới mỗi lần đổi chất lượng/formant/ghi file sẽ cạn dần.
  const idle = [];

  const stretchParams = (profile) => ({ semitones: pitch, formantCompensation: profile.formant, formantBaseHz: 0 });
  const cacheKey = (config) => `${SR}|${JSON.stringify(config)}`;
  async function newStretchNode(config) {
    const node = idle.pop() ?? (await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }));
    await node.configure(config); // cũng reset bộ đệm
    const k = cacheKey(config);
    if (!latencyCache.has(k)) latencyCache.set(k, Math.round((await node.latency()) * SR));
    return { node, latency: latencyCache.get(k) };
  }
  const releaseStretch = (node) => {
    node.disconnect();
    node.schedule({ active: false }); // đã ngắt khỏi out ⇒ tắt ngay được
    idle.push(node);
  };
  /** Độ trễ của cấu hình; lần đầu phải tạo Stretch để đo (rồi để vào pool rảnh). */
  async function configLatency(config) {
    if (!latencyCache.has(cacheKey(config))) releaseStretch((await newStretchNode(config)).node);
    return latencyCache.get(cacheKey(config));
  }
  async function stretchProc(scope, profile) {
    const key = `s|${scope}|${JSON.stringify(profile)}|${target}`;
    let p = procs.get(key);
    if (!p) {
      const { node, latency } = await newStretchNode(profile.config);
      const pad = target - latency;
      const comp = pad > 0 ? new DelayNode(ctx, { maxDelayTime: 1, delayTime: pad / SR }) : null;
      p = procs.get(key); // tạo song song trong lúc chờ
      if (p) releaseStretch(node);
      else {
        p = { key, kind: 'stretch', input: node, output: comp ?? node, internal: comp ? [[node, comp, 0]] : [], node, profile, active: false };
        procs.set(key, p);
      }
    }
    return p;
  }
  function delayProc(scope) {
    const key = `d|${scope}|${target}`;
    let p = procs.get(key);
    if (!p) {
      const node = new DelayNode(ctx, { maxDelayTime: 1, delayTime: target / SR });
      p = { key, kind: 'delay', input: node, output: node, internal: [], active: false };
      procs.set(key, p);
    }
    return p;
  }
  function dropProc(p) {
    for (const n of new Set([p.input, p.output])) n.disconnect();
    if (p.kind === 'stretch') releaseStretch(p.node);
    procs.delete(p.key);
  }

  // ---------- cổng ----------
  const gates = new Map(); // key → GainNode
  function gateOf(from, output, proc) {
    const key = `${idOf(from)}:${output}>${proc.key}`;
    let g = gates.get(key);
    if (!g) {
      g = new GainNode(ctx, { gain: 0 });
      gates.set(key, g);
    }
    return g;
  }
  /** Mở (to = 1) / đóng (to = 0) cổng bằng fade equal-power, tiếp tục từ mức hiện tại nếu đang fade dở. */
  function rampGate(g, to, immediate) {
    const p = g.gain;
    const now = ctx.currentTime;
    const a1 = to ? Math.PI / 2 : 0;
    const a0 = immediate ? a1 : gateAngle(g, now);
    const dur = (XF_S * Math.abs(a1 - a0)) / (Math.PI / 2);
    gateFades.set(g, { a0, a1, t0: now, dur });
    p.cancelAndHoldAtTime(now); // cắt ngắn fade đang dở (cancelScheduledValues để lại cả đường cong đã bắt đầu)
    if (dur < 1e-4) {
      p.setValueAtTime(to, now);
      return;
    }
    const curve = Float32Array.from({ length: 32 }, (_, i) => Math.sin(a0 + ((a1 - a0) * i) / 31));
    p.setValueCurveAtTime(curve, now, dur);
  }

  // ---------- tách lớp ----------
  const stems = STEM_NAMES.map((name) => ({
    name,
    svol: new GainNode(ctx), // âm lượng ở chế độ dùng chung (trước Stretch)
    pvol: new GainNode(ctx), // âm lượng ở chế độ từng lớp (sau tap)
    tap: new GainNode(ctx), // điểm ghi file của lớp
  }));

  // Bộ tách lớp theo preset (mỗi chất lượng một preset). Đổi preset = crossfade ở cổng đầu vào sang bộ khác; bộ
  // không dùng nữa được tạm dừng (worklet không xử lý) và giữ lại để dùng sau, vì như Stretch, bộ nhớ WASM của nó
  // chỉ được trả khi AudioContext đóng.
  const seps = new Map(); // JSON(preset) → node (+ .paused)
  let sep = null; // bộ đang dùng
  let sepKey = null;
  let separated = false;
  let perStem = false;
  let recorder = null;

  async function ensureSeparator() {
    const preset = separatorPreset(opts.quality, SR);
    const key = JSON.stringify(preset);
    let node = seps.get(key);
    if (!node) {
      node = await createSeparatorNode(ctx, preset, separatorParams(opts));
      node.paused = false;
      seps.set(key, node);
    } else if (node.paused) {
      node.port.postMessage('reset'); // bỏ âm thanh cũ còn trong bộ đệm
      node.port.postMessage('resume');
      node.paused = false;
      node.setParams(separatorParams(opts));
    } else if (node !== sep) {
      node.setParams(separatorParams(opts)); // đang fade ra, được dùng lại: giữ liên tục, không reset
    }
    sep = node;
    sepKey = key;
  }
  function pauseSeparator(node) {
    node.disconnect();
    node.port.postMessage('pause');
    node.paused = true;
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

  // ---------- nối dây ----------
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
  /** Các cạnh đi vào `start` (và các node phía trước nó) trong tập `edges`. */
  function upstream(start, edges) {
    const result = [];
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
      const n = queue.shift();
      if (seen.has(n)) continue;
      seen.add(n);
      for (const e of edges) {
        if (e[1] !== n) continue;
        result.push(e);
        queue.push(e[0]);
      }
    }
    return result;
  }

  function applyWiring() {
    const now = ctx.currentTime;
    lingering = lingering.filter((l) => l.until > now);
    wiring.apply([...desiredEdges, ...lingering.flatMap((l) => l.edges)]);
  }

  /** Sau thời gian giữ: tháo cạnh đuôi, bỏ nhánh/cổng/Separator không còn dùng. */
  function cleanup() {
    cleanupTimer = null;
    if (disposed) return;
    applyWiring();
    if (lingering.length) return scheduleCleanup();
    const inUse = new Set(desiredEdges.flatMap(([a, b]) => [a, b]));
    for (const p of [...procs.values()]) if (!p.active && !inUse.has(p.input)) dropProc(p);
    for (const [k, g] of gates) {
      if (inUse.has(g)) continue;
      g.disconnect();
      gates.delete(k);
    }
    for (const node of seps.values()) if (!node.paused && !inUse.has(node)) pauseSeparator(node);
  }
  function scheduleCleanup() {
    if (cleanupTimer || disposed) return;
    cleanupTimer = setTimeout(cleanup, (LINGER_S + 0.1) * 1000);
  }

  // route() có await (tạo/cấu hình Stretch) mà popup gọi setOptions liên tục khi kéo thanh trượt ⇒ chạy lần lượt,
  // mỗi lần đọc trạng thái mới nhất.
  let routing = Promise.resolve();
  function route(immediate = false) {
    const run = routing.then(() => routeNow(immediate));
    routing = run.catch(() => {});
    return run;
  }

  /** @param {boolean} immediate  không crossfade (lần route đầu, hoặc chưa phát gì) */
  async function routeNow(immediate) {
    if (disposed) return;
    immediate ||= ctx.currentTime === 0;
    const want = opts.separate;
    const bypass = pitch === 0;
    const per = want && perStem;
    const transposed = (name) => opts.stems[name].transpose && !bypass;
    const profileOf = (name) => stretchProfile(opts, want ? name : null);
    if (want) await ensureSeparator();

    // Độ trễ chung: theo profile chậm nhất của chế độ hiện tại — không phụ thuộc lớp nào đang đổi tông, để bật/tắt
    // đổi tông từng lớp hoặc về 0 bán cung không làm lệch nhịp.
    const configs = new Map((want ? STEM_NAMES : [null]).map((n) => stretchProfile(opts, n).config).map((c) => [JSON.stringify(c), c]));
    const lats = await Promise.all([...configs.values()].map(configLatency));
    target = Math.max(...lats);

    // Chọn nhánh cho từng đường vào (tạo Stretch mới nếu cần) trước khi nối, để không await giữa chừng.
    const plan = []; // [from, output, proc, after]  after: node nhận output của nhánh
    if (!want) {
      plan.push([input, 0, bypass ? delayProc('shared') : await stretchProc('shared', profileOf(null)), out]);
    } else {
      for (const [i, s] of stems.entries()) {
        if (per) {
          const proc = transposed(s.name) ? await stretchProc(s.name, profileOf(s.name)) : delayProc(s.name);
          plan.push([sep, i, proc, s.tap]);
        } else {
          const proc = transposed(s.name) ? await stretchProc('shared', profileOf(s.name)) : delayProc('shared');
          plan.push([s.svol, 0, proc, out]);
        }
      }
    }
    const now = ctx.currentTime;

    const edges = [];
    const feeds = new Set();
    const open = new Set();
    const used = new Set();
    const edge = (a, b, o = 0) => edges.push([a, b, o]);
    const feed = (a, b, o = 0) => {
      edge(a, b, o);
      feeds.add(b);
    };
    if (want) {
      const g = gateOf(input, 0, { key: `sep|${sepKey}` });
      open.add(g);
      edge(input, g);
      edge(g, sep);
      stems.forEach((s, i) => {
        if (per) {
          edge(s.tap, s.pvol);
          edge(s.pvol, out);
        } else {
          feed(sep, s.svol, i);
        }
      });
    }
    for (const [from, o, proc, after] of plan) {
      const g = gateOf(from, o, proc);
      open.add(g);
      used.add(proc);
      edge(from, g, o);
      edge(g, proc.input);
      edges.push(...proc.internal);
      edge(proc.output, after);
    }

    // Bật/tắt Stretch. Stretch vừa thôi dùng vẫn chạy thêm LINGER_S giây cho cổng đóng hẳn và hết phần đuôi.
    for (const p of procs.values()) {
      if (p.kind !== 'stretch') continue;
      if (used.has(p) && !p.active) {
        await p.node.schedule({ active: true, ...stretchParams(p.profile) });
        p.active = true;
      } else if (!used.has(p) && p.active) {
        await p.node.schedule({ active: false, outputTime: now + LINGER_S });
        p.active = false;
      }
    }

    // Giữ nhánh cũ thêm LINGER_S giây: node thôi được cấp tín hiệu giữ phía sau nó; cổng vừa đóng giữ cả phía trước
    // (nó cần tín hiệu vào để fade) lẫn phía sau.
    const previous = wiring.list();
    const tails = [];
    for (const n of fed) if (!feeds.has(n)) tails.push(...downstream(n, previous));
    for (const g of gatesOpen) {
      if (open.has(g)) continue;
      rampGate(g, 0, immediate);
      tails.push(...upstream(g, previous), ...downstream(g, previous));
    }
    for (const g of open) if (!gatesOpen.has(g)) rampGate(g, 1, immediate);
    if (tails.length && !immediate) lingering.push({ edges: tails, until: now + LINGER_S });

    desiredEdges = edges;
    fed = feeds;
    gatesOpen = open;
    separated = want;
    applyWiring();
    scheduleCleanup();
  }

  await route(true);
  applyVolumes(true);

  const activeStretches = () => [...procs.values()].filter((p) => p.kind === 'stretch' && p.active);

  return {
    async setSemitones(value) {
      const wasBypass = pitch === 0;
      pitch = value;
      // Về 0: Stretch giữ cao độ cũ trong lúc fade ra; Stretch bật lại nhận cao độ mới khi route.
      if (value !== 0) await Promise.all(activeStretches().map((p) => p.node.schedule({ semitones: value })));
      if (wasBypass !== (pitch === 0)) await route();
    },

    async setOptions(patch) {
      const prev = opts;
      opts = mergeOptions(opts, patch);
      await route(); // đổi chất lượng/formant ⇒ profile khác ⇒ Stretch mới, crossfade sang
      const params = separatorParams(opts);
      if (sep && JSON.stringify(params) !== JSON.stringify(separatorParams(prev))) sep.setParams(params);
      applyVolumes();
    },

    options: () => mergeOptions(opts),

    /** Tổng độ trễ xử lý (giây), chưa tính độ trễ thiết bị. */
    async latency() {
      return target / SR + (separated ? sep.latencySamples / SR : 0);
    },

    /** centerRatio ≈ 1 ⇒ bài gần như mono (lớp giọng sẽ lẫn nhiều nhạc cụ). */
    stats: () => ({ centerRatio: separated ? sep.stats.centerRatio : null }),

    /** Cho test: số Stretch đang tồn tại / đang chạy. */
    debug: () => ({
      stretchNodes: [...procs.values()].filter((p) => p.kind === 'stretch').length,
      stretchInstances: [...procs.values()].filter((p) => p.kind === 'stretch').length + idle.length, // kể cả node rảnh
      activeStretches: activeStretches().length,
      separated,
      perStem: separated && perStem,
      separatorAlive: !!sep && !sep.paused,
      separatorInstances: seps.size, // kể cả bộ đang tạm dừng
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
        // Bỏ đoạn đầu: nhánh dùng chung còn đang fade ra (có trong mix nhưng không thuộc lớp nào).
        if (ctx.currentTime > 0) startAt = ctx.currentTime + target / SR + XF_S + 0.05;
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
      for (const node of seps.values()) {
        node.disconnect();
        node.port.postMessage('free');
      }
      for (const p of [...procs.values()]) dropProc(p);
      for (const g of gates.values()) g.disconnect();
      for (const n of stems.flatMap((s) => [s.svol, s.pvol, s.tap])) n.disconnect();
      out.disconnect();
    },
  };
}
