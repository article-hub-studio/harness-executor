/* ============================================================
   upio web — view Hub: segmented [MCPs | Plugins | Skills],
   search + chip category, list card, bottom-sheet chi tiết
   (connect/invoke · toggle plugin · run skill).
   ============================================================ */
import {
  api, listen, esc, toast, openSheet, onSheetClose,
  store, debounce, fmtNum, copyText,
} from '../app.js';

const state = {
  tab: 'mcps',           // 'mcps' | 'plugins' | 'skills'
  q: '',
  cat: '',
  limit: 40,
  mcps: [], plugins: [], skills: [],
  loaded: false,
};

export async function render(el) {
  state.limit = 40;

  el.innerHTML = `
  <div class="container">
    <header class="hero">
      <h1 class="hero-brand">🧩 Hub</h1>
      <p class="hero-sub">Registry MCP servers · plugins · skills</p>
    </header>
    <div class="segmented" role="tablist" id="hub-seg">
      <button type="button" class="seg-btn active" data-tab="mcps" role="tab">MCPs</button>
      <button type="button" class="seg-btn" data-tab="plugins" role="tab">Plugins</button>
      <button type="button" class="seg-btn" data-tab="skills" role="tab">Skills</button>
    </div>
    <input type="search" class="input" id="hub-search" placeholder="Tìm theo tên, mô tả…" autocomplete="off">
    <div class="chip-row" id="hub-chips" style="margin-top:10px"></div>
    <div class="hub-list" id="hub-list"></div>
    <div style="text-align:center;margin-top:6px"><button type="button" class="btn ghost small hidden" id="hub-more">Xem thêm</button></div>
  </div>`;

  const $ = (id) => el.querySelector('#' + id);

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
        <div class="empty-ico">🛰️</div><b>API offline</b>
        <p class="dim">Không tải được registry. Kiểm tra backend rồi thử lại.</p>
        <button type="button" class="btn primary small" id="hub-retry" style="margin-top:12px">↻ Thử lại</button></div>`;
      $('hub-retry').addEventListener('click', () => { state.loaded = false; ensureData().then((ok) => ok && renderAll()); });
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
    $('hub-chips').innerHTML = cats.map((c) =>
      `<button type="button" class="chip ${c === state.cat || (c === 'All' && !state.cat) ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  }

  /* ---------------- List rendering ---------------- */
  function cardHTML(it) {
    if (state.tab === 'mcps') {
      const st = it.state === 'connected';
      return `
        <button type="button" class="card row-card" data-id="${esc(it.id)}">
          <span class="rc-icon">${esc(it.icon || '🔌')}</span>
          <span class="rc-main">
            <span class="rc-top"><b>${esc(it.name)}</b><span class="badge mini info">⭐ ${fmtNum(it.stars)}</span></span>
            <span class="rc-desc">${esc(it.description)}</span>
            <span class="rc-meta"><span class="dot ${st ? 'connected' : 'disconnected'}"></span>${esc(it.category)} · v${esc(it.version)} · ${(it.tools || []).length} tools</span>
          </span>
          <span class="rc-chevron">›</span>
        </button>`;
    }
    if (state.tab === 'plugins') {
      return `
        <button type="button" class="card row-card" data-id="${esc(it.id)}">
          <span class="rc-icon">${esc(it.icon || '🧩')}</span>
          <span class="rc-main">
            <span class="rc-top"><b>${esc(it.name)}</b><span class="badge mini ${it.enabled ? 'connected' : 'disconnected'}">${it.enabled ? 'ON' : 'OFF'}</span></span>
            <span class="rc-desc">${esc(it.description)}</span>
            <span class="rc-meta">v${esc(it.version)} · 🔥 ${esc(String(it.popularity ?? '—'))}</span>
          </span>
          <span class="rc-chevron">›</span>
        </button>`;
    }
    return `
      <button type="button" class="card row-card" data-id="${esc(it.id)}">
        <span class="rc-icon">${esc(it.icon || '✨')}</span>
        <span class="rc-main">
          <span class="rc-top"><b>${esc(it.name)}</b><span class="badge mini grad">${(it.steps || []).length} bước</span></span>
          <span class="rc-desc">${esc(it.description)}</span>
          <span class="rc-meta">${esc((it.tags || []).join(' · '))}</span>
        </span>
        <span class="rc-chevron">›</span>
      </button>`;
  }

  function renderList() {
    const arr = items();
    const slice = arr.slice(0, state.limit);
    $('hub-list').innerHTML = slice.length
      ? slice.map(cardHTML).join('')
      : `<div class="card pad empty" style="grid-column:1/-1"><div class="empty-ico">🔍</div>
         <b>Không tìm thấy mục nào</b><p class="dim">Thử đổi từ khóa hoặc bỏ chip lọc.</p></div>`;
    const more = $('hub-more');
    more.classList.toggle('hidden', arr.length <= state.limit);
    more.textContent = `Xem thêm (${arr.length - state.limit})`;
  }

  function renderAll() { renderChips(); renderList(); }

  /* ---------------- Controls ---------------- */
  $('hub-seg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.tab = b.dataset.tab;
    state.cat = '';
    state.limit = 40;
    el.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    renderAll();
  });

  $('hub-search').addEventListener('input', debounce((e) => {
    state.q = e.target.value;
    state.limit = 40;
    renderList();
  }, 250));

  $('hub-chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    state.cat = c.dataset.cat === 'All' ? '' : c.dataset.cat;
    renderAll();
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
    if (it && evt.state) { it.state = evt.state; if (state.tab === 'mcps') renderList(); }
  });

  /* ================= Sheet MCP ================= */
  function openMcpSheet(it) {
    const panel = openSheet(`
      <div class="sheet-head">
        <span class="rc-icon">${esc(it.icon || '🔌')}</span>
        <div style="min-width:0">
          <div class="sheet-title">${esc(it.name)}</div>
          <div class="sheet-sub">by ${esc(it.author || 'upio')} · v${esc(it.version)} · ${esc(it.transport || 'builtin')}</div>
        </div>
      </div>
      <div class="tag-row">${(it.tags || []).map((t) => `<span class="badge mini disconnected">#${esc(t)}</span>`).join('')}
        <span class="badge mini info">⭐ ${fmtNum(it.stars)}</span></div>
      <p class="sheet-desc">${esc(it.description)}</p>
      <div class="sheet-sec">
        <div class="form-grid cols-2">
          <div class="field"><label>Trạng thái</label>
            <div><span class="badge ${it.state === 'connected' ? 'connected' : 'disconnected'}" id="mcp-state-badge">
              <span class="dot ${it.state === 'connected' ? 'connected' : 'disconnected'}"></span>${esc(it.state || 'disconnected')}</span></div>
          </div>
          <div class="field"><label>&nbsp;</label>
            <button type="button" class="btn block ${it.state === 'connected' ? 'ghost' : 'primary'}" id="mcp-toggle-btn"></button>
          </div>
        </div>
      </div>
      <div class="sheet-sec" id="mcp-tools-area"></div>
      <div class="sheet-sec hidden" id="mcp-invoke-area"></div>`);

    const tools = () => it.tools || [];

    function drawToggleBtn(btn) {
      const connected = it.state === 'connected';
      btn.textContent = connected ? '⛔ Disconnect' : '🔌 Connect';
      btn.className = `btn block ${connected ? 'ghost' : 'primary'}`;
    }

    async function toggleConnect(btn, badge) {
      const connected = it.state === 'connected';
      btn.classList.add('loading'); // spinner ngay trong nút
      try {
        const resp = connected ? await api.disconnect(it.id) : await api.connect(it.id);
        it.state = resp.state || (connected ? 'disconnected' : 'connected');
        if (resp.tools) it.tools = resp.tools;
        badge.className = `badge ${it.state}`;
        badge.innerHTML = `<span class="dot ${it.state === 'connected' ? 'connected' : 'disconnected'}"></span>${esc(it.state)}`;
        drawToggleBtn(btn);
        drawToolsArea();
        toast(`${it.name}: ${it.state}`, it.state === 'connected' ? 'ok' : 'info');
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
        ? `<div class="result-err"><div class="rz-head">⛔ Lỗi</div><pre>${esc(r.error || 'Unknown error')}</pre></div>`
        : `<div class="result-ok"><div class="rz-head"><span>✅ Kết quả</span><button type="button" class="btn ghost small obs-copy" id="copy-result">⧉ copy</button></div>
           <pre>${esc(JSON.stringify(r.result ?? r, null, 2))}</pre>${meta ? `<div class="rz-meta">${meta}</div>` : ''}</div>`;
      const cp = box.querySelector('#copy-result');
      if (cp) cp.addEventListener('click', async () => {
        if (await copyText(JSON.stringify(r.result ?? r, null, 2))) toast('Đã copy kết quả', 'ok');
      });
    }

    function drawToolsArea() {
      const area = panel.querySelector('#mcp-tools-area');
      const inv = panel.querySelector('#mcp-invoke-area');
      if (it.state !== 'connected') {
        area.innerHTML = `<h4>Tools</h4><div class="empty" style="padding:14px"><div class="empty-ico">🔒</div>
          <p>Kết nối server để xem và gọi <b>${tools().length}</b> tools.</p></div>`;
        inv.classList.add('hidden');
        inv.innerHTML = '';
        return;
      }

      // Accordion danh sách tools
      area.innerHTML = `<h4>Tools (${tools().length})</h4>` + tools().map((t, i) => `
        <div class="acc" data-ti="${i}">
          <button type="button" class="acc-head">
            <span class="tool-name">${esc(t.name)}</span>
            ${isDangerous(t.name) ? '<span class="badge mini warn">⚠ risky</span>' : ''}
            <span class="acc-caret">›</span>
          </button>
          <div class="acc-body">
            <div>${esc(t.description)}</div>
            <div class="schema-box">${esc(schemaHint(t))}</div>
          </div>
        </div>`).join('');
      area.onclick = (e) => {
        const head = e.target.closest('.acc-head');
        if (head) head.parentElement.classList.toggle('open');
      };

      // Form invoke
      inv.classList.remove('hidden');
      inv.innerHTML = `<h4>▶ Invoke tool</h4>
        <div class="field"><label>Tool</label>
          <select class="input" id="inv-tool">${tools().map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')}</select>
        </div>
        <div id="inv-inputs"></div>
        <label class="check-row hidden" id="inv-approved-row">
          <input type="checkbox" id="inv-approved"><span>Tôi phê duyệt hành động này (approved — tool ghi/xóa)</span>
        </label>
        <button type="button" class="btn primary block" id="inv-run" style="margin-top:8px">▶ Run</button>
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
          const r = await api.invoke(it.id, tool.name, args, approvedEl && approvedEl.checked);
          drawResult(inv.querySelector('#inv-result'), r);
        } catch (err) {
          drawResult(inv.querySelector('#inv-result'), { ok: false, error: err.message });
        } finally {
          btn.classList.remove('loading');
        }
      });
    }

    const tglBtn = panel.querySelector('#mcp-toggle-btn');
    drawToggleBtn(tglBtn);
    tglBtn.addEventListener('click', () => toggleConnect(tglBtn, panel.querySelector('#mcp-state-badge')));
    drawToolsArea();
  }

  /* ================= Sheet Plugin ================= */
  function openPluginSheet(it) {
    const panel = openSheet(`
      <div class="sheet-head">
        <span class="rc-icon">${esc(it.icon || '🧩')}</span>
        <div><div class="sheet-title">${esc(it.name)}</div>
        <div class="sheet-sub">v${esc(it.version)} · 🔥 popularity ${esc(String(it.popularity ?? '—'))}</div></div>
      </div>
      <p class="sheet-desc">${esc(it.description)}</p>
      <div class="sheet-sec"><h4>Permissions</h4>
        <div class="tag-row">${[...new Set(it.permissions || [])].map((p) => `<span class="badge mini warn">🔑 ${esc(p)}</span>`).join('') || '<span class="dim">—</span>'}</div>
      </div>
      <div class="sheet-sec"><h4>Hooks</h4>
        <div class="tag-row">${(it.hooks || []).map((h) => `<code>${esc(h)}</code>`).join(' ') || '<span class="dim">—</span>'}</div>
      </div>
      <div class="sheet-sec"><div class="check-row" style="justify-content:space-between">
        <b>Enabled</b>
        <span class="switch"><input type="checkbox" id="plg-toggle" ${it.enabled ? 'checked' : ''}><span class="track"></span></span>
      </div></div>`);

    panel.querySelector('#plg-toggle').addEventListener('change', async (e) => {
      const val = e.target.checked;
      it.enabled = val; // optimistic UI
      updateCardInPlace(it);
      try {
        const updated = await api.togglePlugin(it.id, val);
        if (updated && typeof updated.enabled === 'boolean') it.enabled = updated.enabled;
        toast(`${it.name}: ${it.enabled ? 'enabled' : 'disabled'}`, 'ok');
      } catch (err) {
        it.enabled = !val;   // revert khi lỗi
        e.target.checked = it.enabled;
        toast(err.message, 'error');
      }
      updateCardInPlace(it);
    });
  }

  /** Cập nhật 1 card trong list mà không re-render toàn bộ (giữ scroll). */
  function updateCardInPlace(it) {
    const row = document.querySelector(`#hub-list [data-id="${CSS.escape(it.id)}"]`);
    if (row && state.tab === 'plugins') {
      const tmp = document.createElement('div');
      tmp.innerHTML = cardHTML(it);
      row.replaceWith(tmp.firstElementChild);
    }
  }

  /* ---------------- boot view ---------------- */
  const ok = await ensureData();
  if (ok) renderAll();

  return () => { offMcp(); };
}

/* ================= Sheet Skill (+ Run) — dùng chung cho Home ================= */
/**
 * Sheet chạy skill: form inputs → POST runSkill → lắng nghe SSE 'skill-run'
 * khớp runId, append/update step rows (⏳→✅/⚠️), tổng kết khi đủ bước.
 */
export function openSkillSheet(skill) {
  const inputs = skill.inputs || [];
  const total = (skill.steps || []).length;
  const panel = openSheet(`
    <div class="sheet-head">
      <span class="rc-icon">${esc(skill.icon || '✨')}</span>
      <div><div class="sheet-title">${esc(skill.name)}</div>
      <div class="sheet-sub">${total} bước · ${inputs.length} input</div></div>
    </div>
    <p class="sheet-desc">${esc(skill.description)}</p>
    <form id="skill-form">
      ${inputs.map((i) => `
        <div class="field"><label>${esc(i.label || i.key)}</label>
          <input class="input" name="${esc(i.key)}" placeholder="${esc(i.placeholder || '')}" autocomplete="off">
        </div>`).join('')}
      <button type="submit" class="btn primary block" id="skill-run-btn">▶ Run skill</button>
    </form>
    <div class="progress-zone hidden" id="skill-progress"></div>`);

  const form = panel.querySelector('#skill-form');
  const zone = panel.querySelector('#skill-progress');
  const rows = new Map(); // step i → row element

  function stepRow(evt) {
    const icon = evt.status === 'ok' ? '✅' : evt.status === 'error' ? '⚠️' : '⏳';
    let row = rows.get(evt.i);
    if (!row) {
      row = document.createElement('div');
      zone.appendChild(row);
      rows.set(evt.i, row);
    }
    row.className = `step-row st-${evt.status || 'running'}`;
    row.innerHTML = `<span class="step-ico">${icon}</span>
      <div style="min-width:0"><div class="step-tit">Bước ${esc(String(evt.i))}/${esc(String(evt.total ?? total))} · ${esc(evt.type || '')}</div>
      <div class="step-detail">${esc(evt.detail || '')}</div></div>`;
    zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function finish(okCount, errCount, t0) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const sum = document.createElement('div');
    sum.className = 'step-summary';
    sum.textContent = errCount
      ? `⚠️ Hoàn tất với ${okCount} bước OK, ${errCount} lỗi trong ${secs}s`
      : `✅ Hoàn thành ${okCount}/${total} bước trong ${secs}s`;
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
        `<div class="result-err"><div class="rz-head">⛔ Lỗi</div><pre>${esc(err.message)}</pre></div>`);
    }
  });
}
