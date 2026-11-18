// Đa ngôn ngữ cho giao diện CAPO (popup, trang AI). Mặc định: tiếng Anh.
// Không dùng chrome.i18n vì nó luôn theo ngôn ngữ trình duyệt — ở đây người dùng tự chọn trong Tùy chọn.
//
//   t('key', { name: 'x', n: 2 })  — thay {name}; nếu n === 1 và có 'key_one' thì dùng bản số ít.
//   <el data-i18n="key">, data-i18n-title, data-i18n-aria-label  — applyI18n() điền chữ vào DOM.
//   Lỗi đi qua message dưới dạng chuỗi → dùng mã: capoError('notActive') → "capo:notActive",
//   giao diện dịch bằng translateError().

export const DEFAULT_LANGUAGE = 'en';
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'vi', label: 'Tiếng Việt' },
];

const DICT = {
  en: {
    // ----- popup -----
    'pill.off': 'Off',
    'pill.running': 'Running · {ms} ms',
    'pill.recording': 'Recording {time}',
    'pill.title': 'Audio delay vs. video (processing + device)',
    'power.on': 'Turn on',
    'power.off': 'Turn off',
    'power.starting': 'Starting…',
    'power.titleOn': 'Turn CAPO on for this tab',
    'power.titleOff': 'Turn CAPO off for this tab (original audio)',
    'pitch.section': 'Transpose',
    'pitch.down': 'Down 1 semitone',
    'pitch.downTitle': 'Down 1 semitone (key −)',
    'pitch.up': 'Up 1 semitone',
    'pitch.upTitle': 'Up 1 semitone (key +)',
    'pitch.slider': 'Semitones',
    'pitch.unit': 'semitones',
    'pitch.unit_one': 'semitone',
    'pitch.fine': 'Fine-tune',
    'pitch.cents': 'cents',
    'pitch.reset': 'Reset',
    'pitch.resetTitle': 'Back to the original key (key 0)',
    'stems.section': 'Stem separation',
    'stems.title': 'Stem separation',
    'stems.subtitle': '4 stems · adds ≈85 ms latency',
    'stems.volume': 'Volume',
    'stems.mute': 'Mute',
    'stems.muteTitle': 'Mute',
    'stems.solo': 'Solo',
    'stems.soloTitle': 'Listen to this stem only',
    'stems.key': 'Key',
    'stems.keyTitle': 'Transpose this stem',
    'stems.monoWarning': '⚠ Nearly mono track — the vocal stem will include other instruments.',
    'stem.drums': 'Drums',
    'stem.bass': 'Bass',
    'stem.vocals': 'Vocals',
    'stem.other': 'Other',
    'stem.volumeAria': '{stem} volume',
    'stem.gainTitle': 'Double-click to reset to 100%',
    'stem.muteBtn': 'Mute {stem}',
    'stem.soloBtn': 'Solo {stem}',
    'stem.transposeBtn': 'Transpose {stem} with the main slider',
    'record.label': 'Record stems',
    'record.stop': 'Stop & save {time}',
    'record.titleStems': 'Record the mix and 4 stems to WAV',
    'record.titleMix': 'Record the mix to WAV (turn on stem separation to record each stem)',
    'record.titleOff': 'Turn CAPO on before recording',
    'record.saving': 'Saving files…',
    'record.saved': 'Saved {n} files ({mb} MB) to Downloads/{folder}.',
    'record.saved_one': 'Saved 1 file ({mb} MB) to Downloads/{folder}.',
    'ai.open': '✦ AI separation…',
    'ai.openTitle': 'High-quality stem separation with AI, from a recording or an audio file',
    'opt.title': 'Options',
    'opt.language': 'Language',
    'opt.mode': 'Processing mode',
    'opt.mode.default': 'High quality',
    'opt.mode.lowLatency': 'Low latency (for video)',
    'opt.mode.cheaper': 'Save CPU (pitch shift only)',
    'opt.formant': 'Preserve formants — vocals sound less "chipmunk"',
    'opt.center': 'Vocal focus',
    'opt.centerHint': 'Higher: cleaner vocal stem, but some vocals may leak into other stems.',
    'footer.shortcuts': 'Shortcuts: Alt+Shift+↑ / ↓ / 0 · in popup: + / − / 0',
    'msg.turnedOff': 'Turned off — the tab plays its original audio.',

    // ----- trang AI -----
    'aipage.lead':
      'Split a song into 4 stems — drums, bass, vocals, other — with the HTDemucs model. Higher quality than real-time mode, but it processes the whole track at once. Your audio never leaves your computer.',
    'aipage.model': 'Model',
    'aipage.checking': 'Checking…',
    'aipage.modelReady': 'Ready — saved on this computer ({size}), works offline.',
    'aipage.modelNeeded': 'One-time download of {size} from Hugging Face, then it works offline.',
    'aipage.downloading': 'Downloading… {got} / {total} ({pct}%)',
    'aipage.download': 'Download model (181 MB)',
    'aipage.cancel': 'Cancel',
    'aipage.deleteModel': 'Delete model',
    'aipage.deleteConfirm': 'Click again to delete',
    'aipage.modelName': 'HTDemucs (Meta), ONNX build from demucs-web',
    'aipage.source': 'Audio source',
    'aipage.sourceGroup': 'Audio source',
    'aipage.latestRecording': 'Latest CAPO recording',
    'aipage.audioFile': 'Audio file',
    'aipage.noFile': 'No file selected',
    'aipage.drop': 'Drag & drop a file here or',
    'aipage.choose': 'choose a file…',
    'aipage.formats': 'MP3, WAV, FLAC, OGG, M4A…',
    'aipage.separate': 'Separate',
    'aipage.processor': 'Processor',
    'aipage.auto': 'Auto (WebGPU if available)',
    'aipage.cpu': 'CPU (WASM)',
    'aipage.gpuYes': 'WebGPU available — this will be fast.',
    'aipage.gpuNo': 'No WebGPU — runs on the CPU and may take a few minutes per minute of music.',
    'aipage.run': 'Separate with AI',
    'aipage.stop': 'Stop',
    'aipage.needModel': 'Download the model in step 1.',
    'aipage.needSource': 'Choose an audio source in step 2.',
    'aipage.decoding': 'Decoding audio…',
    'aipage.loading': 'Loading the model…',
    'aipage.separating': 'Separating {dur} of audio with {engine}…',
    'aipage.progress': '{engine} · segment {i}/{n} · about {eta} left',
    'aipage.done': 'Done: {dur} of audio in {time} ({x}× real time, {engine}).',
    'aipage.stopped': 'Stopped.',
    'aipage.engineCpu': 'CPU ({n} threads)',
    'aipage.engineCpu_one': 'CPU (1 thread)',
    'aipage.results': 'Results',
    'aipage.downloadAll': 'Download all (WAV)',
    'aipage.showFolder': 'Show in folder',
    'aipage.downloadOne': 'Download',
    'aipage.saved': 'Saved {n} files to Downloads/{folder}',
    'aipage.saved_one': 'Saved 1 file to Downloads/{folder}',
    'aipage.preview': 'Preview {stem}',
    'aipage.recordingName': 'Recording {stamp}',
    'aipage.error': 'Error: {msg}',

    // ----- lỗi -----
    'error.generic': 'Error: {msg}',
    'error.noResponse': 'No response from the service worker.',
    'error.chromePage': "Can't capture audio on this page (chrome:// pages, Chrome Web Store…).",
    'error.activeStream': 'This tab is already being captured by another extension or app.',
    'error.startCapture': "Chrome couldn't capture this tab. Reload the page and try again.",
    'error.notActive': "CAPO isn't on for this tab.",
    'error.enableBeforeRecording': 'Turn CAPO on for this tab before recording.',
    'error.alreadyRecording': 'Already recording.',
    'error.notRecording': 'Not recording.',
    'error.recordingFinished': 'This recording has already finished.',
    'error.modelHttp': 'Model download failed: HTTP {status}.',
    'error.modelMismatch': "The downloaded model doesn't match ({bytes} bytes, SHA-256 {sha}…) — it was deleted.",
    'error.modelMissing': 'The model has not been downloaded yet.',
    'error.noWebgpu': "This browser/GPU doesn't support WebGPU.",
    'error.modelNotLoaded': 'The model is not loaded.',
    'error.workerFailed': 'The AI worker crashed.',
    'error.workerStopped': 'The AI worker was stopped.',
    'error.notAudio': "That file isn't an audio file.",
  },

  vi: {
    'pill.off': 'Chưa bật',
    'pill.running': 'Đang chạy · {ms} ms',
    'pill.recording': 'Đang ghi {time}',
    'pill.title': 'Độ trễ âm thanh so với hình (xử lý + thiết bị)',
    'power.on': 'Bật',
    'power.off': 'Tắt',
    'power.starting': 'Đang bật…',
    'power.titleOn': 'Bật CAPO trên tab này',
    'power.titleOff': 'Tắt CAPO trên tab này (âm thanh gốc)',
    'pitch.section': 'Đổi tông',
    'pitch.down': 'Giảm 1 bán cung',
    'pitch.downTitle': 'Giảm 1 bán cung (phím −)',
    'pitch.up': 'Tăng 1 bán cung',
    'pitch.upTitle': 'Tăng 1 bán cung (phím +)',
    'pitch.slider': 'Bán cung',
    'pitch.unit': 'bán cung',
    'pitch.fine': 'Tinh chỉnh',
    'pitch.cents': 'cent',
    'pitch.reset': 'Về 0',
    'pitch.resetTitle': 'Về tông gốc (phím 0)',
    'stems.section': 'Tách lớp nhạc cụ',
    'stems.title': 'Tách lớp nhạc cụ',
    'stems.subtitle': '4 lớp · thêm ≈85 ms trễ',
    'stems.volume': 'Âm lượng',
    'stems.mute': 'Mute',
    'stems.muteTitle': 'Tắt tiếng',
    'stems.solo': 'Solo',
    'stems.soloTitle': 'Chỉ nghe lớp này',
    'stems.key': 'Tông',
    'stems.keyTitle': 'Đổi tông lớp này',
    'stems.monoWarning': '⚠ Bài gần như mono — lớp giọng sẽ lẫn nhạc cụ.',
    'stem.drums': 'Trống',
    'stem.bass': 'Bass',
    'stem.vocals': 'Giọng hát',
    'stem.other': 'Nhạc cụ khác',
    'stem.volumeAria': 'Âm lượng {stem}',
    'stem.gainTitle': 'Nhấp đúp để về 100%',
    'stem.muteBtn': 'Tắt tiếng {stem}',
    'stem.soloBtn': 'Chỉ nghe {stem}',
    'stem.transposeBtn': 'Đổi tông {stem} theo thanh trượt chính',
    'record.label': 'Ghi các lớp',
    'record.stop': 'Dừng & lưu {time}',
    'record.titleStems': 'Ghi bản mix và 4 lớp ra file WAV',
    'record.titleMix': 'Ghi bản mix ra file WAV (bật "Tách lớp" để ghi từng lớp)',
    'record.titleOff': 'Bật CAPO trước khi ghi',
    'record.saving': 'Đang lưu file…',
    'record.saved': 'Đã lưu {n} file ({mb} MB) vào Downloads/{folder}.',
    'ai.open': '✦ Tách bằng AI…',
    'ai.openTitle': 'Tách lớp chất lượng cao bằng AI trên bản ghi hoặc file âm thanh',
    'opt.title': 'Tùy chọn',
    'opt.language': 'Ngôn ngữ',
    'opt.mode': 'Chế độ xử lý',
    'opt.mode.default': 'Chất lượng cao',
    'opt.mode.lowLatency': 'Độ trễ thấp (xem video)',
    'opt.mode.cheaper': 'Tiết kiệm CPU (phần đổi tông)',
    'opt.formant': 'Giữ formant — giọng hát đỡ bị "méo"/"chipmunk"',
    'opt.center': 'Độ hẹp vùng giọng hát',
    'opt.centerHint': 'Cao hơn: lớp giọng sạch hơn nhưng có thể sót giọng sang lớp khác.',
    'footer.shortcuts': 'Phím tắt: Alt+Shift+↑ / ↓ / 0 · trong popup: + / − / 0',
    'msg.turnedOff': 'Đã tắt — tab phát lại âm thanh gốc.',

    'aipage.lead':
      'Tách bài hát thành 4 lớp — trống, bass, giọng hát, nhạc cụ khác — bằng mô hình HTDemucs. Chất lượng cao hơn chế độ realtime, nhưng xử lý cả bài một lần. Âm thanh không rời khỏi máy bạn.',
    'aipage.model': 'Model',
    'aipage.checking': 'Đang kiểm tra…',
    'aipage.modelReady': 'Sẵn sàng — đã lưu trên máy ({size}), dùng được offline.',
    'aipage.modelNeeded': 'Cần tải một lần {size} từ Hugging Face, sau đó dùng offline.',
    'aipage.downloading': 'Đang tải… {got} / {total} ({pct}%)',
    'aipage.download': 'Tải model (181 MB)',
    'aipage.cancel': 'Hủy',
    'aipage.deleteModel': 'Xóa model',
    'aipage.deleteConfirm': 'Bấm lần nữa để xóa',
    'aipage.modelName': 'HTDemucs (Meta), bản ONNX của demucs-web',
    'aipage.source': 'Nguồn âm thanh',
    'aipage.sourceGroup': 'Nguồn âm thanh',
    'aipage.latestRecording': 'Bản ghi CAPO gần nhất',
    'aipage.audioFile': 'File âm thanh',
    'aipage.noFile': 'Chưa chọn file',
    'aipage.drop': 'Kéo thả file vào đây hoặc',
    'aipage.choose': 'chọn file…',
    'aipage.formats': 'MP3, WAV, FLAC, OGG, M4A…',
    'aipage.separate': 'Tách lớp',
    'aipage.processor': 'Bộ xử lý',
    'aipage.auto': 'Tự động (WebGPU nếu có)',
    'aipage.cpu': 'CPU (WASM)',
    'aipage.gpuYes': 'Có WebGPU — sẽ nhanh.',
    'aipage.gpuNo': 'Không có WebGPU — sẽ chạy bằng CPU, có thể mất vài phút cho mỗi phút nhạc.',
    'aipage.run': 'Tách bằng AI',
    'aipage.stop': 'Dừng',
    'aipage.needModel': 'Cần tải model ở bước 1.',
    'aipage.needSource': 'Chọn nguồn âm thanh ở bước 2.',
    'aipage.decoding': 'Đang giải mã âm thanh…',
    'aipage.loading': 'Đang nạp model vào bộ xử lý…',
    'aipage.separating': 'Đang tách {dur} âm thanh bằng {engine}…',
    'aipage.progress': '{engine} · đoạn {i}/{n} · còn khoảng {eta}',
    'aipage.done': 'Xong: {dur} âm thanh trong {time} ({x}× realtime, {engine}).',
    'aipage.stopped': 'Đã dừng.',
    'aipage.engineCpu': 'CPU ({n} luồng)',
    'aipage.results': 'Kết quả',
    'aipage.downloadAll': 'Tải tất cả (WAV)',
    'aipage.showFolder': 'Mở thư mục',
    'aipage.downloadOne': 'Tải',
    'aipage.saved': 'Đã lưu {n} file vào Downloads/{folder}',
    'aipage.preview': 'Nghe thử {stem}',
    'aipage.recordingName': 'Bản ghi {stamp}',
    'aipage.error': 'Lỗi: {msg}',

    'error.generic': 'Lỗi: {msg}',
    'error.noResponse': 'Không có phản hồi từ service worker.',
    'error.chromePage': 'Không thể bắt âm thanh của trang này (trang chrome://, Chrome Web Store…).',
    'error.activeStream': 'Tab đang bị một extension/ứng dụng khác capture.',
    'error.startCapture': 'Chrome không bắt được âm thanh tab này. Thử tải lại trang rồi bật lại.',
    'error.notActive': 'CAPO chưa được bật trên tab này.',
    'error.enableBeforeRecording': 'Hãy bật CAPO trên tab này trước khi ghi.',
    'error.alreadyRecording': 'Đang ghi rồi.',
    'error.notRecording': 'Chưa ghi.',
    'error.recordingFinished': 'Bản ghi đã kết thúc.',
    'error.modelHttp': 'Tải model thất bại: HTTP {status}.',
    'error.modelMismatch': 'File model không khớp ({bytes} byte, SHA-256 {sha}…) — đã xóa.',
    'error.modelMissing': 'Chưa tải model.',
    'error.noWebgpu': 'Trình duyệt/GPU này không hỗ trợ WebGPU.',
    'error.modelNotLoaded': 'Chưa nạp model.',
    'error.workerFailed': 'Worker AI bị lỗi.',
    'error.workerStopped': 'Worker AI đã dừng.',
    'error.notAudio': 'File thả vào không phải file âm thanh.',
  },
};

let lang = DEFAULT_LANGUAGE;

export const getLanguage = () => lang;
/** Locale cho định dạng ngày giờ/số. */
export const locale = () => (lang === 'vi' ? 'vi-VN' : 'en-US');

function setLocal(code) {
  lang = DICT[code] ? code : DEFAULT_LANGUAGE;
  return lang;
}

/** Đọc ngôn ngữ đã chọn (chrome.storage.local, khóa "language"). */
export async function loadLanguage() {
  try {
    const { language } = await chrome.storage.local.get('language');
    return setLocal(language);
  } catch {
    return setLocal(DEFAULT_LANGUAGE);
  }
}

export async function saveLanguage(code) {
  setLocal(code);
  await chrome.storage.local.set({ language: lang });
  return lang;
}

/** Gọi `cb(lang)` khi ngôn ngữ đổi ở bất kỳ trang nào của extension. */
export function onLanguageChange(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.language) cb(setLocal(changes.language.newValue));
  });
}

export function t(key, params = {}) {
  const dict = DICT[lang];
  const template =
    (params.n === 1 && (dict[`${key}_one`] ?? DICT.en[`${key}_one`])) || dict[key] || DICT.en[key] || key;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/** Điền chữ cho các phần tử có data-i18n / data-i18n-title / data-i18n-aria-label. */
export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
}

/** <select> chọn ngôn ngữ: điền lựa chọn, lưu khi đổi. */
export function bindLanguageSelect(select) {
  select.replaceChildren(...LANGUAGES.map((l) => new Option(l.label, l.code)));
  select.value = lang;
  select.addEventListener('change', () => saveLanguage(select.value));
}

// ---------- lỗi có mã (dịch được ở giao diện) ----------
const ERROR_PREFIX = 'capo:';

/** Error có message dạng "capo:<code>[:<json params>]" — đi qua chrome.runtime message mà vẫn dịch được. */
export function capoError(code, params) {
  return new Error(`${ERROR_PREFIX}${code}${params ? `:${JSON.stringify(params)}` : ''}`);
}

export function translateError(err) {
  const msg = String(err?.message ?? err ?? '');
  const m = /^capo:([\w.]+)(?::([\s\S]*))?$/.exec(msg);
  if (m) {
    let params = {};
    try {
      params = m[2] ? JSON.parse(m[2]) : {};
    } catch {}
    return t(`error.${m[1]}`, params);
  }
  // Lỗi do Chrome trả về.
  if (/Chrome pages|chrome:\/\/|cannot be captured|Extension has not been invoked/i.test(msg)) return t('error.chromePage');
  if (/active stream/i.test(msg)) return t('error.activeStream');
  if (/Error starting tab capture/i.test(msg)) return t('error.startCapture');
  return t('error.generic', { msg });
}

/** Cho test: mọi khóa đều có ở mọi ngôn ngữ (bản _one là tùy chọn). */
export function missingKeys() {
  const out = {};
  const base = Object.keys(DICT.en).filter((k) => !k.endsWith('_one'));
  for (const code of Object.keys(DICT)) out[code] = base.filter((k) => !(k in DICT[code]));
  return out;
}
