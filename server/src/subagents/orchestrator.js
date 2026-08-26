// orchestrator.js — AgentOrchestrator: điều phối subagent runtime plan→tool→observe→final (SPEC §5.7).
// Zero-dependency: chỉ dùng node: core modules.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** @typedef {{server:string, tool:string}} ToolRef */
/** @typedef {{i:number, thought:string, action:object|null, observation:string, at:string}} AgentStep */

const TOTAL_LIMIT_MS = 120_000; // guard tổng thời gian sống của 1 agent
const MAX_STEPS_CAP = 32;       // trần an toàn cho maxSteps
const OBS_CLIP = 600;           // observation tối đa lưu/emit
const HIST_CLIP = 400;          // mỗi dòng lịch sử trong prompt
const ANSWER_CLIP = 8_000;
const INVALID_TOOL_LIMIT = 2;   // sai whitelist quá 2 lần → ép final
const MIN_OK_CALLS_BEFORE_MOCK_FINAL = 2;

const STOP_TOKENS = new Set([
  'va', 'cac', 'cua', 'cho', 'tu', 'tren', 'voi', 'mot', 'nhung', 'la', 'de', 'di', 'ra',
  'bang', 'co', 'khong', 'va', 'and', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'with',
]);

// Đồng nghĩa VI↔EN giúp mock planner khớp từ khóa task ↔ tool name.
const PHRASE_SYNONYMS = [
  ['cơ sở dữ liệu', ' database '], ['csdl', ' database '], ['database', ' database db '],
  ['truy vấn', ' query '], ['người dùng', ' users user '], ['khách hàng', ' customer '],
  ['địa chỉ web', ' url '], ['đường dẫn', ' path '], ['tệp tin', ' file '], ['tập tin', ' file '],
  ['thư mục', ' directory dir '], ['tìm kiếm', ' search '], ['tải về', ' fetch download '],
  ['trang web', ' web page '], ['gửi thư', ' mail send '], ['thư điện tử', ' email '],
];

function nowIso() { return new Date().toISOString(); }

function clipStr(s, n) {
  const v = String(s ?? '');
  return v.length <= n ? v : v.slice(0, Math.max(0, n - 1)) + '…';
}

/** stringify an toàn (vòng lặp tham chiếu, bigint, function) */
function safeJson(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return String(v);
      if (typeof v === 'function') return '[Function]';
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Parse JSON tolerant: tìm '{' đầu tiên và cặp '}' đóng cân bằng tương ứng
 * (bỏ qua nội dung trong chuỗi). Thất bại → thử từ '{' đầu tới '}' cuối.
 */
function extractJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          const v = JSON.parse(s.slice(start, i + 1));
          return v && typeof v === 'object' ? v : null;
        } catch {
          break;
        }
      }
    }
  }
  const end = s.lastIndexOf('}');
  if (end > start) {
    try {
      const v = JSON.parse(s.slice(start, end + 1));
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Chuẩn hoá quyết định của model về {type:'tool'|'final', ...}; không hợp lệ → null */
function normalizeDecision(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const a = (parsed.action && typeof parsed.action === 'object')
    ? parsed.action
    : (typeof parsed.type === 'string' ? parsed : null);
  if (!a) return null;
  const type = String(a.type || '').toLowerCase();
  if (type === 'final') return { type: 'final', answer: a.answer ?? a.result ?? '' };
  if (type === 'tool') {
    return {
      type: 'tool',
      server: typeof a.server === 'string' ? a.server.trim() : '',
      tool: typeof a.tool === 'string' ? a.tool.trim() : '',
      args: (a.args && typeof a.args === 'object' && !Array.isArray(a.args)) ? a.args : {},
    };
  }
  return null;
}

function asciiFold(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd');
}

/** Tách task thành tokens thường hóa (kèm đồng nghĩa VI→EN) để so khớp tên tool */
function tokenize(text) {
  let s = ' ' + String(text || '').toLowerCase() + ' ';
  for (const [phrase, expansion] of PHRASE_SYNONYMS) s = s.split(phrase).join(expansion);
  s = asciiFold(s);
  const out = [];
  for (const tok of s.split(/[^a-z0-9]+/)) {
    if (tok.length < 2 || STOP_TOKENS.has(tok)) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

function slugify(text) {
  const slug = tokenize(text).slice(0, 6).join('-');
  return clipStr(slug || 'ket-qua', 48);
}

export class AgentOrchestrator extends EventEmitter {
  /** @param {{executor:object, modelHub:object}} deps */
  constructor(deps = {}) {
    super();
    this.deps = deps || {};
    /** @type {Map<string, object>} */
    this.agents = new Map();
    this._seq = 0;
  }

  /**
   * Spawn agent và chạy nền (setTimeout(0)), trả ngay.
   * @param {{task:string, name?:string, model?:string, maxSteps?:number, tools?:ToolRef[]}} spec
   * @returns {{id:string}}
   */
  spawn(spec = {}) {
    const task = clipStr(String(spec.task ?? '').trim(), 2000) || '(Nhiệm vụ trống)';
    const id = 'ag-' + randomUUID().slice(0, 8);
    const rawMax = Number.parseInt(spec.maxSteps, 10);
    const maxSteps = Number.isFinite(rawMax) ? Math.min(Math.max(rawMax, 1), MAX_STEPS_CAP) : 6;
    const tools = Array.isArray(spec.tools)
      ? spec.tools
        .filter((t) => t && typeof t.tool === 'string' && t.tool.trim())
        .map((t) => ({ server: typeof t.server === 'string' ? t.server.trim() : '', tool: t.tool.trim() }))
      : [];
    const agent = {
      id,
      name: (spec.name && String(spec.name).trim()) || 'Agent ' + id.slice(3),
      task,
      status: 'running',
      steps: [],
      answer: null,
      model: spec.model ? String(spec.model) : null,
      maxSteps,
      tools,
      createdAt: nowIso(),
      // --- multi-turn (Agent AI Workspace) ---
      /** @type {{role:'user'|'agent'|'observation', text:string, at:string}[]} */
      session: [{ role: 'user', text: task, at: nowIso() }],
      followUps: 0,
      _lastMessage: task, // yêu cầu mới nhất (followUp) — mock planner khớp từ khoá theo cái này trước
      // --- nội bộ, không serialize ---
      _seq: ++this._seq,
      _cancelled: false,
      _finished: false,
      _deadline: Date.now() + TOTAL_LIMIT_MS,
      _nextI: 1,                // số bước tiếp theo (liên tục qua các lượt followUp)
      _usedTools: new Set(),
      _okToolCalls: 0,
      _invalidHits: 0,
      _toolInfo: new Map(),     // 'server|tool' -> {description, props:[[name, schema]]}
      _serverTools: new Map(),  // server -> Set(tool)
      _infoLoaded: false,
      _cancelNotify: null,
    };
    this.agents.set(id, agent);
    setTimeout(() => { this._run(agent).catch(() => {}); }, 0);
    return { id };
  }

  /**
   * Lượt nói tiếp theo cho agent ĐÃ chạy xong (done/error): đẩy message vào session
   * và chạy lại vòng lặp nền TIẾP tục lịch sử (+4 maxSteps). Agent đang running/cancelled → throw.
   * @param {string} id @param {string} message @returns {{ok:true, id:string}}
   */
  followUp(id, message) {
    const a = this.agents.get(id);
    if (!a) throw new Error(`agent '${id}' không tồn tại`);
    if (typeof message !== 'string') throw new Error('message phải là chuỗi 1..2000 ký tự');
    const msg = clipStr(message.trim(), 2000);
    if (!msg) throw new Error('message phải là chuỗi 1..2000 ký tự');
    if (a.status === 'running') throw new Error('agent đang chạy');
    if (a.status === 'cancelled') throw new Error('đã huỷ');
    a.session.push({ role: 'user', text: msg, at: nowIso() });
    a._lastMessage = msg;
    a.status = 'running';
    a.followUps = (a.followUps ?? 0) + 1;
    a.maxSteps += 4;
    a._finished = false;
    a._cancelled = false;
    a._deadline = Date.now() + TOTAL_LIMIT_MS; // gia hạn guard thời gian cho lượt mới
    setTimeout(() => { this._run(a).catch(() => {}); }, 0);
    return { ok: true, id };
  }

  /** Đặt cờ hủy; vòng lặp kiểm giữa các bước (kể cả giữa lúc đang chờ model/invoke). */
  cancel(id) {
    const a = this.agents.get(id);
    if (!a || a._finished || a._cancelled) return false;
    a._cancelled = true;
    a.status = 'cancelled';
    if (a._cancelNotify) { try { a._cancelNotify(); } catch { /* noop */ } }
    return true;
  }

  /** Bản sao đầy đủ (kèm steps) của agent. */
  get(id) {
    const a = this.agents.get(id);
    return a ? this._serialize(a, true) : undefined;
  }

  /** Danh sách rút gọn (không steps), mới nhất trước. */
  list() {
    return [...this.agents.values()]
      .sort((x, y) => y._seq - x._seq)
      .map((a) => this._serialize(a, false));
  }

  // ------------------------------------------------------------------ vòng đời

  /** @private */
  async _run(agent) {
    try {
      for (let i = agent._nextI; i <= agent.maxSteps; i++) {
        if (agent._cancelled) { this._markCancelled(agent); return; }
        if (Date.now() > agent._deadline) {
          await this._summarizeAndFinish(agent, 'vượt giới hạn thời gian 120 giây (timeout)');
          return;
        }

        const decision = await this._decide(agent, i);
        if (agent._cancelled) { this._markCancelled(agent); return; }

        const action = decision && decision.action;
        if (!action || action.type === 'final') {
          const ans = action ? action.answer : null;
          if (typeof ans === 'string' && ans.trim()) {
            this._finishWithAnswer(agent, decision.thought, ans, i);
          } else {
            await this._summarizeAndFinish(agent, action ? 'final thiếu answer' : 'không đọc được quyết định của model');
          }
          return;
        }

        // action.type === 'tool'
        const entry = this._matchAllowedTool(agent, action);
        if (!entry) {
          agent._invalidHits += 1;
          const label = `${action.server ? action.server + '.' : ''}${action.tool}`;
          this._pushStep(
            agent, i, decision.thought, action,
            `TỪ CHỐI: công cụ "${label}" không nằm trong danh sách công cụ được cấp cho agent này.`,
          );
          if (agent._invalidHits > INVALID_TOOL_LIMIT) {
            await this._summarizeAndFinish(agent, `đề xuất công cụ ngoài phạm vi quá ${INVALID_TOOL_LIMIT} lần`);
            return;
          }
          continue;
        }

        const server = this._resolveServer(agent, action, entry);
        const observation = await this._invokeSafe(agent, server, entry.tool, action.args || {});
        if (agent._cancelled) { this._markCancelled(agent); return; }
        this._pushStep(agent, i, decision.thought, { type: 'tool', server, tool: entry.tool, args: action.args || {} }, observation);
        if (!observation.startsWith('ERROR:')) {
          agent._okToolCalls += 1;
          agent._usedTools.add(server + '|' + entry.tool);
        }
      }
      // Hết maxSteps mà chưa final → tổng hợp câu trả lời từ các observation.
      await this._summarizeAndFinish(agent);
    } catch (err) {
      if (agent._cancelled) { this._markCancelled(agent); return; }
      agent.status = 'error';
      agent.answer = `Agent gặp lỗi nội bộ: ${(err && err.message) || String(err)}`;
      agent._finished = true;
      this.emit('agent-final', { id: agent.id, answer: agent.answer, status: 'error' });
    }
  }

  /** @private Một lượt ra quyết định: model trước, mock planner fallback. */
  async _decide(agent, i) {
    const hub = this.deps.modelHub;
    let raw = null;
    if (hub && typeof hub.chat === 'function') {
      try {
        const pending = Promise.resolve(hub.chat({
          messages: [
            { role: 'system', content: this._systemPrompt(agent) },
            { role: 'user', content: this._statePrompt(agent, i) },
          ],
          model: agent.model || undefined,
        }));
        const res = await Promise.race([pending, this._cancelWait(agent)]);
        if (!agent._cancelled) raw = (res && typeof res === 'object') ? res.content : res;
      } catch {
        raw = null; // model lỗi → mock planner
      }
    }
    const parsed = typeof raw === 'string' ? extractJson(raw) : null;
    const action = parsed ? normalizeDecision(parsed) : null;
    if (action) {
      return {
        thought: typeof parsed.thought === 'string' ? parsed.thought : '',
        action,
        source: 'model',
      };
    }
    return this._mockPlan(agent, {
      rawText: typeof raw === 'string' ? raw : '',
      parsedThought: parsed && typeof parsed.thought === 'string' ? parsed.thought : null,
    });
  }

  // ------------------------------------------------------------------ prompts

  /** @private */
  _systemPrompt(agent) {
    const L = [];
    L.push('Bạn là một AI agent chạy bên trong nền tảng "upio MCP Executor", có khả năng gọi công cụ (tool) qua MCP để hoàn thành nhiệm vụ.');
    L.push('');
    L.push('## NHIỆM VỤ');
    L.push(agent.task);
    L.push('');
    L.push('## CÔNG CỤ ĐƯỢC CẤP (chỉ được dùng các công cụ này)');
    this._loadToolInfo(agent);
    if (!agent.tools.length) {
      L.push('- (không có danh sách giới hạn — hãy tự đề xuất server.tool phù hợp)');
    } else {
      for (const t of agent.tools) {
        const info = agent._toolInfo.get(t.server + '|' + t.tool);
        L.push(`- ${this._toolLabel(t)}${info && info.description ? ' — ' + clipStr(info.description, 140) : ''}`);
      }
    }
    L.push('');
    L.push('## ĐỊNH DẠNG TRẢ LỜI (bắt buộc: MỘT đối tượng JSON duy nhất, không markdown, không văn bản thừa)');
    L.push('Gọi công cụ: {"thought":"suy nghĩ ngắn gọn","action":{"type":"tool","server":"<server>","tool":"<tool>","args":{}}}');
    L.push('Kết thúc:    {"thought":"...","action":{"type":"final","answer":"câu trả lời hoàn chỉnh bằng tiếng Việt"}}');
    return L.join('\n');
  }

  /** @private Trạng thái hiện tại: bước thứ mấy + CONTEXT (8 entry cuối của session) + lịch sử (≤400 ký tự/bước). */
  _statePrompt(agent, i) {
    const hist = this._historyLines(agent);
    const L = [];
    L.push(`Trạng thái hiện tại: bước ${i}/${agent.maxSteps}.`);
    // CONTEXT: 8 entry cuối của session (user/agent/observation) — để agent biết kết quả trước
    const recent = (agent.session ?? []).slice(-8);
    if (recent.length) {
      L.push('CONTEXT — hội thoại gần nhất:');
      for (const m of recent) L.push(`- [${m.role}] ${clipStr(m.text, 200)}`);
    } else {
      L.push('Chưa có ngữ cảnh hội thoại nào.');
    }
    L.push(hist ? 'Lịch sử các bước trước:' : 'Chưa có bước nào được thực hiện.');
    if (hist) L.push(hist);
    L.push('');
    L.push(`Trả về MỘT JSON duy nhất — gọi tool tiếp theo hoặc final nếu thông tin đã đủ${i >= agent.maxSteps ? ' (đây là bước cuối, hãy cân nhắc final)' : ''}.`);
    return L.join('\n');
  }

  /** @private */
  _historyLines(agent) {
    return agent.steps
      .map((s) => clipStr(
        `Bước ${s.i} | thought: ${s.thought || '(trống)'} | action: ${safeJson(s.action)} | observation: ${s.observation || '(trống)'}`,
        HIST_CLIP,
      ))
      .join('\n');
  }

  // ------------------------------------------------------------------ mock planner

  /** @private Fallback khi modelHub.chat throw HOẶC nội dung không parse được JSON. */
  _mockPlan(agent, _ctx = {}) {
    // Lượt followUp: khớp từ khoá theo MESSAGE MỚI trước, fallback task cũ;
    // hết tool phù hợp → final "Bổ sung..." tổng hợp observation mới + cũ.
    const freshTurn = agent.followUps > 0 && agent._lastMessage && agent._lastMessage !== agent.task;
    if (freshTurn) {
      const pick = this._pickTool(agent);
      if (!pick) return this._mockFollowUpFinal(agent);
      const why = pick.matched.length
        ? `khớp từ khóa của yêu cầu bổ sung: ${pick.matched.slice(0, 3).join(', ')}`
        : 'thử công cụ còn lại trong danh sách';
      const thought = `[mock-planner] Yêu cầu bổ sung "${clipStr(agent._lastMessage, 120)}" → chọn \`${this._toolLabel(pick.entry)}\` (${why}).`;
      return {
        thought,
        action: { type: 'tool', server: pick.entry.server, tool: pick.entry.tool, args: this._mockArgs(agent, pick.entry) },
        source: 'mock',
      };
    }
    if (agent._okToolCalls >= MIN_OK_CALLS_BEFORE_MOCK_FINAL) {
      return this._mockFinal(agent, `đã gọi công cụ thành công ${agent._okToolCalls} lần, đủ dữ liệu để tổng hợp`);
    }
    const pick = this._pickTool(agent);
    if (!pick) return this._mockFinal(agent, 'không còn công cụ phù hợp với nhiệm vụ');
    const why = pick.matched.length
      ? `khớp từ khóa: ${pick.matched.slice(0, 3).join(', ')}`
      : 'không khớp từ khóa rõ ràng, thử công cụ đầu tiên còn lại trong danh sách';
    const thought = `[mock-planner] Chọn \`${this._toolLabel(pick.entry)}\` (${why}); sinh tham số suy luận từ yêu cầu.`;
    return {
      thought,
      action: { type: 'tool', server: pick.entry.server, tool: pick.entry.tool, args: this._mockArgs(agent, pick.entry) },
      source: 'mock',
    };
  }

  /** @private Chấm điểm yêu cầu hiện tại ↔ tool bằng tokens; lượt followUp thử message mới trước rồi mới tới task cũ. */
  _pickTool(agent) {
    this._loadToolInfo(agent);
    const attempt = (tokens) => {
      let best = null;
      agent.tools.forEach((entry, idx) => {
        if (agent._usedTools.has(entry.server + '|' + entry.tool)) return;
        const info = agent._toolInfo.get(entry.server + '|' + entry.tool);
        const bag = new Set(tokenize(`${entry.server} ${entry.tool.replace(/[._\-]+/g, ' ')} ${info ? info.description : ''}`));
        const matched = tokens.filter((t) => bag.has(t));
        // Cho phép fallback "công cụ đầu tiên" duy nhất khi chưa gọi tool nào.
        if (!matched.length && !(best === null && agent._okToolCalls === 0)) return;
        const score = matched.length * 10 - idx * 0.001;
        if (!best || score > best.score) best = { entry, score, matched };
      });
      return best;
    };
    const msgTokens = tokenize(agent._lastMessage ?? '');
    const taskTokens = tokenize(agent.task);
    const useMessageFirst = agent._lastMessage && agent._lastMessage !== agent.task;
    let best = attempt(useMessageFirst ? msgTokens : taskTokens);
    if (!best && useMessageFirst) best = attempt(taskTokens); // fallback task cũ
    return best;
  }

  /** @private Sinh args mẫu theo tên prop (schema nếu có, mặc định đoán từ tên tool). */
  _mockArgs(agent, entry) {
    const info = this._loadToolInfo(agent).get(entry.server + '|' + entry.tool);
    // yêu cầu mới nhất (followUp) được ưu tiên khi suy luận tham số
    const tokens = tokenize(`${agent._lastMessage ?? ''} ${agent.task}`);
    const first = tokens[0] || 'du-lieu';
    const slug = slugify(agent._lastMessage || agent.task);
    const props = (info && info.props && info.props.length) ? info.props : this._guessProps(entry.tool);
    const args = {};
    for (const pair of props) {
      const name = String(pair[0]);
      const schema = pair[1];
      const n = name.toLowerCase();
      const type = schema && typeof schema === 'object' ? String(schema.type || '') : '';
      if (n.includes('url')) { args[name] = `https://example.com/${slug}`; continue; }
      if (n.includes('path') || n.includes('filepath') || n.includes('filename')) { args[name] = '/' + first; continue; }
      if (n === 'q' || /(query|sql|prompt|text|search|input|message|content|body)/.test(n)) { args[name] = agent.task; continue; }
      if (type === 'number' || type === 'integer' || /(limit|size|count|max|min|page|top|num|port|depth)/.test(n)) { args[name] = 3; continue; }
      if (type === 'boolean' || /^(is|has|enable|strict|recursive|use)/.test(n)) { args[name] = true; continue; }
      if (type === 'array' || /(ids|items|tags|values|list)$/.test(n)) { args[name] = [first]; continue; }
      if (type === 'object') { args[name] = {}; continue; }
      args[name] = agent.task;
    }
    if (!Object.keys(args).length) args.query = agent.task;
    return args;
  }

  /** @private Không có inputSchema → đoán prop từ phần sau dấu '.' của tên tool. */
  _guessProps(toolName) {
    const short = (String(toolName).split('.').pop() || '').toLowerCase();
    if (/(url|fetch|http|download|web)/.test(short)) return [['url', { type: 'string' }]];
    if (/(path|file|read|write|dir|ls|cat)/.test(short)) return [['path', { type: 'string' }]];
    return [['query', { type: 'string' }]];
  }

  /** @private Final dạng mock: ghép câu tiếng Việt có cấu trúc từ observations. */
  _mockFinal(agent, reason) {
    return {
      thought: `[mock-planner] ${reason}; tổng hợp câu trả lời cuối từ các quan sát.`,
      action: { type: 'final', answer: this._mockFinalText(agent, reason) },
      source: 'mock',
    };
  }

  /** @private Final cho lượt followUp khi không còn tool phù hợp với yêu cầu mới. */
  _mockFollowUpFinal(agent) {
    const reason = `yêu cầu bổ sung "${clipStr(agent._lastMessage ?? '', 160)}" không còn công cụ phù hợp`;
    return {
      thought: `[mock-planner] ${reason}; tổng hợp bổ sung từ toàn bộ quan sát (mới + cũ).`,
      action: { type: 'final', answer: this._mockFinalText(agent, reason) },
      source: 'mock',
    };
  }

  /** @private */
  _mockFinalText(agent, reason) {
    const toolSteps = agent.steps.filter((s) => s.action && s.action.type === 'tool');
    const L = [];
    if (agent.followUps > 0 && agent._lastMessage && agent._lastMessage !== agent.task) {
      // lượt bổ sung: mở đầu bằng yêu cầu mới, tổng hợp observation mới + cũ
      L.push(`Bổ sung dựa trên yêu cầu "${clipStr(agent._lastMessage, 300)}":`);
      L.push('');
    }
    L.push(`Tổng kết nhiệm vụ: “${clipStr(agent.task, 300)}”.`);
    L.push('');
    L.push('Diễn tiến các bước:');
    if (toolSteps.length) {
      for (const s of toolSteps) {
        L.push(`• Bước ${s.i}: gọi \`${s.action.tool}\` → ${clipStr(s.observation || '(không có quan sát)', 200)}`);
      }
    } else {
      L.push('• Chưa có lần gọi công cụ nào (không tìm thấy công cụ phù hợp với yêu cầu).');
    }
    L.push('');
    L.push(`Kết luận: agent hoàn thành ở chế độ lập kế hoạch dự phòng (mock planner) — lý do dừng: ${reason}. Các quan sát trên là dữ liệu chính phục vụ nhiệm vụ.`);
    L.push('');
    L.push('Đề xuất tiếp theo:');
    L.push('• Kết nối thêm MCP server chuyên biệt nếu cần dữ liệu sâu hơn hoặc thao tác ghi;');
    L.push('• Chạy lại agent với model thật và tăng maxSteps để có chuỗi suy luận đầy đủ hơn;');
    L.push('• Dùng mục Chat để hỏi đáp/phân tích trực tiếp trên kết quả vừa thu được.');
    return L.join('\n');
  }

  // ------------------------------------------------------------------ helpers

  /** @private Nạp mô tả + inputSchema.properties của tools qua executor.getTools (nếu có). */
  _loadToolInfo(agent) {
    if (agent._infoLoaded) return agent._toolInfo;
    agent._infoLoaded = true;
    const ex = this.deps.executor;
    if (!ex || typeof ex.getTools !== 'function') return agent._toolInfo;
    const servers = [...new Set(agent.tools.map((t) => t.server).filter(Boolean))];
    for (const sv of servers) {
      let list = null;
      try { list = ex.getTools(sv); } catch { continue; }
      if (!Array.isArray(list)) continue;
      const set = new Set();
      for (const tl of list) {
        if (!tl || typeof tl.name !== 'string') continue;
        set.add(tl.name);
        const schemaProps = tl.inputSchema && typeof tl.inputSchema === 'object'
          && tl.inputSchema.properties && typeof tl.inputSchema.properties === 'object'
          ? Object.entries(tl.inputSchema.properties)
          : [];
        agent._toolInfo.set(sv + '|' + tl.name, {
          description: typeof tl.description === 'string' ? tl.description : '',
          props: schemaProps,
        });
      }
      agent._serverTools.set(sv, set);
    }
    return agent._toolInfo;
  }

  /** @private Kiểm tra whitelist: khi tools được cung cấp, tool phải nằm trong đó. */
  _matchAllowedTool(agent, action) {
    const toolName = String(action.tool || '').trim();
    if (!toolName) return null;
    if (!agent.tools.length) return { server: String(action.server || '').trim(), tool: toolName };
    const wantServer = String(action.server || '').trim();
    return agent.tools.find((t) => t.tool === toolName && (!wantServer || !t.server || t.server === wantServer)) || null;
  }

  /** @private Resolve server: khai báo → model đề xuất → tra getTools → rỗng. */
  _resolveServer(agent, action, entry) {
    if (entry.server) return entry.server;
    const want = String(action.server || '').trim();
    if (want) return want;
    for (const [sv, set] of agent._serverTools) {
      if (set.has(entry.tool)) return sv;
    }
    return '';
  }

  /** @private Gọi executor.invoke với ctx.source='agent'; trả observation chuỗi. */
  async _invokeSafe(agent, server, tool, args) {
    const ex = this.deps.executor;
    if (!ex || typeof ex.invoke !== 'function') return 'ERROR: executor.invoke không khả dụng.';
    try {
      const pending = Promise.resolve(ex.invoke(server, tool, args, { source: 'agent' }));
      const res = await Promise.race([pending, this._cancelWait(agent)]);
      if (agent._cancelled) return 'ERROR: (đã hủy)';
      if (!res || typeof res !== 'object') return clipStr(safeJson(res), OBS_CLIP) || 'OK';
      if (res.ok) return clipStr(safeJson(res.result !== undefined ? res.result : res), OBS_CLIP);
      return clipStr('ERROR: ' + (res.error != null ? String(res.error) : safeJson(res)), OBS_CLIP);
    } catch (err) {
      return clipStr('ERROR: ' + ((err && err.message) || String(err)), OBS_CLIP);
    }
  }

  /** @private Promise đánh thức khi cancel (để race với await dài). */
  _cancelWait(agent) {
    return new Promise((resolve) => { agent._cancelNotify = () => resolve(undefined); });
  }

  /** @private */
  _pushStep(agent, i, thought, action, observation) {
    const step = {
      i,
      thought: clipStr(thought || '', 2000),
      action: action ? safeRoundTrip(action) : null,
      observation: clipStr(observation ?? '', OBS_CLIP),
      at: nowIso(),
    };
    agent.steps.push(step);
    agent._nextI = Math.max(agent._nextI, i + 1); // đánh số liên tục qua các lượt followUp
    if (step.observation) {
      agent.session.push({ role: 'observation', text: clipStr(observation ?? '', 400), at: nowIso() });
    }
    this.emit('agent-step', {
      id: agent.id,
      i,
      thought: step.thought,
      action: step.action,
      observation: step.observation,
      progress: i / agent.maxSteps,
    });
  }

  /** @private Set answer + status 'done' + emit agent-final và bước tổng hợp. */
  _finishWithAnswer(agent, thought, answer, i) {
    const text = clipStr(String(answer ?? '').trim() || '(Agent không đưa ra câu trả lời.)', ANSWER_CLIP);
    agent.answer = text;
    this._pushStep(agent, i, clipStr(thought || 'Hoàn thành nhiệm vụ.', 500), { type: 'final', answer: text }, '');
    agent.session.push({ role: 'agent', text: text, at: nowIso() });
    agent.status = 'done';
    agent._finished = true;
    this.emit('agent-final', { id: agent.id, answer: text, status: 'done' });
  }

  /**
   * @private Tổng hợp answer khi hết maxSteps / bị ép dừng:
   * thử gọi model lần cuối ("Viết câu trả lời cuối..."), lỗi thì ghép thủ công.
   */
  async _summarizeAndFinish(agent, forcedReason = null) {
    if (agent._cancelled) { this._markCancelled(agent); return; }
    const obs = agent.steps
      .map((s) => `- Bước ${s.i} (${s.action ? s.action.type : '?'}): ${clipStr(s.observation || '(không có)', 400)}`)
      .join('\n');
    let answer = null;
    const hub = this.deps.modelHub;
    if (hub && typeof hub.chat === 'function') {
      try {
        const pending = Promise.resolve(hub.chat({
          messages: [
            { role: 'system', content: 'Bạn là bộ tổng hợp kết quả của một AI agent. Viết câu trả lời cuối bằng tiếng Việt, rõ ràng, có cấu trúc, dựa trên quan sát được cung cấp.' },
            {
              role: 'user',
              content: `Viết câu trả lời cuối cho nhiệm vụ: ${agent.task}\n\nQuan sát thu được:\n${obs || '(không có)'}\n\n${forcedReason ? `Lưu ý: agent bị dừng sớm (${forcedReason}), hãy nói rõ điều này.\n` : ''}Hãy viết câu trả lời hoàn chỉnh cho người dùng.`,
            },
          ],
          model: agent.model || undefined,
        }));
        const res = await Promise.race([pending, this._cancelWait(agent)]);
        if (agent._cancelled) { this._markCancelled(agent); return; }
        const c = (res && typeof res === 'object') ? res.content : res;
        if (typeof c === 'string' && c.trim()) answer = c.trim();
      } catch { /* model lỗi → ghép thủ công bên dưới */ }
    }
    if (!answer) answer = this._mockFinalText(agent, forcedReason || 'đã hết số bước tối đa');
    this._finishWithAnswer(
      agent,
      forcedReason
        ? `Ép kết thúc: ${forcedReason}.`
        : `Đã dùng hết ${agent.maxSteps} bước; tổng hợp câu trả lời cuối từ các quan sát.`,
      answer,
      agent._nextI,
    );
  }

  /** @private */
  _markCancelled(agent) {
    agent.status = 'cancelled';
    agent._finished = true;
  }

  /** @private */
  _serialize(a, withSteps) {
    const out = {
      id: a.id,
      name: a.name,
      task: a.task,
      status: a.status,
      answer: a.answer,
      model: a.model,
      maxSteps: a.maxSteps,
      tools: a.tools.map((t) => ({ ...t })),
      createdAt: a.createdAt,
      stepsDone: a.steps.length,
      followUps: a.followUps ?? 0,
    };
    if (withSteps) {
      out.steps = a.steps.map((s) => ({ ...s, action: s.action ? { ...s.action } : null }));
      out.session = (a.session ?? []).map((m) => ({ role: m.role, text: m.text, at: m.at }));
    }
    return out;
  }

  /** @private */
  _toolLabel(entry) {
    return entry.server ? `${entry.server}.${entry.tool}` : entry.tool;
  }
}

/** bản sao JSON-an toàn cho action lưu vào step */
function safeRoundTrip(action) {
  try { return JSON.parse(safeJson(action)); } catch { return { type: String(action && action.type) }; }
}

// --------------------------------------------------------------------- demo
const __isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (__isMain) {
  const executor = {
    invoke: async (server, tool, args) => ({ ok: true, result: { echo: args, server, tool }, meta: { mocked: true } }),
    getTools: () => [],
  };
  const modelHub = { chat: async () => ({ content: 'mình không trả lời được bằng JSON', usage: {} }) };
  const orch = new AgentOrchestrator({ executor, modelHub });
  orch.on('agent-step', (e) => console.log(`[demo] bước ${e.i}: ${e.action ? e.action.type : '?'} → ${clipStr(e.observation, 90)}`));
  const { id } = orch.spawn({
    task: 'Truy vấn cơ sở dữ liệu để liệt kê đơn hàng mới nhất',
    tools: [{ server: 'db-x', tool: 'db.query' }],
  });
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const a = orch.get(id);
      if (a && a.status !== 'running') { clearInterval(timer); resolve(undefined); }
    }, 50);
  });
  console.log(JSON.stringify(orch.get(id), null, 2));
}
