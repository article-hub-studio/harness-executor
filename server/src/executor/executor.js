// executor.js — lõi MCP Executor: connect/disconnect/invoke + plugin pipeline (kèm BEHAVIORS)
// + skills + hỗ trợ MCP THẬT (real:true: install/connect/gate approved). Xem docs/SPEC.md §5.3
import { EventEmitter } from 'node:events';
import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Registry } from '../registry/registry.js';
import { createStdioTransport, createHttpTransport } from './mcp-client.js';
import { BEHAVIORS } from './plugin-behaviors.js';

/** @typedef {import('../types.js').ToolResult} ToolResult */
/** @typedef {import('../types.js').McpTool} McpTool */
/** @typedef {import('../types.js').Plugin} Plugin */

const INVOKE_TIMEOUT_MS = 15_000;
const AUDIT_TAIL = 20;
const INSTALL_TIMEOUT_MS = 10 * 60_000; // 10 phút cho clone/build server thật
const LIST_TOOLS_TIMEOUT_MS = 90_000;   // tools/list cho server thật (npx cold-start có thể chậm)
/**
 * Whitelist tool "đọc-an toàn" cho MCP thật: không cần ctx.approved.
 * Mọi tool khác trên server real → bắt buộc approved=true.
 *
 * Phiên bản Luau/LSP: mọi server đều real, nên whitelist phải bao gồm các tool
 * chỉ-đọc của luau-lsp và các LSP bridge. Tool ghi/thực thi (execute, rename,
 * write_file, mutate_*, manage_*, code_action…) KHÔNG nằm ở đây → vẫn cần duyệt.
 */
const SAFE_TOOL_RX = new RegExp([
  '^(list[-_]|get[-_]|search|semantic|script-grep)',           // whitelist cũ
  '^luau_(analyze|check_source|require_graph|document_symbols|hover|definition|lint_rules|version)$',
  '^lsp_(init|health|definition|type_definition|implementation|references|hover|signature_help)$',
  '^lsp_(document_symbols|workspace_symbols|diagnostics|workspace_diagnostics|completions)$',
  '^lsp_(goto_definition|goto_type_definition|find_references|find_implementations)$',
  '^lsp_(file_exports|file_imports|related_files)$',
  '^(read_file|read_text_file|list_directory|directory_tree|get_file_info|search_files)$',
  '^git_(status|log|show|diff|diff_staged|diff_unstaged)$',
  '^(read_graph|search_nodes|open_nodes)$',
  '^(system_info|scene_overview|describe_instance|find_instances|query_instances)$',
].join('|'), 'i');

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
  /** @param {{dataDir:string, rootDir?:string, modelHub?:object, rebuild?:boolean}} opts */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.dataDir = opts.dataDir;
    /** Path gốc dự án (cho MCP thật: clone dir, workspace, args tương đối). */
    this.rootDir = opts.rootDir
      ?? (this.dataDir ? path.resolve(this.dataDir, '..') : process.cwd());
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

  /** @returns {(McpDescriptor&{state:string})|null} descriptor nếu server là MCP THẬT (real:true). */
  _realDesc(id) {
    const desc = this.registry.mcp(id);
    return desc && desc.real === true ? desc : null;
  }

  /**
   * Server thực đã cài chưa? git-clone/bundled → kiểm tra file entry; npx → coi là có.
   * @param {string} id @returns {Promise<boolean>}
   */
  async isRealInstalled(id) {
    this._ensureReady();
    const desc = this._realDesc(id);
    if (!desc) return false;
    const install = desc.install ?? {};
    if (install.method === 'git-clone' || install.method === 'bundled') {
      if (!install.dir) return false;
      return existsSync(path.join(this.rootDir, install.dir, install.entry ?? 'dist/index.js'));
    }
    return true; // npx / phương thức khác → không cần bản cài đặt local trước
  }

  /** Spawn process, stream TỪNG DÒNG stdout/stderr qua log(), kill khi vượt timeout. */
  _streamProc(command, argsArr, { cwd, timeoutMs = INSTALL_TIMEOUT_MS }, log) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, argsArr, { cwd, env: process.env });
      } catch (e) {
        log('error', `spawn '${command}' lỗi: ${e?.message ?? e}`);
        resolve({ ok: false, code: -1 });
        return;
      }
      let settled = false;
      let timer;
      const fin = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      timer = setTimeout(() => {
        log('error', `timeout sau ${Math.round(timeoutMs / 1000)}s — kill '${command}'`);
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        fin({ ok: false, code: null, timedOut: true });
      }, timeoutMs);
      timer.unref?.();
      const pipe = (stream, level) => {
        if (!stream) return;
        let b = '';
        stream.setEncoding('utf8');
        stream.on('data', (d) => {
          b += d;
          let i;
          while ((i = b.indexOf('\n')) >= 0) {
            const line = b.slice(0, i).trim();
            b = b.slice(i + 1);
            if (line) log(level, line);
          }
        });
        stream.on('end', () => { const rest = b.trim(); if (rest) log(level, rest); });
      };
      pipe(child.stdout, 'info');
      pipe(child.stderr, 'warn');
      child.on('error', (e) => fin({ ok: false, code: -1, error: e }));
      child.on('exit', (code) => fin({ ok: code === 0, code }));
    });
  }

  /**
   * Cài server THẬT (chỉ hỗ trợ git-clone): git clone --depth 1 → chạy install.build
   * qua `bash -lc` tại dir; stream từng dòng log qua emit('log',{level,line,payloadInstall:true}).
   * Đã installed mà không rebuild → bỏ qua. Lỗi → {ok:false}.
   * @param {string} id @param {Function} [emit] @param {{rebuild?:boolean}} [opts]
   * @returns {Promise<{ok:boolean, logs:string[], skipped?:boolean|string, error?:string}>}
   */
  async installReal(id, emit = () => {}, opts = {}) {
    this._ensureReady();
    const desc = this.registry.mcp(id);
    if (!desc) throw new Error(`MCP '${id}' không tồn tại trong registry`);
    const logs = [];
    const log = (level, line) => {
      logs.push(line);
      const payload = { level, line, payloadInstall: true };
      try { emit('log', payload); } catch { /* emitter ngoài lỗi không làm hỏng install */ }
      this.emit('log', payload);
    };
    if (desc.real !== true) {
      log('info', `'${id}' không phải MCP thật (real:true) — bỏ qua install`);
      return { ok: true, skipped: 'not-real', logs };
    }
    const install = desc.install ?? {};
    if (install.method !== 'git-clone') {
      log('info', `phương thức '${install.method ?? '?'}' không cần clone — bỏ qua install`);
      return { ok: true, skipped: install.method ?? 'unknown', logs };
    }
    const dirAbs = path.join(this.rootDir, install.dir ?? path.join('mcp-servers', id));
    const rebuild = opts.rebuild ?? this.opts.rebuild === true;
    if (existsSync(dirAbs)) {
      if (!rebuild) {
        log('info', `đã có ${install.dir} — bỏ qua clone/build (dùng opts.rebuild=true để build lại)`);
        return { ok: true, skipped: 'already-installed', logs };
      }
      log('info', `đã có ${install.dir} — bỏ qua clone, build lại theo yêu cầu`);
    } else {
      if (!install.repo) {
        log('error', `thiếu install.repo cho '${id}'`);
        return { ok: false, error: `thiếu install.repo cho '${id}'`, logs };
      }
      log('info', `git clone --depth 1 ${install.repo} → ${install.dir}`);
      const r = await this._streamProc(
        'git',
        ['clone', '--depth', '1', install.repo, dirAbs],
        { cwd: this.rootDir, timeoutMs: INSTALL_TIMEOUT_MS },
        log,
      );
      if (!r.ok) {
        const why = r.timedOut ? 'timeout' : `exit ${r.code ?? '?'}`;
        log('error', `clone thất bại (${why})`);
        return { ok: false, error: `git clone thất bại (${why})`, logs };
      }
    }
    if (install.build) {
      log('info', `build: ${install.build}`);
      const r = await this._streamProc(
        'bash',
        ['-lc', install.build],
        { cwd: dirAbs, timeoutMs: INSTALL_TIMEOUT_MS },
        log,
      );
      if (!r.ok) {
        const why = r.timedOut ? 'timeout' : `exit ${r.code ?? '?'}`;
        log('error', `build thất bại (${why})`);
        return { ok: false, error: `build thất bại (${why})`, logs };
      }
    }
    log('info', `install '${id}' hoàn tất`);
    return { ok: true, logs };
  }

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
      if (desc.real === true) {
        // --- MCP THẬT (stdio) ---
        if (!(await this.isRealInstalled(id))) {
          throw new Error(`server thực chưa được cài — gọi installReal('${id}') trước (git clone + build)`);
        }
        const wsDir = path.join(this.rootDir, 'workspace');
        let needWorkspace = false;
        const argv = (desc.args ?? []).map((raw) => {
          let a = String(raw).replaceAll('{workspace}', wsDir); // placeholder '{workspace}'
          if (String(raw).includes('{workspace}')) needWorkspace = true;
          // arg tương đối nhưng tồn tại dưới rootDir (vd entry của git-clone) → tuyệt đối hoá
          if (!path.isAbsolute(a) && existsSync(path.join(this.rootDir, a))) {
            a = path.join(this.rootDir, a);
          }
          return a;
        });
        if (needWorkspace) await mkdir(wsDir, { recursive: true });
        const userEnv = this.registry.getMcpEnv(id);
        const missing = (desc.needsEnv ?? []).filter((k) => {
          const v = process.env[k] ?? userEnv[k];
          return v === undefined || v === null || String(v).trim() === '';
        });
        if (missing.length) {
          throw new Error(`cần biến môi trường: ${missing.join(', ')} — cấu hình trong chi tiết MCP`);
        }
        const cwd = desc.install?.method === 'git-clone' && desc.install?.dir
          ? path.join(this.rootDir, desc.install.dir)
          : this.rootDir;
        transport = createStdioTransport({
          command: desc.command,
          args: argv,
          env: userEnv,
          cwd,
          listToolsTimeoutMs: LIST_TOOLS_TIMEOUT_MS,
        });
      } else if (desc.transport === 'stdio') {
        transport = createStdioTransport({ command: desc.command, args: desc.args ?? [] });
      } else if (desc.transport === 'http') {
        transport = createHttpTransport({ url: desc.url });
      } else {
        // Registry chỉ còn MCP THẬT (stdio/http). Không còn transport 'builtin' mô phỏng.
        throw new Error(`transport '${desc.transport}' không được hỗ trợ — registry chỉ nhận stdio/http`);
      }
      // verify: luôn thử tools/list thật; lỗi → ném để router trả 502 (không im lặng fallback)
      let tools = Array.isArray(desc.tools) ? desc.tools : [];
      const listed = await transport.listTools();
      if (Array.isArray(listed) && listed.length) tools = listed;
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
   * Tra JSON Schema (inputSchema) của tool: transport cache → descriptor server →
   * quét registry-wide theo tên tool (fallback giúp validate khi target không khai báo).
   * @returns {object|undefined}
   */
  _resolveToolSchema(serverId, toolName) {
    const local = this.transports.get(serverId)?.tools?.find((t) => t?.name === toolName)?.inputSchema;
    if (local) return local;
    const declared = (this.registry.mcp(serverId)?.tools ?? []).find((t) => t?.name === toolName)?.inputSchema;
    if (declared) return declared;
    for (const m of this.registry.mcps()) {
      const hit = (m.tools ?? []).find((t) => t?.name === toolName)?.inputSchema;
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * Gọi tool qua pipeline plugin (observer + BEHAVIORS) + gate server thật + audit.
   * @param {string} server @param {string} tool @param {object} args
   * @param {{source?:string, force?:boolean, approved?:boolean, timeoutMs?:number}} [ctx]
   * @returns {Promise<ToolResult>}
   */
  async invoke(server, tool, args = {}, ctx = {}) {
    this._ensureReady();
    const t0 = Date.now();
    const desc = this.registry.mcp(server);
    const conn = this.transports.get(server);
    const mocked = false; // registry chỉ còn MCP thật → không bao giờ mô phỏng
    const pluginsApplied = [];
    /** @type {ToolResult} */
    let result;
    let transportCalled = false; // meta.mocked chỉ xuất hiện khi transport thực sự được gọi

    try {
      let use = conn;
      if (!use && ctx.force) {
        try { await this.connect(server); use = this.transports.get(server); } catch { use = null; }
      }
      if (!use) {
        result = { ok: false, error: `server '${server}' chưa kết nối`, meta: {} };
      } else if (desc?.real === true && !SAFE_TOOL_RX.test(String(tool)) && ctx.approved !== true) {
        // Gate an toàn cho MCP THẬT: tool ngoài whitelist đọc-an toàn cần approved=true
        // (chặn TRƯỚC khi gọi transport; vẫn audit + emit log phía dưới).
        result = {
          ok: false,
          error: 'permission required: set approved=true',
          meta: { needsApproval: true },
        };
      } else {
        const toolSchema = this._resolveToolSchema(server, String(tool));
        let callArgs = deepClone(args ?? {});
        let preBlocked = null;

        // 1. preInvoke: observer cũ (pluginsApplied) + BEHAVIORS (ném Error → short-circuit)
        for (const p of this._pluginsWithHook('preInvoke')) {
          pluginsApplied.push(p.id);
          const beh = p.behavior ? BEHAVIORS[p.behavior] : null;
          if (beh && beh.hook === 'preInvoke' && typeof beh.fn === 'function') {
            try {
              const bctx = {
                server, tool,
                schema: toolSchema,
                plugin: p.id,
                executor: this,
                behaviorLabel: p.behaviorLabel ?? beh.label,
                source: ctx.source,
              };
              callArgs = (await beh.fn(callArgs, bctx)) ?? callArgs;
            } catch (e) { preBlocked = e; break; }
          } else if (typeof /** @type {any} */ (p).preInvoke === 'function') {
            try { callArgs = (await p.preInvoke(callArgs, { ...ctx, plugin: p.id })) ?? callArgs; } catch { /* giữ args */ }
          }
        }

        if (preBlocked) {
          // SHORT-CIRCUIT: không gọi transport, vẫn ghi audit + emit log ở cuối hàm
          result = {
            ok: false,
            error: String(preBlocked?.message ?? preBlocked),
            meta: { pluginsApplied, server, tool },
          };
        } else {
          // 2. gọi transport (timeout 15s)
          let timer;
          transportCalled = true;
          const raw = await Promise.race([
            use.transport.call(tool, callArgs, { ...ctx, pluginsApplied }),
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
            const beh = p.behavior ? BEHAVIORS[p.behavior] : null;
            if (beh && beh.hook === 'postInvoke' && typeof beh.fn === 'function') {
              try {
                const bctx = {
                  server, tool,
                  schema: toolSchema,
                  plugin: p.id,
                  executor: this,
                  behaviorLabel: p.behaviorLabel ?? beh.label,
                  source: ctx.source,
                };
                res = (await beh.fn(res, bctx)) ?? res;
              } catch { /* giữ result */ }
            } else if (typeof /** @type {any} */ (p).postInvoke === 'function') {
              try { res = (await p.postInvoke(res, { ...ctx, plugin: p.id })) ?? res; } catch { /* giữ result */ }
            }
          }
          result = res;
        }
      }
    } catch (e) {
      result = { ok: false, error: String(e?.message ?? e), meta: {} };
    }

    const durationMs = Date.now() - t0;
    // canonical fields của executor luôn thắng; mocked chỉ khi transport thực sự chạy
    result.meta = {
      ...(result.meta ?? {}),
      server, tool, durationMs,
      ...(transportCalled ? { mocked } : {}),
      pluginsApplied,
    };

    this.invocations += 1;
    this.emit('log', {
      level: 'info',
      line: `invoke ${server}.${tool} → ${result.ok ? 'ok' : 'error'} (${durationMs}ms)`,
    });
    // Tool-call event riêng: web Chat dựng part "tool" kiểu OpenCode từ đây.
    // Cắt output cho gọn để SSE không bao giờ tải nặng.
    this.emit('mcp', {
      id: server,
      tool,
      ok: result.ok,
      durationMs,
      args,
      detail: String(result.ok ? (result.result ?? '') : (result.error ?? '')).slice(0, 4000),
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
    const items = this.registry.mcps(rest).map((m) => {
      const live = this.transports.get(m.id)?.tools ?? [];
      return {
        ...m,
        state: this.transports.has(m.id) ? 'connected' : 'disconnected',
        // dynamicTools: số tool chỉ biết sau khi kết nối; chưa kết nối thì lấy toolPreview
        toolCount: live.length || (m.tools ?? []).length || (m.toolPreview ?? []).length,
      };
    });
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
          // chưa connect → tìm server trong registry khai báo tool này (tools thật hoặc toolPreview)
          const cand = this.registry.mcps().find(
            (m) => (m.tools ?? []).some((t) => t.name === toolName)
              || (m.toolPreview ?? []).includes(toolName),
          );
          if (!cand) throw new Error(`không có server nào cung cấp tool '${toolName}'`);
          serverId = cand.id;
        }
        // server đã khai báo nhưng chưa kết nối → tự kết nối (mọi MCP đều là stdio thật)
        if (!this.transports.has(serverId)) await this.connect(serverId);

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

  /** @returns {{counts:{plugins:number,mcps:number,skills:number,realMcps:number}, connectedMcps:number, realMcps:number, invocations:number, lastAudit:any[]}} */
  stats() {
    this._ensureReady();
    const realMcps = this.registry.mcps().filter((m) => m?.real === true).length;
    return {
      // realMcps nằm cả trong counts (tiện /api/status) lẫn cấp cao nhất theo hợp đồng mới
      counts: { ...this.registry.counts(), realMcps },
      connectedMcps: this.connectedCount(),
      realMcps,
      invocations: this.invocations,
      lastAudit: this._lastAudit(),
    };
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  console.log('executor.js demo — new Executor({dataDir}).init() rồi connect/invoke/runSkill');
}
