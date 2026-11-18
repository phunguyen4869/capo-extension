// Ghi nhiều track cùng lúc ra file WAV (PCM 16-bit stereo) trong OPFS.
// Dữ liệu được ghi thẳng xuống đĩa theo từng đoạn ~0.25 s nên RAM không tăng theo độ dài bản ghi.
import { capoError } from '../i18n.js';

const WORKLET_URL = new URL('../worklets/recorder-processor.js', import.meta.url).href;
const workletLoaded = new WeakMap();
const DIR_NAME = 'capo-recordings';

/** Header WAV 44 byte, PCM 16-bit. */
export function wavHeader(dataBytes, sampleRate, channels = 2) {
  const b = new ArrayBuffer(44);
  const v = new DataView(b);
  const str = (off, s) => [...s].forEach((ch, i) => v.setUint8(off + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  return b;
}

async function recordingsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR_NAME, { create: true });
}

/** Các bản ghi trong OPFS (mới nhất trước): [{name, track, file}]. */
export async function listRecordings() {
  const dir = await recordingsDir();
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    const m = /^(\d+)-(.+)\.wav$/.exec(name);
    if (!m || handle.kind !== 'file') continue;
    out.push({ name, stamp: Number(m[1]), track: m[2], file: await handle.getFile() });
  }
  return out.sort((a, b) => b.stamp - a.stamp);
}

/** Xóa các bản ghi cũ trong OPFS. */
export async function clearRecordings() {
  const dir = await recordingsDir();
  for await (const name of dir.keys()) await dir.removeEntry(name).catch(() => {});
}

/**
 * @param {BaseAudioContext} ctx
 * @param {Record<string, AudioNode>} taps  tên track → node cần ghi
 * @param {{startAt?: number}} [opts]       thời điểm (ctx.currentTime) bắt đầu ghi; mọi track bắt đầu cùng lúc
 */
export async function createRecorder(ctx, taps, { startAt = 0 } = {}) {
  if (!workletLoaded.has(ctx)) workletLoaded.set(ctx, ctx.audioWorklet.addModule(WORKLET_URL));
  await workletLoaded.get(ctx);
  await clearRecordings();
  const dir = await recordingsDir();
  const stamp = Date.now();

  // Recorder cần nối tới destination để được render; gain 0 nên không phát ra loa.
  const sink = new GainNode(ctx, { gain: 0 });
  sink.connect(ctx.destination);

  const tracks = [];
  for (const [name, node] of Object.entries(taps)) {
    const handle = await dir.getFileHandle(`${stamp}-${name}.wav`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(wavHeader(0, ctx.sampleRate));
    const rec = new AudioWorkletNode(ctx, 'capo-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { startAt },
    });
    const track = { name, node, handle, writable, rec, bytes: 0, chain: Promise.resolve(), flushed: null, error: null };
    rec.port.onmessage = (e) => {
      if (e.data.type === 'data') {
        const buf = e.data.buf;
        track.bytes += buf.byteLength;
        track.chain = track.chain.then(() => writable.write(buf)).catch((err) => (track.error ??= err));
      } else if (e.data.type === 'flushed') {
        track.flushed?.();
      }
    };
    node.connect(rec);
    rec.connect(sink);
    tracks.push(track);
  }

  const startTime = Math.max(ctx.currentTime, startAt);
  let finished = false;

  function detach() {
    for (const t of tracks) {
      try {
        t.node.disconnect(t.rec);
      } catch {}
      t.rec.disconnect();
      t.rec.port.postMessage('stop');
    }
    sink.disconnect();
  }

  return {
    seconds: () => Math.max(0, ctx.currentTime - startTime),

    /** Dừng ghi, hoàn tất header WAV. Trả về [{name, file: File}]. */
    async stop() {
      if (finished) throw capoError('recordingFinished');
      finished = true;
      await Promise.all(
        tracks.map(
          (t) =>
            new Promise((resolve) => {
              t.flushed = resolve;
              t.rec.port.postMessage('flush');
            }),
        ),
      );
      detach();
      const files = [];
      for (const t of tracks) {
        await t.chain;
        if (t.error) throw t.error;
        await t.writable.write({ type: 'write', position: 0, data: wavHeader(t.bytes, ctx.sampleRate) });
        await t.writable.close();
        files.push({ name: t.name, file: await t.handle.getFile() });
      }
      return files;
    },

    /** Hủy bản ghi, bỏ dữ liệu. */
    async abort() {
      if (finished) return;
      finished = true;
      detach();
      for (const t of tracks) await t.writable.abort().catch(() => {});
      await clearRecordings();
    },
  };
}
