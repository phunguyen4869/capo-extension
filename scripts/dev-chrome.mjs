// Mở một cửa sổ Chrome dev (profile riêng) với CAPO đã được nạp sẵn.
// Dùng CDP Extensions.loadUnpacked (thay cho --load-extension, đã bị gỡ khỏi Chrome bản thường từ 137).
//
//   node scripts/dev-chrome.mjs [url]
//
// Script chạy tới khi bạn đóng cửa sổ Chrome đó. Biến môi trường:
//   CHROME          đường dẫn trình duyệt (mặc định: google-chrome)
//   CAPO_PROFILE    thư mục profile dev (mặc định: ~/.cache/capo-dev-chrome)

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || 'google-chrome';
const profile = process.env.CAPO_PROFILE || path.join(homedir(), '.cache', 'capo-dev-chrome');
const startUrl = process.argv[2] || 'https://www.youtube.com';

const chrome = spawn(
  CHROME,
  [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'chrome://extensions',
  ],
  // fd3: lệnh gửi vào Chrome, fd4: phản hồi từ Chrome
  { stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'] },
);

const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];
let buffer = '';
let nextId = 0;
const pending = new Map();

fromChrome.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
    toChrome.write(JSON.stringify({ id, method, params }) + '\0');
  });
}

chrome.on('exit', (code) => {
  console.log(`[capo] Chrome đã đóng (code ${code}).`);
  process.exit(0);
});

try {
  const { id } = await send('Extensions.loadUnpacked', { path: extDir });
  console.log(`[capo] Đã nạp extension từ ${extDir}`);
  console.log(`[capo] Extension ID: ${id}`);
  await send('Target.createTarget', { url: startUrl });
  console.log(`[capo] Profile dev: ${profile}`);
  console.log('[capo] Đóng cửa sổ Chrome này để kết thúc.');
} catch (err) {
  console.error('[capo] Không nạp được extension:', err.message);
  chrome.kill();
  process.exit(1);
}
