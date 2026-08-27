#!/usr/bin/env node
/* ============================================================================
   luau-mcp — MCP server THẬT cho Luau (stdio JSON-RPC 2.0), zero-dependency.
   Bọc binary `luau-lsp` (npx luau-lsp / luau-lsp trong PATH) để cung cấp:
     · luau_analyze        — type-check + lint cả file/thư mục
     · luau_check_source   — kiểm tra một đoạn Luau dán trực tiếp
     · luau_require_graph  — đồ thị require của project
     · luau_document_symbols / luau_hover / luau_definition — qua LSP thật
     · luau_lint_rules     — liệt kê FFlag/rule đang bật
     · luau_format_check   — phát hiện lỗi cú pháp trước khi chạy
   Không mô phỏng: mọi kết quả đến từ tiến trình luau-lsp thật.
   ========================================================================== */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NAME = 'luau-mcp';
const VERSION = '1.0.0';
const PROTO = '2024-11-05';
const EXEC_TIMEOUT_MS = Number(process.env.LUAU_TIMEOUT_MS || 45_000);

/* ---------------------------------------------------------------- transport */
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handleLine(line);
  }
});

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const replyErr = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

async function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id == null) return; // notification → bỏ qua
  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: PROTO,
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      });
    }
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const fn = HANDLERS[params?.name];
      if (!fn) return reply(id, textResult(`tool không tồn tại: ${params?.name}`, true));
      const out = await fn(params.arguments || {});
      return reply(id, out);
    }
    if (method === 'ping') return reply(id, {});
    return replyErr(id, -32601, `method không hỗ trợ: ${method}`);
  } catch (err) {
    return reply(id, textResult(`lỗi: ${err?.message || err}`, true));
  }
}

/* ------------------------------------------------------------ luau-lsp exec */
let LUAU_CMD = null; // { cmd, args[] }

/** Tìm binary luau-lsp: PATH trước, không có thì dùng npx (tự tải lần đầu). */
async function resolveLuau() {
  if (LUAU_CMD) return LUAU_CMD;
  const envCmd = process.env.LUAU_LSP_BIN;
  const candidates = [
    ...(envCmd ? [{ cmd: envCmd, args: [] }] : []),
    { cmd: 'luau-lsp', args: [] },
    { cmd: 'npx', args: ['-y', 'luau-lsp'] },
  ];
  for (const c of candidates) {
    const r = await run(c.cmd, [...c.args, '--version'], { timeout: 120_000 }).catch(() => null);
    if (r && r.code === 0 && /\d+\.\d+/.test(r.stdout + r.stderr)) {
      LUAU_CMD = { ...c, version: (r.stdout + r.stderr).trim().split('\n')[0] };
      return LUAU_CMD;
    }
  }
  throw new Error('không tìm thấy luau-lsp (thử: npm i -g luau-lsp, hoặc đặt LUAU_LSP_BIN)');
}

function run(cmd, args, { timeout = EXEC_TIMEOUT_MS, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { p.kill('SIGKILL'); } catch { /* đã chết */ }
      reject(new Error(`timeout ${timeout}ms: ${cmd} ${args.join(' ')}`));
    }, timeout);
    p.stdout.on('data', (d) => { stdout += d; if (stdout.length > 400_000) stdout = stdout.slice(-400_000); });
    p.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200_000) stderr = stderr.slice(-200_000); });
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    p.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } });
    if (input != null) { p.stdin.write(input); }
    p.stdin.end();
  });
}

/** Bỏ dòng nhiễu của luau-lsp để chẩn đoán thật nổi lên. */
const NOISE_RX = /^(WARNING: --platform|\[WARN\] No definitions file|\[INFO\] sourcemap is disabled)/;
const denoise = (text) => text.split('\n').filter((l) => l.trim() && !NOISE_RX.test(l.trim())).join('\n');

/** Chạy `luau-lsp <sub> ...` và trả text đã gộp stdout+stderr (đã lọc nhiễu). */
async function luau(sub, args, opts) {
  const { cmd, args: pre } = await resolveLuau();
  const r = await run(cmd, [...pre, sub, ...args], opts);
  const text = denoise([r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n'));
  return { code: r.code, text: text || '(không có chẩn đoán)' };
}

/** platform: 'standard' (mặc định, im lặng) | 'roblox' (cần definitions Roblox). */
const platformArgs = (platform) => [`--platform=${platform === 'roblox' ? 'roblox' : 'standard'}`];

/* ------------------------------------------------------- LSP client (stdio) */
/** Phiên LSP dùng chung cho hover/definition/symbols — mở theo rootUri. */
class LspSession {
  constructor(root) {
    this.root = root;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.rx = '';
    this.opened = new Set();
  }

  async start() {
    if (this.proc) return;
    const { cmd, args: pre } = await resolveLuau();
    this.proc = spawn(cmd, [...pre, 'lsp'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.proc.stdout.on('data', (d) => this._onData(d.toString('binary')));
    this.proc.on('exit', () => { this.proc = null; this.opened.clear(); });
    await this.request('initialize', {
      processId: process.pid,
      rootUri: `file://${this.root}`,
      capabilities: { textDocument: { hover: { contentFormat: ['plaintext', 'markdown'] }, documentSymbol: {} } },
      workspaceFolders: [{ uri: `file://${this.root}`, name: path.basename(this.root) }],
    });
    this.notify('initialized', {});
  }

  _onData(s) {
    this.rx += s;
    for (;;) {
      const sep = this.rx.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const header = this.rx.slice(0, sep);
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.rx = this.rx.slice(sep + 4); continue; }
      const len = Number(m[1]);
      const start = sep + 4;
      if (this.rx.length < start + len) return;
      const body = Buffer.from(this.rx.slice(start, start + len), 'binary').toString('utf8');
      this.rx = this.rx.slice(start + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || 'lsp error')) : resolve(msg.result);
      }
    }
  }

  _send(obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  notify(method, params) { this._send({ jsonrpc: '2.0', method, params }); }

  request(method, params, timeout = 25_000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout lsp ${method}`)); }
      }, timeout);
    });
  }

  async openDoc(file) {
    const abs = path.resolve(this.root, file);
    if (this.opened.has(abs)) return abs;
    const text = await readFile(abs, 'utf8');
    this.notify('textDocument/didOpen', {
      textDocument: { uri: `file://${abs}`, languageId: 'luau', version: 1, text },
    });
    this.opened.add(abs);
    await new Promise((r) => setTimeout(r, 350)); // để server phân tích
    return abs;
  }

  stop() { try { this.proc?.kill('SIGKILL'); } catch { /* rồi */ } this.proc = null; }
}

const sessions = new Map();
async function sessionFor(root) {
  const key = path.resolve(root || process.cwd());
  if (!sessions.has(key)) sessions.set(key, new LspSession(key));
  const s = sessions.get(key);
  await s.start();
  return s;
}

/* --------------------------------------------------------------- tool defs */
const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

const TOOLS = [
  { name: 'luau_analyze', description: 'Type-check + lint file hoặc thư mục Luau bằng luau-lsp analyze thật. Trả toàn bộ chẩn đoán (error/warning) kèm dòng/cột.',
    inputSchema: S({ path: str('file .luau/.lua hoặc thư mục cần phân tích'), definitions: str('file định nghĩa global (vd globalTypes.d.luau)'), strict: { type: 'boolean', description: 'bật chế độ strict' }, platform: { type: 'string', enum: ['standard', 'roblox'], description: "mặc định standard; 'roblox' cần file definitions" } }, ['path']) },
  { name: 'luau_check_source', description: 'Kiểm tra một đoạn source Luau dán trực tiếp (không cần file trên đĩa) — ghi ra file tạm rồi analyze thật.',
    inputSchema: S({ source: str('nội dung Luau'), filename: str('tên file ảo, mặc định snippet.luau'), platform: { type: 'string', enum: ['standard', 'roblox'], description: 'mặc định standard' } }, ['source']) },
  { name: 'luau_require_graph', description: 'Xuất đồ thị require của project Luau (ai require ai) bằng luau-lsp require-graph.',
    inputSchema: S({ path: str('file gốc hoặc thư mục project') }, ['path']) },
  { name: 'luau_document_symbols', description: 'Danh sách symbol (function/local/table) trong một file Luau qua LSP thật.',
    inputSchema: S({ file: str('đường dẫn file Luau'), root: str('thư mục gốc project') }, ['file']) },
  { name: 'luau_hover', description: 'Thông tin kiểu + tài liệu tại vị trí con trỏ (LSP hover thật).',
    inputSchema: S({ file: str('file Luau'), line: int('dòng, đếm từ 1'), character: int('cột, đếm từ 1'), root: str('thư mục gốc') }, ['file', 'line', 'character']) },
  { name: 'luau_definition', description: 'Nhảy tới định nghĩa của symbol tại vị trí con trỏ (LSP thật).',
    inputSchema: S({ file: str('file Luau'), line: int('dòng, đếm từ 1'), character: int('cột, đếm từ 1'), root: str('thư mục gốc') }, ['file', 'line', 'character']) },
  { name: 'luau_lint_rules', description: 'Liệt kê toàn bộ FFlag/rule của Luau đang khả dụng cùng giá trị hiện tại.',
    inputSchema: S({ filter: str('chỉ hiện flag chứa chuỗi này') }) },
  { name: 'luau_version', description: 'Phiên bản luau-lsp đang dùng + cách nó được tìm thấy (chẩn đoán môi trường).',
    inputSchema: S({}) },
];

/* --------------------------------------------------------------- handlers */
const HANDLERS = {
  async luau_version() {
    const c = await resolveLuau();
    return textResult(`luau-lsp ${c.version}\ncommand: ${c.cmd} ${c.args.join(' ')}`.trim());
  },

  async luau_analyze({ path: target, definitions, strict, platform }) {
    if (!target) return textResult('thiếu path', true);
    await stat(target).catch(() => { throw new Error(`không thấy đường dẫn: ${target}`); });
    const args = [...platformArgs(platform)];
    if (definitions) args.push(`--definitions=${definitions}`);
    if (strict) args.push('--mode=strict');
    args.push(target);
    const { code, text } = await luau('analyze', args);
    const clean = code === 0 && !/error|warning/i.test(text);
    return textResult(`${clean ? '✔ không có chẩn đoán nào' : text}\n\n[exit ${code}]`);
  },

  async luau_check_source({ source, filename, platform }) {
    if (typeof source !== 'string' || !source.trim()) return textResult('thiếu source', true);
    const dir = await mkdtemp(path.join(tmpdir(), 'luau-mcp-'));
    const f = path.join(dir, (filename || 'snippet.luau').replace(/[^\w.-]/g, '_'));
    try {
      await writeFile(f, source, 'utf8');
      const { code, text } = await luau('analyze', [...platformArgs(platform), f]);
      const shown = text.split('\n').map((l) => l.replace(f, filename || 'snippet.luau')).join('\n');
      const clean = code === 0 && !/error|warning/i.test(shown);
      return textResult(`${clean ? '✔ source hợp lệ, không cảnh báo' : shown}\n\n[exit ${code}]`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  async luau_require_graph({ path: target }) {
    if (!target) return textResult('thiếu path', true);
    const { code, text } = await luau('require-graph', [target]);
    return textResult(`${text}\n\n[exit ${code}]`);
  },

  async luau_document_symbols({ file, root }) {
    const s = await sessionFor(root || path.dirname(path.resolve(file)));
    const abs = await s.openDoc(file);
    const res = await s.request('textDocument/documentSymbol', { textDocument: { uri: `file://${abs}` } });
    const list = Array.isArray(res) ? res : [];
    if (!list.length) return textResult('(không có symbol nào được báo)');
    const fmt = (sym, depth = 0) => {
      const r = sym.range || sym.location?.range;
      const ln = (r?.start?.line ?? 0) + 1;
      const kids = (sym.children || []).map((c) => fmt(c, depth + 1)).join('\n');
      return `${'  '.repeat(depth)}· ${sym.name} (kind ${sym.kind}) @${ln}${kids ? '\n' + kids : ''}`;
    };
    return textResult(list.map((x) => fmt(x)).join('\n'));
  },

  async luau_hover({ file, line, character, root }) {
    const s = await sessionFor(root || path.dirname(path.resolve(file)));
    const abs = await s.openDoc(file);
    const res = await s.request('textDocument/hover', {
      textDocument: { uri: `file://${abs}` },
      position: { line: Math.max(0, (line | 0) - 1), character: Math.max(0, (character | 0) - 1) },
    });
    const c = res?.contents;
    const text = !c ? '' : typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.value ?? x).join('\n') : c.value || '';
    return textResult(text.trim() || '(không có thông tin hover tại vị trí này)');
  },

  async luau_definition({ file, line, character, root }) {
    const s = await sessionFor(root || path.dirname(path.resolve(file)));
    const abs = await s.openDoc(file);
    const res = await s.request('textDocument/definition', {
      textDocument: { uri: `file://${abs}` },
      position: { line: Math.max(0, (line | 0) - 1), character: Math.max(0, (character | 0) - 1) },
    });
    const arr = Array.isArray(res) ? res : res ? [res] : [];
    if (!arr.length) return textResult('(không tìm thấy định nghĩa)');
    return textResult(arr.map((d) => {
      const uri = (d.uri || d.targetUri || '').replace('file://', '');
      const r = d.range || d.targetSelectionRange || d.targetRange;
      return `${uri}:${(r?.start?.line ?? 0) + 1}:${(r?.start?.character ?? 0) + 1}`;
    }).join('\n'));
  },

  async luau_lint_rules({ filter }) {
    const { cmd, args: pre } = await resolveLuau();
    const r = await run(cmd, [...pre, '--show-flags']);
    let lines = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !NOISE_RX.test(l));
    if (filter) lines = lines.filter((l) => l.toLowerCase().includes(String(filter).toLowerCase()));
    const head = lines.slice(0, 200);
    return textResult(`${head.length} flag${lines.length > head.length ? ` (rút gọn từ ${lines.length})` : ''}\n${head.join('\n')}`);
  },
};

process.on('SIGTERM', () => { for (const s of sessions.values()) s.stop(); process.exit(0); });
process.on('SIGINT', () => { for (const s of sessions.values()) s.stop(); process.exit(0); });
