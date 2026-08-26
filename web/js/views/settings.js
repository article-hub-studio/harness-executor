/* ============================================================
   upio web — view Settings:
   (1) Environment: checklist (icon trạng thái) + Scan again +
       Build (+repair) với console log realtime qua SSE 'env'.
   (2) Models: list models, thêm/sửa provider OpenAI-compatible,
       Test latency, Save config PUT, chọn default, show/hide key.
   (3) Theme: dark mode toggle (lưu localStorage).
   (4) About: version, stack, credit upio labs.
   ============================================================ */
import { api, listen, esc, toast, store, fmtClock, refreshModels, icon, applyTheme, isDark } from '../app.js';

export async function render(el) {
  el.innerHTML = `
  <div class="container">
    <header class="hero">
      <h1 class="hero-brand">${icon('solar/settings', 'ic-lg')} Settings</h1>
      <p class="hero-sub">Environment · Models · Theme · About</p>
    </header>

    <div class="settings-grid">
      <!-- ============ (1) Environment ============ -->
      <section>
        <div class="card pad" id="env-card">
          <h3 class="card-title">${icon('blade/build', 'ic-sm')} Environment</h3>
          <div id="env-summary" class="tag-row" style="margin-bottom:6px"></div>
          <div id="env-checks"><div class="skel skel-line" style="width:100%"></div><div class="skel skel-line" style="width:88%;margin-top:8px"></div><div class="skel skel-line" style="width:70%;margin-top:8px"></div></div>
          <div class="form-grid cols-2" style="margin-top:14px">
            <button type="button" class="btn ghost" id="env-scan">${icon('blade/refresh', 'ic-sm')} Scan again</button>
            <button type="button" class="btn primary" id="env-build">${icon('blade/build', 'ic-sm')} Build Environment</button>
          </div>
          <label class="check-row"><input type="checkbox" id="env-repair"><span>Repair mode (sửa cả cấu hình thiếu)</span></label>
          <div id="env-log-wrap" class="hidden" style="margin-top:10px">
            <h4 class="sec-title" style="margin-top:4px">Build log <span class="live-dot"></span></h4>
            <div class="console" id="env-console"></div>
          </div>
        </div>

        <!-- Theme -->
        <div class="card pad" style="margin-top:14px">
          <div class="check-row" style="justify-content:space-between">
            <b style="display:inline-flex;align-items:center;gap:8px">${icon('solar/moon', 'ic-sm')} Chế độ tối (dark theme)</b>
            <span class="switch"><input type="checkbox" id="theme-toggle"><span class="track"></span></span>
          </div>
        </div>
      </section>

      <!-- ============ (2) Models + (3) About ============ -->
      <section>
        <div class="card pad" id="models-card">
          <h3 class="card-title">${icon('solar/cpu', 'ic-sm')} Models</h3>
          <div id="model-list"><div class="skel skel-line" style="width:100%"></div></div>

          <h4 class="sec-title">Provider OpenAI-compatible</h4>
          <form id="provider-form">
            <div class="field"><label>ID *</label>
              <input class="input mono" name="id" required placeholder="my-openai" autocomplete="off">
            </div>
            <div class="field"><label>Label</label>
              <input class="input" name="label" placeholder="OpenAI chính">
            </div>
            <div class="field"><label>Base URL</label>
              <input class="input mono" name="baseUrl" placeholder="https://api.openai.com/v1" autocomplete="off">
            </div>
            <div class="field"><label>API key
              (<button type="button" class="linklike" id="ak-eye">${icon('blade/eye', 'ic-xs')} show</button>)</label>
              <input class="input mono" name="apiKey" type="password" placeholder="sk-…" autocomplete="off">
            </div>
            <div class="field"><label>Model ID</label>
              <input class="input mono" name="model" placeholder="gpt-4o-mini" autocomplete="off">
            </div>
            <div class="qa-row">
              <button type="button" class="btn ghost" id="prov-test">${icon('blade/bolt', 'ic-sm')} Test</button>
              <button type="submit" class="btn primary" id="prov-save">${icon('blade/download', 'ic-sm')} Save config</button>
            </div>
            <div id="test-out" class="test-out hidden"></div>
          </form>
        </div>

        <!-- (3) About -->
        <div class="card pad" style="margin-top:14px">
          <h3 class="card-title">${icon('solar/book', 'ic-sm')} About</h3>
          <div class="about-list">
            <div><span class="k">Version</span><b id="about-ver">—</b></div>
            <div><span class="k">Stack</span><span>Vanilla ES modules · CSS thuần · zero-dependency Node</span></div>
            <div><span class="k">Registry</span><span>${esc(String(store.counts.mcps || '98'))} MCPs · ${esc(String(store.counts.plugins || '143'))} plugins · ${esc(String(store.counts.skills || '41'))} skills</span></div>
            <div><span class="k">Credit</span><span>© upio labs<span class="wm-dot" style="margin-left:2px"></span></span></div>
            <div><span class="k">Repo</span><a href="https://github.com/upio-labs/mcp-executor" target="_blank" rel="noopener noreferrer">github.com/upio-labs/mcp-executor ${icon('blade/external', 'ic-xs')}</a></div>
          </div>
        </div>
      </section>
    </div>
  </div>`;

  const $ = (id) => el.querySelector('#' + id);
  let envOff = []; // unsubscribe các listener SSE của build đang chạy

  /* ================= (1) ENVIRONMENT ================= */
  function drawEnv(data) {
    if (!data) { $('env-checks').innerHTML = '<p class="dim">Không tải được checklist (API offline).</p>'; return; }
    const sum = data.summary || {};
    $('env-summary').innerHTML =
      `<span class="badge ok">${icon('blade/check', 'ic-xs')} pass ${sum.pass ?? 0}</span>` +
      `<span class="badge warn">${icon('blade/warn', 'ic-xs')} warn ${sum.warn ?? 0}</span>` +
      `<span class="badge fail">${icon('blade/error', 'ic-xs')} fail ${sum.fail ?? 0}</span>`;
    const ICO = { pass: icon('blade/check', 'ic-sm'), warn: icon('blade/warn', 'ic-sm'), fail: icon('blade/error', 'ic-sm') };
    $('env-checks').innerHTML = (data.checks || []).map((c) => `
      <div class="env-row">
        <span class="env-ico ${c.status === 'pass' ? 'c-ok' : c.status === 'fail' ? 'c-fail' : 'c-warn'}">${ICO[c.status] || '•'}</span>
        <span class="env-label">${esc(c.label || c.id)}
          <span class="env-detail">${esc(c.detail || '')}</span></span>
        ${c.version ? `<span class="env-ver">${esc(c.version)}</span>` : ''}
      </div>`).join('') || '<p class="dim">Trống.</p>';
  }

  async function loadEnv() {
    try { drawEnv(await api.env()); }
    catch { drawEnv(null); }
  }

  $('env-scan').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('loading');
    await loadEnv();
    btn.classList.remove('loading');
    toast('Đã quét lại environment', 'info');
  });

  /* Build: POST → lắng nghe SSE 'env' → console log; im 4s hoặc 15s → refresh checklist */
  $('env-build').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (store.envBuilding) { toast('Build đang chạy rồi nhé', 'warn'); return; }
    const repair = $('env-repair').checked;
    btn.classList.add('loading');
    store.envBuilding = true;

    const wrap = $('env-log-wrap');
    const con = $('env-console');
    wrap.classList.remove('hidden');
    con.innerHTML = '';

    function line(level, text) {
      const div = document.createElement('div');
      div.className = `ln lvl-${level === 'ok' ? 'ok' : level === 'error' ? 'err' : level === 'warn' ? 'warn' : 'info'}`;
      div.innerHTML = `<span class="t">${fmtClock()}</span>`;
      div.appendChild(document.createTextNode(text));
      con.appendChild(div);
      while (con.children.length > 300) con.firstElementChild.remove();
      con.scrollTop = con.scrollHeight;
    }

    let gotEvent = false;
    const offEnv = listen('env', (evt) => {
      gotEvent = true;
      line(evt.level || evt.status || 'info', evt.line ?? evt.detail ?? JSON.stringify(evt));
      armQuiet(); // mỗi dòng log mới → hoãn refresh
    });
    envOff.push(offEnv);

    let quietTimer = null;
    const t0 = Date.now();
    function armQuiet() {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finalize, 4000); // "event cuối"
    }
    async function finalize() {
      clearTimeout(hardTimer);
      envOff.forEach((f) => f());
      envOff = [];
      await loadEnv();
      store.envBuilding = false;
      btn.classList.remove('loading');
      toast('Environment build hoàn tất — checklist đã cập nhật', 'ok');
    }
    const hardTimer = setTimeout(finalize, 15000); // chốt sau tối đa 15s

    try {
      await api.envBuild(repair);
      if (!gotEvent) armQuiet();
      line('info', `build started (repair=${!!repair})…`);
    } catch (err) {
      clearTimeout(hardTimer);
      clearTimeout(quietTimer);
      envOff.forEach((f) => f());
      envOff = [];
      store.envBuilding = false;
      btn.classList.remove('loading');
      line('err', `[lỗi] ${err.message}`);
      toast(err.message, 'error');
    }
  });

  /* ================= THEME ================= */
  const themeBtn = $('theme-toggle');
  themeBtn.checked = isDark();
  themeBtn.addEventListener('change', () => {
    applyTheme(themeBtn.checked);
    toast(themeBtn.checked ? 'Dark theme' : 'Light theme', 'info');
  });

  /* ================= SHOW/HIDE API KEY ================= */
  const eyeBtn = $('ak-eye');
  const keyInput = el.querySelector('#provider-form [name="apiKey"]');
  eyeBtn.addEventListener('click', () => {
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    eyeBtn.innerHTML = `${icon(show ? 'blade/eyeoff' : 'blade/eye', 'ic-xs')} ${show ? 'hide' : 'show'}`;
  });

  /* ================= (2) MODELS ================= */
  let config = { default: 'ox-local-mock', providers: [] };

  function drawModels() {
    const models = store.models;
    $('model-list').innerHTML = !models.length
      ? '<p class="dim">Chưa tải được model nào (API offline?). Mock model vẫn dùng được qua Chat.</p>'
      : models.map((m) => `
        <label class="model-row">
          <input type="radio" name="default-model" value="${esc(m.id)}" class="radio" ${m.id === config.default ? 'checked' : ''}>
          <span class="model-main">
            <span class="model-id">${esc(m.id)}</span>
            <span class="model-label">${esc(m.provider || '')}${m.label && m.label !== m.id ? ' · ' + esc(m.label) : ''}</span>
          </span>
          <span class="badge mini ${m.available ? 'connected' : 'disconnected'}">${m.available ? 'available' : 'unavailable'}</span>
        </label>`).join('');
    $('#about-ver').textContent = store.status?.version || '—';
  }

  // Radio default → PUT ngay (đặt model mặc định)
  $('model-list').addEventListener('change', async (e) => {
    if (e.target.name !== 'default-model') return;
    config.default = e.target.value;
    try {
      await api.saveModels(config);
      toast(`Model mặc định: ${config.default}`, 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Điền form khi bấm vào 1 hàng model có provider tương ứng
  $('model-list').addEventListener('click', (e) => {
    const row = e.target.closest('.model-row');
    if (!row) return;
    const radio = row.querySelector('input[type=radio]');
    const prov = config.providers.find((p) => p.model === radio.value);
    if (!prov) return; // mock hoặc provider chưa lưu
    fillForm(prov);
  });

  function fillForm(p) {
    const f = $('provider-form');
    f.elements.id.value = p.id || '';
    f.elements.label.value = p.label || '';
    f.elements.baseUrl.value = p.baseUrl || '';
    f.elements.apiKey.value = p.apiKey || '';
    f.elements.model.value = p.model || '';
  }

  /* Test provider: POST /api/models/test → hiện latency */
  $('prov-test').addEventListener('click', async () => {
    const out = $('test-out');
    const f = $('provider-form');
    if (!f.elements.id.value.trim()) { out.className = 'test-out err'; out.textContent = 'Cần nhập ID provider trước khi test.'; return; }
    out.className = 'test-out';
    out.textContent = 'Đang ping provider…';
    try {
      const r = await api.testModel(f.elements.id.value.trim());
      out.className = `test-out ${r.ok ? 'ok' : 'err'}`;
      out.textContent = r.ok
        ? `OK — latency ${r.latencyMs}ms${r.detail ? ' · ' + r.detail : ''}`
        : `Fail${r.latencyMs != null ? ` (${r.latencyMs}ms)` : ''}${r.detail ? ' · ' + r.detail : ''}`;
    } catch (err) {
      out.className = 'test-out err';
      out.textContent = err.message;
    }
  });

  /* Save: gộp provider vào config rồi PUT toàn bộ */
  $('provider-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const p = {
      id: f.elements.id.value.trim(),
      label: f.elements.label.value.trim() || undefined,
      baseUrl: f.elements.baseUrl.value.trim(),
      apiKey: f.elements.apiKey.value.trim(),
      model: f.elements.model.value.trim() || undefined,
    };
    if (!p.id) return;
    const i = config.providers.findIndex((x) => x.id === p.id);
    if (i >= 0) config.providers[i] = { ...config.providers[i], ...p };
    else config.providers.push(p);
    try {
      await api.saveModels(config);
      toast('Đã lưu model config', 'ok');
      await loadModels();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function loadModels() {
    await refreshModels();   // nạp vào store + bắn event 'models'
    drawModels();
  }

  /* ---------------- boot view ---------------- */
  const statusOff = listen('status', () => { drawModels(); });
  const modelsOff = listen('models', () => {
    config = store.modelConfig; // đồng bộ config mới nhất từ store
    drawModels();
  });
  loadEnv();
  loadModels();

  return () => {
    statusOff();
    modelsOff();
    envOff.forEach((f) => f());
  };
}
