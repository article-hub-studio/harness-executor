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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(ROOT, 'data');
const WEB_DIR = path.join(ROOT, 'web');
const VERSION = '1.0.0';
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

const executor = new Executor({ dataDir: DATA_DIR, modelHub });
await executor.init();
executor.on('log', (p) => hub.broadcast('log', p));

const envBuilder = new EnvBuilder({ dataDir: DATA_DIR, rootDir: ROOT, port: PORT });

const orchestrator = new AgentOrchestrator({ executor, modelHub });
orchestrator.on('agent-step', (p) => hub.broadcast('agent-step', p));
orchestrator.on('agent-final', (p) => hub.broadcast('log', { level: 'info', line: `agent ${p.id} hoàn tất` }));

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

    // 2. Tự connect toàn bộ MCP builtin (stdio/http chờ cấu hình thủ công)
    const builtins = executor.mcps({}).filter((m) => m.transport === 'builtin');
    hub.broadcast('boot', { phase: 'booting', line: `🔌 Đang kết nối ${builtins.length} MCP servers…` });
    const t1 = Date.now();
    let okCount = 0;
    for (let i = 0; i < builtins.length; i++) {
      try { await executor.connect(builtins[i].id); okCount++; } catch { /* bỏ qua lỗi lẻ */ }
      if ((i + 1) % 20 === 0 || i === builtins.length - 1) {
        hub.broadcast('boot', { phase: 'booting', line: `🔌 ${i + 1}/${builtins.length} MCP đã kết nối` });
      }
    }
    mark('connect-mcp', 'ok', { ms: Date.now() - t1, detail: `${okCount}/${builtins.length} servers` });

    // 3. Sẵn sàng
    bootState.phase = 'ready';
    bootState.finishedAt = new Date().toISOString();
    mark('ready', 'ok', { detail: `${executor.connectedCount()} MCP sẵn sàng · model ox-local-mock` });
    hub.broadcast('log', { level: 'info', line: `[boot] Hệ thống sẵn sàng — ${executor.connectedCount()} MCP đã kết nối` });
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
    ok: true, name: 'upio MCP Executor Harness', version: VERSION,
    uptimeSec: Math.floor((Date.now() - STARTED) / 1000),
    counts: executor.stats().counts ?? {},
    connectedMcps: executor.connectedCount(),
    agents: orchestrator.list().length,
    sseClients: hub.size,
    env: { node: process.version, platform: process.platform },
  });
});

route('GET', '/api/boot', (ctx) => ok(ctx.res, bootState));

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
route('GET', '/api/mcps/:id', (ctx) => {
  const all = executor.mcps ? executor.mcps({}) : [];
  const m = all.find((x) => x.id === ctx.params.id);
  if (!m) return fail(ctx.res, 404, `mcp ${ctx.params.id} not found`);
  ok(ctx.res, { ...m, state: executor.isConnected(ctx.params.id) ? 'connected' : 'disconnected' });
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
  console.log(`\n  ⚡ upio MCP Executor Harness v${VERSION}`);
  console.log(`  ➜ Local:   http://localhost:${PORT}`);
  console.log(`  ➜ Network: http://0.0.0.0:${PORT}  (dùng IP LAN để mở trên điện thoại)`);
  console.log(`  ➜ API:     /api/status · /api/events (SSE) · /v1/chat/completions\n`);
  void autoBoot(); // tự setup môi trường + connect MCP ngay khi mở
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nbye 👋'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
}
