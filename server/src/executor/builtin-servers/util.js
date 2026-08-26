// builtin-servers/util.js — helpers dùng chung cho các handler builtin.
// Zero-dependency: chỉ dùng ngôn ngữ thuần + node: core khi cần ở nơi khác.
// Toàn bộ đầu ra DETERMINISTIC: mọi con số đều xuất phát từ seeded PRNG
// (mulberry32) được gieo bằng tool name + JSON.stringify(args).

/** Mốc thời gian cố định cho mọi timestamp giả lập (2026-01-01T00:00:00Z). */
export const BASE_MS = Date.UTC(2026, 0, 1);

/** FNV-1a 32-bit — hash chuỗi nhanh, ổn định giữa các lần chạy. */
export function fnv1a(strInput) {
  let h = 0x811c9dc5;
  const s = String(strInput);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — PRNG 32-bit chất lượng tốt cho dữ liệu giả lập. */
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** JSON.stringify nhưng key luôn sort — để seed không phụ thuộc thứ tự chèn. */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const parts = [];
  for (const k of Object.keys(v).sort()) parts.push(JSON.stringify(k) + ':' + stableStringify(v[k]));
  return '{' + parts.join(',') + '}';
}

/** RNG gieo theo tool name + args — hạt nhân của tính determinism. */
export function rngFor(tool, args) {
  return mulberry32(fnv1a(tool + '|' + stableStringify(args ?? {})));
}

/* ------------------------------------------------------------------ */
/* Helpers lấy mẫu từ RNG                                              */
/* ------------------------------------------------------------------ */

export const int = (r, min, max) => min + Math.floor(r() * (max - min + 1));

export const float = (r, min, max, dp = 2) => Number((min + r() * (max - min)).toFixed(dp));

export const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

/** Chọn n phần tử KHÔNG trùng khỏi mảng. */
export function picks(r, arr, n) {
  const pool = [...arr];
  const want = Math.max(0, Math.min(n, pool.length));
  const out = [];
  while (out.length < want) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}

export const chance = (r, p) => r() < p;

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Chuỗi hex dài n ký tự. */
export function hex(r, n) {
  const ALPHABET = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(r() * 16)];
  return s;
}

export const uid = (r, prefix) => `${prefix}_${hex(r, 8)}`;

/** Timestamp trong quá khứ (so với BASE_MS cố định), cách tối đa maxDays ngày. */
export const agoMs = (r, maxDays = 30) => BASE_MS - Math.floor(r() * maxDays * 86_400_000);

/** Timestamp trong tương lai (so với BASE_MS cố định). */
export const aheadMs = (r, maxDays = 30) => BASE_MS + Math.floor(r() * maxDays * 86_400_000);

export const isoAgo = (r, maxDays = 30) => new Date(agoMs(r, maxDays)).toISOString();

export const isoAhead = (r, maxDays = 30) => new Date(aheadMs(r, maxDays)).toISOString();

export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export const semver = (r) => `${int(r, 0, 9)}.${int(r, 0, 24)}.${int(r, 0, 40)}`;

export const pad2 = (n) => String(n).padStart(2, '0');

/* ------------------------------------------------------------------ */
/* Word banks                                                          */
/* ------------------------------------------------------------------ */

const WORDS = [
  'aurora', 'basalt', 'cipher', 'delta', 'ember', 'falcon', 'granite', 'harbor',
  'ion', 'jasper', 'krypton', 'lumen', 'mesa', 'nimbus', 'onyx', 'pixel',
  'quartz', 'ridge', 'summit', 'thistle', 'umbra', 'vector', 'willow', 'zephyr',
];

export const word = (r) => pick(r, WORDS);

export const words = (r, n, sep = '-') =>
  Array.from({ length: n }, () => word(r)).join(sep);

export const titleCase = (r, n) =>
  Array.from({ length: n }, () => cap(word(r))).join(' ');

/** Đọc arg string với mặc định; number bị ép về string để echo an toàn. */
export const str = (v, dflt = '') =>
  typeof v === 'string' && v.length ? v : typeof v === 'number' ? String(v) : dflt;

/** Đọc arg số, rơi về mặc định khi thiếu/NaN. */
export const numOr = (v, dflt) =>
  typeof v === 'number' && Number.isFinite(v) ? v : dflt;

/* ------------------------------------------------------------------ */
/* Trích từ khóa khỏi prompt/text (EN + VI stopwords)                  */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(
  ('a an the and or of to in on for with is are was were be been being this that these those ' +
   'it its as at by from into about over under again then once here there all any both each few ' +
   'more most other some such no nor not only own same so than too very can will just don should ' +
   'now việt viết đoạn một các cho là được với những khi thì về trong từ ra này đó đã cũng bạn ' +
   'hãy what how why who when where which').split(' ')
);

/** Trả về tối đa n từ khóa nổi bật (tần suất rồi độ dài) của text. */
export function keywords(text, n = 3) {
  const freq = new Map();
  for (const raw of String(text ?? '').split(/[^\p{L}\p{N}_]+/u)) {
    const w = raw.toLowerCase();
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, Math.max(0, n))
    .map((e) => e[0]);
}
