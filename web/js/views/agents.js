/* ============================================================
   upio web — view Agents: form spawn (task/name/maxSteps/model/
   tools theo server connected), danh sách + progress polling 2s,
   sheet timeline từng bước (thought/action/observation) + cancel.
   ============================================================ */
import {
  api, listen, esc, toast, openSheet, closeSheet, onSheetClose,
  store, fmtAgo, truncate, copyText, icon,
} from '../app.js';

/* Badge trạng thái bằng hình dạng + nhãn (không màu) */
function statusBadge(status) {
  switch (status) {
    case 'running': return `<span class="badge running"><span class="mini-spin"></span> running</span>`;
    case 'done': return `<span class="badge ok">${icon('blade/check', 'ic-xs')} done</span>`;
    case 'cancelled': return `<span class="badge cancelled">${icon('blade/close', 'ic-xs')} cancelled</span>`;
    case 'failed':
    case 'error': return `<span class="badge fail">${icon('blade/error', 'ic-xs')} failed</span>`;
    default: return `<span class="badge disconnected">${esc(status)}</span>`;
  }
}

export async function render(el) {
  el.innerHTML = `
  <div class="container">
    <header class="hero">
      <h1 class="hero-brand">${icon('solar/agents', 'ic-lg')} Agents</h1>
      <p class="hero-sub">Spawn subagent runtime — vòng lặp plan → tool → observe → final</p>
    </header>

    <!-- Form spawn -->
    <section class="card pad" style="margin-top:14px">
      <form id="spawn-form">
        <div class="field"><label>Task *</label>
          <textarea class="input" id="ag-task" rows="3" required
            placeholder="VD: Review repo upio/mcp-executor, liệt kê 5 rủi ro bảo mật và đề xuất fix…"></textarea>
        </div>
        <div class="form-grid cols-2">
          <div class="field"><label>Tên agent</label>
            <input class="input" id="ag-name" placeholder="reviewer-01" autocomplete="off">
          </div>
          <div class="field"><label>Max steps</label>
            <input class="input" id="ag-steps" type="number" min="1" max="12" value="6">
          </div>
        </div>
        <div class="field"><label>Model</label>
          <select class="input" id="ag-model"></select>
        </div>

        <div class="field"><label>Tools (theo MCP server đã connect)</label>
          <div id="ag-tools"><div class="dim" style="font-size:12.5px;display:flex;gap:8px;align-items:center"><span class="spin"></span> Đang tải servers…</div></div>
        </div>
        <button type="submit" class="btn primary block" id="ag-spawn-btn">${icon('blade/bolt', 'ic-sm')} Spawn agent</button>
      </form>
    </section>

    <!-- Danh sách agent -->
    <h2 class="sec-title">Agents <span id="ag-count-badge" class="badge mini disconnected hidden"></span></h2>
    <section class="agent-list" id="agent-list">
      <div class="empty card pad"><div class="empty-ico">${icon('solar/agents', 'ic-lg')}</div><b>Chưa có agent nào</b><p class="dim">Spawn agent đầu tiên bằng form phía trên.</p></div>
    </section>
  </div>`;

  const $ = (id) => el.querySelector('#' + id);
  let items = [];
  let pollTimer = null;
  let alive = true;

  /* ----- Model select ----- */
  function fillModels() {
    const sel = $('ag-model');
    const models = store.models.length ? store.models : [{ id: 'ox-local-mock', label: 'ox-local-mock (mock nội bộ)' }];
    const def = store.modelConfig.default || 'ox-local-mock';
    sel.innerHTML = models.map((m) =>
      `<option value="${esc(m.id)}">${esc(m.label || m.id)}${m.available === false ? ' (unavailable)' : ''}</option>`).join('');
    if (models.some((m) => m.id === def)) sel.value = def;
  }
  // Cập nhật khi Model Hub thay đổi
  const offModels = listen('models', fillModels);

  /* ----- Tools multi-select nhóm theo server đã connect ----- */
  function fillTools() {
    const box = $('ag-tools');
    const connected = store.registries.mcps.filter((m) => m.state === 'connected');
    if (!connected.length) {
      box.innerHTML = `<div class="empty" style="padding:14px 6px">${icon('blade/connect', 'ic-sm')} <b>Chưa có MCP server nào connected</b>
        <p class="dim">Vào tab Hub → kết nối server để chọn tools cho agent.</p></div>`;
      return;
    }
    box.innerHTML = connected.map((m) => `
      <div class="tool-group" data-server="${esc(m.id)}">
        <label class="tg-head">
          <input type="checkbox" class="sel-all" data-server="${esc(m.id)}">
          <span class="rc-icon">${m.icon ? esc(m.icon) : icon('solar/server', '')}</span>
          <span>${esc(m.name)}</span>
          <span class="badge mini">${(m.tools || []).length} tools</span>
        </label>
        <div class="tg-body">
          ${(m.tools || []).map((t) => `
            <label class="check-row">
              <input type="checkbox" class="tool-cb" data-server="${esc(m.id)}" data-tool="${esc(t.name)}">
              <span>${esc(t.name)}</span>
            </label>`).join('')}
        </div>
      </div>`).join('');

    // "Chọn tất cả" mỗi server
    box.addEventListener('change', (e) => {
      const all = e.target.closest('.sel-all');
      if (!all) return;
      box.querySelectorAll(`.tool-cb[data-server="${CSS.escape(all.dataset.server)}"]`)
        .forEach((cb) => { cb.checked = all.checked; });
    });
  }

  function selectedTools() {
    return [...el.querySelectorAll('.tool-cb:checked')]
      .map((cb) => ({ server: cb.dataset.server, tool: cb.dataset.tool }));
  }

  /* ----- Polling: mỗi 2s CHỈ khi còn agent running ----- */
  async function refresh() {
    if (!alive) return;
    try {
      const d = await api.agents();
      items = d.items || [];
    } catch { return; } // offline — giữ nguyên list
    drawList();
    if (items.some((a) => a.status === 'running')) {
      if (!pollTimer) pollTimer = setInterval(refresh, 2000);
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function progressHTML(a) {
    const max = Number(a.maxSteps) || 6;
    const doneN = Number(a.stepsDone) || 0;
    const pct = Math.min(100, Math.round((doneN / max) * 100));
    const running = a.status === 'running';
    return `<div class="pb ${running && !a.maxSteps ? 'indet' : ''}"><i style="width:${pct}%"></i></div>`;
  }

  function emptyListHTML() {
    return `<div class="empty card pad"><div class="empty-ico">${icon('solar/agents', 'ic-lg')}</div><b>Chưa có agent nào</b>
      <p class="dim">Spawn agent đầu tiên bằng form phía trên.</p></div>`;
  }

  let lastListSig = null;   // chống re-render + re-animation khi poll 2s không đổi gì
  let hadItems = false;

  function drawList() {
    const listEl = $('agent-list');
    const badge = $('ag-count-badge');
    badge.classList.toggle('hidden', !items.length);
    badge.textContent = `${items.length} agent`;
    badge.className = `badge mini ${items.length ? 'info' : 'disconnected'}`;
    if (!items.length) {
      lastListSig = '';
      hadItems = false;
      listEl.classList.remove('stagger');
      listEl.innerHTML = emptyListHTML();
      return;
    }
    // Chỉ vẽ lại khi dữ liệu thật sự đổi (tránh nhấp nháy animation mỗi lần poll)
    const sig = items.map((a) => `${a.id}:${a.status}:${a.stepsDone ?? ''}`).join('|');
    if (sig === lastListSig) return;
    listEl.classList.toggle('stagger', !hadItems); // entrance stagger chỉ lần đầu có dữ liệu
    lastListSig = sig;
    hadItems = true;
    listEl.innerHTML = [...items].reverse().map((a) => `
      <button type="button" class="card agent-card ${a.status === 'running' ? 'status-running' : ''}" data-id="${esc(a.id)}">
        <span class="agent-top">
          <span class="agent-name">${icon('solar/agents', 'ic-sm')} ${esc(a.name || a.id)}</span>${statusBadge(a.status)}
        </span>
        <span class="agent-task">${esc(a.task)}</span>
        ${progressHTML(a)}
        <span class="agent-meta"><span>${esc(String(a.stepsDone ?? 0))} steps</span><span>${esc(a.model || '')}</span><span>${esc(fmtAgo(a.createdAt))}</span></span>
      </button>`).join('');
  }

  $('agent-list').addEventListener('click', (e) => {
    const card = e.target.closest('[data-id]');
    if (card) openAgentSheet(card.dataset.id);
  });

  /* ----- Sheet chi tiết agent: timeline steps ----- */
  async function openAgentSheet(id) {
    const panel = openSheet(`<div class="empty" style="display:flex;gap:10px;justify-content:center;align-items:center;padding:34px"><span class="spin"></span> Đang tải agent…</div>`);
    let a;
    try {
      a = await api.agent(id);
    } catch (err) {
      panel.innerHTML = `<div class="empty"><div class="empty-ico">${icon('blade/error', 'ic-lg')}</div><b>${esc(err.message)}</b></div>`;
      return;
    }

    const offStep = listen('agent-step', (evt) => {
      if (evt.id !== id || !panel.isConnected) return;
      const tl = panel.querySelector('#ag-timeline');
      if (tl) tl.insertAdjacentHTML('beforeend', stepBubbleHTML(evt.i, evt));
    });
    onSheetClose(offStep);

    function stepBubbleHTML(i, st) {
      const actionTxt = typeof st.action === 'object' && st.action
        ? `${st.action.tool || st.action.type}${st.action.args ? '(' + JSON.stringify(st.action.args) + ')' : ''}`
        : String(st.action ?? '');
      return `
      <div class="step-bubble">
        <div class="sb-head"><span>BƯỚC ${esc(String(st.i ?? i))}</span><span>${esc(fmtAgo(st.at))}</span></div>
        ${st.thought ? `<div class="sb-thought">${icon('blade/chat', 'ic-sm')} ${esc(st.thought)}</div>` : ''}
        ${actionTxt && actionTxt !== 'undefined' ? `<div class="sb-action">${icon('blade/run', 'ic-sm')} ${esc(truncate(actionTxt, 220))}</div>` : ''}
        ${st.observation != null && st.observation !== '' ? `
          <div class="obs-wrap">
            <pre class="obs-pre">${esc(truncate(String(st.observation), 500))}</pre>
            <button type="button" class="btn ghost small obs-copy" data-copy="${esc(st.observation)}">${icon('blade/copy', 'ic-sm')} copy</button>
          </div>` : ''}
      </div>`;
    }

    const steps = a.steps || [];
    panel.innerHTML = `
      <div class="sheet-head"><span class="rc-icon">${icon('solar/agents', '')}</span>
        <div style="min-width:0"><div class="sheet-title">${esc(a.name || a.id)}</div>
        <div class="sheet-sub mono">${esc(a.id)} · ${esc(a.model || '')} · ${STATUS_TEXT[a.status] ? '' : esc(a.status)}
        ${statusBadge(a.status)}</div></div>
      </div>
      <p class="sheet-desc">${esc(a.task)}</p>
      ${a.answer != null && a.answer !== '' ? `<h4 class="sec-title" style="margin-top:14px">Kết quả cuối</h4>
        <div class="answer-card">${esc(a.answer)}</div>` : ''}
      <div class="sheet-sec"><h4>Timeline (${steps.length} bước)</h4>
        <div id="ag-timeline">${steps.map((st) => stepBubbleHTML(st.i, st)).join('') ||
          `<div class="empty" style="padding:16px;display:flex;gap:8px;justify-content:center;align-items:center"><span class="mini-spin"></span> Chưa có bước nào.</div>`}</div>
      </div>
      ${a.status === 'running' ? `<button type="button" class="btn danger block" id="ag-cancel" style="margin-top:8px">${icon('blade/stop', 'ic-sm')} Cancel agent</button>` : ''}`;

    // Copy observation
    panel.addEventListener('click', async (e) => {
      const cp = e.target.closest('[data-copy]');
      if (cp && (await copyText(cp.dataset.copy))) toast('Đã copy observation', 'ok');
    });

    const cancelBtn = panel.querySelector('#ag-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', async () => {
      cancelBtn.classList.add('loading');
      try {
        await api.cancelAgent(id);
        toast('Đã yêu cầu cancel agent', 'ok');
        closeSheet(); // app-level helper (đã import tĩnh)
        refresh();
      } catch (err) {
        toast(err.message, 'error');
        cancelBtn.classList.remove('loading');
      }
    });
  }

  /* ----- Spawn submit ----- */
  $('spawn-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const task = $('ag-task').value.trim();
    if (!task) { toast('Task không được để trống', 'warn'); return; }
    const btn = $('ag-spawn-btn');
    btn.classList.add('loading');
    try {
      await api.spawnAgent({
        task,
        name: $('ag-name').value.trim() || undefined,
        model: $('ag-model').value || undefined,
        maxSteps: Math.min(12, Math.max(1, parseInt($('ag-steps').value, 10) || 6)),
        tools: selectedTools(),
      });
      $('ag-task').value = '';
      toast('Agent đã được spawn', 'ok');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.classList.remove('loading');
    }
  });

  /* ---------------- boot view ---------------- */
  fillModels();
  fillTools();
  refresh();

  return () => {
    alive = false;
    offModels();
    if (pollTimer) clearInterval(pollTimer);
  };
}

/* Nhãn trạng thái dùng trong subtitle sheet (không HTML) */
const STATUS_TEXT = { running: 'running', done: 'done', cancelled: 'cancelled', failed: 'failed', error: 'failed' };
