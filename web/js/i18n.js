// web/js/i18n.js — Song ngữ VI/EN cho Harness Executor.
// Cách làm: dịch theo KHỚP CHÍNH XÁC text node (bảng VI→EN) + MutationObserver
// để mọi view render mới đều được dịch ngay khi đang ở chế độ EN.
// Mặc định TIẾNG VIỆT nguyên bản; EN là lớp phủ (overlay) không đụng template.

const KEY = 'harness.lang';

/** Bảng khớp chính xác: text gốc (trim) → text EN */
const MAP = new Map(Object.entries({
  /* ---- tab bar ---- */
  'Home': 'Home', 'Hub': 'Hub', 'Agents': 'Agents', 'Chat': 'Chat',
  'Settings': 'Settings', 'Term': 'Term',
  /* ---- home ---- */
  'executor': 'executor',
  'Mobile control plane cho MCP servers · plugins · skills · agents':
    'Mobile control plane for MCP servers · plugins · skills · agents',
  'MCP servers': 'MCP servers', 'Plugins': 'Plugins', 'Skills': 'Skills', 'Models': 'Models',
  'đã kết nối': 'connected', 'kết nối': 'connect', 'ngắt kết nối': 'disconnect',
  'mô phỏng': 'simulated', 'thật': 'real',
  /* ---- hub / chung ---- */
  'Tất cả': 'All', 'tất cả': 'all', 'builtin': 'builtin', 'Thật': 'Real', 'real': 'real',
  'Tìm MCP, plugin, skill…': 'Search MCPs, plugins, skills…',
  'Kết nối': 'Connect', 'Ngắt': 'Disconnect', 'Đã kết nối': 'Connected',
  'Chưa kết nối': 'Not connected', 'đang chạy': 'running', 'huỷ': 'cancelled',
  'Bật': 'On', 'Tắt': 'Off', 'Đang bật': 'Enabled', 'Đang tắt': 'Disabled',
  'Cài đặt trước': 'Install first', 'Lưu env': 'Save env',
  'Biến môi trường': 'Environment variables', 'Hành vi': 'Behavior',
  'sẽ có:': 'will have:',
  /* ---- agents ---- */
  'Spawn agent': 'Spawn agent', 'spawn agent': 'spawn agent', 'Mới': 'New',
  'Workspace': 'Workspace', 'Nhắn tiếp…': 'Reply again…', 'Gửi': 'Send',
  'Huỷ agent': 'Cancel agent', 'bước': 'steps', 'lượt nhắn tiếp': 'follow-ups',
  'Task': 'Task', 'Tên': 'Name', 'Model': 'Model', 'Tools': 'Tools',
  /* ---- term ---- */
  'terminal': 'terminal', 'tự động': 'autonomous',
  'Session riêng · folder riêng · lệnh nguy hiểm phải duyệt':
    'Own session · own folder · dangerous commands need approval',
  'Yêu cầu permission': 'Permission required',
  'Duyệt': 'Approve', 'Từ chối': 'Deny', 'local': 'local',
  'chưa có terminal nào': 'no terminal yet',
  'An toàn (' : 'Safe (',
  'hiện thẻ phải': 'shows an approval card for',
  'Luôn cấm' : 'Always blocked',
  'chặn trước khi chạy.': 'blocked before running.',
  /* ---- chat ---- */
  'Nhắn gì đó…': 'Type something…', 'New chat': 'New chat', 'chat mới': 'new chat',
  /* ---- settings ---- */
  'Environment': 'Environment', 'Theme': 'Theme', 'About': 'About',
  'Ngôn ngữ': 'Language', 'Language': 'Language',
  'Quét lại': 'Re-scan', 'Sửa môi trường': 'Repair environment',
  'pass': 'pass', 'warn': 'warn', 'fail': 'fail',
  'Version': 'Version', 'Stack': 'Stack', 'Registry': 'Registry',
  'Credit': 'Credit', 'Repo': 'Repo', 'Author': 'Author',
  'Shizuku': 'Shizuku',
  'Bật': 'On', 'Tắt': 'Off',
  /* ---- boot overlay ---- */
  'mobile mcp executor': 'mobile mcp executor',
  'self-hosted executor': 'self-hosted executor',
}));

/** Placeholder/attr dịch theo khớp */
const ATTR_MAP = new Map(Object.entries({
  'Nhắn tin cho model…': 'Message the model…',
  'http://192.168.1.10:8787': 'http://192.168.1.10:8787',
}));

export function getLang() {
  try { return localStorage.getItem(KEY) || 'vi'; } catch { return 'vi'; }
}

export function setLang(lang) {
  try { localStorage.setItem(KEY, lang === 'en' ? 'en' : 'vi'); } catch { /* ignore */ }
  document.documentElement.lang = lang === 'en' ? 'en' : 'vi';
}

function translateNode(node) {
  if (node.nodeType !== Node.TEXT_NODE) return;
  const raw = node.nodeValue;
  if (!raw || !raw.trim()) return;
  const en = MAP.get(raw.trim());
  if (en && raw !== en) {
    // giữ khoảng trắng hai đầu như bản gốc
    const lead = raw.slice(0, raw.length - raw.trimStart().length);
    const trail = raw.slice(raw.trimEnd().length);
    node.__vi = node.__vi || raw;
    node.nodeValue = lead + en + trail;
  }
}

function translateAttrs(el) {
  const ph = el.getAttribute?.('placeholder');
  if (ph && ATTR_MAP.has(ph)) el.setAttribute('placeholder', ATTR_MAP.get(ph));
}

export function apply(root = document.body) {
  if (getLang() !== 'en') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) translateNode(n);
  root.querySelectorAll?.('*').forEach(translateAttrs);
}

let observer = null;

/** Gọi 1 lần trong app.init(): tự dịch mọi DOM mới khi lang=en */
export function autoTranslate() {
  if (observer) return;
  if (getLang() !== 'en') return;
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) translateNode(n);
        else if (n.nodeType === Node.ELEMENT_NODE) apply(n);
      });
      if (m.type === 'characterData') translateNode(m.target);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
