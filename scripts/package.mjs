// Đóng gói CAPO thành file ZIP để chia sẻ / nộp Chrome Web Store.
//
//   node scripts/package.mjs            → dist/capo-<version>.zip
//
// - Chỉ lấy file cần khi chạy (bỏ dsp/, tests/, scripts/, docs/, README…).
// - Kiểm tra mọi file được tham chiếu (manifest, src/href trong HTML, import / new URL(...) trong JS)
//   đều có trong gói; thiếu là dừng.
// - Không cần thư viện ngoài: ghi ZIP bằng zlib (deflate + CRC32). Thời gian trong ZIP cố định
//   ⇒ cùng source cho ra cùng một file (so được SHA-256).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;

// ---------- chọn file ----------
const RUNTIME_DIRS = ['_locales', 'audio', 'icons', 'lib', 'wasm', 'workers', 'worklets'];
const ROOT_FILE = /^(manifest\.json|LICENSE|[\w-]+\.(html|js|css))$/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.posix.join(dir, name);
    if (name.startsWith('.')) continue;
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const files = [
  ...readdirSync(root).filter((n) => ROOT_FILE.test(n) && statSync(path.join(root, n)).isFile()),
  ...RUNTIME_DIRS.flatMap((d) => walk(d)),
].sort();
const included = new Set(files);

// ---------- kiểm tra tham chiếu ----------
const missing = [];
const need = (from, ref) => {
  if (!ref || /^(https?:|data:|chrome:|#|__MSG_)/.test(ref)) return;
  const clean = ref.split(/[?#]/)[0];
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
  // Tham chiếu thư mục (ví dụ wasmPaths của ORT): cần có ít nhất một file trong đó.
  const ok = clean.endsWith('/')
    ? files.some((f) => f.startsWith(target.replace(/\/?$/, '/')))
    : included.has(target);
  if (!ok) missing.push(`${from} → ${ref}`);
};
// manifest
const m = manifest;
for (const p of Object.values(m.icons ?? {})) need('manifest.json', p);
for (const p of Object.values(m.action?.default_icon ?? {})) need('manifest.json', p);
need('manifest.json', m.action?.default_popup);
need('manifest.json', m.background?.service_worker);
if (m.default_locale) need('manifest.json', `_locales/${m.default_locale}/messages.json`);
// HTML + JS
for (const f of files) {
  const text = /\.(html|js|mjs|css)$/.test(f) ? readFileSync(path.join(root, f), 'utf8') : '';
  if (f.endsWith('.html')) {
    for (const [, ref] of text.matchAll(/\s(?:src|href)="([^"]+)"/g)) need(f, ref);
  } else if (/\.m?js$/.test(f) && !f.startsWith('lib/onnxruntime-web/')) {
    // ORT tự nạp file theo wasmPaths (kiểm tra riêng bên dưới); bản min có chuỗi giống import.
    for (const [, ref] of text.matchAll(/(?:^|\s)(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) need(f, ref);
    for (const [, ref] of text.matchAll(/new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) need(f, ref);
    for (const [, ref] of text.matchAll(/chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/g)) need('manifest.json', ref);
    for (const [, ref] of text.matchAll(/OFFSCREEN_URL\s*=\s*['"]([^'"]+)['"]/g)) need('manifest.json', ref);
  }
}
for (const f of ['lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs', 'lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm']) {
  if (!included.has(f)) missing.push(`audio/ai-separator.js (ort.env.wasm.wasmPaths) → ${f}`);
}
if (missing.length) {
  console.error('Thiếu file được tham chiếu:\n  ' + missing.join('\n  '));
  process.exit(1);
}

// ---------- hướng dẫn cài cho người nhận ----------
const install = `CAPO ${version} — Chrome extension
Transpose any tab's audio without changing its tempo, split it into stems, record to WAV.

INSTALL (Chrome 116+, also Edge/Brave/other Chromium browsers)
  1. Unzip this file into a folder you will keep (Chrome loads the extension from that folder).
  2. Open chrome://extensions and turn on "Developer mode" (top right).
  3. Click "Load unpacked" and select the unzipped folder (the one containing manifest.json).
  4. Pin CAPO from the puzzle-piece menu, play audio in a tab, click the CAPO icon, then "Turn on".
  Update: replace the folder's contents with the new version and click the reload icon on the CAPO card.
  Language: Options → Language in the popup (English / Tiếng Việt).

CÀI ĐẶT (Chrome 116+, cũng chạy trên Edge/Brave/trình duyệt Chromium khác)
  1. Giải nén file này vào một thư mục sẽ giữ lâu dài (Chrome nạp extension từ thư mục đó).
  2. Mở chrome://extensions, bật "Developer mode" (góc trên bên phải).
  3. Bấm "Load unpacked" và chọn thư mục vừa giải nén (thư mục có file manifest.json).
  4. Ghim CAPO từ menu hình mảnh ghép, phát âm thanh trong một tab, bấm icon CAPO rồi "Turn on".
  Cập nhật: thay nội dung thư mục bằng bản mới rồi bấm nút tải lại trên thẻ CAPO.
  Ngôn ngữ: Options → Language trong popup (English / Tiếng Việt).

Privacy: all audio processing happens on your computer. The only network request is the optional
one-time AI model download (181 MB from Hugging Face) that you start yourself on the AI page.
Source: https://github.com/phunguyen4869/capo-extension — MIT License (see LICENSE).
`;

// ---------- ghi ZIP ----------
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01, cố định để gói tái lập được
const entries = [
  ...files.map((name) => ({ name, data: readFileSync(path.join(root, name)) })),
  { name: 'INSTALL.txt', data: Buffer.from(install, 'utf8') },
];

const chunks = [];
const central = [];
let offset = 0;
for (const { name, data } of entries) {
  const nameBuf = Buffer.from(name, 'utf8');
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const store = deflated.length >= data.length;
  const body = store ? data : deflated;
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // tên file UTF-8
  local.writeUInt16LE(store ? 0 : 8, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, body);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(store ? 0 : 8, 10);
  cd.writeUInt16LE(DOS_TIME, 12);
  cd.writeUInt16LE(DOS_DATE, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(body.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // quyền file -rw-r--r--
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);
  offset += local.length + nameBuf.length + body.length;
}
const cdBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(cdBuf.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...chunks, cdBuf, end]);

const outDir = path.join(root, 'dist');
if (!existsSync(outDir)) mkdirSync(outDir);
const outFile = path.join(outDir, `capo-${version}.zip`);
writeFileSync(outFile, zip);

const unpacked = entries.reduce((s, e) => s + e.data.length, 0);
console.log(`Đã tạo ${path.relative(root, outFile)}`);
console.log(`  ${entries.length} file · ${(unpacked / 1e6).toFixed(1)} MB → ${(zip.length / 1e6).toFixed(1)} MB nén`);
console.log(`  SHA-256 ${createHash('sha256').update(zip).digest('hex')}`);
