import { applyI18n, bindLanguageSelect, capoError, getLanguage, loadLanguage, onLanguageChange, t, translateError } from './i18n.js';
import { STEM_NAMES, effectiveGains, mergeOptions } from './presets.js';

const $ = (id) => document.getElementById(id);
const els = {
  title: $('tab-title'),
  pill: $('pill'),
  pillText: $('pill-text'),
  power: $('power'),
  message: $('message'),
  value: $('value'),
  unit: $('unit'),
  semis: $('semis'),
  cents: $('cents'),
  centsValue: $('cents-value'),
  up: $('up'),
  down: $('down'),
  reset: $('reset'),
  separate: $('separate'),
  stemList: $('stem-list'),
  monoWarning: $('mono-warning'),
  record: $('record'),
  recordLabel: $('record-label'),
  openAi: $('open-ai'),
  quality: $('quality'),
  formant: $('formant'),
  center: $('center'),
  centerValue: $('center-value'),
  language: $('language'),
};

let tabId = null;
let active = false;
let starting = false;
let recording = false;
let lastState = { active: false };
let options = mergeOptions();
const stemEls = {};

async function send(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ target: 'background', type, tabId, ...extra });
  if (!res?.ok) throw res?.error ? new Error(res.error) : capoError('noResponse');
  return res.result;
}

const currentValue = () => Number(els.semis.value) + Number(els.cents.value) / 100;

function formatValue(v) {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  return (v > 0 ? '+' : '−') + (Number.isInteger(abs) ? abs : abs.toFixed(2));
}

function formatTime(s) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function showValue(v) {
  els.value.textContent = formatValue(v);
  els.value.className = v > 0 ? 'up' : v < 0 ? 'down' : '';
  els.unit.textContent = t('pitch.unit', { n: Math.abs(v) });
  const c = Number(els.cents.value);
  els.centsValue.textContent = c > 0 ? `+${c}` : c < 0 ? `−${-c}` : '0';
}

// ---------- thông báo ----------
let messageTimer = null;
function showMessage(text, kind = 'info') {
  clearTimeout(messageTimer);
  els.message.hidden = !text;
  els.message.textContent = text || '';
  els.message.classList.toggle('error', kind === 'error');
  if (text && kind !== 'error') messageTimer = setTimeout(() => (els.message.hidden = true), 8000);
}
const clearError = () => els.message.classList.contains('error') && showMessage('');

const explain = translateError;

// ---------- các lớp nhạc cụ ----------
function buildStemRows() {
  for (const name of STEM_NAMES) {
    const row = Object.assign(document.createElement('div'), { className: 'stem-row' });
    const title = document.createElement('span');
    const gain = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 150, step: 5 });
    gain.setAttribute('list', 'gain-ticks');
    const value = Object.assign(document.createElement('span'), { className: 'gain-value' });
    const toggle = (cls, text) => {
      const b = Object.assign(document.createElement('button'), { className: `toggle ${cls}`, textContent: text });
      b.setAttribute('aria-pressed', 'false');
      return b;
    };
    const mute = toggle('mute', 'M');
    const solo = toggle('solo', 'S');
    const transpose = toggle('transpose', '♯');
    row.append(title, gain, value, mute, solo, transpose);
    els.stemList.append(row);
    stemEls[name] = { row, title, gain, value, mute, solo, transpose };

    gain.addEventListener('input', () => (value.textContent = `${gain.value}%`));
    gain.addEventListener('change', () => pushStem(name, { gain: Number(gain.value) / 100 }));
    gain.addEventListener('dblclick', () => {
      gain.value = 100;
      value.textContent = '100%';
      pushStem(name, { gain: 1 });
    });
    for (const [key, btn] of Object.entries({ mute, solo, transpose })) {
      btn.addEventListener('click', () => pushStem(name, { [key]: btn.getAttribute('aria-pressed') !== 'true' }));
    }
  }
  const ticks = Object.assign(document.createElement('datalist'), { id: 'gain-ticks' });
  ticks.append(Object.assign(document.createElement('option'), { value: 100 }));
  els.stemList.append(ticks);
  labelStemRows();
}

/** Nhãn/tooltip của các lớp theo ngôn ngữ hiện tại. */
function labelStemRows() {
  for (const name of STEM_NAMES) {
    const e = stemEls[name];
    const stem = t(`stem.${name}`);
    e.title.textContent = stem;
    e.title.title = stem;
    e.gain.setAttribute('aria-label', t('stem.volumeAria', { stem }));
    e.gain.title = t('stem.gainTitle');
    for (const [btn, key] of [[e.mute, 'stem.muteBtn'], [e.solo, 'stem.soloBtn'], [e.transpose, 'stem.transposeBtn']]) {
      btn.title = t(key, { stem });
      btn.setAttribute('aria-label', btn.title);
    }
  }
}

function renderOptions() {
  els.quality.value = options.quality;
  els.formant.checked = options.formant;
  els.separate.checked = options.separate;
  els.stemList.hidden = !options.separate;
  els.center.value = options.centerWidth;
  els.centerValue.textContent = options.centerWidth;
  const gains = effectiveGains(options.stems);
  for (const name of STEM_NAMES) {
    const s = options.stems[name];
    const e = stemEls[name];
    e.gain.value = Math.round(s.gain * 100);
    e.value.textContent = `${e.gain.value}%`;
    e.mute.setAttribute('aria-pressed', String(s.mute));
    e.solo.setAttribute('aria-pressed', String(s.solo));
    e.transpose.setAttribute('aria-pressed', String(s.transpose));
    e.row.classList.toggle('silent', gains[name] === 0);
  }
  renderWarning();
}

function renderWarning() {
  const ratio = lastState.stats?.centerRatio;
  els.monoWarning.hidden = !(options.separate && ratio != null && ratio > 0.97);
}

async function pushOptions(patch) {
  options = mergeOptions(options, patch);
  renderOptions();
  try {
    options = await send('set-options', { options: patch });
    renderOptions();
    if (active) renderLive(await send('get-state'));
  } catch (err) {
    showMessage(explain(err), 'error');
  }
}
const pushStem = (name, patch) => pushOptions({ stems: { [name]: patch } });

// ---------- trạng thái ----------
function render(state) {
  const semis = Math.round(state.semitones || 0);
  els.semis.value = semis;
  els.cents.value = Math.round(((state.semitones || 0) - semis) * 100);
  showValue(currentValue());
  renderLive(state);
}

/** Phần cập nhật định kỳ — không đụng tới thanh trượt người dùng có thể đang kéo. */
function renderLive(state) {
  lastState = state;
  active = !!state.active;
  recording = !!state.recording?.active;

  els.power.textContent = t(active ? 'power.off' : starting ? 'power.starting' : 'power.on');
  els.power.setAttribute('aria-pressed', String(active));
  els.power.disabled = starting;
  els.power.title = t(active ? 'power.titleOff' : 'power.titleOn');

  els.pill.classList.toggle('on', active);
  els.pill.classList.toggle('rec', recording);
  els.pillText.textContent = recording
    ? t('pill.recording', { time: formatTime(state.recording.seconds) })
    : active
      ? t('pill.running', { ms: state.latencyMs })
      : t('pill.off');
  els.pill.title = active ? t('pill.title') : '';

  els.record.disabled = !active;
  els.record.classList.toggle('recording', recording);
  els.recordLabel.textContent = recording ? t('record.stop', { time: formatTime(state.recording.seconds) }) : t('record.label');
  els.record.title = t(active ? (options.separate ? 'record.titleStems' : 'record.titleMix') : 'record.titleOff');
  els.reset.disabled = currentValue() === 0;
  renderWarning();
}

// Gộp các lần kéo slider: luôn gửi giá trị mới nhất, không gửi chồng chéo.
let inflight = false;
let queued = null;
async function pushPitch(v) {
  queued = v;
  if (inflight) return;
  inflight = true;
  try {
    while (queued !== null) {
      const value = queued;
      queued = null;
      if (!active) {
        starting = true;
        renderLive(lastState);
      }
      try {
        const state = await send('set-pitch', { semitones: value });
        clearError();
        starting = false;
        renderLive(state);
      } catch (err) {
        starting = false;
        renderLive(lastState);
        showMessage(explain(err), 'error');
      }
    }
  } finally {
    inflight = false;
    starting = false;
  }
}

function onPitchInput() {
  const v = currentValue();
  showValue(v);
  els.reset.disabled = v === 0;
  pushPitch(v);
}

function nudge(delta) {
  els.semis.value = Math.min(12, Math.max(-12, Number(els.semis.value) + delta));
  onPitchInput();
}

function resetPitch() {
  els.semis.value = 0;
  els.cents.value = 0;
  onPitchInput();
}

async function togglePower() {
  if (active) {
    try {
      render(await send('stop'));
      showMessage(t('msg.turnedOff'));
    } catch (err) {
      showMessage(explain(err), 'error');
    }
  } else {
    pushPitch(currentValue());
  }
}

async function toggleRecording() {
  els.record.disabled = true;
  try {
    if (recording) {
      showMessage(t('record.saving'));
      const res = await send('record-stop');
      renderLive(await send('get-state'));
      const mb = res.files.reduce((s, f) => s + f.bytes, 0) / 1e6;
      showMessage(t('record.saved', { n: res.files.length, mb: mb.toFixed(1), folder: res.folder }));
    } else {
      renderLive(await send('record-start'));
      clearError();
    }
  } catch (err) {
    showMessage(explain(err), 'error');
  } finally {
    els.record.disabled = !active;
  }
}

function onKey(e) {
  const t = e.target;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (t instanceof HTMLInputElement && t.type !== 'checkbox') return;
  if (t instanceof HTMLSelectElement) return;
  if (e.key === '+' || e.key === '=') nudge(+1);
  else if (e.key === '-' || e.key === '_') nudge(-1);
  else if (e.key === '0') resetPitch();
  else return;
  e.preventDefault();
}

async function init() {
  await loadLanguage();
  applyI18n();
  bindLanguageSelect(els.language);
  onLanguageChange(() => {
    els.language.value = getLanguage();
    applyI18n();
    labelStemRows();
    showValue(currentValue());
    renderLive(lastState);
  });
  buildStemRows();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  els.title.textContent = tab?.title || tab?.url || '';
  els.title.title = els.title.textContent;

  options = mergeOptions(undefined, await send('get-options'));
  renderOptions();
  render(await send('get-state'));

  els.semis.addEventListener('input', onPitchInput);
  els.cents.addEventListener('input', onPitchInput);
  els.cents.addEventListener('dblclick', () => {
    els.cents.value = 0;
    onPitchInput();
  });
  els.up.addEventListener('click', () => nudge(+1));
  els.down.addEventListener('click', () => nudge(-1));
  els.reset.addEventListener('click', resetPitch);
  els.power.addEventListener('click', togglePower);
  els.record.addEventListener('click', toggleRecording);
  els.openAi.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('ai.html') }));
  els.separate.addEventListener('change', () => pushOptions({ separate: els.separate.checked }));
  els.quality.addEventListener('change', () => pushOptions({ quality: els.quality.value }));
  els.formant.addEventListener('change', () => pushOptions({ formant: els.formant.checked }));
  els.center.addEventListener('input', () => (els.centerValue.textContent = els.center.value));
  els.center.addEventListener('change', () => pushOptions({ centerWidth: Number(els.center.value) }));
  document.addEventListener('keydown', onKey);

  // Đồng hồ ghi, độ trễ, cảnh báo mono.
  setInterval(async () => {
    if (!active) return;
    try {
      renderLive(await send('get-state'));
    } catch {}
  }, 1000);
}

init().catch((err) => showMessage(explain(err), 'error'));
