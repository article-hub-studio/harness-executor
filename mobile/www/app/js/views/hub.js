/* ============================================================
   upio web — view Hub: segmented [MCPs | Plugins | Skills],
   search + chip category (icon hoá), list card, bottom-sheet
   chi tiết (connect/invoke · toggle plugin · run skill).
   ============================================================ */
import {
  api, listen, esc, toast, openSheet, onSheetClose,
  store, debounce, copyText, icon, stMark, stateLabel,
} from '../app.js';

const state = {
  tab: 'mcps',           // 'mcps' | 'plugins' | 'skills'
  q: '',
  cat: '',
  limit: 40,
  mcps: [], plugins: [], skills: [],
  loaded: false,
};

/* Icon theo category (chỉ dùng tên có trong ICONS) */
const CAT_ICONS = {
  /* MCP category của bản Luau/LSP */
  luau: 'solar/cpu', lsp: 'solar/search', workspace: 'solar/folder', security: 'solar/shield',
  /* plugins / tags */
  automation: 'solar/zap', devtools: 'solar/terminal', ai: 'solar/cpu', web: 'solar/globe',
  system: 'solar/server', data: 'solar/database', networking: 'solar/link', text: 'solar/file',
  tools: 'solar/wrench', prompt: 'solar/chat', roblox: 'solar/house', ops: 'solar/server',
  /* server thật */
  real: 'blade/bolt',
};

/** Nhãn hiển thị của category. */
const CAT_LABELS = { luau: 'Luau', lsp: 'LSP', workspace: 'Workspace', security: 'Security', real: 'Thật' };
const catLabel = (c) => CAT_LABELS[String(c)] ?? String(c ?? '');

/** Icon trong data là emoji (server thật) hay SVG name → render tương ứng. */
function itemIcon(it, fallbackSvg) {
  if (!it.icon) return icon(fallbackSvg, '');
  return /\p{Extended_Pictographic}/u.test(it.icon)
    ? `<span class="emo">${esc(it.icon)}</span>`
    : icon(it.icon, '');
}

/* Env đã lưu cho server thật (local flag khi API không trả envKeys) */
const envSavedMap = new Map(); // `${id}:${key}` → true

export async function render(el) {
  state.limit = 40;

  el.innerHTML = `
  <div class="container">
    <header class="oc-hero">
      <div class="oc-wordmark">hub</div>
      <div class="oc-statusline"><span class="oc-sl-item">registry luau · lsp · workspace</span></div>
    </header>
    <div class="segmented" role="tablist" id="hub-seg">
      <button type="button" class="seg-btn active" data-tab="mcps" role="tab">MCPs</button>
      <button type="button" class="seg-btn" data-tab="plugins" role="tab">Plugins</button>
      <button type="button" class="seg-btn" data-tab="skills" role="tab">Skills</button>
    </div>
    <div class="search-wrap">
      ${icon('solar/search', 'ic-sm')}
      <input type="search" class="input" id="hub-search" placeholder="Tìm theo tên, mô tả…" autocomplete="off">
    </div>
    <div class="chip-row" id="hub-chips" style="margin-top:10px"></div>
    <div class="hub-list" id="hub-list"></div>
    <div style="text-align:center;margin-top:6px"><button type="button" class="btn ghost small hidden" id="hub-more">Xem thêm</button></div>
  </div>`;

  const $ = (s) => el.querySelector(String(s).startsWith('#') ? s : '#' + s);

  /* ---------------- Nạp dữ liệu registry ---------------- */
  async function ensureData() {
    if (state.loaded) return true;
    $('hub-list').innerHTML = Array.from({ length: 5 }, () =>
      `<div class="card skel-card"><div class="skel-row"><div class="skel skel-ico"></div>
       <div class="skel-lines"><div class="skel skel-line" style="width:55%"></div>
       <div class="skel skel-line" style="width:90%"></div></div></div></div>`).join('');
    const [m, p, s] = await Promise.allSettled([api.mcps(), api.plugins(), api.skills()]);
    state.mcps = m.status === 'fulfilled' ? m.value.items || [] : [];
    state.plugins = p.status === 'fulfilled' ? p.value.items || [] : [];
    state.skills = s.status === 'fulfilled' ? s.value.items || [] : [];
    store.registries = { mcps: state.mcps, plugins: state.plugins, skills: state.skills };
    state.loaded = state.mcps.length + state.plugins.length + state.skills.length > 0;
    if (!state.loaded) {
      $('hub-list').innerHTML = `<div class="card pad empty" style="grid-column:1/-1">
        <div class="empty-ico">${icon('solar/server', 'ic-lg')}</div><b>API offline</b>
        <p class="dim">Không tải được registry. Kiểm tra backend rồi thử lại.</p>
        <button type="button" class="btn primary small" id="hub-retry" style="margin-top:12px">${icon('blade/refresh', 'ic-sm')} Thử lại</button></div>`;
      $('hub-retry').addEventListener('click', () => { state.loaded = false; ensureData().then((ok) => ok && renderAll(true)); });
      return false;
    }
    return true;
  }

  /* ---------------- Filter + chips ---------------- */
  function items() {
    const q = state.q.trim().toLowerCase();
    let arr = state[state.tab] || [];
    if (state.cat) {
      arr = arr.filter((it) => state.tab === 'skills'
        ? (it.tags || []).includes(state.cat)
        : it.category === state.cat);
    }
    if (q) {
      arr = arr.filter((it) =>
        `${it.name} ${it.description} ${it.category || ''} ${(it.tags || []).join(' ')}`
          .toLowerCase().includes(q));
    }
    return arr;
  }

  function renderChips() {
    const src = state.tab === 'skills'
      ? [...new Set(state.skills.flatMap((x) => x.tags || []))]
      : [...new Set(state[state.tab].map((x) => x.category))];
    const cats = ['All', ...src.filter(Boolean).slice(0, 12)];
    $('hub-chips').innerHTML = cats.map((c) => {
      const icName = c === 'All' ? '' : CAT_ICONS[String(c).toLowerCase()];
      const active = c === state.cat || (c === 'All' && !state.cat);
      return `<button type="button" class="chip ${active ? 'active' : ''}" data-cat="${esc(c)}">` +
        `${icName ? icon(icName, 'ic-xs') : ''}${esc(c === 'All' ? 'All' : catLabel(c))}</button>`;
    }).join('');
  }

  /* ---------------- List rendering ---------------- */
  function cardHTML(it) {
    const chev = `<span class="rc-chevron">${icon('blade/chevr', 'ic-sm')}</span>`;
    if (state.tab === 'mcps') {
      const connected = it.state === 'connected';
      // Registry chỉ còn MCP thật → không cần badge REAL nữa; thay bằng AUTO cho server tự bật.
      const autoBadge = it.autoStart ? '<span class="badge mini inv">AUTO</span>' : '';
      const featured = it.featured ? ' featured' : '';
      // toolCount do API trả (tools/list thật khi đã bật, toolPreview khi chưa)
      const nTools = it.toolCount ?? (it.tools || []).length;
      return `
        <button type="button" class="card row-card${featured}" data-id="${esc(it.id)}">
          <span class="rc-icon">${itemIcon(it, 'solar/server')}</span>
          <span class="rc-main">
            <span class="rc-top"><b>${esc(it.name)}</b>${autoBadge}</span>
            <span class="rc-desc">${esc(it.description)}</span>
            <span class="rc-meta">${stMark(connected ? 'connected' : 'disconnected')}${esc(catLabel(it.category))} · ${esc(String(nTools))} tools · ${esc(it.transport)}</span>
          </span>
          ${chev}
        </button>`;
    }
    if (state.tab === 'plugins') {
      return `
        <button type="button" class="card row-card" data-id="${esc(it.id)}">
          <span class="rc-icon">${itemIcon(it, 'solar/puzzle')}</span>
          <span class="rc-main">
            <span class="rc-top"><b>${esc(it.name)}</b><span class="badge mini${it.enabled ? ' inv' : ''}">${it.enabled ? 'ON' : 'OFF'}</span></span>
            <span class="rc-desc">${esc(it.description)}</span>
            <span class="rc-meta">${icon('blade/bolt', 'ic-xs')}${esc(it.behavior || '—')}</span>
          </span>
          ${chev}
        </button>`;
    }
    return `
      <button type="button" class="card row-card" data-id="${esc(it.id)}">
        <span class="rc-icon">${itemIcon(it, 'blade/sparkles')}</span>
        <span class="rc-main">
          <span class="rc-top"><b>${esc(it.name)}</b><span class="badge mini">${(it.steps || []).length} bước</span></span>
          <span class="rc-desc">${esc(it.description)}</span>
          <span class="rc-meta">${esc((it.tags || []).join(' · '))}</span>
        </span>
        ${chev}
      </button>`;
  }

  /** stagger=true → list entrance lần lượt (lần đầu/tab/chip); false khi filter/SSE để không nhấp nháy. */
  function renderList(stagger = false) {
    const arr = items();
    const slice = arr.slice(0, state.limit);
    const listEl = $('hub-list');
    listEl.classList.toggle('stagger', !!stagger && slice.length > 0);
    listEl.innerHTML = slice.length
      ? slice.map(cardHTML).join('')
      : `<div class="card pad empty" style="grid-column:1/-1"><div class="empty-ico">${icon('blade/search', 'ic-lg')}</div>
         <b>Không tìm thấy mục nào</b><p class="dim">Thử đổi từ khóa hoặc bỏ chip lọc.</p></div>`;
    const more = $('hub-more');
    more.classList.toggle('hidden', arr.length <= state.limit);
    more.textContent = `Xem thêm (${arr.length - state.limit})`;
  }

  function renderAll(stagger = false) { renderChips(); renderList(stagger); }

  /* ---------------- Controls ---------------- */
  $('hub-seg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.tab = b.dataset.tab;
    state.cat = '';
    state.limit = 40;
    el.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    renderAll(true);
  });

  $('hub-search').addEventListener('input', debounce((e) => {
    state.q = e.target.value;
    state.limit = 40;
    renderList(false);
  }, 250));

  $('hub-chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    state.cat = c.dataset.cat === 'All' ? '' : c.dataset.cat;
    renderAll(true);
  });

  $('hub-more').addEventListener('click', () => { state.limit += 40; renderList(); });

  // Mở sheet chi tiết theo tab
  $('hub-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const it = items().find((x) => x.id === row.dataset.id);
    if (!it) return;
    if (state.tab === 'mcps') openMcpSheet(it);
    else if (state.tab === 'plugins') openPluginSheet(it);
    else openSkillSheet(it);
  });

  // Cập nhật dot trạng thái khi server broadcast SSE 'mcp'
  const offMcp = listen('mcp', (evt) => {
    const it = state.mcps.find((m) => m.id === evt.id || (evt.server && m.id === evt.server));
    if (it && evt.state) { it.state = evt.state; if (state.tab === 'mcps') renderList(false); }
  });

  /* ================= Sheet MCP ================= */
  function drawStateBadge(badge, item) {
    const st = item.state === 'connected' ? 'connected' : item.state === 'error' ? 'error' : 'disconnected';
    badge.className = `badge ${st}`;
    badge.innerHTML = `${stMark(st === 'connected' ? 'connected' : st === 'error' ? 'fail' : 'disconnected')}${esc(stateLabel(item.state))}`;
  }

  async function openMcpSheet(listItem) {
    const panel = openSheet(`<div class="empty" style="display:flex;gap:10px;justify-content:center;align-items:center;padding:34px"><span class="spin"></span> Đang tải chi tiết…</div>`);
    let item = listItem;
    // Server thật: lấy detail mới (có installed / envKeys / needsEnv)
    if (listItem.real) {
      try {
        const d = await api.mcp(listItem.id);
        Object.assign(listItem, d);
      } catch (err) {
        panel.querySelector('.sheet-body').innerHTML =
          `<div class="empty"><div class="empty-ico">${icon('blade/error', 'ic-lg')}</div><b>${esc(err.message)}</b></div>`;
        return;
      }
    }
    const body = panel.querySelector('.sheet-body');
    body.innerHTML = `
      <div class="sheet-head">
        <span class="rc-icon">${itemIcon(item, 'solar/server')}</span>
        <div style="min-width:0">
          <div class="sheet-title">${esc(item.name)}${item.autoStart ? ' <span class="badge mini inv">AUTO</span>' : ''}</div>
          <div class="sheet-sub">by ${esc(item.author || 'upio')} · v${esc(item.version)} · ${esc(item.transport)}${item.install ? ` · ${esc(item.install.method)}` : ''}</div>
        </div>
      </div>
      <div class="tag-row">${(item.tags || []).map((t) => `<span class="badge mini">#${esc(t)}</span>`).join('')}</div>
      <p class="sheet-desc">${esc(item.description)}</p>
      ${!item.installed && item.install && item.install.repo ? `<p class="dim" style="font-size:12.5px;margin:-2px 0 8px;display:flex;gap:6px;align-items:baseline">${icon('blade/warn', 'ic-xs')} Server chưa được cài trên máy này — cần tải &amp; build từ repo trước khi kết nối.</p>` : ''}
      <div class="sheet-sec hidden" id="mcp-install-area"></div>
      <div class="sheet-sec">
        <div class="form-grid cols-2">
          <div class="field"><label>Trạng thái</label>
            <div><span class="badge disconnected" id="mcp-state-badge"></span></div>
          </div>
          <div class="field"><label>&nbsp;</label>
            <button type="button" class="btn block primary" id="mcp-toggle-btn"></button>
            <div class="field-hint dim hidden" id="mcp-install-hint">Cài đặt trước khi kết nối</div>
          </div>
        </div>
      </div>
      <div class="sheet-sec hidden" id="mcp-env-area"></div>
      <div class="sheet-sec" id="mcp-tools-area"></div>
      <div class="sheet-sec hidden" id="mcp-invoke-area"></div>`;

    const tools = () => item.tools || [];

    /* ----- Cài đặt server thật (git clone + build), log stream qua SSE ----- */
    function pushInstallLine(box, text) {
      const div = document.createElement('div');
      div.className = 'ln lvl-info';
      div.textContent = String(text ?? '');
      box.appendChild(div);
      while (box.children.length > 200) box.firstElementChild.remove(); // tối đa 200 dòng
      box.scrollTop = box.scrollHeight;
    }

    async function runInstall(btn) {
      const area = body.querySelector('#mcp-install-area');
      const wrap = area.querySelector('#mcp-install-log-wrap');
      const con = area.querySelector('#mcp-install-console');
      wrap.classList.remove('hidden');
      con.innerHTML = '';
      btn.classList.add('loading');
      btn.disabled = true;

      const offs = [];
      onSheetClose(() => offs.forEach((f) => f()));
      // Log stream: SSE event 'log' với payload.install === true
      offs.push(listen('log', (evt) => {
        if (!evt || evt.install !== true || !con.isConnected) return;
        pushInstallLine(con, evt.line ?? evt.detail ?? JSON.stringify(evt));
      }));

      try {
        const r = await api.installMcp(item.id); // → {ok, logs}
        if (r && Array.isArray(r.logs)) r.logs.forEach((l) => con.isConnected && pushInstallLine(con, l));
      } catch (err) {
        if (con.isConnected) pushInstallLine(con, `[lỗi] ${err.message}`);
        toast(err.message, 'error');
      } finally {
        btn.classList.remove('loading');
        // Cài xong (dù lỗi): GET lại detail để cập nhật installed
        try {
          const d = await api.mcp(item.id);
          Object.assign(listItem, d);
        } catch { /* giữ trạng thái cũ */ }
        redrawSheet();
        toast(item.installed === false
          ? `${item.name}: cài đặt chưa hoàn tất`
          : `${item.name}: đã cài xong — có thể kết nối`, item.installed === false ? 'warn' : 'ok');
      }
    }

    function drawInstallArea() {
      const area = body.querySelector('#mcp-install-area');
      const need = item.real && item.installed === false && item.install && item.install.method === 'git-clone';
      if (!need) { area.classList.add('hidden'); area.innerHTML = ''; return; }
      area.classList.remove('hidden');
      area.innerHTML = `
        <h4>Cài đặt</h4>
        <button type="button" class="btn primary block" id="mcp-install-btn">${icon('blade/download', 'ic-sm')} Tải &amp; build</button>
        <div id="mcp-install-log-wrap" class="hidden" style="margin-top:10px">
          <div class="console" id="mcp-install-console" aria-live="polite"></div>
        </div>`;
      area.querySelector('#mcp-install-btn').addEventListener('click', (e) => runInstall(e.currentTarget));
    }

    function drawToggleBtn(btn) {
      const connected = item.state === 'connected';
      const needsInstall = item.real && item.installed === false;
      btn.disabled = needsInstall;
      btn.innerHTML = needsInstall
        ? `${icon('blade/lock', 'ic-sm')} Cài đặt trước`
        : connected
          ? `${icon('blade/disconnect', 'ic-sm')} Disconnect`
          : `${icon('blade/connect', 'ic-sm')} Connect`;
      btn.className = `btn block ${needsInstall ? 'ghost' : connected ? 'ghost' : 'primary'}`;
      body.querySelector('#mcp-install-hint').classList.toggle('hidden', !needsInstall);
    }

    /* ----- Biến môi trường cho server thật (needsEnv) ----- */
    const keySaved = (k) =>
      envSavedMap.has(`${item.id}:${k}`) ||
      (Array.isArray(item.envKeys) && item.envKeys.includes(k));

    function drawEnvArea() {
      const box = body.querySelector('#mcp-env-area');
      const keys = item.needsEnv || [];
      if (!keys.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
      box.classList.remove('hidden');
      box.innerHTML = `<h4>Biến môi trường</h4>` + keys.map((k) => {
        const saved = keySaved(k);
        return `
        <div class="env-key-row" data-key="${esc(k)}">
          <div class="env-key-head"><span class="mono">${esc(k)}</span>
            <span class="badge mini key-status ${saved ? 'ok' : 'warn'}">${saved ? `${icon('blade/check', 'ic-xs')} đủ` : `${icon('blade/warn', 'ic-xs')} thiếu`}</span></div>
          <div class="key-input">
            <input class="input mono" type="password" data-envkey="${esc(k)}" placeholder="dán giá trị ${esc(k)}…" autocomplete="off">
            <button type="button" class="key-eye" aria-label="Hiện/ẩn giá trị">${icon('blade/eye', 'ic-sm')}</button>
          </div>
        </div>`;
      }).join('') +
        `<button type="button" class="btn primary block" id="mcp-env-save" style="margin-top:10px">${icon('blade/key', 'ic-sm')} Lưu env</button>`;
    }

    body.addEventListener('click', async (e) => {
      // eye toggle password cho env key
      const eye = e.target.closest('.key-eye');
      if (eye) {
        const inp = eye.parentElement.querySelector('input[data-envkey]');
        if (inp) {
          const show = inp.type === 'password';
          inp.type = show ? 'text' : 'password';
          eye.innerHTML = icon(show ? 'blade/eyeoff' : 'blade/eye', 'ic-sm');
        }
        return;
      }
      // Lưu env → PUT /api/mcps/:id/env
      const saveBtn = e.target.closest('#mcp-env-save');
      if (saveBtn) {
        const inputs = [...body.querySelectorAll('[data-envkey]')].filter((i) => i.value.trim());
        if (!inputs.length) { toast('Nhập ít nhất một giá trị env', 'warn'); return; }
        const env = {};
        for (const i of inputs) env[i.dataset.envkey] = i.value.trim();
        saveBtn.classList.add('loading');
        try {
          await api.saveMcpEnv(item.id, env);
          for (const i of inputs) { i.value = ''; envSavedMap.set(`${item.id}:${i.dataset.envkey}`, true); }
          toast(`Đã lưu env cho ${item.name}`, 'ok');
          drawEnvArea();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          saveBtn.classList.remove('loading');
        }
      }
    });

    /** Vẽ lại mọi vùng phụ thuộc trạng thái (sau install/connect). */
    function redrawSheet() {
      const badge = body.querySelector('#mcp-state-badge');
      const btn = body.querySelector('#mcp-toggle-btn');
      if (badge) drawStateBadge(badge, item);
      if (btn) drawToggleBtn(btn);
      drawInstallArea();
      drawEnvArea();
      drawToolsArea();
    }

    async function toggleConnect(btn, badge) {
      if (item.real && item.installed === false) { toast('Cài đặt server trước khi kết nối', 'warn'); return; }
      const connected = item.state === 'connected';
      btn.classList.add('loading'); // spinner ngay trong nút
      try {
        const resp = connected ? await api.disconnect(item.id) : await api.connect(item.id);
        item.state = resp.state || (connected ? 'disconnected' : 'connected');
        if (resp.tools) item.tools = resp.tools; // server thật: tools thật trả về sau connect
        drawStateBadge(badge, item);
        drawToggleBtn(btn);
        drawToolsArea();
        toast(`${item.name}: ${stateLabel(item.state)}`, item.state === 'connected' ? 'ok' : 'info');
      } catch (err) {
        toast(err.message, 'error'); // vd. stdio/http connect fail → 502
      } finally {
        btn.classList.remove('loading');
      }
    }

    /* ----- Tools accordion + form invoke ----- */
    function schemaHint(tool) {
      const sc = tool.inputSchema || {};
      const props = Object.entries(sc.properties || {});
      const req = new Set(sc.required || []);
      if (!props.length) return '(không cần tham số)';
      return props.map(([k, v]) => `${k}${req.has(k) ? '*' : ''}: ${v.type || 'any'}`).join('\n');
    }

    const isDangerous = (name) =>
      /write|delete|remove|exec|run|kill|drop|create|update|patch|post|put|deploy|send|push/i.test(name);

    /** Render inputs tự động từ inputSchema.properties. */
    function toolInputsHTML(tool) {
      const props = (tool.inputSchema && tool.inputSchema.properties) || {};
      const req = new Set((tool.inputSchema && tool.inputSchema.required) || []);
      const keys = Object.keys(props);
      if (!keys.length) return '<p class="dim" style="font-size:12.5px">Tool này không nhận tham số.</p>';
      return keys.map((k) => {
        const t = props[k].type || 'string';
        const label = `<label>${esc(k)}${req.has(k) ? ' *' : ''}<span class="type-tag">${esc(t)}</span></label>`;
        if (t === 'boolean') {
          return `<div class="check-row"><input type="checkbox" data-arg="${esc(k)}" data-type="boolean"><span>${esc(k)}</span></div>`;
        }
        if (t === 'integer' || t === 'number') {
          return `<div class="field">${label}<input class="input" data-arg="${esc(k)}" data-type="${esc(t)}" type="number" step="any" placeholder="0"></div>`;
        }
        if (t === 'object' || t === 'array') {
          return `<div class="field">${label}<textarea class="input mono" rows="3" data-arg="${esc(k)}" data-type="${esc(t)}" placeholder='${t === 'array' ? '["a","b"]' : '{ "key": "value" }'}'></textarea></div>`;
        }
        return `<div class="field">${label}<input class="input" data-arg="${esc(k)}" data-type="string" placeholder="${esc(props[k].description || k)}"></div>`;
      }).join('');
    }

    /** Thu args từ form; JSON textarea parse lỗi → throw thân thiện. */
    function collectArgs(scope) {
      const args = {};
      for (const inp of scope.querySelectorAll('[data-arg]')) {
        const k = inp.dataset.arg;
        const t = inp.dataset.type;
        if (t === 'boolean') { args[k] = inp.checked; continue; }
        const raw = inp.value.trim();
        if (!raw) continue;
        if (t === 'integer') args[k] = parseInt(raw, 10);
        else if (t === 'number') args[k] = parseFloat(raw);
        else if (t === 'object' || t === 'array') {
          try { args[k] = JSON.parse(raw); } catch { throw new Error(`Giá trị "${k}" không phải JSON hợp lệ`); }
        } else args[k] = raw;
      }
      return args;
    }

    function drawResult(box, r) {
      box.classList.remove('hidden');
      const bad = !r || r.ok === false || r.error;
      const meta = r && r.meta
        ? `${esc(r.meta.server)}·${esc(r.meta.tool)} · ${esc(String(r.meta.durationMs))}ms · ${r.meta.mocked ? 'mocked' : 'live'}`
        : '';
      box.innerHTML = bad
        ? `<div class="result-err"><div class="rz-head"><span class="lbl">${icon('blade/error', 'ic-sm')} Lỗi</span></div><pre>${esc(r.error || 'Unknown error')}</pre></div>`
        : `<div class="result-ok"><div class="rz-head"><span class="lbl">${icon('blade/check', 'ic-sm')} Kết quả</span>` +
          `<button type="button" class="btn ghost small obs-copy" id="copy-result">${icon('blade/copy', 'ic-sm')} copy</button></div>` +
          `<pre>${esc(JSON.stringify(r.result ?? r, null, 2))}</pre>${meta ? `<div class="rz-meta">${meta}</div>` : ''}</div>`;
      const cp = box.querySelector('#copy-result');
      if (cp) cp.addEventListener('click', async () => {
        if (await copyText(JSON.stringify(r.result ?? r, null, 2))) toast('Đã copy kết quả', 'ok');
      });
    }

    function drawToolsArea() {
      const area = panel.querySelector('#mcp-tools-area');
      const inv = panel.querySelector('#mcp-invoke-area');
      if (item.state !== 'connected') {
        const preview = item.toolPreview || [];
        const previewLine = preview.length
          ? `<p class="dim" style="margin-top:6px">sẽ có: <span class="mono">${esc(preview.slice(0, 5).join(', '))}${preview.length > 5 ? ', …' : ''}</span></p>`
          : '';
        area.innerHTML = `<h4>Tools</h4><div class="empty" style="padding:14px"><div class="empty-ico">${icon('solar/lock', 'ic-lg')}</div>
          <p>Kết nối server để xem và gọi <b>${tools().length || 'các'}</b> tools.</p>${previewLine}</div>`;
        inv.classList.add('hidden');
        inv.innerHTML = '';
        return;
      }

      // Accordion danh sách tools
      area.innerHTML = `<h4>Tools (${tools().length})</h4>` + tools().map((t, i) => `
        <div class="acc" data-ti="${i}">
          <button type="button" class="acc-head">
            <span class="tool-name">${esc(t.name)}</span>
            ${isDangerous(t.name) ? `<span class="badge mini warn">${icon('blade/warn', 'ic-xs')} risky</span>` : ''}
            <span class="acc-caret">${icon('blade/chevr', 'ic-sm')}</span>
          </button>
          <div class="acc-body">
            <div class="acc-inner">
              <div>${esc(t.description)}</div>
              <div class="schema-box">${esc(schemaHint(t))}</div>
            </div>
          </div>
        </div>`).join('');
      area.onclick = (e) => {
        const head = e.target.closest('.acc-head');
        if (head) head.parentElement.classList.toggle('open');
      };

      // Form invoke
      inv.classList.remove('hidden');
      inv.innerHTML = `<h4>Invoke tool</h4>
        <div class="field"><label>Tool</label>
          <select class="input" id="inv-tool">${tools().map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')}</select>
        </div>
        <div id="inv-inputs"></div>
        <label class="check-row hidden" id="inv-approved-row">
          <input type="checkbox" id="inv-approved"><span>Tôi phê duyệt hành động này (approved — tool ghi/xóa)</span>
        </label>
        <button type="button" class="btn primary block" id="inv-run" style="margin-top:8px">${icon('blade/run', 'ic-sm')} Run</button>
        <div class="result-zone hidden" id="inv-result"></div>`;

      const sel = inv.querySelector('#inv-tool');
      function onToolChange() {
        const tool = tools().find((t) => t.name === sel.value);
        inv.querySelector('#inv-inputs').innerHTML = tool ? toolInputsHTML(tool) : '';
        inv.querySelector('#inv-approved-row').classList.toggle('hidden', !(tool && isDangerous(tool.name)));
      }
      sel.addEventListener('change', onToolChange);
      onToolChange();

      inv.querySelector('#inv-run').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const tool = tools().find((t) => t.name === sel.value);
        if (!tool) return;
        let args;
        try { args = collectArgs(inv); } catch (err) { toast(err.message, 'warn'); return; }
        const approvedEl = inv.querySelector('#inv-approved');
        btn.classList.add('loading');
        try {
          const r = await api.invoke(item.id, tool.name, args, approvedEl && approvedEl.checked);
          drawResult(inv.querySelector('#inv-result'), r);
        } catch (err) {
          drawResult(inv.querySelector('#inv-result'), { ok: false, error: err.message });
        } finally {
          btn.classList.remove('loading');
        }
      });
    }

    const tglBtn = body.querySelector('#mcp-toggle-btn');
    redrawSheet();
    tglBtn.addEventListener('click', () => toggleConnect(tglBtn, body.querySelector('#mcp-state-badge')));
  }

  /* ================= Sheet Plugin ================= */
  function openPluginSheet(item) {
    const panel = openSheet(`
      <div class="sheet-head">
        <span class="rc-icon">${itemIcon(item, 'solar/puzzle')}</span>
        <div><div class="sheet-title">${esc(item.name)}</div>
        <div class="sheet-sub">v${esc(item.version)} · popularity ${esc(String(item.popularity ?? '—'))}</div></div>
      </div>
      <p class="sheet-desc">${esc(item.description)}</p>
      ${item.behaviorLabel ? `<div class="tag-row" style="margin-bottom:10px"><span class="badge mini mono">Hành vi: ${esc(item.behaviorLabel)}</span></div>` : ''}
      <div class="sheet-sec"><h4>Permissions</h4>
        <div class="tag-row">${[...new Set(item.permissions || [])].map((p) => `<span class="badge mini">${icon('blade/key', 'ic-xs')} ${esc(p)}</span>`).join('') || '<span class="dim">—</span>'}</div>
      </div>
      <div class="sheet-sec"><h4>Hooks</h4>
        <div class="tag-row">${(item.hooks || []).map((h) => `<code>${esc(h)}</code>`).join(' ') || '<span class="dim">—</span>'}</div>
      </div>
      <div class="sheet-sec"><div class="check-row" style="justify-content:space-between">
        <b>Enabled</b>
        <span class="switch"><input type="checkbox" id="plg-toggle" ${item.enabled ? 'checked' : ''}><span class="track"></span></span>
      </div></div>`);

    panel.querySelector('#plg-toggle').addEventListener('change', async (e) => {
      const val = e.target.checked;
      item.enabled = val; // optimistic UI
      updateCardInPlace(item);
      try {
        const updated = await api.togglePlugin(item.id, val);
        if (updated && typeof updated.enabled === 'boolean') item.enabled = updated.enabled;
        toast(`${item.name}: ${item.enabled ? 'enabled' : 'disabled'}`, 'ok');
      } catch (err) {
        item.enabled = !val;   // revert khi lỗi
        e.target.checked = item.enabled;
        toast(err.message, 'error');
      }
      updateCardInPlace(item);
    });
  }

  /** Cập nhật 1 card trong list mà không re-render toàn bộ (giữ scroll). */
  function updateCardInPlace(item) {
    const row = document.querySelector(`#hub-list [data-id="${CSS.escape(item.id)}"]`);
    if (row && state.tab === 'plugins') {
      const tmp = document.createElement('div');
      tmp.innerHTML = cardHTML(item);
      row.replaceWith(tmp.firstElementChild);
    }
  }

  /* ---------------- boot view ---------------- */
  const ok = await ensureData();
  if (ok) renderAll(true);

  return () => { offMcp(); };
}

/* ================= Sheet Skill (+ Run) — dùng chung cho Home ================= */
/**
 * Sheet chạy skill: form inputs → POST runSkill → lắng nghe SSE 'skill-run'
 * khớp runId, append/update step rows (spinner → check/warn), tổng kết khi đủ bước.
 */
export function openSkillSheet(skill) {
  const inputs = skill.inputs || [];
  const total = (skill.steps || []).length;
  const panel = openSheet(`
    <div class="sheet-head">
      <span class="rc-icon">${skill.icon ? esc(skill.icon) : icon('blade/sparkles', '')}</span>
      <div><div class="sheet-title">${esc(skill.name)}</div>
      <div class="sheet-sub">${total} bước · ${inputs.length} input</div></div>
    </div>
    <p class="sheet-desc">${esc(skill.description)}</p>
    <form id="skill-form">
      ${inputs.map((i) => `
        <div class="field"><label>${esc(i.label || i.key)}</label>
          <input class="input" name="${esc(i.key)}" placeholder="${esc(i.placeholder || '')}" autocomplete="off">
        </div>`).join('')}
      <button type="submit" class="btn primary block" id="skill-run-btn">${icon('blade/run', 'ic-sm')} Run skill</button>
    </form>
    <div class="progress-zone hidden" id="skill-progress"></div>`);

  const form = panel.querySelector('#skill-form');
  const zone = panel.querySelector('#skill-progress');
  const rows = new Map(); // step i → row element

  function stepRow(evt) {
    const icoHTML = evt.status === 'ok'
      ? icon('blade/check', 'ic-sm')
      : evt.status === 'error' ? icon('blade/warn', 'ic-sm') : '<span class="mini-spin" aria-hidden="true"></span>';
    let row = rows.get(evt.i);
    if (!row) {
      row = document.createElement('div');
      zone.appendChild(row);
      rows.set(evt.i, row);
    }
    row.className = `step-row st-${evt.status || 'running'}`;
    row.innerHTML = `<span class="step-ico">${icoHTML}</span>
      <div style="min-width:0"><div class="step-tit">Bước ${esc(String(evt.i))}/${esc(String(evt.total ?? total))} · ${esc(evt.type || '')}</div>
      <div class="step-detail">${esc(evt.detail || '')}</div></div>`;
    zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function finish(okCount, errCount, t0) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const sum = document.createElement('div');
    sum.className = 'step-summary';
    sum.innerHTML = errCount
      ? `${icon('blade/warn', 'ic-sm')} Hoàn tất với ${okCount} bước OK, ${errCount} lỗi trong ${secs}s`
      : `${icon('blade/check', 'ic-sm')} Hoàn thành ${okCount}/${total} bước trong ${secs}s`;
    zone.appendChild(sum);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = panel.querySelector('#skill-run-btn');
    const input = {};
    for (const f of form.elements) if (f.name) input[f.name] = f.value.trim();
    btn.classList.add('loading');
    zone.classList.remove('hidden');
    zone.innerHTML = '';
    rows.clear();

    // Dọn listener khi sheet đóng
    const offs = [];
    onSheetClose(() => offs.forEach((f) => f()));

    let runId = null;
    const t0 = Date.now();
    let okCount = 0, errCount = 0, done = false;

    offs.push(listen('skill-run', (evt) => {
      if (runId && evt.runId !== runId) return;
      if (!runId) runId = evt.runId;
      stepRow(evt);
      if (evt.status === 'ok') okCount += 1;
      if (evt.status === 'error') errCount += 1;
      if (!done && okCount + errCount >= total) { done = true; finish(okCount, errCount, t0); }
    }));

    try {
      const r = await api.runSkill(skill.id, input);
      runId = r.runId;
      toast('Skill đang chạy — theo dõi tiến độ bên dưới', 'info');
      // Safety: sau 20s chưa đủ bước thì vẫn chốt tổng kết
      setTimeout(() => { if (!done && rows.size) { done = true; finish(okCount, errCount, t0); } }, 20000);
    } catch (err) {
      done = true;
      btn.classList.remove('loading');
      zone.insertAdjacentHTML('afterbegin',
        `<div class="result-err"><div class="rz-head"><span class="lbl">${icon('blade/error', 'ic-sm')} Lỗi</span></div><pre>${esc(err.message)}</pre></div>`);
    }
  });
}
