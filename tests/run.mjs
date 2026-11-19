// Chạy tests/pitch-test.html trong Chrome headless qua DevTools Protocol.
// Dùng: node tests/run.mjs   (biến CHROME để đổi đường dẫn trình duyệt; ONLY=testA,testB để chạy vài test)

import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || 'google-chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

const server = createServer(async (req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const profile = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), 'capo-chrome-'));
const debugPort = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeLog = '';
chrome.stdout.on('data', (d) => (chromeLog += d));
chrome.stderr.on('data', (d) => (chromeLog += d));
chrome.on('exit', (code, sig) => (chromeLog += `\n[chrome exited code=${code} signal=${sig}]`));

async function cleanup(code) {
  chrome.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 300));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}

const devtools = `http://127.0.0.1:${debugPort}`;

/**
 * Mở tab mới (tiến trình renderer riêng), chạy tests/pitch-test.html?`query`, trả window.__result.
 * Mỗi test chạy trong tab riêng: OfflineAudioContext không đóng được, bộ nhớ WASM của worklet chỉ được trả khi
 * tiến trình kết thúc, mà một tiến trình chỉ chứa được ~125 WASM memory.
 */
async function runPage(query) {
  const target = await (await fetch(`${devtools}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      console.log('[page]', msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      console.log('[page exception]', msg.params.exceptionDetails.exception?.description);
    } else if (msg.method === 'Log.entryAdded') {
      console.log(`[page ${msg.params.entry.level}]`, msg.params.entry.text);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  try {
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/tests/pitch-test.html?${query}` });
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__result ?? null)', returnByValue: true });
      const result = JSON.parse(r.result?.result?.value ?? 'null');
      if (result) return result;
    }
    return { ok: false, error: `Hết thời gian chờ kết quả test (${query})`, sections: {} };
  } finally {
    ws.close();
    await fetch(`${devtools}/json/close/${target.id}`).catch(() => {});
  }
}

try {
  let lastErr;
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try {
      ready = (await fetch(`${devtools}/json/version`)).ok;
    } catch (e) {
      lastErr = e;
    }
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) {
    throw new Error(`Không kết nối được Chrome DevTools: ${lastErr?.cause?.message || lastErr}\n${chromeLog}`);
  }

  const { tests: all } = await runPage('list');
  const tests = process.env.ONLY ? all.filter((t) => process.env.ONLY.split(',').includes(t)) : all;
  let ok = true;
  for (const name of tests) {
    const result = await runPage(`only=${name}`);
    if (result.error) console.log(`ERROR (${name}):`, result.error);
    for (const [section, rows] of Object.entries(result.sections)) {
      console.log(`\n== ${section} ==`);
      console.table(rows);
    }
    ok &&= result.ok;
  }
  console.log(ok ? 'PASS' : 'FAIL');
  await cleanup(ok ? 0 : 1);
} catch (err) {
  console.error(err);
  await cleanup(2);
}
