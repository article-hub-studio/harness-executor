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
export async function fetchJSON(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: {
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
  } catch {
    throw new Error('Không thể kết nối API (mạng offline)');
  }
  let body = null;
  try { body = await res.json(); } catch { /* body rỗng */ }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

const get = (p) => fetchJSON(p);
const post = (p, body = {}) => fetchJSON(p, { method: 'POST', body: JSON.stringify(body) });
const put = (p, body = {}) => fetchJSON(p, { method: 'PUT', body: JSON.stringify(body) });

/* ---------- REST surface ---------- */
export const api = {
  status: () => get('/api/status'),
  boot: () => get('/api/boot'),
  plugins: () => get('/api/plugins'),
  togglePlugin: (id, enabled) => post(`/api/plugins/${encodeURIComponent(id)}/toggle`, { enabled }),
  mcps: () => get('/api/mcps'),
  mcp: (id) => get(`/api/mcps/${encodeURIComponent(id)}`),
  connect: (id) => post(`/api/mcps/${encodeURIComponent(id)}/connect`),
  disconnect: (id) => post(`/api/mcps/${encodeURIComponent(id)}/disconnect`),
  installMcp: (id) => post(`/api/mcps/${encodeURIComponent(id)}/install`),   // real server: git clone + build (log qua SSE 'log'.install)
  saveMcpEnv: (id, env) => put(`/api/mcps/${encodeURIComponent(id)}/env`, { env }), // env cho server thật
  invoke: (server, tool, args = {}, approved) =>
    post('/api/invoke', approved ? { server, tool, args, approved } : { server, tool, args }),
  skills: () => get('/api/skills'),
  skill: (id) => get(`/api/skills/${encodeURIComponent(id)}`),
  runSkill: (id, input = {}) => post(`/api/skills/${encodeURIComponent(id)}/run`, { input }),
  env: () => get('/api/env'),
  envBuild: (repair = false) => post('/api/env/build', { repair }),
  models: () => get('/api/models'),
  saveModels: (config) => put('/api/models/config', config),
  testModel: (provider) => post('/api/models/test', { provider }),
  agents: () => get('/api/agents'),
  spawnAgent: (body) => post('/api/agents', body),
  agent: (id) => get(`/api/agents/${encodeURIComponent(id)}`),
  sayAgent: (id, message) => post(`/api/agents/${encodeURIComponent(id)}/say`, { message }), // multi-turn: agent chạy tiếp
  cancelAgent: (id) => post(`/api/agents/${encodeURIComponent(id)}/cancel`),
  // Terminal tự động (anyclaw-style): session riêng · folder riêng · permission · shizuku
  termSessions: () => get('/api/terminal/sessions'),
  termCreate: (name) => post('/api/terminal/sessions', { name }),
  term: (sid) => get(`/api/terminal/${encodeURIComponent(sid)}`),
  termKill: (sid) => fetchJSON(`/api/terminal/${encodeURIComponent(sid)}`, { method: 'DELETE' }).then((r) => r.json),
  termExec: (sid, command, via = 'local') => post(`/api/terminal/${encodeURIComponent(sid)}/exec`, { command, via }),
  permApprove: (pid) => post(`/api/terminal/perm/${encodeURIComponent(pid)}/approve`),
  permDeny: (pid) => post(`/api/terminal/perm/${encodeURIComponent(pid)}/deny`),
  shizuku: () => get('/api/shizuku'),
  shizukuSet: (enabled) => put('/api/shizuku', { enabled }),
};

/* ---------- OpenAI-compatible chat stream (/v1/chat/completions) ----------
 * Đọc SSE thủ công từ response.body: tách frame '\n\n', dòng 'data: ',
 * bỏ '[DONE]', cộng dồn delta.content → onDelta(chunk).
 */
export async function chatCompletion({ model, messages, onDelta, signal }) {
  let res;
  try {
    res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new Error('Không thể kết nối API (mạng offline)');
  }
  if (!res.ok) {
    let j = null;
    try { j = await res.json(); } catch { /* ignore */ }
    throw new Error((j && j.error) || `HTTP ${res.status}`);
  }

  const ctype = res.headers.get('content-type') || '';
  // Fallback: server trả JSON thường thay vì stream
  if (!res.body || ctype.includes('application/json')) {
    const j = await res.json();
    const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    if (content && onDelta) onDelta(content);
    return content;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
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
  return content;
}

/* ---------- SSE /api/events (tự reconnect 3s) ---------- */
const EVT_TYPES = ['log', 'skill-run', 'env', 'agent-step', 'mcp', 'plugin', 'boot'];

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
  let stopped = false;
  let timer = null;

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
      es = new EventSource('/api/events');
      es.retryMs = 3000;
    } catch {
      timer = setTimeout(open, 3000);
      return;
    }
    es.onmessage = handle;
    for (const t of EVT_TYPES) es.addEventListener(t, handle);
    es.onerror = () => {
      try { es.close(); } catch { /* ignore */ }
      es = null;
      if (!stopped) timer = setTimeout(open, 3000);
    };
  }
  open();

  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (es) { try { es.close(); } catch { /* ignore */ } }
    },
  };
}
