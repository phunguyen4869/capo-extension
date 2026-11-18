// Service worker: điều phối giữa popup / phím tắt và offscreen document.
// Trạng thái âm thanh thật sự nằm trong offscreen document (service worker có thể bị tắt bất cứ lúc nào).

import { mergeOptions } from './presets.js';
import { capoError } from './i18n.js';

const OFFSCREEN_URL = 'offscreen.html';
const MIN_SEMITONES = -12;
const MAX_SEMITONES = 12;

let creatingOffscreen = null;
const tabLocks = new Map(); // tabId -> Promise, tránh 2 lệnh start chồng nhau trên cùng tab

function withTabLock(tabId, fn) {
  const prev = tabLocks.get(tabId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  tabLocks.set(tabId, next);
  next
    .finally(() => {
      if (tabLocks.get(tabId) === next) tabLocks.delete(tabId);
    })
    .catch(() => {});
  return next;
}

function clampSemitones(value) {
  const v = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(v)) return 0;
  return Math.min(MAX_SEMITONES, Math.max(MIN_SEMITONES, v));
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA'],
        justification: 'Process the tab audio to change its pitch and separate stems.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function toOffscreen(msg) {
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  if (res?.error) throw new Error(res.error);
  return res;
}

async function getOptions() {
  const { options } = await chrome.storage.local.get('options');
  return mergeOptions(undefined, options ?? {});
}

function formatBadge(semitones) {
  if (semitones === 0) return '0';
  const sign = semitones > 0 ? '+' : '−';
  const abs = Math.abs(semitones);
  return sign + (Number.isInteger(abs) ? abs : abs.toFixed(1));
}

async function updateBadge(tabId, state) {
  try {
    if (!state?.active) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    await chrome.action.setBadgeText({ tabId, text: formatBadge(state.semitones) });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: state.semitones === 0 ? '#6b7280' : state.semitones > 0 ? '#d9480f' : '#1971c2',
    });
  } catch {
    // Tab có thể đã đóng.
  }
}

async function getState(tabId) {
  if (!(await hasOffscreen())) return { active: false, semitones: 0 };
  return toOffscreen({ type: 'get-state', tabId });
}

function setPitch(tabId, semitones) {
  return withTabLock(tabId, async () => {
    semitones = clampSemitones(semitones);
    const current = await getState(tabId);
    let state;
    if (current.active) {
      state = await toOffscreen({ type: 'set-pitch', tabId, semitones });
    } else {
      // Phải gọi trong lúc extension đang được "invoke" trên tab (mở popup / phím tắt).
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      await ensureOffscreen();
      state = await toOffscreen({
        type: 'start',
        tabId,
        streamId,
        semitones,
        options: await getOptions(),
      });
    }
    await updateBadge(tabId, state);
    return state;
  });
}

function stop(tabId) {
  return withTabLock(tabId, async () => {
    if (await hasOffscreen()) {
      const { remaining } = await toOffscreen({ type: 'stop', tabId });
      if (remaining === 0) await chrome.offscreen.closeDocument().catch(() => {});
    }
    const state = { active: false, semitones: 0 };
    await updateBadge(tabId, state);
    return state;
  });
}

async function setOptions(options) {
  const merged = mergeOptions(await getOptions(), options);
  await chrome.storage.local.set({ options: merged });
  if (await hasOffscreen()) await toOffscreen({ type: 'set-options', options: merged });
  return merged;
}

function safeName(text) {
  return (text || 'tab').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'tab';
}

/** Tải các file WAV (blob URL do offscreen tạo) vào Downloads/CAPO/<tiêu đề tab>/. */
async function downloadFiles(tabId, files) {
  // tabs.get ném lỗi đồng bộ với id không hợp lệ và reject khi tab đã đóng → bắt cả hai.
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {}
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  // Giờ địa phương (không dùng toISOString — đó là UTC).
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const folder = `CAPO/${safeName(tab?.title)} ${stamp}`;
  const ids = [];
  for (const f of files) {
    ids.push(await chrome.downloads.download({ url: f.url, filename: `${folder}/${f.name}.wav`, conflictAction: 'uniquify' }));
  }
  return { folder, files: files.map((f) => ({ name: f.name, bytes: f.bytes })), downloadIds: ids };
}

async function recordStart(tabId) {
  const state = await getState(tabId);
  if (!state.active) throw capoError('enableBeforeRecording');
  return toOffscreen({ type: 'record-start', tabId });
}

async function recordStop(tabId) {
  const { files } = await toOffscreen({ type: 'record-stop', tabId });
  return downloadFiles(tabId, files);
}

const handlers = {
  'get-state': (msg) => getState(msg.tabId),
  'set-pitch': (msg) => setPitch(msg.tabId, msg.semitones),
  stop: (msg) => stop(msg.tabId),
  'get-options': () => getOptions(),
  'record-start': (msg) => recordStart(msg.tabId),
  'record-stop': (msg) => recordStop(msg.tabId),
  // Offscreen tự lưu bản ghi khi tab bị tắt/đóng giữa chừng.
  'recording-ready': (msg) => downloadFiles(msg.tabId, msg.files),
  'set-options': (msg) => setOptions(msg.options),
  // Offscreen báo stream kết thúc (tab đóng, Chrome ngắt capture...)
  'capture-ended': async (msg) => {
    await updateBadge(msg.tabId, { active: false });
    if (msg.remaining === 0) await chrome.offscreen.closeDocument().catch(() => {});
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return;
  const handler = handlers[msg.type];
  if (!handler) return;
  Promise.resolve(handler(msg)).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
  );
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (tabId == null) return;
    const state = await getState(tabId);
    const current = state.active ? state.semitones : 0;
    if (command === 'pitch-up') await setPitch(tabId, Math.floor(current) + 1);
    else if (command === 'pitch-down') await setPitch(tabId, Math.ceil(current) - 1);
    else if (command === 'pitch-reset' && state.active) await setPitch(tabId, 0);
  } catch (err) {
    console.warn('[capo] command failed:', err);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    if ((await getState(tabId)).active) await stop(tabId);
  } catch {
    // bỏ qua
  }
});
