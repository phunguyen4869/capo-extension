// Offscreen document: nơi duy nhất giữ MediaStream + AudioContext của từng tab.
// Xử lý âm thanh nằm trong audio/engine.js (pitch shift + tách lớp + ghi file).

import { createEngine } from './audio/engine.js';
import { capoError } from './i18n.js';

const sessions = new Map(); // tabId -> { ctx, stream, engine, semitones }
const URL_TTL_MS = 10 * 60 * 1000;

async function describe(tabId) {
  const s = sessions.get(tabId);
  if (!s) return { active: false, semitones: 0 };
  const processing = await s.engine.latency();
  const device = (s.ctx.baseLatency || 0) + (s.ctx.outputLatency || 0);
  return {
    active: true,
    semitones: s.semitones,
    options: s.engine.options(),
    latencyMs: Math.round((processing + device) * 1000),
    stats: s.engine.stats(),
    recording: s.engine.recording(),
  };
}

async function start(tabId, streamId, semitones, options) {
  if (sessions.has(tabId)) await stop(tabId);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  const ctx = new AudioContext({ latencyHint: 'interactive' });

  try {
    // Capture tab làm tab bị tắt tiếng → engine tự phát lại ra loa (ctx.destination).
    const source = ctx.createMediaStreamSource(stream);
    const engine = await createEngine(ctx, source, ctx.destination, { semitones, options });
    sessions.set(tabId, { ctx, stream, engine, semitones });
    await ctx.resume();

    stream.getAudioTracks()[0]?.addEventListener('ended', async () => {
      const { remaining } = await stop(tabId);
      chrome.runtime
        .sendMessage({ target: 'background', type: 'capture-ended', tabId, remaining })
        .catch(() => {});
    });

    return describe(tabId);
  } catch (err) {
    sessions.delete(tabId);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    throw err;
  }
}

function session(tabId) {
  const s = sessions.get(tabId);
  if (!s) throw capoError('notActive');
  return s;
}

async function setPitch(tabId, semitones) {
  const s = session(tabId);
  s.semitones = semitones;
  await s.engine.setSemitones(semitones);
  return describe(tabId);
}

async function setOptions(options) {
  for (const s of sessions.values()) await s.engine.setOptions(options);
  return { ok: true };
}

/** Đổi File trong OPFS thành blob URL để service worker gọi chrome.downloads. */
function exportFiles(files) {
  return files.map(({ name, file }) => {
    const url = URL.createObjectURL(file);
    setTimeout(() => URL.revokeObjectURL(url), URL_TTL_MS);
    return { name, url, bytes: file.size };
  });
}

async function recordStart(tabId) {
  await session(tabId).engine.startRecording();
  return describe(tabId);
}

async function recordStop(tabId) {
  const files = await session(tabId).engine.stopRecording();
  return { files: exportFiles(files) };
}

async function stop(tabId) {
  const s = sessions.get(tabId);
  if (s) {
    sessions.delete(tabId);
    // Đang ghi mà tab bị tắt/đóng → vẫn lưu phần đã ghi.
    if (s.engine.recording().active) {
      try {
        const files = exportFiles(await s.engine.stopRecording());
        chrome.runtime.sendMessage({ target: 'background', type: 'recording-ready', tabId, files }).catch(() => {});
      } catch (err) {
        console.warn('[capo] could not save the recording:', err);
      }
    }
    s.engine.dispose();
    s.stream.getTracks().forEach((t) => t.stop());
    await s.ctx.close().catch(() => {});
  }
  return { remaining: sessions.size };
}

const handlers = {
  'get-state': (m) => describe(m.tabId),
  start: (m) => start(m.tabId, m.streamId, m.semitones, m.options),
  'set-pitch': (m) => setPitch(m.tabId, m.semitones),
  'set-options': (m) => setOptions(m.options),
  'record-start': (m) => recordStart(m.tabId),
  'record-stop': (m) => recordStop(m.tabId),
  stop: (m) => stop(m.tabId),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  const handler = handlers[msg.type];
  if (!handler) return;
  Promise.resolve(handler(msg)).then(sendResponse, (err) =>
    sendResponse({ error: String(err?.message || err) }),
  );
  return true;
});
