/* ============================================================
   upio web — view Home: hero wordmark, stat cards (icon hoá),
   quick actions, activity feed realtime (SSE 'log').
   ============================================================ */
import { api, listen, esc, toast, openSheet, store, fmtDur, fmtClock, fmtNum, icon, countUp } from '../app.js';
import { openSkillSheet } from './hub.js';

export async function render(el) {
  el.innerHTML = `
  <div class="container">
    <header class="hero">
      <h1 class="hero-brand"><span class="wm">harness<span class="wm-dot"></span></span><span class="hero-sub" style="margin-top:0">executor</span></h1>
      <p class="hero-sub">Mobile control plane cho MCP servers · plugins · skills · agents</p>
    </header>

    <!-- Stat grid -->
    <section class="stat-grid" aria-label="Thống kê">
      <div class="card stat"><div class="stat-label">${icon('blade/clock', 'ic-xs')}Uptime</div><div class="stat-value" id="st-uptime">—</div><div class="stat-sub" id="st-env"></div></div>
      <div class="card stat"><div class="stat-label">${icon('solar/puzzle', 'ic-xs')}Plugins</div><div class="stat-value" id="st-plugins">—</div><div class="stat-sub"></div></div>
      <div class="card stat hl"><div class="stat-label">${icon('solar/server', 'ic-xs')}MCPs</div><div class="stat-value" id="st-mcps">—</div><div class="stat-sub" id="st-connected">&nbsp;</div><div class="stat-sub dim" id="st-mcp-cap" hidden></div></div>
      <div class="card stat"><div class="stat-label">${icon('solar/book', 'ic-xs')}Skills</div><div class="stat-value" id="st-skills">—</div><div class="stat-sub"></div></div>
    </section>

    <!-- Quick actions -->
    <h2 class="sec-title">Quick actions</h2>
    <section class="qa-row">
      <button type="button" class="btn primary" id="qa-build">${icon('blade/build', 'ic-sm')} Build Environment</button>
      <button type="button" class="btn ghost" id="qa-skill">${icon('blade/sparkles', 'ic-sm')} Run skill gợi ý</button>
    </section>

    <!-- Activity feed -->
    <h2 class="sec-title">Activity <span class="live-dot" title="realtime qua SSE"></span></h2>
    <section class="card feed-card">
      <ul class="feed" id="feed"></ul>
      <div class="empty" id="feed-empty">
        <div class="empty-ico">${icon('solar/activity', 'ic-lg')}</div>
        <p><b>Chưa có hoạt động nào</b></p>
        <p class="dim">Feed sẽ chạy realtime khi nhận SSE event <code>log</code> từ server.</p>
      </div>
    </section>
  </div>`;

  /* ----- stat cards ----- */
  const $ = (id) => el.querySelector('#' + id);

  function fillStats(s) {
    if (!s) return; // offline — giữ '—'
    const counts = s.counts || {};
    countUp($('st-plugins'), counts.plugins, { fmt: fmtNum });
    countUp($('st-mcps'), counts.mcps, { fmt: fmtNum });
    countUp($('st-skills'), counts.skills, { fmt: fmtNum });
    const conn = typeof s.connectedMcps === 'number' ? s.connectedMcps : null;
    const connEl = $('st-connected');
    if (conn === null) { connEl.innerHTML = '&nbsp;'; }
    else {
      connEl.innerHTML = `${icon('solar/activity', 'ic-xs')} <span id="st-conn-n">0</span> connected`;
      countUp(connEl.querySelector('#st-conn-n'), conn, { fmt: fmtNum });
    }
    // Caption MCPs: '98 mô phỏng · 8 thật' — ẩn nếu backend chưa trả realMcps
    const capEl = $('st-mcp-cap');
    if (typeof counts.realMcps === 'number' && typeof counts.mcps === 'number') {
      const sim = Math.max(0, counts.mcps - counts.realMcps);
      capEl.textContent = `${sim} mô phỏng · ${counts.realMcps} thật`;
      capEl.hidden = false;
    } else {
      capEl.hidden = true;
    }
    $('st-env').textContent = s.env && s.env.node ? `node ${s.env.node}` : '';
  }

  // Uptime tick mỗi giây (mốc từ lần fetch status gần nhất)
  let uptimeBase = store.status ? store.status.uptimeSec : null;
  let fetchedAt = Date.now();
  function tickUptime() {
    if (uptimeBase == null) { $('st-uptime').textContent = '—'; return; }
    $('st-uptime').textContent = fmtDur(uptimeBase + (Date.now() - fetchedAt) / 1000);
  }

  const offStatus = listen('status', (s) => {
    if (!s) return;
    uptimeBase = s.uptimeSec;
    fetchedAt = Date.now();
    fillStats(s);
    tickUptime();
  });
  fillStats(store.status);
  tickUptime();
  const upTimer = setInterval(tickUptime, 1000);

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
        <div><div class="sheet-title">Chạy skill nhanh</div>
        <div class="sheet-sub">${esc(String(skills.length))} skills khả dụng</div></div>
      </div>
      <div id="skill-pick" class="stagger">${skills.slice(0, 40).map((sk) => `
        <button type="button" class="card row-card" data-skill-id="${esc(sk.id)}">
          <span class="rc-icon">${sk.icon ? esc(sk.icon) : icon('blade/sparkles', '')}</span>
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

  /* ----- Activity feed realtime (SSE 'log') ----- */
  const feed = $('feed');
  const feedEmpty = $('feed-empty');

  function prependLog(evt) {
    const line = evt.line ?? evt.message ?? evt.detail ?? JSON.stringify(evt);
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="feed-time">${icon('blade/clock', 'ic-xs')}${fmtClock()}</span>` +
      `<span class="feed-line">${esc(line)}</span>`;
    feed.prepend(li);
    while (feed.children.length > 50) feed.lastElementChild.remove(); // giữ tối đa 50 dòng
    feedEmpty.classList.add('hidden');
  }

  const offLog = listen('log', prependLog);

  /* ----- cleanup khi rời view ----- */
  return () => {
    clearInterval(upTimer);
    offStatus();
    offLog();
  };
}
