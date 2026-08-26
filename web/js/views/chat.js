/* ============================================================
   upio web — view Chat: full-height giữa tab bar và header,
   bubbles user/assistant, stream typewriter qua /v1/chat/completions,
   history client-side, New chat, Enter gửi / Shift+Enter xuống dòng.
   ============================================================ */
import { chatCompletion, esc, listen, store, icon, toast } from '../app.js';

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

  const $ = (id) => el.querySelector('#' + id);
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
    if (models.some((m) => m.id === def)) sel.value = def;
  }

  // Làm mới model list khi status/models thay đổi
  const offModels = listen('models', () => fillModels());

  /* ----- Bubble helpers (dùng textContent → an toàn XSS) ----- */
  function addBubble(role) {
    emptyHint.classList.add('hidden');
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    inner.appendChild(div);
    return div;
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

  /* ----- Gửi tin nhắn + stream typewriter ----- */
  async function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    grow();
    updateSendState();

    messages.push({ role: 'user', content: text });
    addBubble('user').textContent = text;
    stick(true);

    busy = true;
    updateSendState();

    const bubble = addBubble('assistant');
    const txtNode = document.createTextNode('');
    bubble.appendChild(txtNode);
    const cursor = document.createElement('span'); // con trỏ nháy trong lúc stream
    cursor.className = 'cursor';
    bubble.appendChild(cursor);
    stick(true);

    try {
      const content = await chatCompletion({
        model: $('chat-model').value,
        messages: [...messages], // chưa gồm assistant placeholder
        onDelta: (delta) => {
          txtNode.textContent += delta; // typing effect realtime
          stick();
        },
      });
      messages.push({ role: 'assistant', content: content || txtNode.textContent });
    } catch (err) {
      if (!(err && err.name === 'AbortError')) {
        bubble.classList.add('error'); // bubble lỗi
        txtNode.textContent += (txtNode.textContent ? '\n\n' : '') + `Lỗi: ${err.message}`;
      }
    } finally {
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

  /* ----- New chat ----- */
  $('chat-new').addEventListener('click', () => {
    if (busy) { toast('Đang stream — đợi xong rồi new chat nhé', 'warn'); return; }
    messages = [];
    inner.querySelectorAll('.msg').forEach((m) => m.remove());
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
  };
}
