// Ghi âm stereo → PCM 16-bit xen kẽ (L R L R …), gửi về luồng chính mỗi ~0.25 s (transfer, không copy).
// Khi input không có kênh nào (nguồn im lặng) vẫn ghi số 0 để mọi track luôn khớp thời gian.

class CapoRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.startAt = options?.processorOptions?.startAt ?? 0;
    this.frames = Math.round(sampleRate * 0.25);
    this.buf = new Int16Array(this.frames * 2);
    this.pos = 0;
    this.on = true;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.send();
        this.port.postMessage({ type: 'flushed' });
      } else if (e.data === 'stop') {
        this.on = false;
      }
    };
  }

  send() {
    if (this.pos === 0) return;
    const chunk = this.buf.slice(0, this.pos * 2);
    this.port.postMessage({ type: 'data', buf: chunk.buffer }, [chunk.buffer]);
    this.pos = 0;
  }

  process(inputs, outputs) {
    if (!this.on) return false;
    if (currentTime < this.startAt) return true;
    const input = inputs[0];
    const l = input[0];
    const r = input[1] ?? input[0];
    const n = outputs[0][0].length;
    for (let i = 0; i < n; i++) {
      let a = l ? l[i] : 0;
      let b = r ? r[i] : 0;
      a = a < -1 ? -1 : a > 1 ? 1 : a;
      b = b < -1 ? -1 : b > 1 ? 1 : b;
      this.buf[this.pos * 2] = a < 0 ? a * 32768 : a * 32767;
      this.buf[this.pos * 2 + 1] = b < 0 ? b * 32768 : b * 32767;
      if (++this.pos === this.frames) this.send();
    }
    return true;
  }
}

registerProcessor('capo-recorder', CapoRecorderProcessor);
