import { createAiClient } from './audio/ai-client.js';
import { AI_STEMS, MODEL, decodeForAi, deleteModel, downloadModel, modelInfo, webgpuAvailable } from './audio/ai-model.js';
import { listRecordings } from './audio/recorder.js';
import { applyI18n, bindLanguageSelect, capoError, getLanguage, loadLanguage, locale, onLanguageChange, t, translateError } from './i18n.js';

const $ = (id) => document.getElementById(id);
const els = {
  language: $('language'),
  stepModel: $('step-model'),
  stepSource: $('step-source'),
  stepRun: $('step-run'),
  modelStatus: $('model-status'),
  modelProgress: $('model-progress'),
  modelDownload: $('model-download'),
  modelCancel: $('model-cancel'),
  modelDelete: $('model-delete'),
  modelSource: $('model-source'),
  choiceRecording: $('choice-recording'),
  recordingInfo: $('recording-info'),
  fileInfo: $('file-info'),
  file: $('file'),
  drop: $('drop'),
  backend: $('backend'),
  gpuInfo: $('gpu-info'),
  run: $('run'),
  cancel: $('cancel'),
  runInfo: $('run-info'),
  runProgress: $('run-progress'),
  results: $('results'),
  stemResults: $('stem-results'),
  downloadAll: $('download-all'),
  showFolder: $('show-folder'),
  downloadInfo: $('download-info'),
  error: $('error'),
};

let modelReady = false;
let downloading = null; // AbortController khi đang tải model
let downloadProgress = null; // { got, total }
let busy = false;
let cancelled = false;
let client = null; // worker AI, giữ session giữa các lần tách
let loaded = null; // { requested, backend, threads }
let gpu = false;
let latestRecording = null; // { file, stamp, seconds }
let selectedFile = null;
let outputs = null; // { baseName, stems: [{name, blob, url}] }
let lastDownloadId = null;
// Các thông báo được giữ dạng {key, params} để dịch lại khi đổi ngôn ngữ.
let runNote = null;
let downloadNote = null;
let lastError = null;

const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pad = (n) => String(n).padStart(2, '0');
/** Thời gian địa phương, an toàn cho tên thư mục: 2026-11-18 14-05-09 */
const localStamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const safeName = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 80) || 'audio';
const note = (key, params = {}) => ({ key, params });
const say = (n) => (n ? t(n.key, n.params) : '');

function setProgress(el, ratio) {
  el.hidden = ratio == null;
  if (ratio != null) el.firstElementChild.style.width = `${Math.round(ratio * 100)}%`;
}
function showError(err) {
  lastError = err ?? null;
  els.error.hidden = !err;
  els.error.textContent = err ? translateError(err) : '';
  if (err) console.error(err);
}
const source = () => document.querySelector('input[name="source"]:checked')?.value;
const hasSource = () => (source() === 'recording' ? !!latestRecording : !!selectedFile);
const engineLabel = () =>
  loaded?.backend === 'webgpu' ? 'WebGPU' : t('aipage.engineCpu', { n: loaded?.threads ?? 1 });

function setStep(el, done, n) {
  el.classList.toggle('done', done);
  el.textContent = done ? '✓' : n;
}

/** Trạng thái nút "Tách bằng AI" + lý do khi bị khóa. */
function updateRun() {
  setStep(els.stepModel, modelReady, '1');
  setStep(els.stepSource, hasSource(), '2');
  els.run.disabled = busy || !modelReady || !hasSource() || !!downloading;
  els.run.hidden = busy;
  els.cancel.hidden = !busy;
  els.backend.disabled = busy;
  if (!busy) {
    els.runInfo.textContent = !modelReady ? t('aipage.needModel') : !hasSource() ? t('aipage.needSource') : say(runNote);
  }
}

// ---------- 1. model ----------
function renderModel() {
  els.modelStatus.textContent = downloadProgress
    ? t('aipage.downloading', {
        got: mb(downloadProgress.got),
        total: mb(downloadProgress.total),
        pct: Math.round((downloadProgress.got / downloadProgress.total) * 100),
      })
    : t(modelReady ? 'aipage.modelReady' : 'aipage.modelNeeded', { size: mb(MODEL.bytes) });
  els.modelDownload.hidden = modelReady || !!downloading;
  els.modelCancel.hidden = !downloading;
  els.modelDelete.hidden = !modelReady || busy;
  els.modelSource.textContent =
    `${t('aipage.modelName')} · huggingface.co/timcsy/demucs-web-onnx @ ${MODEL.revision.slice(0, 7)} · SHA-256 ${MODEL.sha256.slice(0, 12)}…`;
  updateRun();
}

async function refreshModel() {
  modelReady = (await modelInfo()).cached;
  renderModel();
}

els.modelDownload.addEventListener('click', async () => {
  showError(null);
  downloading = new AbortController();
  downloadProgress = { got: 0, total: MODEL.bytes };
  renderModel();
  try {
    await downloadModel({
      signal: downloading.signal,
      onProgress: (got, total) => {
        downloadProgress = { got, total };
        setProgress(els.modelProgress, got / total);
        renderModel();
      },
    });
  } catch (err) {
    if (err.name !== 'AbortError') showError(err);
  } finally {
    downloading = null;
    downloadProgress = null;
    setProgress(els.modelProgress, null);
    await refreshModel();
  }
});
els.modelCancel.addEventListener('click', () => downloading?.abort());

// Xác nhận bằng 2 lần bấm (không dùng hộp thoại confirm chặn trang).
let deleteArmed = null;
function disarmDelete() {
  clearTimeout(deleteArmed);
  deleteArmed = null;
  els.modelDelete.textContent = t('aipage.deleteModel');
}
els.modelDelete.addEventListener('click', async () => {
  if (!deleteArmed) {
    els.modelDelete.textContent = t('aipage.deleteConfirm');
    deleteArmed = setTimeout(disarmDelete, 3000);
    return;
  }
  disarmDelete();
  client?.terminate();
  client = null;
  loaded = null;
  await deleteModel();
  await refreshModel();
});

// ---------- 2. nguồn ----------
function renderSource() {
  els.choiceRecording.hidden = !latestRecording;
  if (latestRecording) {
    const { file, stamp, seconds } = latestRecording;
    els.recordingInfo.textContent = `${new Date(stamp).toLocaleString(locale())} · ${fmtTime(seconds)} · ${mb(file.size)}`;
  }
  els.fileInfo.textContent = selectedFile ? `${selectedFile.name} · ${mb(selectedFile.size)}` : t('aipage.noFile');
}

async function refreshRecordings() {
  const mix = (await listRecordings()).find((r) => r.track === 'mix');
  latestRecording = null;
  if (mix) {
    const h = new DataView(await mix.file.slice(0, 44).arrayBuffer());
    const bytesPerSecond = h.getUint32(28, true);
    latestRecording = { file: mix.file, stamp: mix.stamp, seconds: bytesPerSecond ? (mix.file.size - 44) / bytesPerSecond : 0 };
  }
  document.querySelector(`input[name="source"][value="${mix ? 'recording' : 'file'}"]`).checked = true;
  renderSource();
  updateRun();
}

function selectFile(file) {
  if (!file) return;
  selectedFile = file;
  document.querySelector('input[name="source"][value="file"]').checked = true;
  renderSource();
  updateRun();
}

for (const r of document.querySelectorAll('input[name="source"]')) r.addEventListener('change', updateRun);
els.file.addEventListener('change', () => selectFile(els.file.files[0]));
// Kéo thả: thả ở bất kỳ đâu trên trang.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  els.drop.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.drop.classList.remove('dragging');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.drop.classList.remove('dragging');
  const file = [...(e.dataTransfer?.files ?? [])].find(
    (f) => f.type.startsWith('audio/') || /\.(wav|mp3|flac|ogg|m4a|aac|opus)$/i.test(f.name),
  );
  if (file) selectFile(file);
  else if (e.dataTransfer?.files.length) showError(capoError('notAudio'));
});

// ---------- 3. tách ----------
function clearOutputs() {
  for (const s of outputs?.stems ?? []) URL.revokeObjectURL(s.url);
  outputs = null;
  downloadNote = null;
  els.results.hidden = true;
  els.stemResults.replaceChildren();
  els.downloadInfo.textContent = '';
  els.showFolder.hidden = true;
}

function renderOutputs() {
  if (!outputs) return;
  els.stemResults.replaceChildren(
    ...outputs.stems.map((s) => {
      const row = Object.assign(document.createElement('div'), { className: 'stem' });
      const name = Object.assign(document.createElement('strong'), { textContent: t(`stem.${s.name}`) });
      const audio = Object.assign(document.createElement('audio'), { controls: true, src: s.url, preload: 'metadata' });
      audio.setAttribute('aria-label', t('aipage.preview', { stem: t(`stem.${s.name}`) }));
      // Chỉ phát một lớp tại một thời điểm.
      audio.addEventListener('play', () => {
        for (const other of els.stemResults.querySelectorAll('audio')) if (other !== audio) other.pause();
      });
      const btn = Object.assign(document.createElement('button'), { textContent: t('aipage.downloadOne') });
      btn.addEventListener('click', () => download([s]));
      row.append(name, audio, btn);
      return row;
    }),
  );
  els.downloadInfo.textContent = say(downloadNote);
  els.results.hidden = false;
}

async function download(stems) {
  try {
    const folder = `CAPO/AI/${outputs.baseName} ${localStamp()}`;
    for (const s of stems) {
      lastDownloadId = await chrome.downloads.download({ url: s.url, filename: `${folder}/${s.name}.wav`, conflictAction: 'uniquify' });
    }
    downloadNote = note('aipage.saved', { n: stems.length, folder });
    els.downloadInfo.textContent = say(downloadNote);
    els.showFolder.hidden = false;
  } catch (err) {
    showError(err);
  }
}
els.downloadAll.addEventListener('click', () => download(outputs.stems));
els.showFolder.addEventListener('click', () => lastDownloadId != null && chrome.downloads.show(lastDownloadId));

els.cancel.addEventListener('click', () => {
  cancelled = true;
  client?.terminate(); // dừng ngay cả khi đang ở giữa một đoạn
  client = null;
  loaded = null;
});

els.run.addEventListener('click', async () => {
  showError(null);
  busy = true;
  cancelled = false;
  runNote = null;
  els.modelDelete.hidden = true;
  updateRun();
  clearOutputs();
  setStep(els.stepRun, false, '3');
  try {
    let buffer, baseName;
    if (source() === 'recording') {
      buffer = await latestRecording.file.arrayBuffer();
      baseName = t('aipage.recordingName', { stamp: localStamp(new Date(latestRecording.stamp)) });
    } else {
      buffer = await selectedFile.arrayBuffer();
      baseName = safeName(selectedFile.name.replace(/\.[^.]+$/, ''));
    }
    els.runInfo.textContent = t('aipage.decoding');
    const audio = await decodeForAi(buffer);
    buffer = null;

    const backend = els.backend.value;
    client ??= createAiClient();
    if (loaded?.requested !== backend) {
      els.runInfo.textContent = t('aipage.loading');
      loaded = { requested: backend, ...(await client.load(backend)) };
    }

    const t0 = performance.now();
    setProgress(els.runProgress, 0.01);
    els.runInfo.textContent = t('aipage.separating', { dur: fmtTime(audio.seconds), engine: engineLabel() });
    // Tách trong worker: trang vẫn phản hồi; mảng âm thanh được chuyển sang worker (không copy).
    const blobs = await client.separate(audio.left, audio.right, ({ progress, currentSegment, totalSegments }) => {
      setProgress(els.runProgress, Math.max(0.01, progress));
      const elapsed = (performance.now() - t0) / 1000;
      const eta = progress > 0 ? elapsed / progress - elapsed : 0;
      els.runInfo.textContent = t('aipage.progress', {
        engine: engineLabel(),
        i: currentSegment,
        n: totalSegments,
        eta: fmtTime(eta),
      });
    });
    const seconds = (performance.now() - t0) / 1000;
    runNote = note('aipage.done', {
      dur: fmtTime(audio.seconds),
      time: fmtTime(seconds),
      x: (audio.seconds / seconds).toFixed(1),
      engine: engineLabel(),
    });
    setStep(els.stepRun, true, '3');

    outputs = { baseName, stems: AI_STEMS.map((name) => ({ name, blob: blobs[name], url: URL.createObjectURL(blobs[name]) })) };
    renderOutputs();
  } catch (err) {
    if (cancelled) runNote = note('aipage.stopped');
    else showError(err);
  } finally {
    setProgress(els.runProgress, null);
    busy = false;
    await refreshModel();
  }
});

// Đang tách mà đóng tab → hỏi lại (tránh mất công xử lý dài).
window.addEventListener('beforeunload', (e) => {
  if (busy || downloading) e.preventDefault();
});

// ---------- ngôn ngữ ----------
function renderAll() {
  applyI18n();
  els.language.value = getLanguage();
  if (deleteArmed) disarmDelete();
  els.gpuInfo.textContent = t(gpu ? 'aipage.gpuYes' : 'aipage.gpuNo');
  renderModel();
  renderSource();
  renderOutputs();
  if (lastError) showError(lastError);
}

// ---------- khởi động ----------
async function init() {
  await loadLanguage();
  bindLanguageSelect(els.language);
  onLanguageChange(renderAll);
  applyI18n();
  gpu = await webgpuAvailable();
  renderAll();
  await refreshModel();
  await refreshRecordings();
}

init().catch(showError);
