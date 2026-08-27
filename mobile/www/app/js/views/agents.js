/* ============================================================
   upio web — view Agents: SEGMENTED [Agents | Workspace].
   • Segment "Agents": form spawn (task/name/maxSteps/model/tools
     theo server connected), danh sách + progress polling 2s,
     sheet timeline từng bước (thought/action/observation) + cancel.
   • Segment "Workspace" (Agent AI Workspace): select agent +
     '+ Mới' (spawn sheet dùng chung form), thread chat-like
     (user bubble phải plain; khối agent trái gồm timeline step
     thu gọn mở rộng được + answer render MARKDOWN), live poll
     1.5s + SSE 'agent-step', nhắn thêm qua POST say (khóa input
     khi running), cancel khi running.
   Cả 2 segment dùng chung danh sách agent (cache nhẹ module-level,
   chuyển seg không refetch thừa).
   ============================================================ */
import {
  api, listen, esc, toast, openSheet, closeSheet, onSheetClose,
  store, fmtAgo, truncate, copyText, icon,
} from '../app.js';
import { renderMarkdown } from '../md.js';

/* Cache nhẹ chia sẻ giữa 2 segment + giữ state khi chuyển tab */
const wsState = {
  seg: 'agents',            // 'agents' | 'workspace'
  selectedId: null,
  cache: { items: null, at: 0 },
  TTL: 3000,                // ms — chuyển seg trong TTL không refetch
};

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

/* Nhãn trạng thái dùng trong subtitle sheet (không HTML) */
const STATUS_TEXT = { running: 'running', done: 'done', cancelled: 'cancelled', failed: 'failed', error: 'failed' };

/* ================= Spawn form (dùng chung 2 chỗ) ================= */

/** HTML các trường spawn; p = prefix id để tránh trùng khi có sheet. */
function spawnFieldsHTML(p) {
  return `
    <div class="field"><label>Task *</label>
      <textarea class="input" id="${p}-task" rows="3" required
        placeholder="VD: Review repo upio/mcp-executor, liệt kê 5 rủi ro bảo mật và đề xuất fix…"></textarea>
    </div>
    <div class="form-grid cols-2">
      <div class="field"><label>Tên agent</label>
        <input class="input" id="${p}-name" placeholder="reviewer-01" autocomplete="off">
      </div>
      <div class="field"><label>Max steps</label>
        <input class="input" id="${p}-steps" type="number" min="1" max="12" value="6">
      </div>
    </div>
    <div class="field"><label>Model</label>
      <select class="input" id="${p}-model"></select>
    </div>
    <div class="field"><label>Tools (theo MCP server đã connect)</label>
      <div id="${p}-tools"><div class="dim" style="font-size:12.5px;display:flex;gap:8px;align-items:center"><span class="spin"></span> Đang tải servers…</div></div>
    </div>`;
}

/** Đổ model options vào 1 select (dùng chung). */
function fillModelSelect(sel) {
  const models = store.models.length ? store.models : [{ id: 'ox-local-mock', label: 'ox-local-mock (mock nội bộ)' }];
  const def = store.modelConfig.default || 'ox-local-mock';
  sel.innerHTML = models.map((m) =>
    `<option value="${esc(m.id)}">${esc(m.label || m.id)}${m.available === false ? ' (unavailable)' : ''}</option>`).join('');
  if (models.some((m) => m.id === def)) sel.value = def;
}

/** Vẽ tools multi-select nhóm theo server connected vào box. */
function buildToolsBox(box) {
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
  box.onchange = (e) => {
    const all = e.target.closest('.sel-all');
    if (!all) return;
    box.querySelectorAll(`.tool-cb[data-server="${CSS.escape(all.dataset.server)}"]`)
      .forEach((cb) => { cb.checked = all.checked; });
  };
}

function collectTools(root) {
  return [...root.querySelectorAll('.tool-cb:checked')]
    .map((cb) => ({ server: cb.dataset.server, tool: cb.dataset.tool }));
}

/* ================= View ================= */

export async function render(el) {
  const seg = wsState.seg;

  el.innerHTML = `
  <div class="container">
    <header class="oc-hero">
      <div class="oc-wordmark">agents</div>
      <div class="oc-statusline"><span class="oc-sl-item">plan → tool → observe → final</span></div>
    </header>

    <div class="segmented two" role="tablist" id="ag-seg">
      <button type="button" class="seg-btn ${seg !== 'workspace' ? 'active' : ''}" data-seg="agents" role="tab">Agents</button>
      <button type="button" class="seg-btn ${seg === 'workspace' ? 'active' : ''}" data-seg="workspace" role="tab">Workspace</button>
    </div>

    <!-- ============ SEGMENT 1: Agents (giữ nguyên màn cũ) ============ -->
    <section id="ag-pane-agents" class="${seg === 'workspace' ? 'hidden' : ''}">
      <section class="card pad" style="margin-top:14px">
        <form id="spawn-form">
          ${spawnFieldsHTML('ag')}
          <button type="submit" class="btn primary block" id="ag-spawn-btn">${icon('blade/bolt', 'ic-sm')} Spawn agent</button>
        </form>
      </section>

      <h2 class="oc-sec">Agents <span id="ag-count-badge" class="badge mini disconnected hidden"></span></h2>
      <section class="agent-list" id="agent-list">
        <div class="empty card pad"><div class="empty-ico">${icon('solar/agents', 'ic-lg')}</div><b>Chưa có agent nào</b><p class="dim">Spawn agent đầu tiên bằng form phía trên.</p></div>
      </section>
    </section>

    <!-- ============ SEGMENT 2: Workspace ============ -->
    <section id="ag-pane-workspace" class="${seg === 'workspace' ? '' : 'hidden'}">
      <div class="ws-head">
        <select class="input" id="ws-agent" aria-label="Chọn agent"></select>
        <button type="button" class="btn primary" id="ws-new">${icon('blade/plus', 'ic-sm')} Mới</button>
      </div>
      <div class="ws-thread" id="ws-thread"></div>
      <form class="chat-input-bar ws-inputbar" id="ws-bar">
        <textarea class="input" id="ws-input" rows="1" placeholder="Nhắn thêm cho agent…" enterkeyhint="send"></textarea>
        <button type="button" class="ws-stop hidden" id="ws-stop" title="Cancel agent" aria-label="Cancel agent">${icon('blade/stop', '')}</button>
        <button type="submit" class="send-btn" id="ws-send" disabled title="Gửi" aria-label="Gửi">${icon('blade/send', '')}</button>
      </form>
    </section>
  </div>`;

  const $ = (s) => el.querySelector(String(s).startsWith('#') ? s : '#' + s);
  let items = [];
  let pollTimer = null;       // polling list (segment Agents)
  let liveTimer = null;       // polling detail 1.5s (Workspace)
  let alive = true;
  let threadSig = '';         // chống re-render thread thừa khi poll

  /* ----- Model select (segment 1) ----- */
  const agModelSel = $('ag-model');
  fillModelSelect(agModelSel);
  const offModels = listen('models', () => fillModelSelect(agModelSel));

  /* ----- Tools box (segment 1) ----- */
  buildToolsBox($('ag-tools'));

  /* ================= Dữ liệu chung: api.agents() + cache ================= */
  async function refreshAgents(force = false) {
    const fresh = wsState.cache.items && Date.now() - wsState.cache.at < wsState.TTL;
    if (!force && fresh) { items = wsState.cache.items; drawList(); fillAgentSelect(); return items; }
    try {
      const d = await api.agents();
      items = d.items || [];
      wsState.cache.items = items;
      wsState.cache.at = Date.now();
    } catch { return items; } // offline — giữ nguyên list
    drawList();
    fillAgentSelect();
    return items;
  }

  /* ----- Polling list: mỗi 2s CHỈ khi còn agent running ----- */
  function armListPolling() {
    if (items.some((a) => a.status === 'running')) {
      if (!pollTimer) pollTimer = setInterval(() => refreshAgents(true), 2000);
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /* ================= Segment switching ================= */
  $('ag-seg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b || b.dataset.seg === wsState.seg) return;
    wsState.seg = b.dataset.seg;
    el.querySelectorAll('#ag-seg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    const ws = wsState.seg === 'workspace';
    $('ag-pane-agents').classList.toggle('hidden', ws);
    $('ag-pane-workspace').classList.toggle('hidden', !ws);
    if (ws) enterWorkspace(); // dữ liệu đã có từ refreshAgents() — không refetch thừa
  });

  /* ================= SEGMENT 1: list + sheet chi tiết ================= */

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
    if (!listEl) return;
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

  /* ----- Sheet chi tiết agent: timeline steps (ghi vào .sheet-body để giữ nút đóng) ----- */
  async function openAgentSheet(id) {
    const panel = openSheet(`<div class="empty" style="display:flex;gap:10px;justify-content:center;align-items:center;padding:34px"><span class="spin"></span> Đang tải agent…</div>`);
    let a;
    try {
      a = await api.agent(id);
    } catch (err) {
      panel.querySelector('.sheet-body').innerHTML =
        `<div class="empty"><div class="empty-ico">${icon('blade/error', 'ic-lg')}</div><b>${esc(err.message)}</b></div>`;
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
    panel.querySelector('.sheet-body').innerHTML = `
      <div class="sheet-head"><span class="rc-icon">${icon('solar/agents', '')}</span>
        <div style="min-width:0"><div class="sheet-title">${esc(a.name || a.id)}</div>
        <div class="sheet-sub mono">${esc(a.id)} · ${esc(a.model || '')} · ${STATUS_TEXT[a.status] ? '' : esc(a.status)}
        ${statusBadge(a.status)}</div></div>
      </div>
      <p class="sheet-desc">${esc(a.task)}</p>
      ${a.answer != null && a.answer !== '' ? `<h4 class="oc-sec" style="margin-top:14px">Kết quả cuối</h4>
        <div class="answer-card md">${renderMarkdown(String(a.answer))}</div>` : ''}
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
        refreshAgents(true).then(armListPolling);
      } catch (err) {
        toast(err.message, 'error');
        cancelBtn.classList.remove('loading');
      }
    });
  }

  /* ----- Spawn submit (segment 1) ----- */
  $('spawn-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const task = $('ag-task').value.trim();
    if (!task) { toast('Task không được để trống', 'warn'); return; }
    const btn = $('ag-spawn-btn');
    btn.classList.add('loading');
    try {
      const r = await api.spawnAgent({
        task,
        name: $('ag-name').value.trim() || undefined,
        model: agModelSel.value || undefined,
        maxSteps: Math.min(12, Math.max(1, parseInt($('ag-steps').value, 10) || 6)),
        tools: collectTools($('ag-tools')),
      });
      $('ag-task').value = '';
      toast('Agent đã được spawn', 'ok');
      await refreshAgents(true); armListPolling();
      // Nếu đang ở workspace thì chọn luôn agent mới (spawn trả {id})
      if (r && r.id && wsState.seg === 'workspace') { wsState.selectedId = r.id; loadThread(r.id); }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.classList.remove('loading');
    }
  });

  /* ================= SEGMENT 2: WORKSPACE ================= */

  const threadEl = $('ws-thread');
  const wsInput = $('ws-input');
  const wsSend = $('ws-send');
  const wsStop = $('ws-stop');
  let wsBusy = false;         // đang chờ agent phản hồi sau say/spawn
  const expandedSlots = new Set(); // slot timeline đang mở rộng
  let stepData = [];          // dữ liệu step theo slot (để toggle mở rộng)

  /** Chọn agent mặc định: done gần nhất > running > mới nhất. */
  function pickDefaultAgent(sorted) {
    const byTs = (v) => { const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; };
    const s = [...sorted].sort((a, b) => byTs(b.createdAt) - byTs(a.createdAt));
    return (s.find((a) => a.status === 'done') || s.find((a) => a.status === 'running') || s[0] || {}).id || null;
  }

  function fillAgentSelect() {
    const sel = $('ws-agent');
    if (!sel) return;
    if (!items.length) {
      sel.innerHTML = `<option value="">— chưa có agent —</option>`;
      return;
    }
    const byTs = (v) => { const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; };
    const sorted = [...items].sort((a, b) => byTs(b.createdAt) - byTs(a.createdAt));
    if (!wsState.selectedId || !sorted.some((a) => a.id === wsState.selectedId)) {
      wsState.selectedId = pickDefaultAgent(sorted); // mặc định: agent done gần nhất
    }
    sel.innerHTML = sorted.map((a) =>
      `<option value="${esc(a.id)}">${esc(a.name || a.id)} · ${esc(a.status)}${Number(a.followUps) ? ` · ${esc(String(a.followUps))} lượt` : ''}</option>`).join('');
    sel.value = wsState.selectedId || sorted[0].id;
  }

  $('ws-agent').addEventListener('change', (e) => {
    wsState.selectedId = e.target.value || null;
    stopLive();
    loadThread(wsState.selectedId);
  });

  function setWsBusy(running) {
    wsBusy = !!running;
    wsInput.disabled = wsBusy;
    wsSend.disabled = wsBusy || !wsInput.value.trim();
    wsStop.classList.toggle('hidden', !running);
    wsInput.placeholder = running ? 'Agent đang chạy…' : 'Nhắn thêm cho agent…';
  }

  function wsGrow() {
    wsInput.style.height = 'auto';
    wsInput.style.height = Math.min(wsInput.scrollHeight, 110) + 'px';
  }
  wsInput.addEventListener('input', () => { wsGrow(); if (!wsBusy) wsSend.disabled = !wsInput.value.trim(); });
  wsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sayToAgent(); }
  });

  /* ----- Nhắn thêm (multi-turn): optimistic bubble + khóa input đến khi done ----- */
  wsStop.addEventListener('click', async () => {
    if (!wsState.selectedId) return;
    try {
      await api.cancelAgent(wsState.selectedId);
      toast('Đã yêu cầu cancel agent', 'ok');
      refreshAgents(true).then(armListPolling);
    } catch (err) { toast(err.message, 'error'); }
  });

  $('ws-bar').addEventListener('submit', (e) => { e.preventDefault(); sayToAgent(); });

  async function sayToAgent() {
    const msg = wsInput.value.trim();
    if (!msg || wsBusy || !wsState.selectedId) return;
    wsInput.value = '';
    wsGrow();

    // Optimistic user bubble (plain, bubble phải)
    let turn = threadEl.querySelector('.ws-turn:last-child');
    if (!turn) {
      threadEl.insertAdjacentHTML('beforeend', `<div class="ws-turn"></div>`);
      turn = threadEl.querySelector('.ws-turn:last-child');
    }
    turn.insertAdjacentHTML('beforeend',
      `<div class="msg user ws-msg-user">${esc(msg)}</div>` +
      `<div class="ws-agent-block"><div class="ws-thinking"><span class="mini-spin"></span> Đang xử lý…</div></div>`);
    scrollThread(true);

    setWsBusy(true);
    try {
      await api.sayAgent(wsState.selectedId, msg);
      startLive(wsState.selectedId); // poll 1.5s + SSE đến khi done → unlock
    } catch (err) {
      toast(err.message, 'error');
      setWsBusy(false);
      loadThread(wsState.selectedId); // dọn khối "Đang xử lý…" optimistic
    }
  }

  function scrollThread(force) {
    const last = threadEl.lastElementChild;
    if (last) last.scrollIntoView({ behavior: force ? 'smooth' : 'auto', block: 'nearest' });
  }

  /* ----- Live: poll GET /api/agents/:id mỗi 1.5s + SSE 'agent-step' realtime ----- */
  function startLive(id) {
    stopLive();
    if (!id) return;
    liveTimer = setInterval(async () => {
      if (!alive || wsState.selectedId !== id) return stopLive();
      let d;
      try { d = await api.agent(id); } catch { return; } // offline → thử lần sau
      const sig = `${d.status}:${(d.steps || []).length}:${(d.session || []).length}`;
      if (sig !== threadSig) {
        threadSig = sig;
        drawThread(d);
      }
      const running = d.status === 'running';
      if (!running) {
        stopLive();
        setWsBusy(false);
        refreshAgents(true).then(armListPolling); // status/followUps đổi → refresh list
      }
    }, 1500);
  }

  function stopLive() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
  }

  /** SSE 'agent-step': append chip realtime vào timeline của turn đang chạy. */
  const offStep = listen('agent-step', (evt) => {
    if (!evt || evt.id !== wsState.selectedId || !threadEl.isConnected) return;
    let stepsBox = threadEl.querySelector('.ws-turn:last-child .ws-steps');
    if (!stepsBox) {
      const block = threadEl.querySelector('.ws-turn:last-child .ws-agent-block');
      if (!block) return;
      block.insertAdjacentHTML('afterbegin', `<div class="ws-steps"></div>`);
      stepsBox = threadEl.querySelector('.ws-turn:last-child .ws-steps');
    }
    const slot = stepData.push({ thought: evt.thought || '', action: evt.action ?? '', observation: evt.observation ?? '', i: evt.i }) - 1;
    stepsBox.insertAdjacentHTML('beforeend', stepChipHTML(slot));
    scrollThread(false);
  });

  /* ----- Build turns từ session (fallback tổng hợp từ steps/answer) ----- */
  const tsOf = (v) => { const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; };

  function buildTurns(a) {
    const steps = Array.isArray(a.steps) ? a.steps : [];
    const sess = Array.isArray(a.session) ? a.session : [];
    let turns = [];

    if (sess.length) {
      let cur = null;
      for (const m of sess) {
        const role = m.role || 'user';
        if (role === 'user') {
          cur = { user: String(m.text ?? ''), at: m.at, steps: [], answers: [] };
          turns.push(cur);
        } else if (role === 'observation') {
          if (!cur) { cur = { user: '', at: m.at, steps: [], answers: [] }; turns.push(cur); }
          cur.steps.push({ thought: '', action: '', observation: String(m.text ?? ''), at: m.at });
        } else { // 'agent'
          if (!cur) { cur = { user: '', at: m.at, steps: [], answers: [] }; turns.push(cur); }
          cur.answers.push(String(m.text ?? ''));
        }
      }
      // Gán step chi tiết (thought/action) vào turn theo mốc thời gian user message
      if (steps.length && turns.length) {
        const marks = turns.map((t) => tsOf(t.at));
        for (const st of steps) {
          let ti = -1;
          for (let k = marks.length - 1; k >= 0; k--) {
            if (tsOf(st.at) >= marks[k]) { ti = k; break; }
          }
          if (ti < 0) ti = 0;
          turns[ti].steps.push(st);
        }
        turns.forEach((t) => t.steps.sort((x, y) => (Number(x.i) || 0) - (Number(y.i) || 0)));
      }
    } else {
      turns = [{
        user: String(a.task || ''),
        at: a.createdAt,
        steps: [...steps],
        answers: (a.answer != null && a.answer !== '') ? [String(a.answer)] : [],
      }];
    }
    return turns;
  }

  /* ----- Timeline chip (thu gọn 1 dòng) + bản mở rộng ----- */
  function actionText(action) {
    if (action && typeof action === 'object') {
      return `${action.tool || action.type || ''}${action.args ? '(' + JSON.stringify(action.args) + ')' : ''}`;
    }
    return String(action ?? '');
  }

  function stepChipHTML(slot) {
    const st = stepData[slot] || {};
    const thought = st.thought ? `<span class="sc-thought">${icon('blade/sparkles', 'ic-xs')} ${esc(truncate(st.thought, 42))}</span>` : '';
    const act = actionText(st.action);
    const actHtml = act ? `<span class="sc-action">${icon('blade/run', 'ic-xs')} ${esc(truncate(act, 40))}</span>` : '';
    const obsHtml = st.observation != null && st.observation !== ''
      ? `<span class="sc-obs">${esc(truncate(String(st.observation), 80))}</span>` : '';
    return `<button type="button" class="step-chip" data-slot="${slot}">` +
      `<span class="sc-n mono">${esc(String(st.i ?? slot + 1))}</span>${thought}${actHtml}${obsHtml}` +
      `<span class="acc-caret">${icon('blade/chevd', 'ic-xs')}</span></button>`;
  }

  function stepFullHTML(slot) {
    const st = stepData[slot] || {};
    const act = actionText(st.action);
    return `<div class="step-full" data-slot="${slot}">
      <div class="sf-head"><span>BƯỚC ${esc(String(st.i ?? slot + 1))}</span>
        <button type="button" class="linklike sf-fold">${icon('blade/chevd', 'ic-xs')} thu gọn</button></div>
      ${st.thought ? `<div class="sf-thought">${icon('blade/sparkles', 'ic-xs')} ${esc(st.thought)}</div>` : ''}
      ${act ? `<div class="sf-action">${icon('blade/run', 'ic-xs')} ${esc(act)}</div>` : ''}
      ${st.observation != null && st.observation !== '' ? `
        <div class="obs-wrap">
          <pre class="obs-pre">${esc(truncate(String(st.observation), 2000))}</pre>
          <button type="button" class="btn ghost small obs-copy" data-copy="${esc(st.observation)}">${icon('blade/copy', 'ic-sm')} copy</button>
        </div>` : ''}
    </div>`;
  }

  /* ----- Vẽ thread cho 1 agent ----- */
  function drawThread(a) {
    expandedSlots.clear();
    stepData = [];
    const turns = buildTurns(a);
    if (!turns.length && a.status === 'running') turns.push({ user: String(a.task || ''), at: a.createdAt, steps: [], answers: [] });

    if (!turns.length) {
      threadEl.innerHTML = `<div class="empty card pad"><div class="empty-ico">${icon('solar/agents', 'ic-lg')}</div>
        <b>Agent chưa có nội dung</b><p class="dim">Nhắn thêm bên dưới để bắt đầu.</p></div>`;
      return;
    }

    threadEl.innerHTML = turns.map((t) => {
      const chips = t.steps.map((st) => { const slot = stepData.push(st) - 1; return stepChipHTML(slot); }).join('');
      const answers = t.answers.filter(Boolean).map((txt) =>
        `<div class="ws-answer md">${renderMarkdown(txt)}</div>`).join('');
      const thinking = (a.status === 'running' && t === turns[turns.length - 1] && !answers)
        ? `<div class="ws-thinking"><span class="mini-spin"></span> Đang suy luận…</div>` : '';
      return `<div class="ws-turn">
          ${t.user ? `<div class="msg user ws-msg-user">${esc(t.user)}</div>` : ''}
          <div class="ws-agent-block">
            ${chips ? `<div class="ws-steps">${chips}</div>` : ''}
            ${answers}
            ${thinking}
          </div>
        </div>`;
    }).join('');
    scrollThread(true);
  }

  /** Load chi tiết agent → vẽ thread + arm live nếu running. */
  async function loadThread(id) {
    threadSig = '';
    if (!id) {
      threadEl.innerHTML = emptyWorkspaceHTML();
      setWsBusy(false);
      return;
    }
    threadEl.innerHTML = `<div class="empty" style="display:flex;gap:10px;justify-content:center;align-items:center;padding:30px"><span class="spin"></span> Đang tải phiên làm việc…</div>`;
    let a;
    try { a = await api.agent(id); } catch (err) {
      threadEl.innerHTML = `<div class="empty card pad"><div class="empty-ico">${icon('blade/error', 'ic-lg')}</div><b>${esc(err.message)}</b></div>`;
      return;
    }
    drawThread(a);
    threadEl.dataset.loadedFor = id;
    const running = a.status === 'running';
    setWsBusy(running);
    if (running) startLive(id); else stopLive();
  }

  function emptyWorkspaceHTML() {
    return `<div class="empty card pad"><div class="empty-ico ws-empty-xl">${icon('solar/agents', '')}</div>
      <b>Chưa có agent nào trong workspace</b>
      <p class="dim">Spawn agent đầu tiên — bấm “Mới” phía trên, rồi trò chuyện tiếp qua từng lượt.</p>
      <button type="button" class="btn primary small" id="ws-empty-new" style="margin-top:12px">${icon('blade/plus', 'ic-sm')} Mới</button></div>`;
  }

  threadEl.addEventListener('click', async (e) => {
    // Toggle mở rộng/thu gọn step
    const fold = e.target.closest('.step-chip, .step-full .sf-fold');
    if (fold) {
      const holder = fold.closest('[data-slot]');
      const slot = Number(holder?.dataset.slot);
      if (!holder || !Number.isInteger(slot)) return;
      if (expandedSlots.has(slot)) { expandedSlots.delete(slot); holder.outerHTML = stepChipHTML(slot); }
      else { expandedSlots.add(slot); holder.outerHTML = stepFullHTML(slot); }
      return;
    }
    // Copy observation trong step mở rộng
    const cp = e.target.closest('[data-copy]');
    if (cp && (await copyText(cp.dataset.copy))) toast('Đã copy observation', 'ok');
    // Empty-state CTA
    if (e.target.closest('#ws-empty-new')) openSpawnSheet();
  });

  /* ----- '+ Mới': spawn sheet tái dùng form chung ----- */
  $('ws-new').addEventListener('click', openSpawnSheet);

  function openSpawnSheet() {
    const panel = openSheet(`
      <div class="sheet-head"><span class="rc-icon">${icon('solar/agents', '')}</span>
        <div><div class="sheet-title">Spawn agent mới</div>
        <div class="sheet-sub">Vòng lặp plan → tool → observe → final</div></div>
      </div>
      <form id="ws-spawn-form">
        ${spawnFieldsHTML('wsp')}
        <button type="submit" class="btn primary block" id="wsp-spawn-btn">${icon('blade/bolt', 'ic-sm')} Spawn agent</button>
      </form>`);
    const body = panel.querySelector('.sheet-body');
    fillModelSelect(body.querySelector('#wsp-model'));
    buildToolsBox(body.querySelector('#wsp-tools'));

    body.querySelector('#ws-spawn-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const task = body.querySelector('#wsp-task').value.trim();
      if (!task) { toast('Task không được để trống', 'warn'); return; }
      const btn = body.querySelector('#wsp-spawn-btn');
      btn.classList.add('loading');
      try {
        const r = await api.spawnAgent({
          task,
          name: body.querySelector('#wsp-name').value.trim() || undefined,
          model: body.querySelector('#wsp-model').value || undefined,
          maxSteps: Math.min(12, Math.max(1, parseInt(body.querySelector('#wsp-steps').value, 10) || 6)),
          tools: collectTools(body.querySelector('#wsp-tools')),
        });
        toast('Agent đã được spawn', 'ok');
        closeSheet();
        await refreshAgents(true); armListPolling();
        wsState.seg = 'workspace';
        if (r && r.id) { wsState.selectedId = r.id; fillAgentSelect(); loadThread(r.id); }
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.classList.remove('loading');
      }
    });
  }

  /* ----- Vào workspace lần đầu (hoặc quay lại) ----- */
  function enterWorkspace() {
    fillAgentSelect();
    if (!items.length) { threadEl.innerHTML = emptyWorkspaceHTML(); setWsBusy(false); return; }
    if (!threadEl.dataset.loadedFor || threadEl.dataset.loadedFor !== wsState.selectedId) {
      loadThread(wsState.selectedId);
    }
  }

  /* ---------------- boot view ---------------- */
  await refreshAgents(!wsState.cache.items); // cache nhẹ: còn tươi thì không refetch
  armListPolling();
  if (wsState.seg === 'workspace') {
    $('ag-pane-agents').classList.add('hidden');
    $('ag-pane-workspace').classList.remove('hidden');
    enterWorkspace();
  }
  wsGrow();

  return () => {
    alive = false;
    offModels();
    offStep();
    if (pollTimer) clearInterval(pollTimer);
    stopLive();
  };
}
