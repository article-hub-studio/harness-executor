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

await check('GET /api/status (registry Luau/LSP — 100% MCP thật)', async () => {
  const j = expectOk(await req('GET', '/api/status'), 'status');
  assert(j.ok === true, 'ok != true');
  assert(j.counts.mcps >= 8, `mcps=${j.counts.mcps} quá ít`);
  assert(j.counts.realMcps === j.counts.mcps, `còn MCP mô phỏng: real=${j.counts.realMcps}/${j.counts.mcps}`);
  assert(j.counts.plugins >= 8, `plugins=${j.counts.plugins}`);
  assert(j.counts.skills >= 10, `skills=${j.counts.skills}`);
  return `node ${j.env?.node} · ${j.counts.mcps} MCP (100% thật) · ${j.counts.plugins} plugin · ${j.counts.skills} skill`;
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
  assert(names.includes('autostart-mcp'), 'thiếu step autostart-mcp (tự bật MCP executor)');
  // autoStart chạy nền: chờ tới khi done rồi mới kiểm số kết nối
  const dl2 = Date.now() + 90000;
  let a = boot.autoStart;
  while (Date.now() < dl2 && (!a || !a.done)) {
    await new Promise((r2) => setTimeout(r2, 700));
    a = (await req('GET', '/api/boot')).json?.autoStart;
  }
  assert(a && a.done === true, `autoStart chưa xong: ${JSON.stringify(a)}`);
  assert(a.total >= 1, 'không có MCP nào khai báo autoStart');
  assert(a.ok >= 1, `không MCP nào tự bật được: ${JSON.stringify(a.failed)}`);
  const st = expectOk(await req('GET', '/api/status'), 'status sau boot');
  assert(st.connectedMcps >= 1, `connectedMcps=${st.connectedMcps}`);
  return `tự bật ${a.ok}/${a.total} MCP trong ${a.ms}ms · connected=${st.connectedMcps}`;
});

let pluginId;
await check('GET /api/plugins (search + chi tiết)', async () => {
  const list = expectOk(await req('GET', '/api/plugins?q=luau'), 'plugins');
  assert(list.total > 0, 'search không ra kết quả');
  pluginId = list.items[0].id;
  const one = expectOk(await req('GET', `/api/plugins/${pluginId}`), 'plugin detail');
  assert(one.id === pluginId, 'id lệch');
  return `${list.total} kết quả "luau", sample=${pluginId}`;
});
await check('POST toggle plugin on→off', async () => {
  const on = expectOk(await req('POST', `/api/plugins/${pluginId}/toggle`, { enabled: true }), 'toggle on');
  const off = expectOk(await req('POST', `/api/plugins/${pluginId}/toggle`, { enabled: false }), 'toggle off');
  assert(on.enabled === true && off.enabled === false, 'trạng thái không đổi đúng');
  return pluginId;
});

await check('GET /api/mcps (chỉ MCP thật + có category luau & lsp)', async () => {
  const all = expectOk(await req('GET', '/api/mcps'), 'mcps');
  assert(all.total >= 8, `total=${all.total}`);
  assert(all.items.every((m) => m.real === true), 'còn MCP không phải thật trong danh sách');
  assert(all.items.every((m) => m.transport === 'stdio'), 'có MCP không dùng stdio');
  const luau = expectOk(await req('GET', '/api/mcps?category=luau'), 'filter luau');
  assert(luau.total >= 2, `category luau=${luau.total}`);
  const lsp = expectOk(await req('GET', '/api/mcps?category=lsp'), 'filter lsp');
  assert(lsp.total >= 2, `category lsp=${lsp.total}`);
  const autos = all.items.filter((m) => m.autoStart === true);
  assert(autos.length >= 1, 'không MCP nào bật autoStart');
  return `${all.total} server thật · luau=${luau.total} lsp=${lsp.total} · autoStart=${autos.length}`;
});

await check('MCP THẬT luau-lsp: type-check code Luau SAI KIỂU phải báo lỗi', async () => {
  const d = expectOk(await req('GET', '/api/mcps/luau-lsp'), 'detail');
  assert(d.real === true && d.installed === true, `real=${d.real} installed=${d.installed}`);
  assert(d.state === 'connected', `luau-lsp phải tự bật khi boot, state=${d.state}`);
  assert(d.toolCount >= 8, `tools thật=${d.toolCount}`);
  // code sai kiểu → luau-lsp thật phải trả TypeError
  const bad = expectOk(await req('POST', '/api/invoke', {
    server: 'luau-lsp', tool: 'luau_check_source',
    args: { source: '--!strict\nlocal x: number = "chuoi"\nprint(x)\n', filename: 'bad.luau' },
  }), 'invoke bad');
  assert(bad.ok === true, `invoke lỗi: ${bad.error}`);
  assert(/TypeError/.test(String(bad.result)), `không thấy TypeError: ${String(bad.result).slice(0, 160)}`);
  assert(bad.meta?.mocked === false, 'meta.mocked phải false (server thật)');
  // code đúng → sạch
  const good = expectOk(await req('POST', '/api/invoke', {
    server: 'luau-lsp', tool: 'luau_check_source',
    args: { source: '--!strict\nlocal function f(a: number): number\n\treturn a + 1\nend\nprint(f(1))\n', filename: 'good.luau' },
  }), 'invoke good');
  assert(good.ok === true && !/TypeError/.test(String(good.result)), `code đúng vẫn báo lỗi: ${String(good.result).slice(0, 160)}`);
  return `${d.toolCount} tool thật · phát hiện TypeError đúng · code sạch pass`;
});

await check('MCP THẬT lsp-universal: tools/list qua LSP bridge', async () => {
  const d = expectOk(await req('GET', '/api/mcps/lsp-universal'), 'detail');
  assert(d.state === 'connected', `state=${d.state} (phải tự bật)`);
  assert(d.toolCount >= 10, `tools=${d.toolCount}`);
  const names = (d.tools || []).map((t) => t.name);
  for (const need of ['lsp_init', 'lsp_diagnostics', 'lsp_references', 'lsp_definition']) {
    assert(names.includes(need), `thiếu tool ${need}`);
  }
  return `${d.toolCount} tool LSP thật`;
});

let connectedTools = 0;
await check('MCP THẬT mcp-filesystem: connect + đọc thư mục workspace', async () => {
  const d = expectOk(await req('GET', '/api/mcps/mcp-filesystem'), 'detail');
  assert(d.state === 'connected', `state=${d.state} (phải tự bật)`);
  connectedTools = d.toolCount;
  assert(connectedTools >= 5, `tools=${connectedTools}`);
  // root cho phép do server tự khai báo → hỏi nó rồi mới liệt kê (không đoán đường dẫn)
  const roots = expectOk(await req('POST', '/api/invoke', { server: 'mcp-filesystem', tool: 'list_allowed_directories', args: {} }), 'roots');
  assert(roots.ok === true, `list_allowed_directories lỗi: ${roots.error}`);
  const root = String(roots.result).split('\n').filter((l) => l.startsWith('/'))[0];
  assert(root, `không parse được root từ: ${String(roots.result).slice(0, 120)}`);
  const inv = expectOk(await req('POST', '/api/invoke', { server: 'mcp-filesystem', tool: 'list_directory', args: { path: root } }), 'invoke');
  assert(inv.ok === true, `list_directory lỗi: ${inv.error}`);
  return `list_directory ${root} OK (${connectedTools} tools thật)`;
});

await check('GET /api/skills', async () => {
  const s = expectOk(await req('GET', '/api/skills'), 'skills');
  assert(s.total >= 10, `skills=${s.total}`);
  const ids = s.items.map((x) => x.id);
  for (const need of ['luau-type-audit', 'luau-snippet-review', 'lsp-workspace-health']) {
    assert(ids.includes(need), `thiếu skill ${need}`);
  }
  return `${s.total} skill Luau/LSP`;
});
let runId;
await check('POST chạy skill luau-snippet-review (tool THẬT trong pipeline)', async () => {
  const r = expectOk(await req('POST', '/api/skills/luau-snippet-review/run', {
    input: { source: '--!strict\nlocal y: string = 42\nprint(y)\n' },
  }), 'run');
  runId = r.runId;
  assert(typeof runId === 'string' && runId.startsWith('run-'), `runId=${runId}`);
  // chờ skill gọi luau-lsp thật rồi kiểm audit log
  await new Promise((r2) => setTimeout(r2, 4000));
  const au = expectOk(await req('GET', '/api/audit?tail=25'), 'audit');
  const hit = (au.items || []).find((x) => x.server === 'luau-lsp' && x.tool === 'luau_check_source' && x.ok === true);
  assert(hit, 'skill không gọi được luau_check_source thật');
  return `${runId} · luau-lsp được gọi thật trong skill`;
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

await check('Plugin behavior thật: validate-required chặn invoke luau-lsp', async () => {
  const all = expectOk(await req('GET', '/api/plugins'), 'plugins');
  const p = all.items.find((x) => x.behavior === 'validate-required');
  assert(p, 'không có plugin validate-required');
  await req('POST', `/api/plugins/${p.id}/toggle`, { enabled: true });
  // thiếu arg 'source' bắt buộc → plugin phải chặn TRƯỚC khi tới luau-lsp
  const inv = await req('POST', '/api/invoke', { server: 'luau-lsp', tool: 'luau_check_source', args: {} });
  await req('POST', `/api/plugins/${p.id}/toggle`, { enabled: false });
  assert(inv.json && inv.json.ok === false, 'plugin không chặn được');
  assert(/validate-required/.test(String(inv.json.error)), `error lạ: ${inv.json.error}`);
  return `${p.id} chặn luau_check_source thiếu source`;
});

await check('SSE nhận ít nhất log + env events', async () => {
  const seen = await listenSse(6000, async () => {
    await fetch(BASE + '/api/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server: 'luau-lsp', tool: 'luau_version', args: {}, force: true }) }).catch(() => {});
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

  // 4) tab bar: số cột CSS phải khớp số tab thật trong index.html (bug lệch nav)
  const html = readFileSync(`${root}/index.html`, 'utf8');
  const nTabs = (html.match(/class="tab-btn/g) || []).length;
  const gridDecl = css.match(/\.tab-bar\s*\{[^}]*grid-template-columns:\s*repeat\((\d+)/);
  if (gridDecl && Number(gridDecl[1]) !== nTabs) {
    problems.push(`tab-bar chia ${gridDecl[1]} cột nhưng có ${nTabs} tab → nav lệch`);
  }

  // 4b) view KHÔNG được tự bọc thêm .view bên trong: el truyền vào render() đã LÀ .view,
  //     thẻ .view lồng trong không có .active → display:none → cả tab trắng trơn.
  for (const f of walk(`${root}/js/views`)) {
    const src = readFileSync(f, 'utf8');
    const code = src.split('\n').filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join('\n');
    if (/class="view[\s"]/.test(code)) problems.push(`${f.replace(root, 'web')}: tự bọc class="view" → tab bị display:none`);
  }

  // 5) MỌI route trong ROUTES của app.js phải có <section id="view-*"> + data-route tương ứng.
  //    Thiếu container → navigate() return im lặng, tab bấm vào không hiện gì.
  const appSrc = readFileSync(`${root}/js/app.js`, 'utf8');
  const routesBlock = appSrc.match(/const ROUTES = \{([\s\S]*?)\};/);
  assert(routesBlock, 'không tìm thấy const ROUTES trong app.js');
  const routeKeys = [...routesBlock[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert(routeKeys.length >= 5, `chỉ parse được ${routeKeys.length} route`);
  const containers = new Set([...html.matchAll(/id="view-([\w-]+)"/g)].map((m) => m[1]));
  const navRoutes = new Set([...html.matchAll(/data-route="([\w-]+)"/g)].map((m) => m[1]));
  for (const k of routeKeys) {
    if (!containers.has(k)) problems.push(`route "${k}" thiếu <section id="view-${k}"> → tab chết`);
    if (!navRoutes.has(k)) problems.push(`route "${k}" thiếu nút data-route="${k}" trong tab bar`);
  }
  for (const c of containers) {
    if (!routeKeys.includes(c)) problems.push(`view-${c} không có route tương ứng trong ROUTES`);
  }

  assert(problems.length === 0, `UI có lỗi tiềm ẩn:\n    ${problems.join('\n    ')}`);
  return `${nIcons} icon · ${declared.size} CSS var · ${nTabs} tab · ${routeKeys.length} route khớp container`;
});

await check('GUI OpenCode: token màu + layout part đã áp dụng', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../web', import.meta.url));
  const css = readFileSync(`${root}/css/app.css`, 'utf8');
  const problems = [];
  // bảng màu warm-neutral của OpenCode (hsl), không còn #ffffff/#0a0a0a cứng
  if (!/--bg:\s*hsl\(0,\s*20%,\s*99%\)/.test(css)) problems.push('thiếu --bg light hsl(0,20%,99%) của OpenCode');
  if (!/--bg:\s*hsl\(0,\s*9%,\s*7%\)/.test(css)) problems.push('thiếu --bg dark hsl(0,9%,7%) của OpenCode');
  if (!/--hi:\s*hsl\(62,/.test(css)) problems.push('thiếu accent --hi vàng-chanh hsl(62,…)');
  // góc 4px thay vì bo tròn 10px kiểu cũ
  if (!/--r-md:\s*4px/.test(css)) problems.push('--r-md phải là 4px (0.25rem) theo OpenCode');
  // layout part + tool block
  for (const need of ['.part-rail', '.part-mark', '.part-bar', '.part-text', '.tool-block', '.tool-head', '.tool-args', '.oc-panel', '.oc-stream', '.oc-wordmark']) {
    if (!css.includes(need)) problems.push(`thiếu class ${need}`);
  }
  const chatSrc = readFileSync(`${root}/js/views/chat.js`, 'utf8');
  if (/addBubble\(/.test(chatSrc)) problems.push('chat.js còn dùng bubble cũ (addBubble)');
  if (!/addPart\(/.test(chatSrc)) problems.push('chat.js chưa dùng addPart() kiểu OpenCode');
  const homeSrc = readFileSync(`${root}/js/views/home.js`, 'utf8');
  if (/stat-grid/.test(homeSrc)) problems.push('home.js còn stat-grid kiểu dashboard cũ');
  if (!/oc-panel/.test(homeSrc)) problems.push('home.js chưa dùng oc-panel');
  // không được sót số registry hard-code cũ
  for (const f of ['js/views/settings.js', 'js/views/home.js']) {
    const src = readFileSync(`${root}/${f}`, 'utf8');
    for (const n of ['98', '143', '41', '106']) {
      if (new RegExp(`'${n}'`).test(src)) problems.push(`${f}: còn hard-code số registry cũ '${n}'`);
    }
  }
  assert(problems.length === 0, `GUI chưa đúng chuẩn OpenCode:\n    ${problems.join('\n    ')}`);
  return 'token màu + part layout + tool block + panel OK';
});

await check('install.sh: update tự restart + chỉ kill đúng cổng & đúng thư mục', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const sh = readFileSync(fileURLToPath(new URL('../install.sh', import.meta.url)), 'utf8');
  const problems = [];
  // /api/status phải trả pid + rootDir để installer nhận diện tiến trình
  const st = expectOk(await req('GET', '/api/status'), '/api/status');
  if (typeof st.pid !== 'number') problems.push('/api/status thiếu pid');
  if (typeof st.rootDir !== 'string' || !st.rootDir) problems.push('/api/status thiếu rootDir');
  // installer phải so version đĩa vs version đang chạy rồi restart
  for (const need of ['disk_version()', 'running_version()', 'status_field pid', 'status_field rootDir', 'stop_running()']) {
    if (!sh.includes(need)) problems.push(`install.sh thiếu ${need}`);
  }
  // TUYỆT ĐỐI không pkill theo tên tiến trình (giết cả instance khác của người dùng)
  if (/pkill\s+-f\s+server\/index\.js/.test(sh)) problems.push('install.sh còn pkill -f server/index.js');
  // repo URL phải là repo chuẩn hiện tại
  if (!sh.includes('article-hub-studio/harness-executor')) problems.push('install.sh dùng URL repo cũ');
  assert(problems.length === 0, `install.sh chưa đúng:\n    ${problems.join('\n    ')}`);
  return `pid=${st.pid} · rootDir ok · so version + restart có gác cổng/thư mục`;
});

await check('Watchdog index.html không bật banner offline oan cho app đang sống', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../web', import.meta.url));
  const html = readFileSync(`${root}/index.html`, 'utf8');
  const appjs = readFileSync(`${root}/js/app.js`, 'utf8');
  // app.js phải đặt cờ Ở TOP-LEVEL (không nằm trong init()) vì init() mất >1.5s.
  const beforeInit = appjs.split('async function init()')[0];
  assert(/window\.__UPIO_MODULES\s*=\s*true/.test(beforeInit),
    'app.js chưa đặt window.__UPIO_MODULES = true ở top-level');
  // cả 3 nhánh watchdog/retry đều phải kiểm tra cờ đó
  const guards = html.match(/__UPIO_MODULES/g) || [];
  assert(guards.length >= 3, `index.html chỉ có ${guards.length} guard __UPIO_MODULES (cần >= 3)`);
  assert(!/if \(window\.__UPIO_BOOTED\) return;/.test(html),
    'index.html còn nhánh chỉ kiểm tra __UPIO_BOOTED → banner offline hiện oan');
  return `cờ top-level + ${guards.length} guard`;
});

await check('Không emoji trong chrome UI: mọi icon registry là key ICONS thật', async () => {
  const { fileURLToPath } = await import('node:url');
  const { ICONS } = await import(fileURLToPath(new URL('../web/js/icons.js', import.meta.url)));
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  const bad = [];
  let n = 0;
  for (const [ep, label] of [['/api/mcps', 'mcp'], ['/api/plugins', 'plugin'], ['/api/skills', 'skill']]) {
    const d = expectOk(await req('GET', ep), ep);
    for (const it of d.items) {
      n++;
      if (EMOJI.test(String(it.icon ?? ''))) bad.push(`${label} ${it.id}: icon emoji "${it.icon}"`);
      else if (!ICONS[it.icon]) bad.push(`${label} ${it.id}: icon "${it.icon}" không có trong ICONS`);
    }
  }
  assert(bad.length === 0, `icon sai:\n    ${bad.join('\n    ')}`);
  return `${n} item · 100% icon SVG hợp lệ`;
});

// ---- tổng kết ----
const passed = results.filter((r) => r.ok).length;
console.log(`\n📊 Kết quả: ${passed}/${results.length} pass`);
if (passed < results.length) { console.log('\n❌ SMOKE TEST THẤT BẠI'); process.exit(1); }
console.log('✅ SMOKE TEST PASS TOÀN BỘ\n');
