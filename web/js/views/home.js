/* ============================================================
   upio web — view Home theo phong cách OpenCode WebUI:
   wordmark mono + status line, khối "MCP executor" (danh sách server
   thật + trạng thái tự bật), quick actions, activity stream dạng
   dòng mono có rail — thay cho stat card kiểu dashboard.
   ============================================================ */
import { api, listen, esc, toast, openSheet, store, fmtDur, fmtClock, icon } from '../app.js';
import { openSkillSheet } from './hub.js';

export async function render(el) {
  el.innerHTML = `
  <div class="container">
    <header class="oc-hero">
      <div class="oc-wordmark">harness<span class="wm-dot"></span>executor</div>
      <div class="oc-statusline" id="oc-status">
        <span class="oc-sl-item" id="sl-boot"><span class="ring"></span> đang khởi động</span>
        <span class="oc-sl-sep">·</span>
        <span class="oc-sl-item" id="sl-mcp">— MCP</span>
        <span class="oc-sl-sep">·</span>
        <span class="oc-sl-item" id="sl-up">—</span>
        <span class="oc-sl-sep">·</span>
        <span class="oc-sl-item dim" id="sl-node"></span>
      </div>
    </header>

    <!-- MCP executor: khối chính, tự bật khi mở app -->
    <h2 class="oc-sec">MCP executor <span class="live-dot" title="realtime qua SSE"></span></h2>
    <section class="oc-panel" id="mcp-panel">
      <div class="oc-panel-head">
        <span class="oph-name">servers</span>
        <span class="oph-right" id="mcp-sum">—</span>
      </div>
      <div class="oc-rows" id="mcp-rows">
        <div class="oc-row skel-row-oc"><span class="skel skel-line" style="width:40%"></span></div>
        <div class="oc-row skel-row-oc"><span class="skel skel-line" style="width:55%"></span></div>
        <div class="oc-row skel-row-oc"><span class="skel skel-line" style="width:32%"></span></div>
      </div>
    </section>

    <!-- Registry counts dạng dòng mono, không phải card to -->
    <section class="oc-panel" style="margin-top:12px">
      <div class="oc-panel-head"><span class="oph-name">registry</span><span class="oph-right">luau · lsp</span></div>
      <div class="oc-kv" id="reg-kv">
        <span class="ta-dash"></span><span class="ta-k">mcps</span><span class="ta-v" id="kv-mcps">—</span>
        <span class="ta-dash"></span><span class="ta-k">plugins</span><span class="ta-v" id="kv-plugins">—</span>
        <span class="ta-dash"></span><span class="ta-k">skills</span><span class="ta-v" id="kv-skills">—</span>
      </div>
    </section>

    <!-- Quick actions -->
    <h2 class="oc-sec">Quick actions</h2>
    <section class="qa-row">
      <button type="button" class="btn primary" id="qa-skill">${icon('blade/sparkles', 'ic-sm')} Chạy skill Luau/LSP</button>
      <button type="button" class="btn ghost" id="qa-build">${icon('blade/build', 'ic-sm')} Build Environment</button>
    </section>

    <!-- Activity stream: dòng mono, mới nhất trên cùng -->
    <h2 class="oc-sec">Activity</h2>
    <section class="oc-panel">
      <div class="oc-panel-head"><span class="oph-name">stream</span><span class="oph-right" id="feed-n">0</span></div>
      <ul class="oc-stream" id="feed"></ul>
      <div class="empty" id="feed-empty">
        <div class="empty-ico">${icon('solar/activity', 'ic-lg')}</div>
        <p><b>Chưa có hoạt động nào</b></p>
        <p class="dim">Feed chạy realtime khi nhận SSE event <code>log</code> từ server.</p>
      </div>
    </section>
  </div>`;

  const $ = (s) => el.querySelector(String(s).startsWith('#') ? s : '#' + s);

  /* ----- status line ----- */
  function fillStatus(s) {
    if (!s) return; // offline — giữ '—'
    const c = s.counts || {};
    $('kv-mcps').textContent = `${c.mcps ?? '—'} (100% thật)`;
    $('kv-plugins').textContent = `${c.plugins ?? '—'} (behavior thật)`;
    $('kv-skills').textContent = `${c.skills ?? '—'}`;
    const conn = typeof s.connectedMcps === 'number' ? s.connectedMcps : null;
    $('sl-mcp').textContent = conn === null ? '— MCP' : `${conn}/${c.mcps ?? '?'} MCP đã bật`;
    $('sl-node').textContent = s.env && s.env.node ? `node ${s.env.node}` : '';
  }

  /* ----- MCP executor panel: server thật + trạng thái ----- */
  async function fillMcps() {
    let items = [];
    try {
      const d = await api.mcps();
      items = d.items || [];
      store.registries.mcps = items;
    } catch {
      $('mcp-rows').innerHTML = '<div class="oc-row"><span class="ocr-name dim">không tải được danh sách MCP</span></div>';
      return;
    }
    const on = items.filter((m) => m.state === 'connected').length;
    const autos = items.filter((m) => m.autoStart);
    $('mcp-sum').textContent = `${on}/${items.length} bật · ${autos.length} tự bật`;
    $('mcp-rows').innerHTML = items.map((m) => {
      const live = m.state === 'connected';
      return `<div class="oc-row" data-mcp="${esc(m.id)}">
        <span class="ocr-mark ${live ? 'on' : ''}"></span>
        <span class="ocr-name">${esc(m.id)}</span>
        ${m.autoStart ? '<span class="ocr-tag">auto</span>' : ''}
        <span class="ocr-right">${live ? `${m.toolCount ?? 0} tools` : 'tắt'}</span>
      </div>`;
    }).join('');
  }

  // Uptime tick mỗi giây (mốc từ lần fetch status gần nhất)
  let uptimeBase = store.status ? store.status.uptimeSec : null;
  let fetchedAt = Date.now();
  function tickUptime() {
    $('sl-up').textContent = uptimeBase == null ? '—' : `up ${fmtDur(uptimeBase + (Date.now() - fetchedAt) / 1000)}`;
  }

  const offStatus = listen('status', (s) => {
    if (!s) return;
    uptimeBase = s.uptimeSec;
    fetchedAt = Date.now();
    fillStatus(s);
    tickUptime();
  });
  fillStatus(store.status);
  tickUptime();
  const upTimer = setInterval(tickUptime, 1000);

  /* ----- boot state: hiện tiến trình tự bật MCP ----- */
  async function fillBoot() {
    try {
      const b = await api.boot();
      const a = b.autoStart;
      const elb = $('sl-boot');
      if (!a) { elb.innerHTML = `<span class="ring"></span> ${esc(b.phase || '—')}`; return; }
      if (!a.done) elb.innerHTML = `<span class="mini-spin"></span> đang bật ${a.ok}/${a.total} MCP`;
      else if (a.failed.length) elb.innerHTML = `${icon('blade/warn', 'ic-xs')} ${a.ok}/${a.total} MCP (${a.failed.length} lỗi)`;
      else elb.innerHTML = `${icon('blade/check', 'ic-xs')} ${a.ok}/${a.total} MCP tự bật`;
    } catch { /* offline */ }
  }
  const offBoot = listen('boot', () => { fillBoot(); fillMcps(); });
  const offMcpEvt = listen('mcp', () => fillMcps());

  /* ----- Quick action: Build Environment → auto sang Settings xem log ----- */
  $('qa-build').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('loading');
    try {
      await api.envBuild(false);
      store.envBuilding = true;
      toast('Environment build đã bắt đầu — mở Settings…', 'ok');
      location.hash = '#/settings';
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.classList.remove('loading');
    }
  });

  /* ----- Quick action: Run skill gợi ý (sheet chọn nhanh) ----- */
  async function loadSkills() {
    if (store.registries.skills.length) return store.registries.skills;
    try {
      const d = await api.skills();
      store.registries.skills = d.items || [];
    } catch { /* offline */ }
    return store.registries.skills;
  }

  $('qa-skill').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('loading');
    const skills = await loadSkills();
    btn.classList.remove('loading');
    if (!skills.length) { toast('Không tải được danh sách skills (API offline)', 'warn'); return; }
    openSheet(`
      <div class="sheet-head"><span class="rc-icon">${icon('blade/sparkles', '')}</span>
        <div><div class="sheet-title">Chạy skill</div>
        <div class="sheet-sub">${esc(String(skills.length))} skill Luau/LSP khả dụng</div></div>
      </div>
      <div id="skill-pick" class="stagger">${skills.map((sk) => `
        <button type="button" class="card row-card" data-skill-id="${esc(sk.id)}">
          <span class="rc-icon">${icon(sk.icon || 'blade/sparkles', '')}</span>
          <span class="rc-main">
            <span class="rc-top"><b>${esc(sk.name)}</b></span>
            <span class="rc-desc">${esc(sk.description)}</span>
            <span class="rc-meta">${esc((sk.steps || []).length)} bước · ${esc((sk.inputs || []).length)} input</span>
          </span>
          <span class="rc-chevron">${icon('blade/chevr', 'ic-sm')}</span>
        </button>`).join('')}
      </div>`);
    document.getElementById('skill-pick').addEventListener('click', (ev) => {
      const row = ev.target.closest('[data-skill-id]');
      if (!row) return;
      const sk = skills.find((x) => x.id === row.dataset.skillId);
      if (sk) openSkillSheet(sk);
    });
  });

  /* ----- Activity stream realtime (SSE 'log') ----- */
  const feed = $('feed');
  const feedEmpty = $('feed-empty');
  let nLines = 0;

  function prependLog(evt) {
    const line = evt.line ?? evt.message ?? evt.detail ?? JSON.stringify(evt);
    const li = document.createElement('li');
    li.className = 'ocs-line';
    li.innerHTML =
      `<span class="ocs-t">${fmtClock()}</span>` +
      `<span class="ocs-txt">${esc(line)}</span>`;
    feed.prepend(li);
    while (feed.children.length > 60) feed.lastElementChild.remove(); // giữ tối đa 60 dòng
    feedEmpty.classList.add('hidden');
    $('feed-n').textContent = String(++nLines);
  }

  const offLog = listen('log', prependLog);

  /* ---------------- boot view ---------------- */
  fillMcps();
  fillBoot();

  /* ----- cleanup khi rời view ----- */
  return () => {
    clearInterval(upTimer);
    offStatus();
    offLog();
    offBoot();
    offMcpEvt();
  };
}
