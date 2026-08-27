// mcp-client.js — transport factories cho MCP THẬT (stdio/http). Xem docs/SPEC.md §5.2
import { spawn } from 'node:child_process';

/** @typedef {import('../types.js').ToolResult} ToolResult */
/** @typedef {import('../types.js').McpTool} McpTool */

const CALL_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------- helpers

/**
 * @param {{server:string, tool:string, mocked:boolean}} base
 * @param {number} t0
 * @param {object} [extra]
 */
function meta(base, t0, extra = {}) {
  return { server: base.server, tool: base.tool, durationMs: Date.now() - t0, mocked: base.mocked, ...extra };
}

/** @returns {ToolResult} */
function errResult(base, t0, error, extra = {}) {
  return { ok: false, error: String(error ?? 'unknown error'), meta: meta(base, t0, extra) };
}

/**
 * Chuẩn hoá bất kỳ giá trị trả về nào thành ToolResult hợp lệ.
 * @param {*} r @param {{server:string, tool:string, mocked:boolean}} base @param {number} t0 @returns {ToolResult}
 */
function toToolResult(r, base, t0) {
  if (r && typeof r === 'object' && typeof r.ok === 'boolean') {
    const out = /** @type {any} */ ({ ok: r.ok, meta: { ...meta(base, t0), ...(r.meta ?? {}) } });
    if (r.ok) out.result = r.result;
    else out.error = String(r.error ?? 'unknown error');
    return out;
  }
  return { ok: true, result: r, meta: meta(base, t0) };
}

/**
 * Rút kết quả từ payload MCP `tools/call` (chuẩn spec MCP):
 *   - result.content là mảng → nối text parts bằng '\n' → thử JSON.parse toàn bộ
 *     (thành object thì dùng object, fail thì giữ string);
 *   - result.isError === true → ok:false với error = text;
 *   - result KHÔNG có content → đưa nguyên result.
 * @param {*} res @returns {{ok:boolean, result?:any, error?:string}}
 */
function extractMcpCall(res) {
  if (!res || typeof res !== 'object') return { ok: true, result: res };
  if (res.isError === true) {
    const t = Array.isArray(res.content)
      ? res.content.map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n')
      : '';
    return { ok: false, error: t || res.error?.message || 'tool execution error' };
  }
  if (!Array.isArray(res.content)) return { ok: true, result: res }; // không có content → nguyên result
  const texts = res.content
    .map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : c?.type ? `[${c.type}]` : ''))
    .filter(Boolean)
    .join('\n');
  let out = texts;
  if (texts) {
    try {
      const v = JSON.parse(texts);
      if (v && typeof v === 'object') out = v; // chỉ nhận object/array, còn lại giữ string
    } catch { /* không parse được → giữ string */ }
  }
  return { ok: true, result: out };
}

// ---------------------------------------------------------------- stdio

const STDERR_TAIL_LINES = 40;     // giữ tail stderr ~40 dòng
const STDERR_TAIL_CHARS = 8_000;
const INIT_TIMEOUT_MS = 10_000;   // timeout handshake initialize
/** Env rút gọn truyền xuống process con (PATH/HOME/LAG… tối thiểu) + env do executor cung cấp đè. */
const SPAWN_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'TMPDIR'];

/**
 * Transport stdio thật: spawn process, JSON-RPC 2.0 line-delimited (MCP),
 * handshake ĐÚNG spec: initialize → chờ result → notifications/initialized → mới tools/*.
 * Server→client request (ping/sampling/…) → trả JSON-RPC error -32601; notification → bỏ qua.
 * Timeout mỗi call 10s (listTools dùng listToolsTimeoutMs nếu cấp). close() kill sạch + reject pending.
 * @param {{command:string, args?:string[], env?:Record<string,string>, cwd?:string,
 *          listToolsTimeoutMs?:number}} opts
 */
export function createStdioTransport({ command, args = [], env = {}, cwd, listToolsTimeoutMs }) {
  const base = { server: command ?? 'stdio', tool: '*', mocked: false };
  const LIST_TIMEOUT_MS = Number.isFinite(listToolsTimeoutMs) && listToolsTimeoutMs > 0
    ? listToolsTimeoutMs
    : CALL_TIMEOUT_MS;
  /** @type {import('node:child_process').ChildProcess|null} */
  let proc = null;
  let nextId = 1;
  let buf = '';
  let stderrTail = '';
  let closed = false;
  let handshook = false;
  /** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void, timer:NodeJS.Timeout}>} */
  const pending = new Map();

  const failAll = (why) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    pending.clear();
  };

  /** Tail stderr: tối đa ~40 dòng cuối (kèm trần ký tự). */
  const stderrTailText = () => {
    const lines = stderrTail.split('\n').filter((l) => l.trim()).slice(-STDERR_TAIL_LINES);
    return lines.join('\n').slice(-STDERR_TAIL_CHARS);
  };

  const start = () => {
    if (proc || closed) return proc;
    /** @type {Record<string, string>} */
    const slimEnv = {};
    for (const k of SPAWN_ENV_KEYS) {
      if (process.env[k] != null) slimEnv[k] = process.env[k];
    }
    // detached → process con đứng đầu process group của nó để close() kill được CẢ CÂY
    // (một số server thật tự spawn helper con — kill riêng cha sẽ để lại orphan).
    proc = spawn(command, args, {
      cwd,
      env: { ...slimEnv, ...(env && typeof env === 'object' ? env : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) handleLine(line);
      }
    });
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (d) => { stderrTail = `${stderrTail}${d}`.slice(-STDERR_TAIL_CHARS); });
    proc.on('error', (e) => { failAll(`stdio spawn lỗi: ${e.message}`); });
    proc.on('exit', (code) => {
      proc = null; handshook = false; buf = '';
      const tail = stderrTailText();
      failAll(`stdio process đã thoát (code ${code})${tail ? `:\n${tail}` : ''}`);
    });
    return proc;
  };

  /** Kill cả process tree (process group khi detached) rồi fallback kill riêng. */
  const killTree = (p, sig = 'SIGTERM') => {
    try {
      if (p.pid && process.platform !== 'win32') process.kill(-p.pid, sig);
      else p.kill(sig);
    } catch { try { p.kill(sig); } catch { /* ignore */ } }
  };

  const writeLine = (obj) => {
    try { proc?.stdin?.write(`${JSON.stringify(obj)}\n`); } catch { /* stdin chết → pending sẽ timeout/reject */ }
  };

  const handleLine = (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // bỏ dòng không phải JSON
    if (!msg || typeof msg !== 'object') return;
    // Server→client REQUEST (vd 'ping', 'sampling/createMessage'): không hỗ trợ → trả lỗi -32601
    if (typeof msg.method === 'string') {
      if (msg.id != null) {
        writeLine({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        });
      }
      return; // notification từ server → ignore
    }
    if (msg.id == null) return; // response phải có id
    const idNum = Number(msg.id);
    const p = Number.isFinite(idNum) ? pending.get(idNum) : undefined;
    if (!p) return;
    pending.delete(idNum);
    clearTimeout(p.timer);
    p.resolve(msg);
  };

  /**
   * Gửi 1 JSON-RPC request và chờ response.
   * @returns {Promise<{result?:any, error?:{code:number,message:string}}>}
   */
  const request = (method, params, timeoutMs = CALL_TIMEOUT_MS) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('transport đã đóng'));
    const p = start();
    if (!p.stdin?.writable) return reject(new Error(`không spawn được '${command}'`));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout ${method} (${timeoutMs}ms)`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (err) => {
      if (err) { pending.delete(id); clearTimeout(timer); reject(new Error(`ghi stdin lỗi: ${err.message}`)); }
    });
  });

  const notify = (method, params = {}) => {
    writeLine({ jsonrpc: '2.0', method, params });
  };

  /** Handshake MCP spec: initialize → result → notifications/initialized (chạy đúng 1 lần). */
  let initPromise = null;
  const handshake = () => {
    if (handshook) return Promise.resolve();
    if (!initPromise) {
      initPromise = request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'upio-harness', version: '1.0.0' },
      }, INIT_TIMEOUT_MS).then((msg) => {
        if (msg.error) throw new Error(`initialize bị từ chối: ${msg.error.message}`);
        notify('notifications/initialized'); // CHỈ gửi sau khi có result initialize
        handshook = true;
      }).catch((e) => { initPromise = null; throw e; });
    }
    return initPromise;
  };

  return {
    kind: 'stdio',
    async listTools() {
      await handshake(); // chưa handshake xong thì chưa được tools/*
      const msg = await request('tools/list', {}, LIST_TIMEOUT_MS);
      if (msg.error) throw new Error(msg.error.message);
      return Array.isArray(msg.result?.tools) ? msg.result.tools : [];
    },
    /**
     * @param {string} tool @param {object} args @param {object} [ctx]
     * @returns {Promise<ToolResult>}
     */
    async call(tool, args = {}, ctx = {}) {
      const t0 = Date.now();
      const b = { ...base, tool };
      if (!command) return errResult(b, t0, 'stdio transport thiếu command');
      if (closed) return errResult(b, t0, 'transport đã đóng');
      try {
        await handshake();
        const msg = await request('tools/call', { name: tool, arguments: args }, ctx?.timeoutMs);
        if (msg.error) return errResult(b, t0, msg.error.message ?? 'JSON-RPC error', { code: msg.error.code });
        const out = extractMcpCall(msg.result);
        return out.ok
          ? { ok: true, result: out.result, meta: meta(b, t0) }
          : errResult(b, t0, out.error);
      } catch (e) {
        return errResult(b, t0, e?.message ?? e);
      }
    },
    async close() {
      closed = true;
      handshook = false;
      initPromise = null;
      failAll('transport đã đóng');
      buf = '';
      const p = proc;
      proc = null;
      if (!p) return;
      try { p.stdin?.end(); } catch { /* ignore */ }
      killTree(p, 'SIGTERM');
      const force = setTimeout(() => { killTree(p, 'SIGKILL'); }, 1500);
      force.unref?.();
    },
  };
}

// ---------------------------------------------------------------- http

/**
 * Transport HTTP: POST JSON-RPC tới url (MCP streamable-http tối giản).
 * @param {{url:string, headers?:Record<string,string>}} opts
 */
export function createHttpTransport({ url, headers = {} }) {
  const base = { server: url ?? 'http', tool: '*', mocked: false };
  let nextId = 1;
  let closed = false;

  /** POST một request, trả message JSON-RPC (chấp nhận response JSON thuần hoặc SSE data lines). */
  const postRpc = async (method, params, timeoutMs = CALL_TIMEOUT_MS) => {
    const body = { jsonrpc: '2.0', id: nextId++, method, params };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
    try { return JSON.parse(text); } catch { /* có thể là SSE stream */ }
    for (const line of text.split('\n').reverse()) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(l.slice(5).trim());
        if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return msg;
      } catch { /* thử dòng tiếp theo */ }
    }
    throw new Error('response không phải JSON-RPC hợp lệ');
  };

  const rpc = async (method, params) => {
    const msg = await postRpc(method, params);
    if (msg?.error) throw Object.assign(new Error(msg.error.message ?? 'JSON-RPC error'), { code: msg.error.code });
    return msg?.result;
  };

  return {
    kind: 'http',
    async listTools() {
      const result = await rpc('tools/list', {});
      return Array.isArray(result?.tools) ? result.tools : [];
    },
    /**
     * @param {string} tool @param {object} args @param {object} [ctx]
     * @returns {Promise<ToolResult>}
     */
    async call(tool, args = {}, ctx = {}) {
      const t0 = Date.now();
      const b = { ...base, tool };
      if (!url) return errResult(b, t0, 'http transport thiếu url');
      if (closed) return errResult(b, t0, 'transport đã đóng');
      try {
        const out = extractMcpCall(await rpc('tools/call', { name: tool, arguments: args }));
        return out.ok
          ? { ok: true, result: out.result, meta: meta(b, t0) }
          : errResult(b, t0, out.error);
      } catch (e) {
        const why = e?.name === 'TimeoutError' ? `timeout sau ${CALL_TIMEOUT_MS}ms` : e?.message ?? e;
        return errResult(b, t0, why);
      }
    },
    async close() { closed = true; },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  console.log('mcp-client.js demo — createStdioTransport/createHttpTransport (chỉ MCP thật)');
}
