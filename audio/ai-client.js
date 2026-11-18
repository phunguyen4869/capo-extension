// Phía luồng chính của workers/ai-worker.js.
import { capoError } from '../i18n.js';

export function createAiClient() {
  const worker = new Worker(new URL('../workers/ai-worker.js', import.meta.url), { type: 'module' });
  let nextId = 0;
  const pending = new Map(); // id → { resolve, reject, onProgress }

  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') return p.onProgress?.(m);
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = (e) => {
    const err = e.message ? new Error(e.message) : capoError('workerFailed');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const call = (msg, transfer = [], onProgress) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ ...msg, id }, transfer);
    });

  return {
    /** @returns {Promise<{backend:'webgpu'|'wasm', threads:number|null}>} */
    load: (backend) => call({ type: 'load', backend }),
    /**
     * Mảng `left`/`right` được chuyển (transfer) sang worker — không dùng lại được ở luồng chính.
     * @returns {Promise<Record<'drums'|'bass'|'vocals'|'other', Blob>>} WAV 44.1 kHz
     */
    separate: (left, right, onProgress) =>
      call({ type: 'separate', left, right }, [left.buffer, right.buffer], onProgress).then((m) => m.blobs),
    release: () => call({ type: 'release' }),
    terminate() {
      worker.terminate();
      for (const p of pending.values()) p.reject(capoError('workerStopped'));
      pending.clear();
    },
  };
}
