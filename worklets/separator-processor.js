// AudioWorkletProcessor bọc bộ tách lớp viết bằng Rust (wasm/capo_dsp.wasm).
// 1 input stereo → 4 output stereo: 0 trống, 1 bass, 2 giọng hát, 3 nhạc cụ khác.
// WebAssembly.Module được compile ở luồng chính rồi truyền qua processorOptions
// (AudioWorkletGlobalScope không có fetch).

const STATS_INTERVAL_S = 0.5;

class CapoSeparatorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.alive = false;
    try {
      const { module, preset, params } = options.processorOptions;
      this.ex = new WebAssembly.Instance(module, {}).exports;
      this.ptr = this.ex.sep_new(
        sampleRate, preset.fftSize, preset.hop, preset.timeHalf, preset.freqHalf, preset.margin, preset.sharpness,
      );
      if (!this.ptr) throw new Error('Invalid separator preset: ' + JSON.stringify(preset));
      this.stems = this.ex.sep_num_stems();
      this.maxBlock = this.ex.sep_max_block();
      if (params) this.setParams(params);
      this.bindViews();
      this.statsEvery = Math.round(sampleRate * STATS_INTERVAL_S);
      this.statsCounter = 0;
      this.alive = true;
      this.port.onmessage = (e) => {
        const m = e.data;
        if (m === 'reset') this.ex.sep_reset(this.ptr);
        else if (m === 'free') this.free();
        else if (m?.type === 'params') this.setParams(m);
      };
      this.port.postMessage({ type: 'ready', latency: this.ex.sep_latency(this.ptr), stems: this.stems });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err?.message || err) });
    }
  }

  setParams(p) {
    // NaN ⇒ Rust dùng giá trị mặc định.
    this.ex.sep_set_params(this.ptr, p.bassCutoffHz ?? NaN, p.vocalHighHz ?? NaN, p.centerWidth ?? NaN, p.centerSmoothingMs ?? NaN);
  }

  bindViews() {
    this.memory = this.ex.memory.buffer;
    this.blockViews = new Map(); // kích thước block → view (tạo một lần, không cấp phát trong process)
  }

  /** View vào bộ đệm I/O của Rust cho block `n` mẫu: { in: [L, R], out: [stem][L, R] }. */
  viewsFor(n) {
    let v = this.blockViews.get(n);
    if (!v) {
      const ex = this.ex;
      const view = (ptr) => new Float32Array(this.memory, ptr, n);
      v = {
        in: [0, 1].map((c) => view(ex.sep_input_ptr(this.ptr, c))),
        out: Array.from({ length: this.stems }, (_, s) => [0, 1].map((c) => view(ex.sep_output_ptr(this.ptr, s, c)))),
      };
      this.blockViews.set(n, v);
    }
    return v;
  }

  free() {
    if (!this.alive) return;
    this.alive = false;
    this.ex.sep_free(this.ptr);
  }

  process(inputs, outputs) {
    if (!this.alive) return false;
    // Rust không cấp phát trong process, nhưng vẫn phòng khi memory bị grow (view cũ bị detach).
    if (this.ex.memory.buffer !== this.memory) this.bindViews();

    const input = inputs[0];
    const total = outputs[0][0].length;
    for (let pos = 0; pos < total; pos += this.maxBlock) {
      const n = Math.min(this.maxBlock, total - pos);
      const v = this.viewsFor(n);
      for (let c = 0; c < 2; c++) {
        const src = input[c] ?? input[0];
        if (!src) v.in[c].fill(0);
        else if (n === src.length) v.in[c].set(src); // trường hợp thường gặp: cả block 128 mẫu
        else v.in[c].set(src.subarray(pos, pos + n));
      }
      this.ex.sep_process(this.ptr, n);
      for (let s = 0; s < this.stems; s++) {
        const out = outputs[s];
        if (!out) continue;
        for (let c = 0; c < 2; c++) out[c]?.set(v.out[s][c], pos);
      }
    }

    this.statsCounter += total;
    if (this.statsCounter >= this.statsEvery) {
      this.statsCounter = 0;
      this.port.postMessage({ type: 'stats', centerRatio: this.ex.sep_center_ratio(this.ptr) });
    }
    return true;
  }
}

registerProcessor('capo-separator', CapoSeparatorProcessor);
