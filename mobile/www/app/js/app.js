/* ============================================================
   upio web — app.js: shell ứng dụng (design "TRẮNG ĐEN TỐI GIẢN").
   Router hash · SSE bus · store chung · toast · bottom sheet ·
   helper icon/status · boot overlay gate.
   ============================================================ */
import { api, connectEvents, getApiBase, probeBase, rediscoverBase } from './api.js';
import { icon, ICONS } from './icons.js';
import { gateBoot } from './boot.js';
import * as homeView from './views/home.js';
import * as hubView from './views/hub.js';
import * as agentsView from './views/agents.js';
import * as termView from './views/term.js';
import { apply as i18nApply, autoTranslate, getLang, setLang } from './i18n.js';
import * as chatView from './views/chat.js';
import * as settingsView from './views/settings.js';

// Module graph đã tải & parse xong → watchdog trong index.html KHÔNG được bật
// chế độ tĩnh / banner offline nữa. Phải đặt NGAY tại top-level (không chờ init())
// vì boot gate + navigate + refreshStatus tốn hơn 1.5s ngưỡng của watchdog.
window.__UPIO_MODULES = true;

// Re-export để mọi view chỉ cần import một đường từ '../app.js'
export { api, connectEvents };
export { getApiBase, setApiBase, probeBase, rediscoverBase } from './api.js';
export { chatCompletion } from './api.js';
export { icon, ICONS };

/* ---------------- Store trạng thái chung ---------------- */
export const store = {
  status: null,                                   // GET /api/status
  apiOk: false,
  counts: { plugins: 0, mcps: 0, skills: 0 },
  connectedMcps: 0,
  models: [],                                     // [{id,provider,label,available}]
  modelConfig: { default: 'ox-local-mock', providers: [] },
  registries: { mcps: [], plugins: [], skills: [] }, // cache cho gợi ý nhanh
  envBuilding: false,
};

/* ---------------- Event bus (SSE + nội bộ) ---------------- */
export const bus = new EventTarget();

/** Đăng ký listener trên bus theo type; trả hàm unsubscribe. */
export function listen(type, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

/* ---------------- Helpers chung ---------------- */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape mọi chuỗi user/data trước khi nhúng vào HTML (chống XSS). */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

export function fmtClock(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDur(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
    m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${p2(m)}m`;
  if (m) return `${m}m ${p2(s)}s`;
  return `${s}s`;
}

export function fmtAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (!(s >= 0)) return '';
  if (s < 45) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

export function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* Đếm số nhảy lên cho stat values (tôn trọng prefers-reduced-motion). */
const _countRafs = new WeakMap();

export function countUp(el, to, { dur = 550, fmt = (n) => String(n) } = {}) {
  if (!el) return;
  const target = Number(to) || 0;
  const from = Number(el.dataset.countV ?? 0) || 0;
  el.dataset.countV = String(target);
  let reduce = false;
  try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* ignore */ }
  const prevRaf = _countRafs.get(el);
  if (prevRaf) cancelAnimationFrame(prevRaf);
  if (reduce || from === target) { el.textContent = fmt(target); return; }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    el.textContent = fmt(Math.round(from + (target - from) * eased));
    if (p < 1) _countRafs.set(el, requestAnimationFrame(step));
  };
  _countRafs.set(el, requestAnimationFrame(step));
}

export function truncate(s, n = 500) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Copy vào clipboard với fallback execCommand cho http không-secure. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* ---------------- Icons & trạng thái (hình dạng thay màu) ---------------- */

/** Hydrate mọi phần tử [data-icon] trong root bằng SVG từ ICONS. */
export function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    const name = node.dataset.icon;
    if (!ICONS[name]) continue;
    node.innerHTML = icon(name, node.dataset.cls ?? 'ic');
  }
}

/** Ký hiệu trạng thái dạng hình: connected=check · off=vòng rỗng · warn=tam giác · fail=x-circle · running=spinner. */
export function stMark(kind = 'idle') {
  switch (kind) {
    case 'connected':
    case 'ok':
    case 'pass':
      return `<span class="stm">${icon('blade/check', 'ic-sm')}</span>`;
    case 'warn':
      return `<span class="stm">${icon('blade/warn', 'ic-sm')}</span>`;
    case 'fail':
    case 'error':
      return `<span class="stm">${icon('blade/error', 'ic-sm')}</span>`;
    case 'running':
      return '<span class="mini-spin" aria-hidden="true"></span>';
    default:
      return '<span class="ring" aria-hidden="true"></span>';
  }
}

/** Nhãn tiếng Việt cho trạng thái MCP/server. */
export function stateLabel(st) {
  switch (st) {
    case 'connected': return 'Đã kết nối';
    case 'disconnected': return 'Chưa kết nối';
    case 'error': return 'Lỗi';
    default: return String(st || 'Chưa kết nối');
  }
}

/* ---------------- Theme (light mặc định, dark qua html.dark) ---------------- */
export function isDark() {
  return document.documentElement.classList.contains('dark');
}

/** Áp theme + đồng bộ meta theme-color + lưu localStorage. */
export function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', !!dark);
  document.querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute('content', dark ? '#0a0a0a' : '#ffffff'));
  try { localStorage.setItem('upio-theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
}

/* ---------------- Toast ---------------- */
const TOAST_ICO = { ok: 'blade/check', error: 'blade/error', warn: 'blade/warn', info: 'solar/zap' };

export function toast(msg, type = 'info') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="t-ico">${icon(TOAST_ICO[type] || TOAST_ICO.info, 'ic-sm')}</span><span>${esc(msg)}</span>`;
  root.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, 2900);
}

/* ---------------- Bottom sheet ---------------- */
let sheetCloseFns = [];

/** Đăng ký callback chạy khi sheet đóng (dọn listener/timer của sheet). */
export function onSheetClose(fn) { sheetCloseFns.push(fn); }

/** Mở bottom sheet với html; trả về panel element để view gắn listener. */
export function openSheet(html) {
  const rootEl = document.getElementById('sheet-root');
  const panel = document.getElementById('sheet-panel');
  if (!rootEl || !panel) return null;
  runSheetCloseFns();
  panel.innerHTML =
    `<button type="button" class="sheet-x" aria-label="Đóng">${icon('blade/close', 'ic-sm')}</button>` +
    `<div class="sheet-body">${html}</div>`;
  panel.querySelector('.sheet-x').addEventListener('click', closeSheet);
  panel.scrollTop = 0;
  rootEl.classList.add('open');
  rootEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('sheet-lock');
  return panel;
}

export function closeSheet() {
  const rootEl = document.getElementById('sheet-root');
  const panel = document.getElementById('sheet-panel');
  if (!rootEl || !panel || !rootEl.classList.contains('open')) return;
  runSheetCloseFns();
  rootEl.classList.remove('open');
  rootEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('sheet-lock');
  setTimeout(() => { panel.innerHTML = ''; }, 240);
}

function runSheetCloseFns() {
  const fns = sheetCloseFns;
  sheetCloseFns = [];
  for (const fn of fns) { try { fn(); } catch { /* ignore */ } }
}

/* ---------------- Router hash-based ---------------- */
const ROUTES = {
  home: homeView,
  hub: hubView,
  agents: agentsView,
  term: termView,
  chat: chatView,
  settings: settingsView,
};
let viewCleanup = null;
let events = null;   // handle SSE toàn cục — cần để reopen() khi đổi API base

function parseRoute() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0];
  return Object.prototype.hasOwnProperty.call(ROUTES, name) ? name : 'home';
}

/** Đặt lại vị trí/độ rộng thanh chỉ báo trượt dưới tab bar (transform → mượt). */
function moveTabIndicator() {
  const bar = document.querySelector('.tab-bar');
  const on = bar?.querySelector('.tab-btn.active');
  if (!bar || !on) return;
  const w = Math.max(22, Math.round(on.offsetWidth * 0.42));
  const x = Math.round(on.offsetLeft + (on.offsetWidth - w) / 2);
  bar.style.setProperty('--ind-w', w + 'px');
  bar.style.setProperty('--ind-x', x + 'px');
  bar.style.setProperty('--ind-o', '1');
}
window.addEventListener('resize', () => moveTabIndicator(), { passive: true });
window.addEventListener('orientationchange', () => setTimeout(moveTabIndicator, 120));

async function navigate() {
  const name = parseRoute();
  if (viewCleanup) { try { viewCleanup(); } catch { /* ignore */ } viewCleanup = null; }
  closeSheet(); // đổi tab → đóng sheet đang mở (nếu có)
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === name));
  moveTabIndicator();
  const el = document.getElementById(`view-${name}`);
  if (!el) return;
  try {
    viewCleanup = (await ROUTES[name].render(el)) || null;
  } catch (err) {
    el.innerHTML = `<div class="container"><div class="card pad empty">
      <div class="empty-ico">${icon('blade/error', 'ic-lg')}</div><b>Không render được view "${esc(name)}"</b>
      <p class="dim">${esc(err && err.message)}</p></div></div>`;
  }
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => { i18nApply(el); autoTranslate(); });
}

/* ---------------- Status + offline banner ---------------- */
function setBanner(show, text) {
  const b = document.getElementById('offline-banner');
  if (b) b.classList.toggle('show', !!show);
  const t = document.getElementById('offline-text');
  if (t && text) t.textContent = text;
}

let recheckTimer = null;   // hẹn kiểm lại nhanh sau khi mất kết nối (khai báo trước khi dùng)

/** Nút "Thử lại" trên banner: DÒ LẠI địa chỉ API rồi nạp lại dữ liệu — không reload trang.
 * Reload vô ích khi base lưu trong localStorage đã chết (đổi Wi-Fi / IP máy tính đổi):
 * tải lại vẫn dùng đúng base sai đó. */
let retrying = false;
export async function retryConnection() {
  if (retrying) return false;
  retrying = true;
  setBanner(true, 'Đang dò lại địa chỉ server…');
  try {
    const hit = await rediscoverBase();
    if (!hit) {
      setBanner(true, `Không tìm thấy harness server (đang thử ${getApiBase() || location.host}) — kiểm tra server còn chạy?`);
      return false;
    }
    if (events && events.reopen) events.reopen();   // SSE phải nối lại theo base mới
    // refreshStatus TRƯỚC (nó tự tắt banner khi ok) rồi mới toast, để banner và toast
    // không nói ngược nhau. probe vừa thành công nhưng vẫn phải xác nhận qua đường
    // fetch bình thường — đó mới là đường app thật sự dùng.
    await refreshStatus();
    if (!store.apiOk) {
      setBanner(true, `Dò ra ${hit.base || location.host} nhưng chưa lấy được dữ liệu — thử lại lần nữa?`);
      return false;
    }
    await refreshModels();
    await navigate();                                // vẽ lại view hiện tại với dữ liệu thật
    toast(`Đã kết nối ${hit.base || location.host} · v${hit.version}`, 'ok');
    return true;
  } finally {
    retrying = false;
  }
}

export async function refreshStatus() {
  try {
    const s = await api.status();
    store.status = s;
    store.apiOk = true;
    store.counts = s.counts || store.counts;
    store.connectedMcps = typeof s.connectedMcps === 'number' ? s.connectedMcps : store.connectedMcps;
    setBanner(false, 'API offline — một số dữ liệu không khả dụng');   // trả text về mặc định
    emit('status', s);
  } catch (err) {
    const wasOk = store.apiOk;
    // Server SỐNG mà request lỗi (HTTP 5xx) hoặc client đang bận (hàng đợi đầy) thì
    // KHÔNG phải "API offline" — báo sai làm người dùng đi sửa mạng vô ích.
    const kind = err && err.kind;
    if (kind === 'http') {
      setBanner(true, `Server trả lỗi ${err.status || ''} — server vẫn sống, xem log để rõ hơn`);
    } else if (kind === 'busy') {
      setBanner(true, 'Đang có việc chạy lâu — tạm thời chậm phản hồi');
    } else {
      store.apiOk = false;
      setBanner(true, `API offline (${getApiBase() || location.host}) — bấm Thử lại để dò lại server`);
      if (wasOk) emit('status', null); // báo views biết mất kết nối
      // Mất kết nối thì kiểm lại sau 5s thay vì đợi hết chu kỳ 30s: mạng Wi-Fi
      // chập chờn hồi rất nhanh, banner không nên đứng lại tới nửa phút.
      clearTimeout(recheckTimer);
      recheckTimer = setTimeout(() => { refreshStatus().catch(() => {}); }, 5000);
      return;
    }
    store.apiOk = kind === 'http' || kind === 'busy';   // vẫn coi là còn kết nối
  }
}

const refreshStatusSoon = debounce(refreshStatus, 800);

/* ---------------- Models (Model Hub) ---------------- */
/** Nạp /api/models vào store + bắn event 'models' cho các views đăng ký. */
export async function refreshModels() {
  try {
    const d = await api.models();
    store.models = d.models || [];
    if (d.config) store.modelConfig = d.config;
    emit('models', { models: store.models, config: store.modelConfig });
  } catch { /* offline — views tự fallback mock model */ }
}

/* ---------------- Service worker (chỉ https hoặc localhost) ---------------- */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hostOk = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (location.protocol !== 'https:' && !hostOk) return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* bỏ qua im lặng */ });
}

/* ---------------- Boot ---------------- */
async function init() {
  // Theme: light mặc định; head script đã thêm html.dark sớm nếu cần — sync meta ở đây
  try {
    applyTheme(localStorage.getItem('upio-theme') === 'dark');
  } catch {
    applyTheme(false);
  }

  // Shell: icon hydration + tab bar + phím Esc cho sheet
  hydrateIcons(document);
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => { location.hash = `#/${btn.dataset.route}`; });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  document.getElementById('sheet-backdrop').addEventListener('click', closeSheet);

  // Nút Copy trong code block markdown (.md-copy) — delegation TOÀN CỤC, wire đúng 1 lần.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.md-copy');
    if (!btn) return;
    const code = btn.closest('.md-code')?.querySelector('pre code');
    if (!code || !code.textContent) return;
    if (await copyText(code.textContent)) toast('Đã copy', 'ok');
    else toast('Không copy được', 'error');
  });

  window.addEventListener('hashchange', navigate);

  // Nút "Thử lại" trên banner: dò lại server + nạp lại dữ liệu (KHÔNG reload trang).
  document.getElementById('offline-retry')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();     // chặn handler reload cũ trong index.html
    retryConnection();
  }, true);

  // SSE toàn cục: bật TRƯỚC boot gate để không lỡ event 'boot'/'log'
  events = connectEvents((evt) => {
    if (!evt || !evt.type) return;
    emit(evt.type, evt);
    if (evt.type === 'mcp' || evt.type === 'plugin') refreshStatusSoon();
  });

  // Địa chỉ API lưu sẵn (APK) có thể đã chết vì đổi Wi-Fi/IP → dò lại.
  // Chỉ CHẶN tối đa 1.2s cho base hiện tại; nếu nó chết thì dò tiếp Ở NỀN và vẫn vẽ UI
  // ngay. Dò tuần tự 4 ứng viên × 2.5s = tới 10s, chặn cả gateBoot + navigate trong
  // khoảng đó thì người dùng thấy đúng như treo.
  if (!(await probeBase(getApiBase(), 1200))) {
    rediscoverBase({ skipCurrent: true }).then(async (hit) => {
      if (!hit) return;
      events.reopen();
      await refreshStatus();
      await refreshModels();
      await navigate();           // vẽ lại với dữ liệu thật khi đã tìm được server
    }).catch(() => {});
  }

  // Boot gate: backend tự setup khi vừa mở — overlay chỉ hiện khi phase 'booting'
  try { await gateBoot({ api, listen }); } catch { /* không bao giờ chặn app */ }

  await navigate();

  window.addEventListener('online', () => { retryConnection(); });
  window.addEventListener('offline', () => { store.apiOk = false; setBanner(true, 'Thiết bị mất mạng'); });

  await refreshStatus().catch(() => {});
  setInterval(refreshStatus, 30000);
  await refreshModels(); // cho select model ở Chat / Agents

  registerSW();
  window.__UPIO_BOOTED = true; // watchdog trong index.html kiểm tra cờ này
}

init().catch((err) => {
  console.warn('[upio] boot:', err && err.message);
  setBanner(true);
});
