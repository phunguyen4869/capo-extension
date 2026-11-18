// Quản lý model HTDemucs (tải, kiểm tra, lưu OPFS) + giải mã âm thanh cho AI.
// Không import ONNX Runtime: luồng chính dùng file này, còn suy luận chạy trong workers/ai-worker.js.
import { capoError } from '../i18n.js';

export const AI_SAMPLE_RATE = 44100; // = CONSTANTS.SAMPLE_RATE của demucs-web
export const AI_STEMS = ['drums', 'bass', 'vocals', 'other'];

export const MODEL = {
  revision: '92e33df61cfc9eb820272aaa62d2ef6dcf4d950d',
  url: 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/92e33df61cfc9eb820272aaa62d2ef6dcf4d950d/htdemucs_embedded.onnx',
  bytes: 180534758,
  sha256: 'e5e425c17683f163a472462eb5f5a4ffcd11c31858d57fbd0833b012d8b88077',
  file: 'htdemucs-92e33df.onnx',
};

export async function modelsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('capo-models', { create: true });
}

/** @returns {Promise<{cached:boolean, bytes:number}>} */
export async function modelInfo() {
  try {
    const file = await (await (await modelsDir()).getFileHandle(MODEL.file)).getFile();
    return { cached: file.size === MODEL.bytes, bytes: file.size };
  } catch {
    return { cached: false, bytes: 0 };
  }
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Tải model (ghi thẳng xuống OPFS), kiểm tra kích thước + SHA-256 rồi mới dùng. */
export async function downloadModel({ onProgress, signal } = {}) {
  await navigator.storage.persist?.().catch(() => false);
  const dir = await modelsDir();
  const partName = `${MODEL.file}.part`;
  const res = await fetch(MODEL.url, { signal });
  if (!res.ok || !res.body) throw capoError('modelHttp', { status: res.status });
  const handle = await dir.getFileHandle(partName, { create: true });
  const writable = await handle.createWritable();
  let loaded = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      loaded += value.byteLength;
      onProgress?.(loaded, MODEL.bytes);
    }
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    await dir.removeEntry(partName).catch(() => {});
    throw err;
  }
  const file = await handle.getFile();
  const digest = toHex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  if (file.size !== MODEL.bytes || digest !== MODEL.sha256) {
    await dir.removeEntry(partName).catch(() => {});
    throw capoError('modelMismatch', { bytes: file.size, sha: digest.slice(0, 12) });
  }
  await dir.removeEntry(MODEL.file).catch(() => {});
  await handle.move(MODEL.file);
  return modelInfo();
}

export async function deleteModel() {
  const dir = await modelsDir();
  for await (const name of dir.keys()) await dir.removeEntry(name).catch(() => {});
}

export async function webgpuAvailable() {
  try {
    return !!(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

/** Giải mã file âm thanh bất kỳ trình duyệt hỗ trợ, đổi về 44.1 kHz stereo. */
export async function decodeForAi(arrayBuffer) {
  const ctx = new OfflineAudioContext(2, 1, AI_SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(arrayBuffer);
  const left = new Float32Array(decoded.getChannelData(0));
  const right = decoded.numberOfChannels > 1 ? new Float32Array(decoded.getChannelData(1)) : new Float32Array(left);
  return { left, right, seconds: decoded.duration };
}
