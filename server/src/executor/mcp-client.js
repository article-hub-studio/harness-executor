// mcp-client.js — transport factories cho MCP (builtin/stdio/http). Xem docs/SPEC.md §5.2
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
 * Rút kết quả từ payload MCP `tools/call` ({content:[{type:'text',text}], structuredContent?, isError?}).
 * @param {*} res @returns {{ok:boolean, result?:any, error?:string}}
 */
function extractMcpCall(res) {
  if (!res || typeof res !== 'object') return { ok: true, result: res };
  const texts = Array.isArray(res.content)
    ? res.content.map((c) => (c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : '')).filter(Boolean).join('\n')
    : '';
  if (res.isError === true) return { ok: false, error: texts || res.error?.message || 'tool execution error' };
  const result = res.structuredContent ?? (Array.isArray(res.content) ? (texts || null) : res);
  return { ok: true, result };
}

// ---------------------------------------------------------------- builtin

let _builtinModPromise = null;
/** Lazy-load builtin-servers (agent SA-builtin có thể đang viết song song file này). */
async function loadBuiltinModule() {
  if (!_builtinModPromise) _builtinModPromise = import('./builtin-servers/index.js');
  try { return await _builtinModPromise; } catch (e) {
    _builtinModPromise = null; // cho phép retry ở lần sau (vd file vừa được viết xong)
    throw e;
  }
}

/**
 * Transport nội bộ qua builtin-servers.
 * @param {string} serverId @returns {{kind:'builtin',listTools():Promise<McpTool[]>,call(tool:string,args:object,ctx?:object):Promise<ToolResult>,close():Promise<void>}}
 */
export function createBuiltinTransport(serverId) {
  const base = { server: serverId, tool: '*', mocked: true };
  const getServer = async () => {
    const mod = await loadBuiltinModule();
    return mod.getServer(serverId);
  };
  return {
    kind: 'builtin',
    async listTools() {
      try {
        const srv = await getServer();
        return Array.isArray(srv?.tools) ? srv.tools : [];
      } catch { return []; }
    },
    /**
     * @param {string} tool @param {object} args @param {object} [ctx]
     * @returns {Promise<ToolResult>}
     */
    async call(tool, args = {}, ctx = {}) {
      const t0 = Date.now();
      let srv;
      try { srv = await getServer(); } catch (e) {
        return errResult({ ...base, tool }, t0, `builtin-servers unavailable: ${e?.message ?? e}`);
      }
      if (!srv || typeof srv.call !== 'function') {
        return errResult({ ...base, tool }, t0, `builtin server '${serverId}' không khả dụng`);
      }
      try {
        return toToolResult(await srv.call(tool, args, ctx), { ...base, tool }, t0);
      } catch (e) {
        return errResult({ ...base, tool }, t0, e?.message ?? e);
      }
    },
    async close() { /* builtin không cần dọn tài nguyên */ },
  };
}

// ---------------------------------------------------------------- stdio

/**
 * Transport stdio thật: spawn process, JSON-RPC 2.0 line-delimited (MCP),
 * handshake `initialize`, timeout 10s mỗi call, dọn process khi close().
 * @param {{command:string, args?:string[]}} opts
 */
export function createStdioTransport({ command, args = [] }) {
  const base = { server: command ?? 'stdio', tool: '*', mocked: false };
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

  const start = () => {
    if (proc || closed) return proc;
    proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
    proc.stderr?.on('data', (d) => { stderrTail = `${stderrTail}${d}`.slice(-2000); });
    proc.on('error', (e) => { failAll(`stdio spawn lỗi: ${e.message}`); });
    proc.on('exit', (code) => {
      proc = null; handshook = false;
      failAll(`stdio process đã thoát (code ${code})${stderrTail ? `: ${stderrTail.split('\n').pop()}` : ''}`);
    });
    return proc;
  };

  const handleLine = (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // bỏ dòng không phải JSON
    if (msg == null || msg.id == null) return; // notification → bỏ qua
    const p = pending.get(Number(msg.id));
    if (!p) return;
    pending.delete(Number(msg.id));
    clearTimeout(p.timer);
    p.resolve(msg);
  };

  /**
   * Gửi 1 JSON-RPC request và chờ response (timeout 10s).
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
    try { proc?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); } catch { /* ignore */ }
  };

  /** Handshake MCP: initialize → notifications/initialized (chạy đúng 1 lần). */
  let initPromise = null;
  const handshake = () => {
    if (handshook) return Promise.resolve();
    if (!initPromise) {
      initPromise = request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'upio-executor', version: '1.0.0' },
      }).then((msg) => {
        if (msg.error) throw new Error(`initialize bị từ chối: ${msg.error.message}`);
        notify('notifications/initialized');
        handshook = true;
      }).catch((e) => { initPromise = null; throw e; });
    }
    return initPromise;
  };

  return {
    kind: 'stdio',
    async listTools() {
      await handshake();
      const msg = await request('tools/list');
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
        const msg = await request('tools/call', { name: tool, arguments: args });
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
      failAll('transport đã đóng');
      const p = proc;
      proc = null;
      if (!p) return;
      try { p.kill('SIGTERM'); } catch { /* ignore */ }
      const force = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }, 1500);
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
  console.log('mcp-client.js demo — createBuiltinTransport/createStdioTransport/createHttpTransport');
}
