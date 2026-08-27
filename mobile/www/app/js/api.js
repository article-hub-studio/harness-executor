/* ============================================================
   upio web — api.js: trung tâm REST + SSE + stream chat.
   Zero-dependency; mọi lỗi ném Error với message thân thiện.
   ============================================================ */

/** Dựng querystring, bỏ qua giá trị rỗng. */
function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.set(k, v);
  }
  const s = u.toString();
  return s ? '?' + s : '';
}

/** fetch JSON: lỗi HTTP → throw Error(message từ body.error || status). */
/* API_BASE ĐỔI ĐƯỢC lúc chạy. Bản APK lưu địa chỉ server vào localStorage 'upio.api'
 * (vd http://192.168.1.10:8787). Khi IP máy tính đổi / đổi Wi-Fi, địa chỉ đó chết →
 * mọi request fail → banner "API offline" và nút "Thử lại" chỉ reload nên vô ích vì
 * base sai vẫn còn nguyên. Vì vậy phải cho phép dò lại và ĐỔI base ngay trong app. */
let API_BASE = (typeof window !== 'undefined' && window.__DSH_API_BASE) || '';
export const getApiBase = () => API_BASE;

/** Đổi base đang dùng + ghi nhớ (rỗng = same-origin).
 * persistServer=false khi base chỉ là PHỎNG ĐOÁN loopback lúc dò lại: lúc đó không
 * được ghi đè 'upio.server' — đó là địa chỉ người dùng đã tự cấu hình cho launcher. */
export function setApiBase(base, { persistServer = true } = {}) {
  const next = base || '';
  // Đồng bộ window.__DSH_API_BASE kể cả khi base không đổi, để script inline trong
  // index.html và module không bao giờ đọc lệch nhau.
  try { if (typeof window !== 'undefined') window.__DSH_API_BASE = next; } catch { /* ignore */ }
  if (next === API_BASE) return;
  API_BASE = next;
  inflightGets.clear();   // request đang bay thuộc base CŨ — không được cho ai nối vào
  try {
    // Launcher APK đọc 'upio.server' và mirror sang 'upio.api'; ghi CẢ HAI khi biết
    // chắc, nếu không lần mở app sau launcher lại redirect về base cũ đã chết.
    if (API_BASE) {
      localStorage.setItem('upio.api', API_BASE);
      if (persistServer) localStorage.setItem('upio.server', API_BASE);
    } else {
      // same-origin: xoá 'upio.api' để bundle gọi tương đối, nhưng GIỮ 'upio.server'
      // vì đó là địa chỉ người dùng đã cấu hình cho launcher.
      localStorage.removeItem('upio.api');
    }
  } catch { /* storage bị chặn — vẫn đổi trong RAM */ }
}

/** Một địa chỉ có harness sống không? (deadline ngắn, không bao giờ throw) */
export async function probeBase(base, timeoutMs = 2500) {
  const dl = deadlineSignal(timeoutMs);
  try {
    const r = await fetch((base || '') + '/api/status', { cache: 'no-store', signal: dl.signal });
    const j = await r.json();
    return j && j.ok === true ? { base: base || '', version: j.version } : null;
  } catch { return null; } finally { dl.done(); }
}

/**
 * Dò lại địa chỉ API theo thứ tự: base đang dùng → same-origin → địa chỉ người dùng đã
 * cấu hình cho launcher ('upio.server') → cổng mặc định nội bộ.
 * Trả về base tìm được (đã set) hoặc null. Same-origin ưu tiên cao vì khi UI do chính
 * server phục vụ thì đó chắc chắn là địa chỉ đúng.
 * skipCurrent: bỏ qua base hiện tại khi caller VỪA thử và biết nó chết (khỏi chờ 2 lần).
 */
export async function rediscoverBase({ skipCurrent = false } = {}) {
  let saved = '';
  try { saved = localStorage.getItem('upio.server') || ''; } catch { /* ignore */ }
  const cands = skipCurrent ? [] : [API_BASE];
  cands.push('', saved, 'http://127.0.0.1:8787', 'http://localhost:8787');

  const seen = new Set();
  for (const c of cands) {
    if (c === null || c === undefined) continue;
    const key = c || '(same-origin)';
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = await probeBase(c);
    if (!hit) continue;
    // Loopback chỉ là PHỎNG ĐOÁN: đúng khi server chạy trên chính máy này, nhưng có thể
    // là một harness khác. Dùng tạm được, song không ghi đè địa chỉ user đã cấu hình.
    const guessed = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(c);
    setApiBase(hit.base, { persistServer: !guessed });
    return hit;
  }
  return null;
}

/* ---------- Chống treo UI: timeout + hàng đợi giới hạn ----------
 * HTTP/1.1 chỉ cho 6 kết nối mỗi origin. Nếu fetch KHÔNG timeout mà server
 * nhận kết nối rồi im lặng (Wi-Fi yếu, Termux bị Android freeze, đổi mạng),
 * mỗi lần đổi tab lại chồng thêm request treo. Cạn 6 slot là MỌI thứ cùng
 * origin tắc: file tĩnh, SSE, và mọi tab sau đó → app "freeze" dù JS vẫn chạy.
 * (Đã đo: 6 request /api treo → tải /css/app.css timeout >6s.)
 * Nên: mọi request có deadline, và giữ trần đồng thời < 6 để SSE + asset còn chỗ.
 */
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_INFLIGHT = 3;            // 3 API + 1 SSE = 4 < 6 → luôn còn slot cho asset
const MAX_QUEUE = 24;              // hàng đợi có TRẦN: timer poll không được dồn vô hạn
const MAX_WAIT_MS = 15000;         // chờ tới lượt cũng phải có hạn (xem ghi chú dưới)
let inflight = 0;
const waiters = [];                // [{ res, rej, timer }]

/* Chờ tới lượt PHẢI có hạn: deadline của fetch chỉ bắt đầu tính SAU khi có slot, nên
 * nếu 3 slot đang bị việc chậm (installMcp 180s) giữ thì một request xếp hàng có thể
 * chờ vài phút mà UI vẫn "Đang tải…" — người dùng đọc thành treo. Hết hạn thì báo lỗi
 * rõ ràng để view hiện được trạng thái thật. */
function acquire(maxWaitMs = MAX_WAIT_MS) {
  if (inflight < MAX_INFLIGHT) { inflight++; return Promise.resolve(); }
  // Quá tải (API treo + nhiều timer poll) → chối ngay thay vì phình hàng đợi mãi
  if (waiters.length >= MAX_QUEUE) {
    const e = new Error('API đang quá tải — thử lại sau');
    e.kind = 'busy';
    return Promise.reject(e);
  }
  return new Promise((res, rej) => {
    const w = { res, rej, timer: null };
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);       // rời hàng đợi, không tiêu slot của ai
      const e = new Error(`API đang bận, chờ quá ${Math.round(maxWaitMs / 1000)}s`);
      e.kind = 'busy';
      rej(e);
    }, maxWaitMs);
    waiters.push(w);
  });
}
function release() {
  const next = waiters.shift();
  if (next) { clearTimeout(next.timer); next.res(); }   // chuyển slot trực tiếp, inflight giữ nguyên
  else inflight--;
}

/* Gộp GET trùng: các view poll cùng endpoint (term 4s, agents 2s, status 30s) khi API
 * chậm sẽ chồng request lên nhau. Cùng path đang bay thì dùng lại promise đó. */
const inflightGets = new Map();

/** AbortSignal có deadline, hoạt động cả nơi thiếu AbortSignal.timeout (WebView cũ). */
function deadlineSignal(ms, external) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('timeout')), ms);
  if (external) {
    if (external.aborted) ac.abort(external.reason);
    else external.addEventListener('abort', () => ac.abort(external.reason), { once: true });
  }
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

export async function fetchJSON(pathRaw, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  // Gộp GET trùng CHỈ khi caller không đòi dữ liệu mới. Sau một mutation (spawn agent,
  // env build, exec lệnh) phải đi request riêng: nối vào request phát TRƯỚC mutation
  // sẽ trả state cũ và có view không poll lại (agents chỉ poll khi có agent running)
  // nên UI đứng sai vĩnh viễn. Vì vậy mặc định fresh=false, caller nào cần thì bật.
  if (method === 'GET' && !opts.signal && !opts.fresh) {
    const hit = inflightGets.get(pathRaw);
    if (hit) return hit;
    const p = doFetch(pathRaw, opts).finally(() => {
      if (inflightGets.get(pathRaw) === p) inflightGets.delete(pathRaw);
    });
    inflightGets.set(pathRaw, p);
    return p;
  }
  return doFetch(pathRaw, opts);
}

async function doFetch(pathRaw, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: external, fresh: _fresh, ...rest } = opts;
  await acquire();
  // TẤT CẢ phần sau acquire() phải nằm trong try/finally. Trước đây deadlineSignal()
  // và spread {...rest} nằm ngoài: nếu chúng ném (WebView thiếu AbortController) thì
  // slot không bao giờ được release → 3 lần là mọi request xếp hàng vĩnh viễn, đúng
  // triệu chứng freeze ban đầu.
  let dl = null;
  try {
    const path = API_BASE + pathRaw;   // chốt base tại thời điểm GỬI
    dl = deadlineSignal(timeoutMs, external);
    let res;
    try {
      res = await fetch(path, {
        ...rest,
        signal: dl.signal,
        headers: {
          Accept: 'application/json',
          ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
          ...(rest.headers || {}),
        },
      });
    } catch (err) {
      if (external && external.aborted) throw err;   // caller tự huỷ — giữ nguyên AbortError
      const e = new Error(`API không phản hồi trong ${Math.round(timeoutMs / 1000)}s (mạng yếu hoặc server đã tắt)`);
      e.kind = 'unreachable';
      throw e;
    }
    let body = null;
    try { body = await res.json(); } catch { /* body rỗng */ }
    if (!res.ok) {
      const e = new Error((body && body.error) || `HTTP ${res.status}`);
      e.kind = 'http';       // server VẪN SỐNG, chỉ là request lỗi → không được báo "API offline"
      e.status = res.status;
      throw e;
    }
    return body;
  } finally {
    if (dl) dl.done();
    release();
  }
}

const get = (p, timeoutMs, fresh) => fetchJSON(p, { ...(timeoutMs ? { timeoutMs } : {}), ...(fresh ? { fresh: true } : {}) });
const post = (p, body = {}, timeoutMs) =>
  fetchJSON(p, { method: 'POST', body: JSON.stringify(body), ...(timeoutMs ? { timeoutMs } : {}) });
const put = (p, body = {}, timeoutMs) =>
  fetchJSON(p, { method: 'PUT', body: JSON.stringify(body), ...(timeoutMs ? { timeoutMs } : {}) });

/* Việc CHẬM THẬT (không phải treo) cần deadline riêng, đủ dài để không cắt oan:
 * cài MCP = git clone + build, env build, gọi tool MCP, chạy lệnh shell, chạy skill. */
const SLOW_MS = 180000;   // 3 phút
const TOOL_MS = 90000;    // 90s

/* ---------- REST surface ---------- */
export const api = {
  status: () => get('/api/status'),
  boot: () => get('/api/boot'),
  plugins: () => get('/api/plugins'),
  togglePlugin: (id, enabled) => post(`/api/plugins/${encodeURIComponent(id)}/toggle`, { enabled }),
  mcps: () => get('/api/mcps'),
  mcp: (id) => get(`/api/mcps/${encodeURIComponent(id)}`),
  connect: (id) => post(`/api/mcps/${encodeURIComponent(id)}/connect`, {}, TOOL_MS),   // spawn stdio + initialize + tools/list
  disconnect: (id) => post(`/api/mcps/${encodeURIComponent(id)}/disconnect`),
  installMcp: (id) => post(`/api/mcps/${encodeURIComponent(id)}/install`, {}, SLOW_MS),   // real server: git clone + build (log qua SSE 'log'.install)
  saveMcpEnv: (id, env) => put(`/api/mcps/${encodeURIComponent(id)}/env`, { env }), // env cho server thật
  invoke: (server, tool, args = {}, approved) =>
    post('/api/invoke', approved ? { server, tool, args, approved } : { server, tool, args }, TOOL_MS),
  skills: () => get('/api/skills'),
  skill: (id) => get(`/api/skills/${encodeURIComponent(id)}`),
  runSkill: (id, input = {}) => post(`/api/skills/${encodeURIComponent(id)}/run`, { input }, TOOL_MS),
  env: (fresh) => get('/api/env', undefined, fresh),                // sau env build phải đọc mới
  envBuild: (repair = false) => post('/api/env/build', { repair }, SLOW_MS),
  models: () => get('/api/models'),
  saveModels: (config) => put('/api/models/config', config),
  testModel: (provider) => post('/api/models/test', { provider }, TOOL_MS),
  agents: (fresh) => get('/api/agents', undefined, fresh),          // fresh=true sau mutation: KHÔNG gộp với request cũ
  spawnAgent: (body) => post('/api/agents', body, TOOL_MS),
  agent: (id, fresh) => get(`/api/agents/${encodeURIComponent(id)}`, undefined, fresh),
  sayAgent: (id, message) => post(`/api/agents/${encodeURIComponent(id)}/say`, { message }, TOOL_MS), // multi-turn: agent chạy tiếp
  cancelAgent: (id) => post(`/api/agents/${encodeURIComponent(id)}/cancel`),
  // Terminal tự động (anyclaw-style): session riêng · folder riêng · permission · shizuku
  termSessions: (fresh) => get('/api/terminal/sessions', undefined, fresh),
  termCreate: (name) => post('/api/terminal/sessions', { name }),
  term: (sid, fresh) => get(`/api/terminal/${encodeURIComponent(sid)}`, undefined, fresh),   // sau exec phải đọc mới
  termKill: (sid) => fetchJSON(`/api/terminal/${encodeURIComponent(sid)}`, { method: 'DELETE' }),
  termExec: (sid, command, via = 'local') => post(`/api/terminal/${encodeURIComponent(sid)}/exec`, { command, via }, TOOL_MS),
  permApprove: (pid) => post(`/api/terminal/perm/${encodeURIComponent(pid)}/approve`),
  permDeny: (pid) => post(`/api/terminal/perm/${encodeURIComponent(pid)}/deny`),
  shizuku: () => get('/api/shizuku'),
  shizukuSet: (enabled) => put('/api/shizuku', { enabled }),
};

/* ---------- OpenAI-compatible chat stream (/v1/chat/completions) ----------
 * Đọc SSE thủ công từ response.body: tách frame '\n\n', dòng 'data: ',
 * bỏ '[DONE]', cộng dồn delta.content → onDelta(chunk).
 *
 * Stream cũng phải có deadline, nhưng là deadline TRÊN TỪNG CHUNK (stall) chứ không
 * phải tổng thời gian — câu trả lời dài hợp lệ có thể chạy vài phút. Không có nó thì
 * server im giữa stream = promise treo vĩnh viễn → cờ busy của Chat không bao giờ nhả
 * và tab Chat khoá cứng.
 */
const CHAT_CONNECT_MS = 20000;   // chờ header phản hồi
const CHAT_STALL_MS = 60000;     // im lặng giữa 2 chunk

export async function chatCompletion({ model, messages, onDelta, signal }) {
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
  }
  let stallTimer = null;
  const armStall = (ms) => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ac.abort(new Error('stall')), ms);
  };

  let res;
  armStall(CHAT_CONNECT_MS);
  try {
    res = await fetch(API_BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(stallTimer);
    if (signal && signal.aborted) throw err;               // caller tự huỷ
    throw new Error(`Model không phản hồi trong ${CHAT_CONNECT_MS / 1000}s (mạng yếu hoặc server đã tắt)`);
  }
  if (!res.ok) {
    clearTimeout(stallTimer);
    let j = null;
    try { j = await res.json(); } catch { /* ignore */ }
    throw new Error((j && j.error) || `HTTP ${res.status}`);
  }

  const ctype = res.headers.get('content-type') || '';
  // Fallback: server trả JSON thường thay vì stream
  if (!res.body || ctype.includes('application/json')) {
    try {
      const j = await res.json();
      const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      if (content && onDelta) onDelta(content);
      return content;
    } finally { clearTimeout(stallTimer); }
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  try {
    for (;;) {
      armStall(CHAT_STALL_MS);
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal && signal.aborted) throw err;
        if (content) break;   // đã nhận được phần nào → giữ lại thay vì mất trắng
        throw new Error(`Model ngắt giữa stream (im lặng quá ${CHAT_STALL_MS / 1000}s)`);
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() || '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j;
          try { j = JSON.parse(data); } catch { continue; } // frame lệch — bỏ qua
          const choice = j.choices && j.choices[0];
          const delta = (choice && choice.delta && choice.delta.content) || '';
          if (delta) {
            content += delta;
            if (onDelta) onDelta(delta);
          }
        }
      }
    }
  } finally {
    clearTimeout(stallTimer);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return content;
}

/* ---------- SSE /api/events (tự reconnect 3s) ---------- */
const EVT_TYPES = ['log', 'skill-run', 'env', 'agent-step', 'mcp', 'plugin', 'boot', 'term', 'perm'];

/**
 * Kết nối EventSource tới /api/events.
 * - Parse payload JSON rồi đẩy vào onEvent(obj).
 * - Lắng nghe cả named events lẫn message mặc định (phòng server dùng event:).
 * - onerror → đóng và tự reconnect sau 3s.
 * @returns {{ close(): void }}
 */
export function connectEvents(onEvent) {
  if (typeof EventSource === 'undefined' || location.protocol === 'file:') {
    return { close() {} }; // môi trường không hỗ trợ — no-op an toàn
  }
  let es = null;
  let esBase = null;    // base mà kết nối hiện tại đang dùng
  let stopped = false;
  let timer = null;
  let backoff = 3000;   // API chết → giãn dần tới 30s, khỏi churn kết nối mỗi 3s

  function handle(ev) {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data && typeof data === 'object') {
      if (!data.type) data.type = ev.type === 'message' ? 'log' : ev.type;
      try { onEvent(data); } catch { /* listener lỗi không được chết kết nối */ }
    }
  }

  function open() {
    if (stopped) return;
    try {
      es = new EventSource(API_BASE + '/api/events');   // đọc base HIỆN TẠI mỗi lần mở lại
      esBase = API_BASE;                               // nhớ base đã dùng để phát hiện lệch
    } catch {
      timer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30000);
      return;
    }
    es.onopen = () => { backoff = 3000; };              // nối lại được → reset backoff
    es.onmessage = handle;
    for (const t of EVT_TYPES) es.addEventListener(t, handle);
    es.onerror = () => {
      try { es.close(); } catch { /* ignore */ }
      es = null;
      if (stopped) return;
      // Base đã đổi trong lúc kết nối lỗi (rediscover) → nối lại NGAY theo base mới,
      // không chờ backoff, vì lỗi này là do base cũ chết chứ không phải server mới.
      const delay = esBase !== API_BASE ? 0 : backoff;
      if (esBase === API_BASE) backoff = Math.min(backoff * 2, 30000);
      timer = setTimeout(open, delay);
    };
  }
  open();

  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (es) { try { es.close(); } catch { /* ignore */ } }
    },
    /** Đổi API base xong thì gọi cái này để SSE nối lại đúng địa chỉ mới. */
    reopen() {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
      backoff = 3000;
      open();
    },
  };
}
