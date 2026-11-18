// Test end-to-end: bắt âm thanh của một tab THẬT (popup → service worker → tabCapture → offscreen → engine),
// bật tách lớp, đổi +2 bán cung, ghi 3 s, tải về, rồi đo tần số trong file mix trên đĩa.
//
//   node tests/capture-e2e.mjs        (cần google-chrome; biến CHROME để đổi trình duyệt)
//
// tabCapture bình thường cần người dùng bấm icon; ở đây dùng cờ --allowlisted-extension-id của Chrome
// để cho phép extension này capture mà không cần thao tác tay.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extDir = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
// ID của extension unpacked = sha256(đường dẫn tuyệt đối), 32 ký tự đầu đổi 0–f → a–p.
const extId = [...createHash('sha256').update(extDir).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');

const TONE_HZ = 440;
const SEMITONES = 2;

const server = createServer((_, res) =>
  res.writeHead(200, { 'content-type': 'text/html' }).end(
    `<title>tone</title><script>const c=new AudioContext();const o=c.createOscillator();` +
      `o.frequency.value=${TONE_HZ};const g=c.createGain();g.gain.value=0.5;o.connect(g).connect(c.destination);o.start();</script>`,
  ),
);
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const tmp = process.env.TMPDIR && process.env.TMPDIR.length < 40 ? process.env.TMPDIR : tmpdir();
const profile = mkdtempSync(path.join(tmp, 'capo-e2e-'));
const downloads = mkdtempSync(path.join(tmp, 'capo-e2e-dl-'));
const chrome = spawn(
  process.env.CHROME || 'google-chrome',
  [
    '--headless=new',
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--allowlisted-extension-id=${extId}`,
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
);

let buf = '';
let nextId = 0;
const pending = new Map();
chrome.stdio[4].on('data', (d) => {
  buf += d;
  let e;
  while ((e = buf.indexOf('\0')) >= 0) {
    const m = JSON.parse(buf.slice(0, e));
    buf = buf.slice(e + 1);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  }
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const i = ++nextId;
    pending.set(i, res);
    chrome.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + '\0');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
const check = (step, pass, detail = '') => rows.push({ step, pass, detail: String(detail).slice(0, 120) });

function dominantHz(samples, sr, from, to) {
  const seg = samples.subarray(from, to);
  const power = (f) => {
    const k = 2 * Math.cos((2 * Math.PI * f) / sr);
    let s1 = 0, s2 = 0;
    for (const v of seg) {
      const s0 = v + k * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 + s2 * s2 - k * s1 * s2;
  };
  let best = 100, bestP = -1;
  for (let f = 100; f <= 1500; f += 1) {
    const p = power(f);
    if (p > bestP) { bestP = p; best = f; }
  }
  for (let f = best - 1; f <= best + 1; f += 0.05) {
    const p = power(f);
    if (p > bestP) { bestP = p; best = f; }
  }
  return best;
}

let exitCode = 1;
try {
  const load = await cdp('Extensions.loadUnpacked', { path: extDir });
  if (load.error) throw new Error('loadUnpacked: ' + load.error.message);
  check('nạp extension', load.result.id === extId, load.result.id);
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });

  await cdp('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}/` });
  await sleep(1500);
  const { result: { targetId } } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const { result: { sessionId } } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await sleep(1000);

  const evaluate = async (body) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result.result.value;
  };
  // Tab có tiếng = tab được tạo ngay trước trang popup (extension không có quyền "tabs" để lọc theo tiêu đề).
  await evaluate(`
    const self = await chrome.tabs.getCurrent();
    const ids = (await chrome.tabs.query({})).map((t) => t.id).filter((i) => i !== self.id).sort((a, b) => a - b);
    window.__tabId = ids[ids.length - 1];
    window.__bg = async (type, extra = {}) => chrome.runtime.sendMessage({ target: 'background', type, tabId: window.__tabId, ...extra });
  `);

  const opt = await evaluate(`return await __bg('set-options', { options: { separate: true } });`);
  check('bật tách lớp', opt?.ok && opt.result.separate === true, opt?.error ?? '');

  const pitch = await evaluate(`return await __bg('set-pitch', { semitones: ${SEMITONES} });`);
  check('bắt âm thanh tab + đổi tông', pitch?.ok && pitch.result.active === true, pitch?.error ?? `trễ ${pitch?.result?.latencyMs} ms`);

  const rec = await evaluate(`return await __bg('record-start');`);
  check('bắt đầu ghi', rec?.ok && rec.result.recording?.active, rec?.error ?? '');
  await sleep(3000);
  const stopRec = await evaluate(`return await __bg('record-stop');`);
  check('dừng ghi + tải về', stopRec?.ok && stopRec.result.files.length === 5, stopRec?.error ?? stopRec?.result?.folder);

  if (stopRec?.ok) {
    await sleep(1500);
    const items = await evaluate(`
      const ids = ${JSON.stringify(stopRec.result.downloadIds)};
      const all = await chrome.downloads.search({});
      return ids.map((id) => all.find((d) => d.id === id)).map((d) => ({ filename: d.filename, state: d.state, bytes: d.fileSize }));
    `);
    const names = stopRec.result.files.map((f) => f.name);
    check('5 file tải xong', items.every((d) => d.state === 'complete'), items.map((d) => d.state).join(','));
    const mix = items[names.indexOf('mix')];
    const wav = readFileSync(mix.filename);
    const sr = wav.readUInt32LE(24);
    const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) >> 1);
    const left = Float32Array.from({ length: pcm.length >> 1 }, (_, i) => pcm[2 * i] / 32768);
    const expected = TONE_HZ * 2 ** (SEMITONES / 12);
    const measured = dominantHz(left, sr, Math.floor(left.length * 0.3), Math.floor(left.length * 0.9));
    const err = Math.abs(measured - expected) / expected;
    check('tần số trong mix.wav', err < 0.01, `${measured.toFixed(1)} Hz (mong đợi ${expected.toFixed(1)} Hz, ${(left.length / sr).toFixed(2)} s)`);
  }

  const stop = await evaluate(`return await __bg('stop');`);
  check('tắt', stop?.ok && stop.result.active === false, stop?.error ?? '');

  console.table(rows);
  const ok = rows.every((r) => r.pass);
  console.log(ok ? 'PASS' : 'FAIL');
  exitCode = ok ? 0 : 1;
} catch (err) {
  console.table(rows);
  console.error(err);
  exitCode = 2;
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
  process.exit(exitCode);
}
