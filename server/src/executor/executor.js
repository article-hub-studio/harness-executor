// executor.js — lõi MCP Executor: connect/disconnect/invoke + plugin pipeline + skills. SPEC §5.3
import { EventEmitter } from 'node:events';
import { appendFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Registry } from '../registry/registry.js';
import { createBuiltinTransport, createStdioTransport, createHttpTransport } from './mcp-client.js';

/** @typedef {import('../types.js').ToolResult} ToolResult */
/** @typedef {import('../types.js').McpTool} McpTool */
/** @typedef {import('../types.js').Plugin} Plugin */

const INVOKE_TIMEOUT_MS = 15_000;
const AUDIT_TAIL = 20;

const clip = (v, n) => {
  const s = String(v ?? '');
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
};
const fmtVal = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const deepClone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

/** Thay `{input.key}` và `{observations}` trong chuỗi template. */
function substitute(str, input, observationsText) {
  return String(str)
    .replace(/\{input\.([^}]+)\}/g, (_, k) => fmtVal(input?.[k.trim()]))
    .replace(/\{observations\}/g, observationsText);
}
/** Áp dụng substitute đệ quy lên toàn bộ object/array (argsTemplate). */
function substituteDeep(value, input, observationsText) {
  if (typeof value === 'string') return substitute(value, input, observationsText);
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, input, observationsText));
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteDeep(v, input, observationsText);
    return out;
  }
  return value;
}

export class Executor extends EventEmitter {
  /** @param {{dataDir:string, modelHub?:object}} opts */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.dataDir = opts.dataDir;
    /** ModelHub được inject qua opts (async chat({messages,model,temperature,stream}, onChunk)). */
    this.modelHub = opts.modelHub ?? null;
    this.registry = new Registry(this.dataDir);
    /** @type {Map<string, {transport:any, tools:McpTool[], kind:string}>} */
    this.transports = new Map();
    this.invocations = 0;
    this.auditPath = path.join(this.dataDir, 'audit.jsonl');
    this._ready = false;
  }

  /** nạp Registry + trạng thái */
  async init() {
    await mkdir(this.dataDir, { recursive: true });
    await this.registry.init();
    // process mới không còn transport sống → reset các state 'connected' cũ trong state.json
    for (const m of this.registry.mcps()) {
      if (m.state === 'connected') this.registry.setMcpState(m.id, 'disconnected');
    }
    this._ready = true;
  }

  _ensureReady() {
    if (!this._ready) throw new Error('Executor: gọi init() trước khi dùng');
  }

  // ------------------------------------------------------------- MCP

  /**
   * Kết nối tới một MCP theo descriptor trong registry.
   * @returns {Promise<{id:string, state:'connected', tools:McpTool[]}>}
   */
  async connect(id) {
    this._ensureReady();
    const desc = this.registry.mcp(id);
    if (!desc) throw new Error(`MCP '${id}' không tồn tại trong registry`);
    if (this.transports.has(id)) {
      return { id, state: 'connected', tools: this.transports.get(id).tools };
    }
    let transport;
    try {
      if (desc.transport === 'stdio') {
        transport = createStdioTransport({ command: desc.command, args: desc.args ?? [] });
      } else if (desc.transport === 'http') {
        transport = createHttpTransport({ url: desc.url });
      } else {
        transport = createBuiltinTransport(id);
      }
      // verify: stdio/http thử thật (lỗi → ném để router trả 502); builtin lấy tools nếu có
      let tools = Array.isArray(desc.tools) ? desc.tools : [];
      try {
        const listed = await transport.listTools();
        if (Array.isArray(listed) && listed.length) tools = listed;
      } catch (e) {
        if (desc.transport !== 'builtin') throw e;
      }
      this.transports.set(id, { transport, tools, kind: transport.kind ?? desc.transport });
    } catch (e) {
      try { await transport?.close(); } catch { /* ignore */ }
      throw new Error(`Không thể kết nối '${id}' (${desc.transport}): ${e?.message ?? e}`);
    }
    this.registry.setMcpState(id, 'connected');
    const tools = this.transports.get(id).tools;
    this.emit('mcp', { id, state: 'connected', tools: tools.length });
    this.emit('log', { level: 'info', line: `connect ${id} → connected (${tools.length} tools)` });
    return { id, state: 'connected', tools };
  }

  /** @returns {Promise<{id:string, state:'disconnected'}>} */
  async disconnect(id) {
    this._ensureReady();
    const entry = this.transports.get(id);
    if (entry) {
      this.transports.delete(id);
      try { await entry.transport.close(); } catch { /* ignore */ }
    }
    this.registry.setMcpState(id, 'disconnected');
    this.emit('mcp', { id, state: 'disconnected' });
    this.emit('log', { level: 'info', line: `disconnect ${id} → disconnected` });
    return { id, state: 'disconnected' };
  }

  isConnected(id) { return this.transports.has(id); }

  connectedCount() { return this.transports.size; }

  /** @returns {McpTool[]} tools đã cache lúc connect (sync). */
  getTools(id) { return this.transports.get(id)?.tools ?? []; }

  // ------------------------------------------------------------- invoke

  /** @returns {Plugin[]} plugin enabled đang khai báo hook này, ưu tiên popularity cao. */
  _pluginsWithHook(hookName) {
    return this.registry.plugins()
      .filter((p) => p.enabled && Array.isArray(p.hooks) && p.hooks.includes(hookName))
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  }

  /** Append 1 dòng JSON vào data/audit.jsonl (mkdir recursive nếu thiếu); lỗi audit không làm hỏng invoke. */
  async _audit(entry) {
    try {
      await mkdir(this.dataDir, { recursive: true });
      await appendFile(this.auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch { /* ignore */ }
  }

  /**
   * Gọi tool qua pipeline plugin + audit.
   * @param {string} server @param {string} tool @param {object} args @param {{source?:string, force?:boolean}} [ctx]
   * @returns {Promise<ToolResult>}
   */
  async invoke(server, tool, args = {}, ctx = {}) {
    this._ensureReady();
    const t0 = Date.now();
    const mocked = this.transports.get(server)?.kind === 'builtin';
    const pluginsApplied = [];
    /** @type {ToolResult} */
    let result;

    try {
      let entry = this.transports.get(server);
      if (!entry && ctx.force) {
        try { await this.connect(server); entry = this.transports.get(server); } catch { entry = null; }
      }
      if (!entry) {
        result = { ok: false, error: `server '${server}' chưa kết nối`, meta: {} };
      } else {
        // 1. preInvoke của plugin enabled (observer mặc định: ghi tên plugin; hook fn có thể sửa args)
        let callArgs = deepClone(args ?? {});
        for (const p of this._pluginsWithHook('preInvoke')) {
          pluginsApplied.push(p.id);
          if (typeof /** @type {any} */ (p).preInvoke === 'function') {
            try { callArgs = (await p.preInvoke(callArgs, { ...ctx, plugin: p.id })) ?? callArgs; } catch { /* giữ args */ }
          }
        }
        // 2. gọi transport (timeout 15s)
        let timer;
        const raw = await Promise.race([
          entry.transport.call(tool, callArgs, { ...ctx, pluginsApplied }),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ __timeout: true }), INVOKE_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
        // 3. postInvoke
        let res = raw?.__timeout
          ? { ok: false, error: 'timeout', meta: {} }
          : /** @type {ToolResult} */ (raw);
        // chuẩn hoá mọi biến thể timeout (vd 'timeout tools/call (10000ms)' của stdio) → 'timeout'
        if (!res.ok && /^\s*timeout/i.test(String(res.error ?? '')) && String(res.error) !== 'timeout') {
          res.meta = { ...(res.meta ?? {}), timeoutDetail: res.error };
          res.error = 'timeout';
        }
        for (const p of this._pluginsWithHook('postInvoke')) {
          pluginsApplied.push(p.id);
          if (typeof /** @type {any} */ (p).postInvoke === 'function') {
            try { res = (await p.postInvoke(res, { ...ctx, plugin: p.id })) ?? res; } catch { /* giữ result */ }
          }
        }
        result = res;
      }
    } catch (e) {
      result = { ok: false, error: String(e?.message ?? e), meta: {} };
    }

    const durationMs = Date.now() - t0;
    // canonical fields của executor luôn thắng; giữ lại key phụ từ transport
    result.meta = { ...(result.meta ?? {}), server, tool, durationMs, mocked, pluginsApplied };

    this.invocations += 1;
    this.emit('log', {
      level: 'info',
      line: `invoke ${server}.${tool} → ${result.ok ? 'ok' : 'error'} (${durationMs}ms)`,
    });
    void this._audit({
      ts: new Date().toISOString(),
      server, tool,
      args,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error }),
      durationMs, mocked,
      source: ctx.source ?? 'web',
      pluginsApplied,
    });
    return result;
  }

  // ------------------------------------------------------------- Plugins / Skills / stats

  plugins(filter = {}) {
    this._ensureReady();
    return this.registry.plugins(filter);
  }

  /** @returns {Plugin|null} plugin sau khi đổi trạng thái (null nếu không tồn tại). */
  togglePlugin(id, enabled) {
    this._ensureReady();
    const p = this.registry.setPluginEnabled(id, !!enabled);
    if (p) this.emit('plugin', { id: p.id, enabled: p.enabled });
    return p;
  }

  // --- Passthrough registry (bắt buộc) ---

  /** Danh sách MCP (q/category từ Registry) với `state` theo isConnected; status lọc trên state sống. */
  mcps(filter = {}) {
    this._ensureReady();
    const { status, ...rest } = filter ?? {};
    const items = this.registry.mcps(rest)
      .map((m) => ({ ...m, state: this.transports.has(m.id) ? 'connected' : 'disconnected' }));
    const st = String(status ?? '').trim().toLowerCase();
    return st ? items.filter((m) => m.state === st) : items;
  }

  /** MCP đơn lẻ kèm `state` theo isConnected. */
  mcp(id) {
    this._ensureReady();
    const m = this.registry.mcp(id);
    return m ? { ...m, state: this.transports.has(m.id) ? 'connected' : 'disconnected' } : m;
  }
  plugin(id) { this._ensureReady(); return this.registry.plugin(id); }
  skills(filter = {}) { this._ensureReady(); return this.registry.skills(filter); }
  skill(id) { this._ensureReady(); return this.registry.skill(id); }

  /**
   * Chạy skill nhiều bước — trả {runId} NGAY (sync); các bước chạy nền bất đồng bộ,
   * từng bước emit('skill-run',{runId,i,total,type,status,detail}).
   * Lỗi 1 step không dừng run. Ném sync Error nếu skill không tồn tại (router → 404).
   * @returns {{runId:string, total:number}}
   */
  runSkill(id, input = {}, emit = () => {}) {
    this._ensureReady();
    const skill = this.registry.skill(id);
    if (!skill) throw new Error(`skill '${id}' không tồn tại`);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const steps = Array.isArray(skill.steps) ? skill.steps : [];
    const total = steps.length;
    // worker nền: _runSkillSteps tự bắt lỗi từng step; .catch chỉ là lưới an toàn cuối
    void this._runSkillSteps(skill, runId, input ?? {}, emit).catch(() => {});
    return { runId, total };
  }

  /** @private Vòng lặp các bước của skill (chạy nền sau khi runSkill đã phản hồi). */
  async _runSkillSteps(skill, runId, input, emit = () => {}) {
    const steps = Array.isArray(skill.steps) ? skill.steps : [];
    const total = steps.length;
    const progress = (i, type, status, detail) => {
      const payload = { runId, i, total, type, status, detail: clip(detail, 300) };
      try { emit('skill-run', payload); } catch { /* emitter lỗi không làm hỏng run */ }
      this.emit('skill-run', payload);
    };
    /** @type {string[]} quan sát rút gọn từ các step trước */
    const observations = [];

    for (let idx = 0; idx < steps.length; idx++) {
      const step = steps[idx];
      const i = idx + 1;
      const obsText = observations.join('\n');
      try {
        if (step.type === 'note') {
          progress(i, 'note', 'ok', step.prompt || step.text || `note: ${skill.name}`);
          continue;
        }
        if (step.type === 'model') {
          if (!this.modelHub) throw new Error('modelHub chưa cấu hình');
          let prompt = substitute(step.prompt ?? '', input, obsText);
          if (!String(step.prompt ?? '').includes('{observations}') && observations.length) {
            prompt += `\n\nOBSERVATIONS:\n${obsText}`;
          }
          const messages = [{ role: 'user', content: prompt }];
          const r = await this.modelHub.chat({ messages, model: undefined, temperature: undefined, stream: false });
          const text = clip(r?.content ?? r, 300);
          observations.push(`model: ${clip(r?.content ?? r, 160)}`);
          progress(i, 'model', 'ok', text);
          continue;
        }
        // --- step.type === 'tool' ---
        const toolName = String(step.tool ?? '');
        if (!toolName) throw new Error('step tool thiếu tên tool');
        const tpl = deepClone(step.argsTemplate ?? {});
        // argsTemplate.server là chỉ định server, không phải data → tách ra trước khi thay thế
        const explicitServer = step.server ?? tpl.server;
        delete tpl.server;
        const args = substituteDeep(tpl, input, obsText);

        let serverId = explicitServer;
        if (!serverId) {
          const hit = [...this.transports.entries()].find(([, e]) => e.tools.some((t) => t.name === toolName));
          serverId = hit?.[0];
        }
        if (!serverId) {
          // chưa có server nào connect → tự connect server builtin đầu tiên (theo thứ tự registry) có tool đó
          const cand = this.registry.mcps().find(
            (m) => m.transport === 'builtin' && (m.tools ?? []).some((t) => t.name === toolName),
          );
          if (!cand) throw new Error(`không có server nào cung cấp tool '${toolName}'`);
          await this.connect(cand.id);
          serverId = cand.id;
        }

        const r = await this.invoke(serverId, toolName, args, { source: 'skill' });
        const detail = r.ok ? clip(fmtVal(r.result), 300) : String(r.error ?? 'unknown error');
        observations.push(`${serverId}.${toolName}: ${r.ok ? clip(fmtVal(r.result), 120) : `LỖI ${clip(r.error, 100)}`}`);
        progress(i, 'tool', r.ok ? 'ok' : 'error', detail);
      } catch (e) {
        observations.push(`step ${i} (${step.type}): LỖI ${clip(String(e?.message ?? e), 120)}`);
        progress(i, step.type ?? 'unknown', 'error', String(e?.message ?? e));
      }
    }
    return { runId, total };
  }

  /** Đọc tối đa `tail` dòng cuối của data/audit.jsonl (parse JSON từng dòng, bỏ dòng hỏng). */
  _lastAudit(tail = AUDIT_TAIL) {
    try {
      const lines = readFileSync(this.auditPath, 'utf8').split('\n').filter((l) => l.trim());
      return lines.slice(-tail).flatMap((l) => {
        try { return [JSON.parse(l)]; } catch { return []; }
      });
    } catch { return []; }
  }

  /** @returns {{counts:{plugins:number,mcps:number,skills:number}, connectedMcps:number, invocations:number, lastAudit:any[]}} */
  stats() {
    this._ensureReady();
    return {
      counts: this.registry.counts(),
      connectedMcps: this.connectedCount(),
      invocations: this.invocations,
      lastAudit: this._lastAudit(),
    };
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  console.log('executor.js demo — new Executor({dataDir}).init() rồi connect/invoke/runSkill');
}
