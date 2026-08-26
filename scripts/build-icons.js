// build-icons.js — trích xuất SVG từ @iconify-json/{solar,heroicons} → web/js/icons.js
// Chạy: node scripts/build-icons.js  (yêu cầu npm i --no-save @iconify-json/solar @iconify-json/heroicons)
// Kết quả: module ESM zero-dependency với icon inline SVG. Runtime KHÔNG cần node_modules.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules', '@iconify-json');

// name → [tập ứng viên theo thứ tự ưu tiên] (đều là tên icon trong collection)
const SOLAR = {
  // tab bar & điều hướng
  home: ['home-smile-bold', 'home-2-bold', 'home-angle-2-bold', 'home-bold'],
  hub: ['widget-4-linear', 'widget-add-linear', 'grid-rounded-linear', 'layers-minimalistic-linear'],
  agents: ['bot-bold', 'robotic-bold', 'cpu-bolt-bold'],
  chat: ['chat-round-like-bold', 'dialog-linear', 'chat-round-dots-linear'],
  settings: ['settings-minimalistic-bold', 'settings-linear', 'cog-linear'],
  // chủ đề / hành động chung
  sun: ['sun-2-linear', 'sun-linear'], moon: ['moon-stars-linear', 'moon-linear'],
  search: ['magnifer-linear', 'search-linear'], close: ['close-circle-linear', 'x-linear', 'close-linear'],
  check: ['check-circle-bold', 'checkmark-circle-2-bold', 'check-linear'],
  warn: ['danger-triangle-bold', 'warning-triangle-linear'], error: ['danger-circle-bold', 'circle-critical-linear'],
  clock: ['clock-circle-linear', 'clock-square-linear'], zap: ['zap-bold', 'lightning-bold'],
  refresh: ['refresh-linear', 'restart-linear'], external: ['square-arrow-right-up-linear', 'link-circle-linear'],
  plus: ['add-circle-linear', 'plus-linear'], copy: ['copy-linear', 'copy-01-linear'],
  trash: ['trash-bin-trash-linear', 'trash-box-linear'], eye: ['eye-linear'], eyeoff: ['eye-closed-linear'],
  chevr: ['alt-arrow-right-linear', 'arrow-right-linear'], chevd: ['alt-arrow-down-linear'],
  dots: ['menu-dots-linear', 'more-vertical-circle-linear'],
  // domain
  server: ['server-square-linear', 'server-2-linear', 'minimalistic-square-multiple-alphabet-linear'],
  puzzle: ['puzzle-piece-linear', 'frame-selection-linear', 'box-linear'],
  book: ['book-2-linear', 'notebook-linear', 'journal-linear'],
  database: ['database-linear', 'database-bold'], folder: ['folder-linear', 'folder-open-linear'],
  branch: ['branching-paths-up-linear', 'git-branch-linear', 'code-branch-linear'],
  globe: ['global-linear', 'globe-linear'], cpu: ['cpu-bolt-linear', 'cpu-holder-linear'],
  mail: ['letter-linear', 'envelope-linear'], calendar: ['calendar-linear', 'calendar-minimalistic-linear'],
  chart: ['chart-2-linear', 'graph-linear', 'statistics-linear'], film: ['video-frame-play-horizontal-linear', 'clapperboard-text-linear'],
  link: ['link-circle-linear', 'link-minimalistic-linear'], pin: ['map-point-linear', 'map-pin-linear'],
  house: ['smart-home-linear', 'home-wifi-linear'], lock: ['lock-keyhole-minimalistic-unlocked-linear', 'lock-linear'],
  terminal: ['code-linear', 'terminal-box-linear'], file: ['document-linear', 'file-linear'],
  shield: ['shield-key-linear', 'shield-check-linear', 'shield-minulistic-linear'],
  activity: ['wave-sine-linear', 'pulse-2-linear', 'cardiology-linear'],
  play: ['play-circle-linear', 'play-linear'], plug: ['plug-circle-linear', 'usb-linear', 'plug-linear'],
  send: ['paper-plane-linear', 'send-square-linear'], stop: ['stop-circle-linear', 'pause-circle-linear'],
  wrench: ['toolbox-linear', 'tuning-square-linear', 'spanner-linear'], bolt2: ['bolt-linear', 'flash-linear'],
};
const BLADE_HERO = { // heroicons v2 outline — bộ đi kèm blade-heroicons
  connect: ['link', 'arrow-right-on-rectangle'], disconnect: ['scissors', 'arrow-left-on-rectangle'],
  run: ['play', 'bolt'], stop: ['stop', 'hand-raised'], build: ['wrench-screwdriver', 'wrench'],
  refresh: ['arrow-path'], search: ['magnifying-glass'], close: ['x-mark'],
  copy: ['clipboard-document', 'clipboard'], eye: ['eye'], eyeoff: ['eye-slash'],
  send: ['paper-airplane'], trash: ['trash'], check: ['check-circle', 'check'],
  warn: ['exclamation-triangle'], error: ['exclamation-circle'], external: ['arrow-top-right-on-square'],
  plus: ['plus'], chevr: ['chevron-right'], chevd: ['chevron-down'], chevu: ['chevron-up'],
  user: ['user-circle'], key: ['key'], download: ['arrow-down-tray'], filter: ['funnel'],
  list: ['list-bullet'], sparkles: ['sparkles'], clock: ['clock'], lock: ['lock-closed'],
  doc: ['document-text'], folder: ['folder'], code: ['code-bracket-square', 'command-line'],
  globe: ['globe-alt'], cpu: ['cpu-chip'], database: ['circle-stack'], server: ['server-stack'],
  mail: ['envelope'], chat: ['chat-bubble-left-right'], calendar: ['calendar-days'],
  chart: ['chart-bar'], film: ['film'], link: ['link'], pin: ['map-pin'], home: ['home-modern'],
  shield: ['shield-check'], bolt: ['bolt'], sun: ['sun'], moon: ['moon'], adjust: ['adjustments-horizontal'],
};

async function loadCollection(name) {
  const j = JSON.parse(await readFile(path.join(NM, name, 'icons.json'), 'utf8'));
  const out = new Map();
  for (const [k, v] of Object.entries(j.icons)) out.set(k, v);
  for (const [k, v] of Object.entries(j.aliases ?? {})) if (!out.has(k)) out.set(k, v);
  return { width: j.width ?? 24, icons: out };
}

/** Render body iconify thành <svg> độc lập (currentColor, viewBox chuẩn hoá). */
function render(body, w, hOpt) {
  const h = hOpt ?? w;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" fill="none">${body}</svg>`;
}
function resolve(candidates, coll) {
  for (const c of candidates) {
    const ic = coll.icons.get(c);
    if (ic) {
      const w = ic.width ?? coll.width;
      const h = ic.height ?? w;
      return render(ic.body, w, h);
    }
  }
  return null;
}

const solar = await loadCollection('solar');
const hero = await loadCollection('heroicons');
const out = {}; const missing = [];
for (const [name, candidates] of Object.entries(SOLAR)) {
  const svg = resolve(candidates, solar);
  if (svg) out[`solar/${name}`] = svg; else missing.push(`solar/${name} (${candidates.join(',')})`);
}
for (const [name, candidates] of Object.entries(BLADE_HERO)) {
  const svg = resolve(candidates, hero);
  if (svg) out[`blade/${name}`] = svg; else missing.push(`blade/${name} (${candidates.join(',')})`);
}

const js = `/* icons.js — BỘ ICON NHÚNG TRỰC TIẾP (Solar · Heroicons/Blade-style). Zero-dependency.
 * Được sinh bởi scripts/build-icons.js — KHÔNG sửa tay.
 * Dùng: icon('solar/home') hoặc icon('blade/run', 18)
 */
export const ICONS = ${JSON.stringify(out, null, 0)};

/** Trả chuỗi <svg> cho tên 'tên-bộ/tên-icon'; class CSS tuỳ chọn. */
export function icon(name, cls = 'ic') {
  const raw = ICONS[name];
  if (!raw) return '';
  return raw.replace('<svg ', '<svg class="' + cls + '" aria-hidden="true" ');
}
`;
await writeFile(path.join(ROOT, 'web', 'js', 'icons.js'), js);
console.log(`✔ web/js/icons.js: ${Object.keys(out).length} icons (${(js.length / 1024).toFixed(1)} KB)`);
if (missing.length) { console.log('⚠ MISSING:'); missing.forEach((m) => console.log('  -', m)); }
else console.log('✔ tất cả candidate khớp, không thiếu icon nào');
