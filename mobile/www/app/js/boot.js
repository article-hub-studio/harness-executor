/* ============================================================
   upio web — boot.js: Boot overlay "tự setup khi mở app".
   Flow: fetch /api/boot → phase 'ready' → không hiện overlay;
   'booting' → overlay 3 bước + live log (SSE 'boot' / 'log'.boot)
   + poll /api/boot mỗi 1s; ready → fade out 250ms rồi remove.
   Lỗi → blade/error + nút "Thử lại" (reload).
   Không phụ thuộc app.js (tránh vòng import) — nhận deps vào.
   ============================================================ */
import { icon } from './icons.js';

const STEPS = [
  { key: 'environment', label: 'Setup môi trường', icName: 'blade/build' },
  { key: 'connect-mcp', label: 'Kết nối MCP servers', icName: 'blade/connect' },
  { key: 'ready', label: 'Sẵn sàng', icName: 'blade/check' },
];

/** Overlay chỉ giữ tối đa 6 dòng log cuối. */
function renderLines(box, lines) {
  box.textContent = lines.slice(-6).join('\n');
}

/**
 * Chạy boot gate; resolve khi đã ready (hoặc bỏ qua được) — không bao giờ reject.
 * @param {{ api: { boot(): Promise<object> }, listen(type, fn): () => void }} deps
 */
export function gateBoot(deps) {
  const { api, listen } = deps;
  return new Promise((resolve) => {
    let settled = false;
    let root = null;
    let stepEls = null;
    let logBox = null;
    let errBox = null;
    const lines = [];
    const offs = [];
    let pollTimer = null;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      while (offs.length) { try { offs.pop()(); } catch { /* ignore */ } }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!root) return resolve();
      root.classList.add('hide');                 // fade out 250ms rồi remove
      setTimeout(() => { try { root.remove(); } catch { /* ignore */ } resolve(); }, 260);
    };

    const pushLine = (text) => {
      if (!text || !logBox) return;
      lines.push(String(text));
      renderLines(logBox, lines);
    };

    /** state: 'pending' | 'running' | 'done' | 'error' */
    function setStep(key, state) {
      if (!stepEls) return;
      const li = stepEls.get(key);
      if (!li) return;
      li.classList.remove('pending', 'running', 'done', 'error');
      li.classList.add(state === 'pending' ? 'pending' : state);
      const bsi = li.querySelector('.bsi');
      if (!bsi) return;
      if (state === 'running') bsi.innerHTML = '<span class="mini-spin" aria-hidden="true"></span>';
      else if (state === 'error') bsi.innerHTML = icon('blade/error', '');
      else if (state === 'done') bsi.innerHTML = icon('blade/check', '');
      else bsi.innerHTML = icon(STEPS.find((s) => s.key === key)?.icName || 'blade/check', '');
    }

    /** Đồng bộ trạng thái bước từ snapshot steps của /api/boot. */
    function applySnapshot(d) {
      const okKeys = new Set((d.steps || []).filter((s) => s.status === 'ok').map((s) => s.name));
      let runningAssigned = false;
      for (const st of STEPS) {
        if (okKeys.has(st.key)) setStep(st.key, 'done');
        else if (!runningAssigned && d.phase === 'booting') { setStep(st.key, 'running'); runningAssigned = true; }
        else setStep(st.key, 'pending');
      }
    }

    /** Hiện lỗi: dừng poll, đánh dấu bước đang dở + nút Thử lại (reload). */
    function failHard(msg) {
      cleanup();
      let marked = false;
      for (const st of STEPS) {
        if (stepEls?.get(st.key)?.classList.contains('done')) continue;
        setStep(st.key, marked ? 'pending' : 'error');
        marked = true;
      }
      if (!errBox) return;
      errBox.classList.remove('hidden');
      errBox.innerHTML = `${icon('blade/error', 'ic-sm')}<span>${String(msg || 'Khởi động hệ thống thất bại.').replace(/[<>&]/g, '')}</span>`;
      const actions = document.createElement('div');
      actions.className = 'boot-actions';
      actions.innerHTML =
        `<button type="button" class="btn primary small" id="boot-retry">${icon('blade/refresh', 'ic-sm')} Thử lại</button>` +
        `<button type="button" class="btn ghost small" id="boot-skip">Bỏ qua, tiếp tục</button>`;
      errBox.appendChild(actions);
      actions.querySelector('#boot-retry').addEventListener('click', () => location.reload());
      actions.querySelector('#boot-skip').addEventListener('click', finish);
    }

    function buildOverlay(initialMsg) {
      root = document.createElement('div');
      root.id = 'boot-overlay';
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      root.innerHTML = `
        <div class="boot-core">
          <div>
            <div class="boot-mark">harness<span class="wm-dot"></span></div>
            <div class="boot-tag">self-hosted executor</div>
          </div>
          <ol class="boot-steps">
            ${STEPS.map((st) => `
              <li class="boot-step pending" data-step="${st.key}">
                <span class="bsi">${icon(st.icName, '')}</span><span>${st.label}</span>
              </li>`).join('')}
          </ol>
          <pre class="boot-log" aria-hidden="true"></pre>
          <div class="boot-err hidden"></div>
        </div>`;
      document.body.appendChild(root);
      stepEls = new Map([...root.querySelectorAll('.boot-step')].map((li) => [li.dataset.step, li]));
      logBox = root.querySelector('.boot-log');
      errBox = root.querySelector('.boot-err');
      if (initialMsg) pushLine(initialMsg);
      setStep('environment', 'running');
    }

    async function checkOnce() {
      let d;
      try { d = await api.boot(); } catch { finish(); return; } // API unreachable → không chặn
      if (settled) return;
      if (d.phase === 'ready') { for (const st of STEPS) setStep(st.key, 'done'); finish(); return; }
      if (d.phase === 'error') { failHard(d.error); return; }
      applySnapshot(d);
    }

    (async () => {
      let first;
      try { first = await api.boot(); } catch { resolve(); return; }
      if (settled) return;

      if (first.phase === 'ready') { resolve(); return; }   // đã sẵn sàng → không overlay

      // phase 'booting' | 'error'
      buildOverlay();
      if (first.phase === 'error') { failHard(first.error); return; }
      applySnapshot(first);

      // SSE: log có payload.boot === true + event type 'boot'
      offs.push(listen('log', (evt) => {
        if (evt && evt.boot === true) pushLine(evt.line ?? evt.detail ?? '');
      }));
      offs.push(listen('boot', (evt) => {
        if (!evt) return;
        if (evt.line) pushLine(evt.line);
        if (evt.step && evt.status === 'ok') {
          setStep(evt.step, 'done');
          const idx = STEPS.findIndex((s) => s.key === evt.step);
          const next = idx >= 0 ? STEPS[idx + 1] : null;
          if (next && next.key !== 'ready') setStep(next.key, 'running');
        }
        if (evt.phase === 'ready') { for (const st of STEPS) setStep(st.key, 'done'); setTimeout(finish, 250); }
        else if (evt.phase === 'error' || evt.status === 'error') failHard(evt.detail || evt.error);
      }));

      // Poll an toàn mỗi 1s (phòng khi SSE lỡ event) + giới hạn 25s
      pollTimer = setInterval(checkOnce, 1000);
      setTimeout(() => { if (!settled) finish(); }, 25000);
    })();
  });
}
