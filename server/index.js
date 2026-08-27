// server/index.js — upio Mobile MCP Executor Harness: entry point
// Chạy: node server/index.js  (PORT env, mặc định 8787)
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRouter, readBody } from './src/router.js';
import { SseHub } from './src/sse.js';
import { Executor } from './src/executor/executor.js';
import { EnvBuilder } from './src/envbuilder/envbuilder.js';
import { ModelHub } from './src/modelhub/modelhub.js';
import { AgentOrchestrator } from './src/subagents/orchestrator.js';
import { TerminalHub } from './src/terminal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(ROOT, 'data');
const WEB_DIR = path.join(ROOT, 'web');
const VERSION = '1.3.0';
const STARTED = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// ---------- khởi tạo services ----------
const hub = new SseHub();
const modelHub = new ModelHub({ dataDir: DATA_DIR });
await modelHub.init();

const executor = new Executor({ dataDir: DATA_DIR, modelHub, rootDir: ROOT });
await executor.init();
executor.on('log', (p) => hub.broadcast('log', p));
// tool-call + đổi trạng thái MCP → web Chat/Home dựng part 'tool' và cập nhật panel
executor.on('mcp', (p) => hub.broadcast('mcp', p));
executor.on('skill-run', (p) => hub.broadcast('skill-run', p));

const envBuilder = new EnvBuilder({ dataDir: DATA_DIR, rootDir: ROOT, port: PORT });

const orchestrator = new AgentOrchestrator({ executor, modelHub });
orchestrator.on('agent-step', (p) => hub.broadcast('agent-step', p));
orchestrator.on('agent-final', (p) => hub.broadcast('log', { level: 'info', line: `agent ${p.id} hoàn tất` }));

// Terminal Hub — session riêng · folder riêng · permission 3 mức · Shizuku
const terminalHub = new TerminalHub({
  rootDir: ROOT,
  emit: (ev, payload) => hub.broadcast(ev === 'perm' ? 'perm' : 'term', payload),
});

// ---------- auto-boot: dựng môi trường + tự chạy lệnh + tự connect ----------
const bootState = {
  phase: 'booting', startedAt: new Date().toISOString(), finishedAt: null,
  steps: [], error: null,
};

async function autoBoot() {
  const mark = (name, status, extra = {}) => {
    bootState.steps.push({ name, status, at: new Date().toISOString(), ...extra });
    hub.broadcast('boot', { phase: bootState.phase, step: name, status, ...extra });
  };
  try {
    // 1. Tự dựng môi trường (tạo dirs, ghi .env, dọn tmp…)
    hub.broadcast('boot', { phase: 'booting', line: '⚙️ Đang tự động setup môi trường Linux…' });
    const t0 = Date.now();
    const r = await envBuilder.build({ repair: true }, (_ev, p) => {
      hub.broadcast('log', { level: p.level ?? 'info', line: `[boot] ${p.line}`, boot: true });
    });
    mark('environment', 'ok', { ms: Date.now() - t0, detail: `${r.applied.length} thay đổi` });

    // 2. TỰ ĐỘNG BẬT MCP EXECUTOR — mọi server có autoStart:true (đều là stdio thật).
    //    Chạy SONG SONG và KHÔNG chặn boot: npx cold-start có thể mất hàng chục giây,
    //    nên UI sẵn sàng ngay còn kết nối tiếp tục nền, báo tiến độ qua SSE.
    const auto = executor.mcps({}).filter((m) => m.autoStart === true);
    const t1 = Date.now();
    if (auto.length) {
      hub.broadcast('boot', { phase: 'booting', line: `🔌 Tự bật ${auto.length} MCP executor…` });
      mark('autostart-mcp', 'running', { detail: auto.map((m) => m.id).join(', ') });
      bootState.autoStart = { total: auto.length, ok: 0, failed: [], done: false };

      Promise.allSettled(auto.map(async (m) => {
        try {
          await executor.connect(m.id);
          bootState.autoStart.ok++;
          hub.broadcast('boot', { phase: bootState.phase, line: `✔ ${m.name} đã kết nối` });
          hub.broadcast('log', { level: 'info', line: `[boot] MCP '${m.id}' sẵn sàng`, boot: true });
        } catch (e) {
          const why = String(e?.message ?? e).slice(0, 160);
          bootState.autoStart.failed.push({ id: m.id, error: why });
          hub.broadcast('boot', { phase: bootState.phase, line: `✖ ${m.name}: ${why}` });
          hub.broadcast('log', { level: 'warn', line: `[boot] MCP '${m.id}' lỗi: ${why}`, boot: true });
        }
      })).then(() => {
        const a = bootState.autoStart;
        a.done = true;
        a.ms = Date.now() - t1;
        const step = bootState.steps.find((s) => s.name === 'autostart-mcp');
        if (step) { step.status = a.ok ? 'ok' : 'error'; step.detail = `${a.ok}/${a.total} MCP đã kết nối`; step.ms = a.ms; }
        hub.broadcast('boot', { phase: bootState.phase, step: 'autostart-mcp', status: a.ok ? 'ok' : 'error', detail: `${a.ok}/${a.total} MCP` });
        hub.broadcast('log', { level: a.ok ? 'info' : 'warn', line: `[boot] Tự bật xong: ${a.ok}/${a.total} MCP (${a.ms}ms)`, boot: true });
      });
    } else {
      mark('autostart-mcp', 'skip', { detail: 'không có MCP nào bật autoStart' });
      bootState.autoStart = { total: 0, ok: 0, failed: [], done: true };
    }

    // 3. Sẵn sàng ngay (MCP tiếp tục kết nối nền)
    bootState.phase = 'ready';
    bootState.finishedAt = new Date().toISOString();
    mark('ready', 'ok', { detail: auto.length ? `đang bật ${auto.length} MCP nền` : 'không có MCP autoStart' });
    hub.broadcast('log', { level: 'info', line: '[boot] Hệ thống sẵn sàng — MCP executor đang tự bật nền', boot: true });
  } catch (e) {
    bootState.phase = 'error';
    bootState.error = String(e?.message ?? e);
    mark(bootState.error, 'error');
  }
}

// ---------- router ----------
const router = createRouter();
const route = (m, p, h) => router.add(m, p, h);

function ok(res, data) {
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}
function fail(res, status, error) {
  const buf = Buffer.from(JSON.stringify({ error }));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

route('GET', '/api/status', (ctx) => {
  ok(ctx.res, {
    ok: true, name: 'Harness Executor', product: 'MCP Executor Harness', version: VERSION,
    uptimeSec: Math.floor((Date.now() - STARTED) / 1000),
    counts: executor.stats().counts ?? {},
    connectedMcps: executor.connectedCount(),
    agents: orchestrator.list().length,
    sseClients: hub.size,
    env: { node: process.version, platform: process.platform },
  });
});

route('GET', '/api/boot', (ctx) => ok(ctx.res, bootState));

// Audit trail: N invoke gần nhất (data/audit.jsonl) — dùng cho Home stream + smoke test
route('GET', '/api/audit', (ctx) => {
  const tail = Math.min(500, Math.max(1, Number(ctx.query.tail) || 50));
  const items = executor._lastAudit(tail);
  ok(ctx.res, { total: items.length, items });
});

// ---- plugins ----
route('GET', '/api/plugins', async (ctx) => {
  const items = await Promise.resolve(executor.plugins(ctx.query));
  ok(ctx.res, { total: items.length, items });
});
route('GET', '/api/plugins/:id', (ctx) => {
  const items = executor.plugins({ id: ctx.params.id });
  const detail = Array.isArray(items) ? items[0] : undefined;
  if (!detail) return fail(ctx.res, 404, `plugin ${ctx.params.id} not found`);
  ok(ctx.res, detail);
});
route('POST', '/api/plugins/:id/toggle', async (ctx) => {
  try {
    const body = await readBody(ctx.req);
    const p = executor.togglePlugin(ctx.params.id, Boolean(body.enabled));
    if (!p) return fail(ctx.res, 404, `plugin ${ctx.params.id} not found`);
    hub.broadcast('plugin', { id: p.id, enabled: p.enabled });
    ok(ctx.res, p);
  } catch (e) { fail(ctx.res, 400, e.message); }
});

// ---- mcps ----
route('GET', '/api/mcps', (ctx) => {
  const items = executor.mcps ? executor.mcps(ctx.query) : [];
  ok(ctx.res, { total: items.length, items });
});
route('GET', '/api/mcps/:id', async (ctx) => {
  const all = executor.mcps ? executor.mcps({}) : [];
  const m = all.find((x) => x.id === ctx.params.id);
  if (!m) return fail(ctx.res, 404, `mcp ${ctx.params.id} not found`);
  const installed = typeof executor.isRealInstalled === 'function'
    ? await executor.isRealInstalled(ctx.params.id)
    : true;
  // tools THẬT do server báo về sau tools/list (dynamicTools) — ưu tiên hơn tools tĩnh
  const live = typeof executor.getTools === 'function' ? executor.getTools(ctx.params.id) : [];
  ok(ctx.res, {
    ...m,
    tools: live.length ? live : (m.tools ?? []),
    toolCount: live.length || (m.tools ?? []).length,
    state: executor.isConnected(ctx.params.id) ? 'connected' : 'disconnected',
    installed,
  });
});
// Cài đặt server thật (git clone + build) — log stream qua SSE
route('POST', '/api/mcps/:id/install', async (ctx) => {
  try {
    if (typeof executor.installReal !== 'function') return fail(ctx.res, 501, 'install chưa khả dụng');
    const logs = await executor.installReal(ctx.params.id, (_ev, p) => hub.broadcast('log', { ...p, install: true }));
    hub.broadcast('mcp', { id: ctx.params.id, state: 'installed' });
    ok(ctx.res, { ok: true, logs });
  } catch (e) { fail(ctx.res, 500, e.message); }
});
// Cấu hình biến môi trường cho server thật (GitHub/Brave/Slack…)
route('PUT', '/api/mcps/:id/env', async (ctx) => {
  try {
    const body = await readBody(ctx.req);
    if (!body.env || typeof body.env !== 'object') return fail(ctx.res, 400, 'cần {env:{KEY:value}}');
    if (typeof executor.setMcpEnv !== 'function') return fail(ctx.res, 501, 'env chưa khả dụng');
    ok(ctx.res, await Promise.resolve(executor.setMcpEnv(ctx.params.id, body.env)));
  } catch (e) { fail(ctx.res, 400, e.message); }
});

/* ================= TERMINAL (anyclaw-style autonomy) ================= */
route('GET', '/api/terminal/sessions', (ctx) =>
  ok(ctx.res, { items: [...terminalHub.sessions.values()].map((s) => terminalHub.summary(s)), pending: terminalHub.listPending() }));
route('POST', '/api/terminal/sessions', async (ctx) => {
  const body = await readBody(ctx.req).catch(() => ({}));
  ok(ctx.res, terminalHub.createSession(body.name));
});
route('GET', '/api/terminal/:sid', (ctx) => {
  const t = terminalHub.get(ctx.params.sid);
  if (!t) return fail(ctx.res, 404, 'session không tồn tại');
  ok(ctx.res, t);
});
route('DELETE', '/api/terminal/:sid', (ctx) =>
  ok(ctx.res, { ok: terminalHub.killSession(ctx.params.sid) }));
route('POST', '/api/terminal/:sid/exec', async (ctx) => {
  try {
    const body = await readBody(ctx.req);
    if (!body.command || typeof body.command !== 'string') return fail(ctx.res, 400, 'cần {command}');
    const r = await terminalHub.exec(ctx.params.sid, body.command, { via: body.via === 'shizuku' ? 'shizuku' : 'local' });
    ok(ctx.res, r);
  } catch (e) { fail(ctx.res, 409, e.message); }
});
route('POST', '/api/terminal/perm/:pid/approve', async (ctx) => {
  try { ok(ctx.res, await terminalHub.approve(ctx.params.pid)); }
  catch (e) { fail(ctx.res, 404, e.message); }
});
route('POST', '/api/terminal/perm/:pid/deny', (ctx) => {
  try { ok(ctx.res, terminalHub.deny(ctx.params.pid)); }
  catch (e) { fail(ctx.res, 404, e.message); }
});
route('GET', '/api/shizuku', async (ctx) =>
  ok(ctx.res, await terminalHub.detectShizuku()));
route('PUT', '/api/shizuku', async (ctx) => {
  const body = await readBody(ctx.req).catch(() => ({}));
  ok(ctx.res, { enabled: terminalHub.setShizukuEnabled(body.enabled), ...(await terminalHub.detectShizuku(true)) });
});
route('POST', '/api/mcps/:id/connect', async (ctx) => {
  try {
    const r = await executor.connect(ctx.params.id);
    hub.broadcast('mcp', { id: r.id, state: r.state });
    ok(ctx.res, r);
  } catch (e) { fail(ctx.res, 502, e.message); }
});
route('POST', '/api/mcps/:id/disconnect', async (ctx) => {
  try {
    const r = await executor.disconnect(ctx.params.id);
    hub.broadcast('mcp', { id: r.id, state: r.state });
    ok(ctx.res, r);
  } catch (e) { fail(ctx.res, 502, e.message); }
});

// ---- invoke + skills ----
route('POST', '/api/invoke', async (ctx) => {
  try {
    const body = await readBody(ctx.req);
    if (!body.server || !body.tool) return fail(ctx.res, 400, 'cần {server, tool, args?}');
    const result = await executor.invoke(body.server, body.tool, body.args ?? {}, {
      source: 'rest', approved: Boolean(body.approved),
    });
    ok(ctx.res, result);
  } catch (e) { fail(ctx.res, 500, e.message); }
});
route('GET', '/api/skills', (ctx) => {
  const items = executor.skills ? executor.skills(ctx.query) : [];
  ok(ctx.res, { total: items.length, items });
});
route('GET', '/api/skills/:id', (ctx) => {
  const s = (executor.skills ? executor.skills({}) : []).find((x) => x.id === ctx.params.id);
  if (!s) return fail(ctx.res, 404, `skill ${ctx.params.id} not found`);
  ok(ctx.res, s);
});
route('POST', '/api/skills/:id/run', async (ctx) => {
  try {
    const body = await readBody(ctx.req);
    // runSkill sync → phản hồi NGAY; các bước chạy nền, tiến độ qua SSE 'skill-run'
    const r = executor.runSkill(ctx.params.id, body.input ?? {}, (event, payload) => hub.broadcast(event, payload));
    ok(ctx.res, { runId: r.runId, total: r.total });
  } catch (e) {
    fail(ctx.res, /không tồn tại/i.test(String(e.message)) ? 404 : 400, e.message);
  }
});

// ---- environment ----
route('GET', '/api/env', async (ctx) => {
  try { ok(ctx.res, await envBuilder.scan()); } catch (e) { fail(ctx.res, 500, e.message); }
});
route('POST', '/api/env/build', async (ctx) => {
  try {
    const body = await readBody(ctx.req).catch(() => ({}));
    const emit = (event, payload) => hub.broadcast(event, payload);
    const result = await envBuilder.build({ repair: Boolean(body.repair) }, emit);
    hub.broadcast('env', { level: 'info', line: `build xong: ${result.applied.length} thay đổi` });
    ok(ctx.res, result);
  } catch (e) { fail(ctx.res, 500, e.message); }
});

// ---- models ----
route('GET', '/api/models', async (ctx) => ok(ctx.res, await modelHub.listModels()));
route('PUT', '/api/models/config', async (ctx) => {
  try {
    const body = await readBody(ctx.req);
    ok(ctx.res, await modelHub.saveConfig(body));
  } catch (e) { fail(ctx.res, 400, e.message); }
});
route('POST', '/api/models/test', async (ctx) => {
  try {
    const body = await readBody(ctx.req);
    ok(ctx.res, await modelHub.testProvider(body.provider));
  } catch (e) { fail(ctx.res, 502, e.message); }
});

// ---- OpenAI-compatible endpoint ----
route('POST', '/v1/chat/completions', async (ctx) => {
  try {
    const body = await readBody(ctx.req);
    const out = await modelHub.handleChatCompletion(body);
    resWith(ctx.res, out.status, out.headers, out.body);
  } catch (e) { fail(ctx.res, 500, e.message); }
});

// ---- subagents ----
route('GET', '/api/agents', (ctx) => ok(ctx.res, { items: orchestrator.list() }));
route('POST', '/api/agents', async (ctx) => {
  try {
    const body = await readBody(ctx.req);
    if (!body.task || typeof body.task !== 'string') return fail(ctx.res, 400, 'cần {task}');
    const spec = {
      task: String(body.task).slice(0, 2000),
      name: body.name, model: body.model,
      maxSteps: Math.min(12, Math.max(1, Number(body.maxSteps) || 6)),
      tools: Array.isArray(body.tools) ? body.tools.slice(0, 24) : [],
    };
    ok(ctx.res, orchestrator.spawn(spec));
  } catch (e) { fail(ctx.res, 500, e.message); }
});
route('GET', '/api/agents/:id', (ctx) => {
  const a = orchestrator.get(ctx.params.id);
  if (!a) return fail(ctx.res, 404, `agent ${ctx.params.id} not found`);
  ok(ctx.res, a);
});
route('POST', '/api/agents/:id/cancel', (ctx) => ok(ctx.res, { ok: orchestrator.cancel(ctx.params.id) }));
// Agent AI Workspace: nhắn tiếp cho agent đã chạy xong (multi-turn)
route('POST', '/api/agents/:id/say', async (ctx) => {
  try {
    const body = await readBody(ctx.req);
    const message = String(body.message ?? '').trim();
    if (!message) return fail(ctx.res, 400, 'cần {message}');
    ok(ctx.res, orchestrator.followUp(ctx.params.id, message.slice(0, 2000)));
  } catch (e) {
    fail(ctx.res, /không tồn tại|đang chạy|đã huỷ/i.test(String(e.message)) ? 409 : 400, e.message);
  }
});

// ---- SSE ----
route('GET', '/api/events', (ctx) => { hub.add(ctx.res); });

// ---------- helpers ----------
function resWith(res, status, headers, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const h = { ...headers };
  if (!h['content-length'] && typeof payload === 'string') h['content-length'] = Buffer.byteLength(payload);
  res.writeHead(status, h);
  res.end(payload);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end(); return; }
  if (!existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback về index.html cho route không có đuôi file
    if (!path.extname(rel)) {
      const indexFile = path.join(WEB_DIR, 'index.html');
      if (existsSync(indexFile)) {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        createReadStream(indexFile).pipe(res);
        return;
      }
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const ext = path.extname(file);
  const cache = ext === '.html' || rel === '/index.html' ? 'no-cache'
    : rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': cache });
  createReadStream(file).pipe(res);
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  // CORS mở cho API — APK launcher (origin capacitor) và web client ngoài cần nó
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type,authorization',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  try {
    if (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) {
      const matched = router.match(req.method, pathname);
      if (!matched) return fail(res, 404, `không tìm thấy ${req.method} ${pathname}`);
      const query = Object.fromEntries(url.searchParams.entries());
      await matched.handler({ req, res, params: matched.params, query, url });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
    serveStatic(req, res, pathname);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) fail(res, 500, 'internal error');
  }
});

server.listen(PORT, () => {
  console.log(`\n  ⚡ Harness Executor · self-hosted MCP control plane v${VERSION}`);
  console.log(`  ➜ Local:   http://localhost:${PORT}`);
  console.log(`  ➜ Network: http://0.0.0.0:${PORT}  (dùng IP LAN để mở trên điện thoại)`);
  console.log(`  ➜ API:     /api/status · /api/events (SSE) · /v1/chat/completions\n`);
  void autoBoot(); // tự setup môi trường + connect MCP ngay khi mở
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nbye 👋'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
}
