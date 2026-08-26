/* ============================================================
   upio web — app.js: shell ứng dụng.
   Router hash · SSE bus · store chung · toast · bottom sheet · helpers.
   ============================================================ */
import { api, connectEvents } from './api.js';
import * as homeView from './views/home.js';
import * as hubView from './views/hub.js';
import * as agentsView from './views/agents.js';
import * as chatView from './views/chat.js';
import * as settingsView from './views/settings.js';

// Re-export để mọi view chỉ cần import một đường từ '../app.js'
export { api, connectEvents };
export { chatCompletion } from './api.js';

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

/* ---------------- Toast ---------------- */
const TOAST_ICO = { ok: '✅', error: '⛔', warn: '⚠️', info: 'ℹ️' };

export function toast(msg, type = 'info') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="t-ico">${TOAST_ICO[type] || TOAST_ICO.info}</span><span>${esc(msg)}</span>`;
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
  panel.innerHTML = `<button type="button" class="sheet-x" aria-label="Đóng">✕</button><div class="sheet-body">${html}</div>`;
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
  chat: chatView,
  settings: settingsView,
};
let viewCleanup = null;

function parseRoute() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0];
  return Object.prototype.hasOwnProperty.call(ROUTES, name) ? name : 'home';
}

async function navigate() {
  const name = parseRoute();
  if (viewCleanup) { try { viewCleanup(); } catch { /* ignore */ } viewCleanup = null; }
  closeSheet(); // đổi tab → đóng sheet đang mở (nếu có)
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === name));
  const el = document.getElementById(`view-${name}`);
  if (!el) return;
  try {
    viewCleanup = (await ROUTES[name].render(el)) || null;
  } catch (err) {
    el.innerHTML = `<div class="container"><div class="card pad empty">
      <div class="empty-ico">💥</div><b>Không render được view "${esc(name)}"</b>
      <p class="dim">${esc(err && err.message)}</p></div></div>`;
  }
  window.scrollTo({ top: 0 });
}

/* ---------------- Status + offline banner ---------------- */
function setBanner(show) {
  const b = document.getElementById('offline-banner');
  if (b) b.classList.toggle('show', !!show);
}

export async function refreshStatus() {
  try {
    const s = await api.status();
    store.status = s;
    store.apiOk = true;
    store.counts = s.counts || store.counts;
    store.connectedMcps = typeof s.connectedMcps === 'number' ? s.connectedMcps : store.connectedMcps;
    setBanner(false);
    emit('status', s);
  } catch {
    const wasOk = store.apiOk;
    store.apiOk = false;
    setBanner(true);
    if (wasOk) emit('status', null); // báo views biết mất kết nối
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
  // Theme lưu localStorage (dark mặc định)
  try {
    if (localStorage.getItem('upio-theme') === 'light') document.documentElement.classList.add('light');
  } catch { /* storage chặn — dùng dark */ }

  // Tab bar + phím Esc cho sheet
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => { location.hash = `#/${btn.dataset.route}`; });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  document.getElementById('sheet-backdrop').addEventListener('click', closeSheet);

  window.addEventListener('hashchange', navigate);
  await navigate();

  // SSE toàn cục: đẩy mọi event vào bus
  connectEvents((evt) => {
    if (!evt || !evt.type) return;
    emit(evt.type, evt);
    if (evt.type === 'mcp' || evt.type === 'plugin') refreshStatusSoon();
  });

  window.addEventListener('online', refreshStatus);
  window.addEventListener('offline', () => { store.apiOk = false; setBanner(true); });

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
