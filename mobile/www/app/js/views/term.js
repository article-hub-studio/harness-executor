// web/js/views/term.js — Terminal tự động (anyclaw-style):
// mỗi session một folder riêng trong workspace/terminals/<id> · permission 3 mức
// (safe tự chạy / ask phải Duyệt / blocked chặn hẳn) · chạy qua Shizuku tuỳ chọn.
import { api } from '../api.js';
import { icon } from '../icons.js';
import { esc, toast, listen } from '../app.js';

const state = {
  sessions: [], current: null, log: [], pending: [], busy: false,
  viaShizuku: false, unsub: [], poll: null,
};

export function render(el) {
  // KHÔNG bọc bằng <section class="view">: el đã LÀ .view — thẻ .view lồng bên trong
  // không có .active nên bị `display:none`, làm cả tab Term trắng trơn.
  el.innerHTML = `
  <div class="container">
    <header class="oc-hero">
      <div class="oc-wordmark">terminal<span class="wm-dot"></span>auto</div>
      <div class="oc-statusline"><span class="oc-sl-item">session riêng · folder riêng · lệnh nguy hiểm phải duyệt</span></div>
    </header>

    <!-- Permission pending -->
    <div id="perm-zone"></div>

    <!-- Session chips + tạo mới -->
    <div class="term-bar">
      <div class="term-chips" id="term-chips"></div>
      <button type="button" class="term-new" id="btn-new" title="Tạo terminal riêng">${icon('blade/plus', 'ic-sm')}</button>
    </div>

    <!-- Console -->
    <div class="card pad term-card">
      <div class="term-head">
        <span class="mono dim" id="term-dir">${icon('blade/folder', 'ic-sm')} chưa có session</span>
        <span style="display:flex;gap:6px;align-items:center">
          <label class="dim mono" style="font-size:10.5px;display:flex;gap:4px;align-items:center;gap:5px">
            <input type="checkbox" id="chk-shizuku" style="accent-color:var(--text)"> ${icon('blade/bolt', 'ic-xs')} Shizuku
          </label>
          <button type="button" class="icon-btn" id="btn-kill" title="Xoá session">${icon('blade/trash', 'ic-sm')}</button>
        </span>
      </div>
      <div class="term-console" id="console" aria-live="polite"></div>
      <form class="term-inputrow" id="f-cmd">
        <span class="term-prompt">$</span>
        <input id="cmd" class="term-input" autocomplete="off" spellcheck="false"
               placeholder="ls -la · node -v · npm install …(lệnh nguy hiểm sẽ hỏi permission)">
        <button type="submit" class="icon-btn" title="Chạy">${icon('blade/send', 'ic-sm')}</button>
      </form>
    </div>

    <p class="hint-block dim">An toàn (<i>ls, cat, git status…</i>) chạy ngay · Nguy hiểm (<i>npm install, curl, chmod, rm, sudo…</i>)
    hiện thẻ phải <b>Duyệt</b> trong 60s · Luôn cấm (<i>rm -rf /, mkfs, dd…</i>) chặn trước khi chạy.</p>
  </div>`;

  const $ = (s) => el.querySelector(s);
  const consoleEl = $('#console');

  /* ---------- vẽ ---------- */
  function drawChips() {
    $('#term-chips').innerHTML = state.sessions.map((s) =>
      `<button type="button" class="term-chip ${s.id === state.current ? 'on' : ''}${s.busy ? ' busy' : ''}" data-sid="${esc(s.id)}">
        <span class="dotc"></span>${esc(s.name)}</button>`).join('')
      || '<span class="dim mono" style="font-size:11.5px">chưa có terminal nào</span>';
    el.querySelectorAll('.term-chip').forEach((b) => b.addEventListener('click', () => select(b.dataset.sid)));
  }

  function drawConsole() {
    consoleEl.innerHTML = state.log.map((c) => `<div class="tl tl-${esc(c.stream)}">${esc(c.data).replace(/\n$/, '')}</div>`).join('');
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function drawPerm() {
    const zone = $('#perm-zone');
    if (!state.pending.length) { zone.innerHTML = ''; return; }
    zone.innerHTML = state.pending.map((p) => `
      <div class="card pad perm-card" data-pid="${esc(p.id)}">
        <div class="perm-head">${icon('blade/shield', 'ic-sm')} <b>Yêu cầu permission</b>
          <span class="mono dim perm-via">${p.via === 'shizuku' ? 'via Shizuku' : 'local'}</span></div>
        <code class="perm-cmd">${esc(p.command)}</code>
        <div class="perm-actions">
          <button type="button" class="btn-ok" data-act="ok">${icon('blade/check', 'ic-sm')} Duyệt</button>
          <button type="button" class="btn-no" data-act="no">${icon('blade/close', 'ic-sm')} Từ chối</button>
        </div>
      </div>`).join('');
    zone.querySelectorAll('.perm-card button').forEach((b) => b.addEventListener('click', async () => {
      const pid = b.closest('.perm-card').dataset.pid;
      const act = b.dataset.act === 'ok' ? api.permApprove(pid) : api.permDeny(pid);
      const r = await act.catch((e) => ({ error: e.message }));
      if (r && r.ok) toast(b.dataset.act === 'ok' ? 'Đã duyệt — đang chạy' : 'Đã từ chối');
      else toast(r.error || 'Lỗi', 'fail');
      refresh();
    }));
  }

  function drawAll() { drawChips(); drawConsole(); drawPerm(); }

  /* ---------- dữ liệu ---------- */
  /* fresh=true khi vừa có mutation (exec / tạo / kill session): nối vào request phát
     TRƯỚC mutation sẽ mất output và pending-permission một nhịp. */
  async function refresh(fresh = false) {
    const d = await api.termSessions(fresh).catch(() => null);
    if (!d) return;
    state.sessions = d.items || [];
    state.pending = d.pending || [];
    if (!state.current && state.sessions.length) state.current = state.sessions[0].id;
    if (state.current && !state.sessions.some((s) => s.id === state.current)) {
      state.current = state.sessions[0]?.id ?? null; state.log = [];
    }
    await loadCurrent();
    drawAll();
  }

  async function loadCurrent(fresh = false) {
    if (!state.current) return;
    const t = await api.term(state.current, fresh).catch(() => null);
    if (t) { state.log = t.log || []; $('#term-dir').innerHTML = `${icon('blade/folder', 'ic-sm')} ${esc(t.dir)}`; }
  }

  async function select(sid) {
    state.current = sid;
    state.sessions.forEach((s) => { s.busy = false; });
    await loadCurrent();
    drawAll();
  }

  /* ---------- SSE live ---------- */
  function onOut(payload) {
    if (payload.type === 'out' && payload.sid === state.current) {
      state.log.push({ t: payload.t, stream: payload.stream, data: payload.data });
      if (state.log.length > 800) state.log.splice(0, state.log.length - 800);
      drawConsole();
    }
    refresh();
  }

  /* ---------- events ---------- */
  $('#f-cmd').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('#cmd');
    const cmdText = input.value.trim();
    if (!cmdText || !state.current) { if (!state.current) toast('Tạo terminal trước (nút +)', 'warn'); return; }
    input.value = '';
    state.log.push({ t: Date.now(), stream: 'in', data: `$ ${cmdText}` }); drawConsole();
    const r = await api.termExec(state.current, cmdText, state.viaShizuku ? 'shizuku' : 'local').catch((e) => ({ error: e.message }));
    if (r.error) { state.log.push({ t: Date.now(), stream: 'err', data: `✖ ${r.error}` }); drawConsole(); }
    if (r.needsApproval) toast(`Cần duyệt [${r.permId}] — xem thẻ phía trên`, 'warn');
    setTimeout(() => refresh(true), r.ran ? 250 : 400);
  });

  $('#btn-new').addEventListener('click', async () => {
    const n = state.sessions.length + 1;
    const s = await api.termCreate(`term-${n}`).catch(() => null);
    if (s) { state.current = s.id; await refresh(true); toast('Đã tạo terminal + folder riêng'); }
  });

  $('#btn-kill').addEventListener('click', async () => {
    if (!state.current) return;
    await api.termKill(state.current).catch(() => {});
    state.log = []; await refresh(true); toast('Đã xoá session + folder');
  });

  const chk = $('#chk-shizuku');
  chk.addEventListener('change', async () => {
    state.viaShizuku = chk.checked;
    const st = await api.shizukuSet(chk.checked).catch(() => null);
    if (st && !st.available) toast('rish/Shizuku chưa có trên máy — xem Settings → Shizuku', 'warn');
    else if (st) toast(st.enabled ? `Shizuku BẬT (${st.path})` : 'Shizuku TẮT');
  });
  api.shizuku().then((st) => { chk.checked = !!(st && st.enabled); }).catch(() => {});

  /* ---------- init ---------- */
  state.unsub = [listen('term', onOut), listen('perm', onOut)];
  refresh();
  state.poll = setInterval(() => refresh(), 4000);   // poll thường: gộp được thì cứ gộp

  return () => { clearInterval(state.poll); state.unsub.forEach((u) => { try { u(); } catch { /* ok */ } }); };
}
