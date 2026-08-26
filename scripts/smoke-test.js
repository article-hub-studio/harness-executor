// smoke-test.js — kiểm thử end-to-end toàn bộ harness. Chạy khi server đang mở:
//   node server/index.js &   rồi   node scripts/smoke-test.js [baseUrl]
import http from 'node:http';

const BASE = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 8787}`;
const results = [];
const check = async (name, fn) => {
  try { const info = await fn(); results.push({ name, ok: true, info }); console.log(`  ✔ ${name}${info ? ' — ' + info : ''}`); }
  catch (e) { results.push({ name, ok: false, info: e.message }); console.log(`  ✖ ${name} — ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* giữ text */ }
  return { status: res.status, json, text };
}
const expectOk = (r, what) => { assert(r.status >= 200 && r.status < 300, `${what}: HTTP ${r.status} ${String(r.text).slice(0, 120)}`); return r.json; };

/** Đọc SSE thô trong ms mili-giây, trả về danh sách tên event nhìn thấy. */
function listenSse(ms, trigger) {
  return new Promise((resolve) => {
    const seen = new Set();
    const u = new URL('/api/events', BASE);
    const hreq = http.get(u, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        for (const m of chunk.matchAll(/event: ([a-z-]+)/g)) seen.add(m[1]);
      });
    });
    hreq.on('error', () => {});
    (async () => { await new Promise(r2 => setTimeout(r2, 400)); try { await trigger(); } catch { /* noop */ } })();
    setTimeout(() => { hreq.destroy(); resolve([...seen]); }, ms);
  });
}

console.log(`\n🧪 upio MCP Executor Harness — smoke test against ${BASE}\n`);

await check('GET /api/status (counts đúng 106/143)', async () => {
  const j = expectOk(await req('GET', '/api/status'), 'status');
  assert(j.ok === true, 'ok != true');
  assert(j.counts.mcps === 106, `mcps=${j.counts.mcps} != 106`);
  assert(j.counts.plugins === 143, `plugins=${j.counts.plugins}`);
  assert(j.counts.skills >= 40, `skills=${j.counts.skills}`);
  return `node ${j.env?.node} · realMcps=${j.counts.realMcps}`;
});

let boot;
await check('Auto-boot: env setup + tự connect MCP', async () => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const r = await req('GET', '/api/boot');
    if (r.json?.phase === 'ready' || r.json?.phase === 'error') { boot = r.json; break; }
    await new Promise((r2) => setTimeout(r2, 400));
  }
  assert(boot && boot.phase === 'ready', `boot phase=${boot?.phase ?? 'no-response'} ${boot?.error ?? ''}`);
  const names = boot.steps.map((s) => s.name);
  assert(names.includes('environment'), 'thiếu step environment');
  assert(names.includes('connect-mcp'), 'thiếu step connect-mcp');
  const st = expectOk(await req('GET', '/api/status'), 'status sau boot');
  assert(st.connectedMcps >= 95, `connectedMcps=${st.connectedMcps} quá ít`);
  return `${st.connectedMcps}/98 tự kết nối`;
});

let pluginId;
await check('GET /api/plugins (search + chi tiết)', async () => {
  const list = expectOk(await req('GET', '/api/plugins?q=guard'), 'plugins');
  assert(list.total > 0, 'search không ra kết quả');
  pluginId = list.items[0].id;
  const one = expectOk(await req('GET', `/api/plugins/${pluginId}`), 'plugin detail');
  assert(one.id === pluginId, 'id lệch');
  return `${list.total} kết quả "guard", sample=${pluginId}`;
});
await check('POST toggle plugin on→off', async () => {
  const on = expectOk(await req('POST', `/api/plugins/${pluginId}/toggle`, { enabled: true }), 'toggle on');
  const off = expectOk(await req('POST', `/api/plugins/${pluginId}/toggle`, { enabled: false }), 'toggle off');
  assert(on.enabled === true && off.enabled === false, 'trạng thái không đổi đúng');
  return pluginId;
});

await check('GET /api/mcps (106 items + filter category + real)', async () => {
  const all = expectOk(await req('GET', '/api/mcps'), 'mcps');
  assert(all.total === 106, `total=${all.total}`);
  const fsCat = expectOk(await req('GET', '/api/mcps?category=filesystem'), 'filter');
  assert(fsCat.total >= 8, 'category filesystem < 8');
  const realCat = expectOk(await req('GET', '/api/mcps?category=real'), 'filter real');
  assert(realCat.total === 8, `real=${realCat.total} != 8`);
  return `106 servers · real=${realCat.total}`;
});

let robloxTools = 0;
await check('REAL MCP: roblox-executor cài sẵn + connect + invoke thật', async () => {
  const d = expectOk(await req('GET', '/api/mcps/roblox-executor'), 'detail');
  assert(d.real === true && d.installed === true, `real=${d.real} installed=${d.installed}`);
  const c = expectOk(await req('POST', '/api/mcps/roblox-executor/connect', {}), 'connect');
  assert(c.state === 'connected' && c.tools.length >= 15, `tools=${c.tools.length}`);
  robloxTools = c.tools.length;
  const inv = expectOk(await req('POST', '/api/invoke', { server: 'roblox-executor', tool: 'list-clients', args: {} }), 'invoke');
  assert(inv.ok === true, `list-clients lỗi: ${inv.error}`);
  await req('POST', '/api/mcps/roblox-executor/disconnect', {});
  return `${robloxTools} tools thật · list-clients OK`;
});

let connectedTools = 0;
await check('connect MCP builtin + invoke tool', async () => {
  const c = expectOk(await req('POST', '/api/mcps/filesystem-vaultkeeper/connect', {}), 'connect');
  assert(c.state === 'connected', 'state != connected');
  connectedTools = c.tools.length;
  assert(connectedTools >= 3, 'tools quá ít');
  const inv = expectOk(await req('POST', '/api/invoke', { server: 'filesystem-vaultkeeper', tool: 'fs.list_dir', args: { path: '/' } }), 'invoke');
  assert(inv.ok === true, `invoke lỗi: ${inv.error}`);
  await req('POST', '/api/mcps/filesystem-vaultkeeper/disconnect', {});
  return `fs.list_dir OK (${connectedTools} tools)`;
});

await check('GET /api/skills', async () => {
  const s = expectOk(await req('GET', '/api/skills'), 'skills');
  assert(s.total >= 40, `skills=${s.total}`);
  return `${s.total} skills`;
});
let runId;
await check('POST chạy skill repo-summarize', async () => {
  const r = expectOk(await req('POST', '/api/skills/repo-summarize/run', { input: { repo: 'upio/mcp-executor' } }), 'run');
  runId = r.runId;
  assert(typeof runId === 'string' && runId.startsWith('run-'), `runId=${runId}`);
  return runId;
});

await check('GET /api/env scan', async () => {
  const env = expectOk(await req('GET', '/api/env'), 'env');
  assert(env.checks.length >= 8, `checks=${env.checks.length}`);
  assert(env.summary.pass + env.summary.warn + env.summary.fail === env.checks.length, 'summary sai');
  return `${env.checks.length} checks, pass=${env.summary.pass}`;
});
await check('POST /api/env/build', async () => {
  const b = expectOk(await req('POST', '/api/env/build', { repair: false }), 'build');
  assert(b.buildId && Array.isArray(b.applied), 'shape build sai');
  return `${b.applied.length} applied`;
});

await check('GET /api/models (mock sẵn sàng)', async () => {
  const m = expectOk(await req('GET', '/api/models'), 'models');
  const mock = m.models.find((x) => x.id === 'ox-local-mock');
  assert(mock && mock.available, 'thiếu ox-local-mock available');
  return `${m.models.length} models`;
});
await check('POST /v1/chat/completions (non-stream)', async () => {
  const r = await req('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'Giải thích MCP trong 1 câu.' }] });
  const j = typeof r.json === 'object' && r.json ? r.json : JSON.parse(r.text);
  assert(j.choices?.[0]?.message?.content?.length > 10, 'content trống');
  return `"${j.choices[0].message.content.slice(0, 60)}…"`;
});
await check('POST /v1/chat/completions (stream SSE)', async () => {
  const r = await req('POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'hello' }] });
  const chunks = [...r.text.matchAll(/data: (\{.*\}|\[DONE\])/g)];
  assert(chunks.length >= 3, `chunks=${chunks.length}`);
  assert(r.text.includes('[DONE]'), 'thiếu [DONE]');
  return `${chunks.length} chunks`;
});

let agentId;
await check('POST spawn agent + poll tới done', async () => {
  const s = expectOk(await req('POST', '/api/agents', { task: 'Kiểm tra database orders và tổng hợp trạng thái', maxSteps: 3 }), 'spawn');
  agentId = s.id;
  const deadline = Date.now() + 25000;
  let a;
  while (Date.now() < deadline) {
    a = expectOk(await req('GET', `/api/agents/${agentId}`), 'agent get');
    if (a.status !== 'running') break;
    await new Promise((r2) => setTimeout(r2, 700));
  }
  assert(a.status === 'done', `status=${a.status}`);
  assert(a.steps.length >= 1, 'không có bước nào');
  assert(a.answer && a.answer.length > 10, 'answer trống');
  return `${a.steps.length} steps`;
});

await check('Agent AI Workspace: nhắn tiếp agent (multi-turn)', async () => {
  const s = expectOk(await req('POST', `/api/agents/${agentId}/say`, { message: 'chi tiết hơn về kết quả nhé' }), 'say');
  assert(s.ok === true, 'say không ok');
  const deadline = Date.now() + 25000;
  let a;
  while (Date.now() < deadline) {
    a = expectOk(await req('GET', `/api/agents/${agentId}`), 'agent get 2');
    if (a.status !== 'running') break;
    await new Promise((r2) => setTimeout(r2, 700));
  }
  assert(a.status === 'done', `status=${a.status}`);
  assert((a.followUps ?? 0) === 1, `followUps=${a.followUps}`);
  assert(Array.isArray(a.session) && a.session.length >= 4, `session=${a.session?.length}`);
  return `session ${a.session.length} entry · followUps=${a.followUps}`;
});

await check('Plugin behavior thật: validate-required chặn invoke', async () => {
  const dev = expectOk(await req('GET', '/api/plugins?category=devtools'), 'devtools');
  const p = dev.items.find((x) => x.behavior === 'validate-required');
  assert(p, 'không có plugin validate-required');
  await req('POST', `/api/plugins/${p.id}/toggle`, { enabled: true });
  await expectOk(await req('POST', '/api/mcps/filesystem-vaultkeeper/connect', {}), 'connect cho plugin test');
  const inv = await req('POST', '/api/invoke', { server: 'filesystem-vaultkeeper', tool: 'fs.list_dir', args: {} });
  await req('POST', '/api/mcps/filesystem-vaultkeeper/disconnect', {});
  await req('POST', `/api/plugins/${p.id}/toggle`, { enabled: false });
  assert(inv.json && inv.json.ok === false, 'plugin không chặn được');
  assert(/validate-required/.test(String(inv.json.error)), `error lạ: ${inv.json.error}`);
  return p.id;
});

await check('SSE nhận ít nhất log + env events', async () => {
  const seen = await listenSse(6000, async () => {
    await fetch(BASE + '/api/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server: 'filesystem-vaultkeeper', tool: 'fs.get_info', args: { path: '/tmp' }, force: true }) }).catch(() => {});
    await fetch(BASE + '/api/env/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  });
  assert(seen.includes('log'), `chỉ thấy: ${seen.join(',')}`);
  assert(seen.includes('env'), `chỉ thấy: ${seen.join(',')}`);
  return `[${seen.join(', ')}]`;
});

await check('Terminal: session riêng + folder riêng + safe chạy ngay', async () => {
  const s = expectOk(await req('POST', '/api/terminal/sessions', { name: 'smoke-term' }), 'create');
  assert(s.id && s.dir, 'thiếu id/dir');
  const r1 = expectOk(await req('POST', `/api/terminal/${s.id}/exec`, { command: 'echo smoke-terminal-ok' }), 'safe exec');
  assert(r1.ran === true && r1.exitCode === 0, `ran=${r1.ran} exit=${r1.exitCode}`);
  const d = expectOk(await req('GET', `/api/terminal/${s.id}`), 'detail');
  assert(/smoke-terminal-ok/.test(d.log.map((c) => c.data).join('')), 'không thấy output echo');
  try { await req('POST', `/api/terminal/${s.id}/exec`, { command: 'rm -rf /' }); assert(false, 'blocked phải ném lỗi'); }
  catch (e) { assert(/cấm|blocked/i.test(e.message), `lỗi lạ: ${e.message}`); }
  await req('DELETE', `/api/terminal/${s.id}`);
  return `${d.dir}`;
});

await check('Terminal permission: lệnh nguy hiểm phải duyệt/từ chối', async () => {
  const s = expectOk(await req('POST', '/api/terminal/sessions', { name: 'smoke-perm' }), 'create');
  const r = await req('POST', `/api/terminal/${s.id}/exec`, { command: 'chmod +x run.sh' });
  assert(r.json.needsApproval === true && r.json.permId, `không xin permission: ${JSON.stringify(r.json)}`);
  const list = expectOk(await req('GET', '/api/terminal/sessions'), 'list');
  assert(list.pending.some((p) => p.id === r.json.permId), 'pending không có trong danh sách');
  const dn = expectOk(await req('POST', `/api/terminal/perm/${r.json.permId}/deny`), 'deny');
  assert(dn.ok === true, 'deny fail');
  await req('DELETE', `/api/terminal/${s.id}`);
  return `perm ${r.json.permId} → từ chối OK`;
});

await check('Shizuku status endpoint', async () => {
  const st = expectOk(await req('GET', '/api/shizuku'), 'status');
  assert(typeof st.available === 'boolean', 'thiếu available');
  const set = expectOk(await req('PUT', '/api/shizuku', { enabled: true }), 'set');
  assert(set.enabled === true, 'set enabled fail');
  await req('PUT', '/api/shizuku', { enabled: false });
  return st.available ? `rish: ${st.path}` : 'rish chưa có (bình thường trên Linux)';
});

await check('Web module graph: mọi import ES module trả 200 (chống chế độ tĩnh)', async () => {
  const seen = new Set();
  const queue = ['/js/app.js'];
  let count = 0;
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const res = await fetch(BASE + p);
    assert(res.status === 200, `${p} → HTTP ${res.status} (module graph vỡ → app rơi vào chế độ tĩnh)`);
    const src = await res.text();
    count++;
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      const base = p.slice(0, p.lastIndexOf('/'));
      const parts = (base + '/' + m[1]).split('/');
      const out = [];
      for (const seg of parts) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') out.pop(); else out.push(seg);
      }
      queue.push('/' + out.join('/'));
    }
  }
  return `${count} module OK`;
});

await check('Web JS không dùng global riêng của Node (process/require/__dirname)', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const walk = (d) => readdirSync(d).flatMap((f) => {
    const p = `${d}/${f}`;
    return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });
  const { fileURLToPath } = await import('node:url');
  const files = walk(fileURLToPath(new URL('../web/js', import.meta.url)));
  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    src.split('\n').forEach((ln, i) => {
      if (/(^|[^.\w'"`])(require\(|__dirname|__filename)/.test(ln)) bad.push(`${f}:${i + 1}`);
      // process chỉ được dùng khi đã guard typeof
      if (/(^|[^.\w'"`])process\s*[.[]/.test(ln) && !/typeof process/.test(ln)) bad.push(`${f}:${i + 1} (process chưa guard)`);
    });
  }
  assert(bad.length === 0, `global Node lọt vào code browser → ReferenceError giết module graph:\n    ${bad.join('\n    ')}`);
  return `${files.length} file sạch`;
});

await check('Web UI toàn vẹn: icon 99 key sạch, biến CSS tồn tại, id JS gọi có trong DOM', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../web', import.meta.url));
  const problems = [];

  // 1) icons.js: không SVG rỗng / thiếu thẻ đóng
  const iconsSrc = readFileSync(`${root}/js/icons.js`, 'utf8');
  const { ICONS } = await import(`${root}/js/icons.js`);
  const nIcons = Object.keys(ICONS).length;
  for (const [k, v] of Object.entries(ICONS)) {
    if (v.includes('undefined') || !v.endsWith('</svg>') || v.length < 90) problems.push(`icon hỏng: ${k}`);
  }
  assert(nIcons >= 99, `ICONS chỉ có ${nIcons} key (cần >= 99)`);

  // 2) mọi var(--x) phải được khai báo trong app.css
  const css = readFileSync(`${root}/css/app.css`, 'utf8');
  const declared = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const walk = (d) => readdirSync(d).flatMap((f) => {
    const p = `${d}/${f}`;
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  for (const f of walk(root).filter((f) => /\.(js|css|html)$/.test(f))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/var\((--[\w-]+)/g)) {
      if (!declared.has(m[1])) problems.push(`${f.replace(root, 'web')}: var(${m[1]}) chưa khai báo`);
    }
  }

  // 3) id JS truy cập phải có trong template cùng file (tránh nút chết)
  for (const f of walk(`${root}/js/views`)) {
    const src = readFileSync(f, 'utf8');
    const inHtml = new Set([...src.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
    const dyn = /\$\{p\}-|\$\{pre\}-/.test(src); // form dùng prefix động → bỏ qua
    if (dyn) continue;
    for (const m of src.matchAll(/\$\('#?([\w-]+)'\)/g)) {
      if (!inHtml.has(m[1])) problems.push(`${f.replace(root, 'web')}: $('${m[1]}') không có id tương ứng`);
    }
  }

  assert(problems.length === 0, `UI có lỗi tiềm ẩn:\n    ${problems.join('\n    ')}`);
  return `${nIcons} icon · ${declared.size} CSS var · id khớp`;
});

// ---- tổng kết ----
const passed = results.filter((r) => r.ok).length;
console.log(`\n📊 Kết quả: ${passed}/${results.length} pass`);
if (passed < results.length) { console.log('\n❌ SMOKE TEST THẤT BẠI'); process.exit(1); }
console.log('✅ SMOKE TEST PASS TOÀN BỘ\n');
