// Suy luận HTDemucs (Meta) bằng ONNX Runtime Web (WebGPU, dự phòng WASM) — chạy trong workers/ai-worker.js.
// Quản lý model (tải, kiểm tra SHA-256, OPFS) nằm ở audio/ai-model.js.

import * as ort from '../lib/onnxruntime-web/ort.webgpu.min.mjs';
import { CONSTANTS, DemucsProcessor } from '../lib/demucs-web/index.js';
import { AI_SAMPLE_RATE, MODEL, modelInfo, modelsDir, webgpuAvailable } from './ai-model.js';
import { wavHeader } from './recorder.js';
import { capoError } from '../i18n.js';

// MV3 không cho nạp code từ xa → mọi file wasm/mjs của ORT nằm trong gói extension.
ort.env.wasm.wasmPaths = new URL('../lib/onnxruntime-web/', import.meta.url).href;
ort.env.wasm.proxy = false;
// Đa luồng cần SharedArrayBuffer (cross-origin isolated). Extension KHÔNG bật COOP/COEP vì nó làm hỏng
// tabCapture (xem README) ⇒ thực tế chạy 1 luồng trên CPU; WebGPU không bị ảnh hưởng.
ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;

export { AI_SAMPLE_RATE, AI_STEMS } from './ai-model.js';
if (CONSTANTS.SAMPLE_RATE !== AI_SAMPLE_RATE) throw new Error('demucs-web SAMPLE_RATE differs from AI_SAMPLE_RATE');

/**
 * Nạp model vào ONNX Runtime.
 * @param {{backend?: 'auto'|'webgpu'|'wasm'}} [opts]
 */
export async function createAiSeparator({ backend = 'auto' } = {}) {
  if (!(await modelInfo()).cached) throw capoError('modelMissing');
  const file = await (await (await modelsDir()).getFileHandle(MODEL.file)).getFile();
  const useGpu = backend !== 'wasm' && (await webgpuAvailable());
  if (backend === 'webgpu' && !useGpu) throw capoError('noWebgpu');
  const processor = new DemucsProcessor({
    ort,
    sessionOptions: {
      executionProviders: useGpu ? ['webgpu', 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'all',
    },
  });
  await processor.loadModel(await file.arrayBuffer());
  return {
    backend: useGpu ? 'webgpu' : 'wasm',
    threads: useGpu ? null : ort.env.wasm.numThreads,
    /**
     * @param {Float32Array} left  44.1 kHz
     * @param {Float32Array} right 44.1 kHz
     * @param {(p:{progress:number,currentSegment:number,totalSegments:number}) => void} [onProgress]
     * @returns {Promise<Record<'drums'|'bass'|'vocals'|'other', {left:Float32Array,right:Float32Array}>>}
     */
    async separate(left, right, onProgress) {
      processor.onProgress = onProgress ?? (() => {});
      const r = await processor.separate(left, right);
      return { drums: r.drums, bass: r.bass, vocals: r.vocals, other: r.other };
    },
    async release() {
      await processor.session?.release?.();
    },
  };
}

/** WAV PCM 16-bit stereo. */
export function wavBlob(left, right, sampleRate = AI_SAMPLE_RATE) {
  const n = left.length;
  const pcm = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = Math.max(-1, Math.min(1, left[i]));
    const b = Math.max(-1, Math.min(1, right[i]));
    pcm[2 * i] = a < 0 ? a * 32768 : a * 32767;
    pcm[2 * i + 1] = b < 0 ? b * 32768 : b * 32767;
  }
  return new Blob([wavHeader(pcm.byteLength, sampleRate), pcm], { type: 'audio/wav' });
}
