// Worker chạy tách lớp AI (ONNX Runtime + demucs-web) ngoài luồng chính để trang không bị đứng.
// Giao thức (mỗi message có `id`):
//   → { type: 'load', backend }             ← { type: 'loaded', backend, threads }
//   → { type: 'separate', left, right }     ← { type: 'progress', progress, currentSegment, totalSegments }*
//                                           ← { type: 'result', blobs: { drums, bass, vocals, other } }  (WAV)
//   → { type: 'release' }                   ← { type: 'released' }
//   lỗi: ← { type: 'error', message }

import { AI_STEMS, createAiSeparator, wavBlob } from '../audio/ai-separator.js';
import { capoError } from '../i18n.js';

let separator = null;
let loadedBackend = null;

async function release() {
  await separator?.release();
  separator = null;
  loadedBackend = null;
}

const handlers = {
  async load({ backend }) {
    if (!separator || loadedBackend !== backend) {
      await release();
      separator = await createAiSeparator({ backend });
      loadedBackend = backend;
    }
    return { type: 'loaded', backend: separator.backend, threads: separator.threads };
  },

  async separate({ id, left, right }) {
    if (!separator) throw capoError('modelNotLoaded');
    const stems = await separator.separate(left, right, (p) => postMessage({ type: 'progress', id, ...p }));
    // Mã hóa từng lớp rồi bỏ tham chiếu mảng float ngay để giảm đỉnh bộ nhớ.
    const blobs = {};
    for (const name of AI_STEMS) {
      blobs[name] = wavBlob(stems[name].left, stems[name].right);
      stems[name] = null;
    }
    return { type: 'result', blobs };
  },

  async release() {
    await release();
    return { type: 'released' };
  },
};

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const handler = handlers[msg.type];
    if (!handler) throw new Error(`Unknown command: ${msg.type}`);
    postMessage({ id: msg.id, ...(await handler(msg)) });
  } catch (err) {
    postMessage({ id: msg.id, type: 'error', message: String(err?.message || err) });
  }
};
