/* ============================================================
   upio web — view Chat theo phong cách OpenCode WebUI:
   dòng thời gian "part" thay vì bubble chat — mỗi part có rail bên
   trái (mốc + vạch dọc nối), nhãn vai trò dạng monospace in hoa,
   nội dung là khối phẳng viền 1px. Tool-call render riêng thành
   khối có header + body mono.
   Stream qua /v1/chat/completions, markdown re-render throttle ~120ms.
   ============================================================ */
import { chatCompletion, esc, listen, store, icon, toast } from '../app.js';
import { renderMarkdown } from '../md.js';

const REPAINT_MS = 120; // throttle re-render markdown khi stream

export async function render(el) {
  el.innerHTML = `
    <div class="chat-top">
      <select class="input" id="chat-model" aria-label="Chọn model"></select>
      <button type="button" class="btn ghost small" id="chat-new">${icon('blade/trash', 'ic-sm')} New chat</button>
    </div>
    <div class="chat-scroll" id="chat-scroll">
      <div class="chat-inner" id="chat-inner">
        <div class="chat-empty" id="chat-empty">
          <span class="empty-ico">${icon('solar/chat', 'ic-lg')}</span><br>
          Bắt đầu cuộc trò chuyện với model.<br>
          <span class="dim">Enter gửi · Shift+Enter xuống dòng</span>
        </div>
      </div>
    </div>
    <form class="chat-input-bar" id="chat-bar">
      <textarea class="input" id="chat-input" rows="1" placeholder="Nhập tin nhắn…" enterkeyhint="send"></textarea>
      <button type="submit" class="send-btn" id="chat-send" disabled title="Gửi" aria-label="Gửi">${icon('blade/send', '')}</button>
    </form>`;

  const $ = (s) => el.querySelector(String(s).startsWith('#') ? s : '#' + s);
  const scrollBox = $('chat-scroll');
  const inner = $('chat-inner');
  const input = $('chat-input');
  const sendBtn = $('chat-send');
  const emptyHint = $('chat-empty');

  /** History client-side: [{role:'user'|'assistant'|'system', content}] */
  let messages = [];
  let busy = false;

  /* ----- Model select ----- */
  function fillModels() {
    const sel = $('chat-model');
    const models = store.models.length ? store.models : [{ id: 'ox-local-mock' }];
    const def = store.modelConfig.default || 'ox-local-mock';
    sel.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label || m.id)}</option>`).join('');
    if (models.some((m) => m.id === def) && sel.value !== def) sel.value = def;
  }

  // Làm mới model list khi status/models thay đổi
  const offModels = listen('models', () => fillModels());

  /* ----- Part helpers (OpenCode: rail + khối phẳng, không bubble) ----- */

  /**
   * Tạo một part mới trong dòng thời gian.
   * @param {'user'|'assistant'|'tool'} role
   * @param {string} label nhãn mono in hoa bên trên nội dung
   * @returns {HTMLElement} phần tử .part-body để nhét nội dung
   */
  function addPart(role, label) {
    emptyHint.classList.add('hidden');
    const part = document.createElement('div');
    part.className = 'part';
    part.dataset.role = role;
    part.innerHTML =
      '<div class="part-rail"><span class="part-mark"></span><span class="part-bar"></span></div>' +
      `<div class="part-body"><div class="part-label">${label}</div></div>`;
    inner.appendChild(part);
    return part.querySelector('.part-body');
  }

  /** Nhãn vai trò: USER · ASSISTANT + tên model · TOOL. */
  function roleLabel(role, extra) {
    const name = role === 'user' ? 'User' : role === 'tool' ? 'Tool' : 'Assistant';
    return `${esc(name)}${extra ? `<span class="pl-model">${esc(extra)}</span>` : ''}`;
  }

  function nearBottom() {
    return scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight < 90;
  }
  function stick(force) {
    if (force || nearBottom()) scrollBox.scrollTop = scrollBox.scrollHeight;
  }

  function updateSendState() {
    sendBtn.disabled = busy || !input.value.trim();
  }

  /* ----- Auto-grow textarea 1–4 dòng ----- */
  function grow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }
  input.addEventListener('input', () => { grow(); updateSendState(); });

  /* ----- Enter gửi, Shift+Enter xuống dòng ----- */
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  /* ----- Gửi tin nhắn + stream typewriter (markdown throttle) ----- */
  async function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    grow();
    updateSendState();

    messages.push({ role: 'user', content: text });
    const userBody = addPart('user', roleLabel('user'));
    const userText = document.createElement('div');
    userText.className = 'part-text';
    userText.textContent = text; // user: plain text an toàn
    userBody.appendChild(userText);
    stick(true);

    busy = true;
    updateSendState();

    const model = $('chat-model').value;
    const body = addPart('assistant', roleLabel('assistant', model));
    const bubble = document.createElement('div');
    bubble.className = 'part-text md';
    body.appendChild(bubble);

    // Con trỏ nháy — được nhét vào cuối phần tử chứa text mới nhất mỗi lần paint
    const cursor = document.createElement('span');
    cursor.className = 'cursor';

    let raw = '';
    let lastPaint = 0;
    let pendTimer = null;

    /** Vẽ raw text dưới dạng markdown; final=true → không gắn cursor. */
    function paint(final) {
      bubble.innerHTML = renderMarkdown(raw);
      if (!final && raw) {
        const hosts = bubble.querySelectorAll('p, li, h1, h2, h3, h4, blockquote, td, th, pre code');
        (hosts.length ? hosts[hosts.length - 1] : bubble).appendChild(cursor);
      }
      stick();
    }

    try {
      const content = await chatCompletion({
        model,
        messages: [...messages], // chưa gồm assistant placeholder
        onDelta: (delta) => {
          raw += delta;
          const now = performance.now();
          if (now - lastPaint >= REPAINT_MS) {
            lastPaint = now;
            paint(false); // re-render throttle theo timestamp
          } else if (!pendTimer) {
            pendTimer = setTimeout(() => { pendTimer = null; lastPaint = performance.now(); paint(false); }, REPAINT_MS);
          }
          stick();
        },
      });
      raw = content || raw;
      paint(true); // render lần cuối — không cursor
      messages.push({ role: 'assistant', content: raw });
    } catch (err) {
      if (!(err && err.name === 'AbortError')) {
        bubble.classList.add('error'); // khối lỗi: markdown đã có + dòng lỗi plain
        bubble.innerHTML = renderMarkdown(raw) +
          `<p class="err-line">Lỗi: ${esc(err.message)}</p>`;
      }
    } finally {
      clearTimeout(pendTimer);
      cursor.remove();
      busy = false;
      updateSendState();
      stick();
    }
  }

  $('chat-bar').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });

  /* ----- Tool-call trong dòng thời gian: SSE 'mcp' → part kiểu OpenCode ----- */
  const offMcp = listen('mcp', (evt) => {
    // chỉ hiện khi có tool thật được gọi (invoke), không hiện mỗi lần connect/disconnect
    if (!evt || !evt.tool) return;
    const body = addPart('tool', roleLabel('tool'));
    const okMark = evt.ok === false ? 'blade/error' : 'blade/check';
    const block = document.createElement('div');
    block.className = 'tool-block';

    // args dạng lưới 3 cột (gạch nối · khoá · giá trị) như tool-args của OpenCode
    const args = evt.args && typeof evt.args === 'object' ? evt.args : null;
    const argRows = args
      ? Object.entries(args).slice(0, 8).map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return '<span class="ta-dash"></span>'
          + `<span class="ta-k">${esc(k)}</span>`
          + `<span class="ta-v">${esc(String(val ?? '').replace(/\s+/g, ' ')).slice(0, 160)}</span>`;
      }).join('')
      : '';

    const out = String(evt.detail ?? evt.error ?? evt.result ?? '').trim();
    block.innerHTML =
      `<div class="tool-head">${icon(okMark, 'ic-xs')}<span class="th-name">${esc(evt.tool)}</span>`
      + `<span class="th-srv">${esc(evt.id ?? evt.server ?? '')}</span>`
      + (Number.isFinite(evt.durationMs) ? `<span class="th-ms">${esc(String(evt.durationMs))}ms</span>` : '')
      + '</div>'
      + (argRows ? `<div class="tool-args">${argRows}</div>` : '')
      + `<div class="tool-body">${esc(out || '(không có output)').slice(0, 4000)}</div>`;
    body.appendChild(block);
    stick();
  });

  /* ----- New chat ----- */
  $('chat-new').addEventListener('click', () => {
    if (busy) { toast('Đang stream — đợi xong rồi new chat nhé', 'warn'); return; }
    messages = [];
    inner.querySelectorAll('.part').forEach((m) => m.remove());
    emptyHint.classList.remove('hidden');
    input.focus();
  });

  /* ---------------- boot view ---------------- */
  fillModels();
  updateSendState();
  grow();
  input.focus({ preventScroll: true });

  return () => {
    offModels();
    offMcp();
  };
}
