// modelhub.js — Model Hub: provider tùy chỉnh OpenAI-compatible + mock offline. SPEC §5.6
// Zero-dependency: chỉ dùng node: core modules.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const MOCK_ID = 'ox-local-mock';
const MOCK_LABEL = 'ox-alpha Local (mock)';
const REMOTE_TIMEOUT_MS = 8000;
const STREAM_TICK_MS = 15;

/* ============================== helpers ============================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** FNV-1a 32-bit — deterministic seed từ nội dung. */
function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.55 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Chuẩn hoá messages về [{role, content(string)}]; bỏ phần tử không hợp lệ. */
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' && m.role.trim() ? m.role : 'user';
    let content = m.content;
    if (Array.isArray(content)) {
      content = content
        .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
        .join('\n');
    }
    if (typeof content !== 'string') continue;
    out.push({ role: role.trim(), content });
  }
  return out;
}

function estimateUsage(messages, reply) {
  const promptChars = (messages || []).reduce((n, m) => n + (m.content ? m.content.length : 0), 0);
  return {
    prompt_tokens: Math.max(1, Math.ceil(promptChars / 4)),
    completion_tokens: Math.max(1, Math.ceil((reply ? reply.length : 0) / 4)),
  };
}

function defaultConfig() {
  return {
    default: MOCK_ID,
    providers: [{ id: MOCK_ID, label: MOCK_LABEL, baseUrl: '', apiKey: '', model: MOCK_ID }],
  };
}

/** Kiểm tra + chuẩn hoá config. Ném Error với thông điệp rõ nếu bất hợp lệ. */
function sanitizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('ModelHub.saveConfig: config phải là object {default?, providers}');
  }
  if (!Array.isArray(cfg.providers)) {
    throw new Error('ModelHub.saveConfig: "providers" phải là array');
  }
  const providers = [];
  const seen = new Set();
  for (const p of cfg.providers) {
    if (!p || typeof p !== 'object') {
      throw new Error('ModelHub.saveConfig: mỗi provider phải là object');
    }
    const id = typeof p.id === 'string' ? p.id.trim() : '';
    if (!id) throw new Error('ModelHub.saveConfig: provider thiếu "id" (id phải khác rỗng)');
    if (seen.has(id)) throw new Error(`ModelHub.saveConfig: provider id trùng lặp: "${id}"`);
    seen.add(id);
    providers.push({
      id,
      label: typeof p.label === 'string' && p.label.trim() ? p.label.trim() : id,
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '',
      apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
      model: typeof p.model === 'string' && p.model.trim() ? p.model.trim() : id,
    });
  }
  let def = typeof cfg.default === 'string' && cfg.default.trim() ? cfg.default.trim() : '';
  if (def && !seen.has(def)) def = '';
  if (!def) def = providers[0] ? providers[0].id : MOCK_ID;
  return { default: def, providers };
}

/* ====================== mock engine (offline, deterministic) ====================== */

const VN_DIACRITICS = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/gi;

const VI_STOPWORDS = new Set([
  'là', 'gì', 'và', 'của', 'cho', 'tôi', 'mình', 'một', 'các', 'Những', 'những', 'không', 'có',
  'được', 'để', 'trong', 'với', 'này', 'đó', 'bạn', 'thì', 'từ', 'ra', 'vào', 'hay', 'hoặc',
  'làm', 'sao', 'thế', 'nào', 'rằng', 'đi', 'nhé', 'nha', 'ạ', 'xin', 'giúp', 'hộ', 'vui',
  'lòng', 'cần', 'muốn', 'tai', 'tại',
]);
const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'how', 'why', 'who', 'when', 'where',
  'to', 'of', 'for', 'me', 'i', 'you', 'we', 'my', 'your', 'this', 'that', 'it', 'its', 'in',
  'on', 'with', 'about', 'and', 'or', 'can', 'could', 'would', 'should', 'do', 'does', 'did',
  'please', 'give', 'make', 'tell', 'need', 'want', 'be', 'am',
]);

const CATEGORIES = [
  { id: 'summary', kws: ['tóm tắt', 'tom tat', 'ngắn gọn', 'ngan gon', 'rút gọn', 'rut gon', 'summary', 'summarize', 'tldr', 'tl;dr'] },
  { id: 'plan', kws: ['plan', 'kế hoạch', 'ke hoach', 'lộ trình', 'lo trinh', 'roadmap', 'chiến lược', 'chien luoc', 'timeline', 'giai đoạn', 'giai doan'] },
  { id: 'sql', kws: ['sql', 'query', 'database', 'cơ sở dữ liệu', 'co so du lieu', 'csdl', 'postgres', 'mysql', 'sqlite', 'mongodb', 'select', 'join'] },
  { id: 'api', kws: ['api', 'rest', 'endpoint', 'graphql', 'webhook', 'microservice', 'backend', 'frontend'] },
  { id: 'code', kws: ['code', 'lập trình', 'lap trinh', 'function', 'javascript', 'typescript', 'python', 'node', 'react', 'vue', 'java ', 'bug', 'lỗi', 'loi', 'debug', 'refactor', 'hàm', 'class', 'script', 'thuật toán', 'thuat toan', 'regex', 'css', 'html', 'fibonacci'] },
];
/** Câu hỏi định nghĩa ("X là gì?", "giải thích X") → template explain ưu tiên trước keyword domain. */
const QUESTION_KWS = ['là gì', 'la gi', 'giải thích', 'giai thich', 'định nghĩa', 'dinh nghia', 'what is', 'what are', 'define'];
/** Marker explain còn lại (so sánh / lý do / cách hoạt động). */
const EXPLAIN2_KWS = ['tại sao', 'tai sao', 'why', 'how does', 'how do', 'khác nhau', 'khac nhau', 'so sánh', 'so sanh', 'difference', 'vs ', 'meaning'];

function phraseRegex(kws) {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${kws.map(escapeRe).join('|')})(?:[^\\p{L}\\p{N}]|$)`, 'iu');
}

/** Biên dịch keyword list → regex \b(...)\b (khớp cả tiếng Việt có dấu). */
function categoryRegex(kws) {
  return phraseRegex(kws);
}
const SUMMARY_RES = CATEGORIES.filter((c) => c.id === 'summary').map((c) => ({ id: c.id, re: categoryRegex(c.kws) }));
const DOMAIN_RES = CATEGORIES.filter((c) => c.id !== 'summary').map((c) => ({ id: c.id, re: categoryRegex(c.kws) }));
const QUESTION_RE = phraseRegex(QUESTION_KWS);
const EXPLAIN2_RE = phraseRegex(EXPLAIN2_KWS);

function detectLang(text) {
  const vnHits = (text.match(VN_DIACRITICS) || []).length;
  const letters = (text.match(/\p{L}/gu) || []).length || 1;
  if (letters >= 6 && vnHits / letters >= 0.05) return 'vi';
  const padded = ` ${text.toLowerCase()} `;
  let hits = 0;
  for (const w of ['la', 'gi', 'khong', 'duoc', 'minh', 'ban', 'viet', 'giup']) {
    if (padded.includes(` ${w} `)) hits++;
  }
  return hits >= 2 ? 'vi' : 'en';
}

function detectCategory(text) {
  const norm = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
  if (QUESTION_RE.test(norm)) return 'explain'; // "X là gì?/giải thích X" → giải thích khái niệm
  for (const c of SUMMARY_RES) if (c.re.test(norm)) return c.id;
  for (const c of DOMAIN_RES) if (c.re.test(norm)) return c.id;
  if (EXPLAIN2_RE.test(norm)) return 'explain';
  return 'generic';
}

/** Động từ/cụm chỉ dẫn đầu câu — không phải chủ đề, bỏ khi trích topic. */
const LEAD_INSTRUCTIONS = new Set([
  'giải thích', 'giai thich', 'tóm tắt', 'tom tat', 'phân tích', 'phan tich', 'lập', 'lap',
  'viết', 'viet', 'hãy', 'hay', 'nêu', 'liệt kê', 'liet ke', 'trình bày', 'trinh bay',
  'hướng dẫn', 'huong dan', 'xây dựng', 'xay dung', 'thiết kế', 'thiet ke', 'tạo', 'tao',
  'please', 'explain', 'write', 'describe', 'create', 'build', 'make', 'generate',
  'summarize', 'list', 'show', 'tell', 'give', 'help',
]);

function extractTopic(text, lang) {
  // Chỉ strip dấu câu ở biên token (đầu/cuối/độc lập) để giữ "Node.js", "end-to-end" nguyên vẹn.
  const cleanedRaw = text
    .replace(/(^|\s)[^\p{L}\p{N}\s]+(?=\s|$)/gu, ' ') // token toàn dấu câu
    .replace(/[^\p{L}\p{N}\s]+(?=\s|$)/gu, ' ')        // dấu câu cuối token
    .replace(/(^|\s)[^\p{L}\p{N}\s]+/gu, ' ')          // dấu câu đầu token
    .replace(/\s+/g, ' ')
    .trim();
  // Bỏ cụm động từ chỉ dẫn ở ĐẦU câu ("giải thích X...", "write a ...") — không phải chủ đề.
  const LEAD_PHRASE_RE = new RegExp(
    `^(?:${[
      'giải thích', 'giai thich', 'tóm tắt', 'tom tat', 'phân tích', 'phan tich', 'liệt kê',
      'liet ke', 'trình bày', 'trinh bay', 'hướng dẫn', 'huong dan', 'xây dựng', 'xay dung',
      'thiết kế', 'thiet ke', 'giúp tôi', 'giup toi', 'giúp mình', 'cho tôi', 'cho minh',
      'giải', 'giai', 'viết', 'viet', 'lập', 'lap', 'hãy', 'nêu', 'tạo', 'tao',
      'please', 'kindly', 'explain', 'describe', 'write', 'create', 'build', 'make',
      'generate', 'summarize',
    ].join('|')})\\s+`,
    'i',
  );
  let cleaned = cleanedRaw;
  for (let i = 0; i < 3 && LEAD_PHRASE_RE.test(cleaned); i++) cleaned = cleaned.replace(LEAD_PHRASE_RE, '');
  const words = cleaned.split(' ').filter(Boolean);
  const kept = [];
  for (const w of words) {
    const lw = w.toLowerCase();
    if (VI_STOPWORDS.has(lw) || EN_STOPWORDS.has(lw)) continue;
    if (w.length < 2 && !/\p{N}/u.test(w)) continue;
    kept.push(w);
    if (kept.length >= 12) break;
  }
  while (kept.length && LEAD_INSTRUCTIONS.has(kept[0].toLowerCase())) kept.shift();
  const topicWords = kept.slice(0, 6);
  const fallback = lang === 'vi' ? 'chủ đề của bạn' : 'your topic';
  if (!topicWords.length) return cleaned ? truncate(cleaned, 70) : fallback;
  return truncate(topicWords.join(' '), 90);
}

function analyzePrompt(text) {
  const lang = detectLang(text);
  const category = detectCategory(text);
  const topic = extractTopic(text, lang);
  const wordLen = (text.match(/\S+/g) || []).length;
  return { lang, category, topic, wordLen, charLen: text.length, seed: strHash(text) };
}

/** Tách câu dài ≥12 ký tự phục vụ template "tóm tắt". */
function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+|[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

/** Chia text thành các chunk 24–48 ký tự, cắt tại biên từ khi có thể. */
export function chunkText(text) {
  const sizes = [38, 44, 28, 46, 33, 41, 25, 47];
  const out = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    let n = sizes[k++ % sizes.length];
    let end = Math.min(i + n, text.length);
    if (end < text.length) {
      const sp = text.lastIndexOf(' ', end);
      if (sp > i + 12) end = sp + 1; // cắt sau dấu cách cho tự nhiên
    }
    if (end - i < 24 && out.length && end < text.length) end = Math.min(i + 24, text.length);
    out.push(text.slice(i, end));
    i = end;
  }
  return out.length ? out : [''];
}

/* ----- bộ template mock: mỗi ngôn ngữ × mỗi category ----- */

const TPL = {
  vi: {
    headings: { analysis: 'Phân tích', suggestions: 'Đề xuất', nextSteps: 'Bước tiếp theo', example: 'Ví dụ tham khảo', keyPoints: 'Các điểm chính', planName: 'Kế hoạch đề xuất' },
    greeting: 'Chào bạn! Mình là **ox-alpha** chạy local (mock) — mọi phản hồi được sinh offline, không cần mạng.',
    closings: [
      'Nếu bạn muốn đi sâu hơn vào một phần cụ thể (code hoàn chỉnh, giải thích từng bước, hay tối ưu), cứ nói rõ nhé!',
      'Bạn cần mình triển khai chi tiết hơn phần nào thì nhắn thêm — mình sẽ xử lý tiếp ngay.',
      'Trên là khung trả lời cho yêu cầu của bạn; cần mở rộng hướng nào thì cho mình biết nhé!',
    ],
    categories: {
      explain: (c) => ({
        opening: pick([
          `Dưới đây là giải thích ngắn gọn, dễ hiểu về **${c.topic}**, kèm gợi ý để áp dụng ngay.`,
          `Câu hỏi về **${c.topic}** khá thú vị — mình sẽ trình bày từ khái niệm gốc đến cách dùng thực tế.`,
        ], c.seed),
        analysis: [
          `Khái niệm cốt lõi: **${c.topic}** nên được tiếp cận theo 3 lớp — định nghĩa, cơ chế hoạt động, và tình huống sử dụng thực tế.`,
          `Điểm thường gây nhầm lẫn: ranh giới giữa **${c.topic}** và các khái niệm lân cận; tách bạch rõ giúp hiểu sâu và nhớ lâu hơn.`,
          `Hình dung nhanh: **${c.topic}** giống một quy trình *đầu vào → xử lý → đầu ra*, trong đó từng giai đoạn đều có thể kiểm chứng độc lập.`,
        ],
        suggestions: [
          `Bắt đầu từ định nghĩa chính thức rồi mới đọc ví dụ — thứ tự này giúp ghi nhớ chắc hơn.`,
          `Tự diễn lại **${c.topic}** bằng lời của bạn trong 2–3 câu; diễn lại trôi chảy đồng nghĩa với đã hiểu.`,
          `So sánh **${c.topic}** với một thứ bạn đã quen thuộc để tạo "móc neo" tri thức.`,
        ],
        steps: [
          `Xác định bối cảnh bạn cần dùng **${c.topic}** (học tập, dự án thật, ôn phỏng vấn…).`,
          `Lấy một ví dụ nhỏ và tự làm theo, ghi lại những điểm còn mơ hồ.`,
          `Quay lại hỏi mình phần chưa rõ — kèm ví dụ cụ thể sẽ nhận được câu trả lời chính xác hơn.`,
        ],
      }),
      code: (c) => ({
        opening: pick([
          `Nhận yêu cầu về **${c.topic}** — dưới đây là phân tích bài toán và phương án triển khai cụ thể.`,
          `Với **${c.topic}**, mình đề cập cách chia nhỏ bài toán, ví dụ code khung và các bước kiểm chứng.`,
        ], c.seed),
        analysis: [
          `Bài toán **${c.topic}** nên được tách thành các hàm nhỏ, mỗi hàm một trách nhiệm — dễ test, dễ bảo trì.`,
          `Xử lý case biên trước tiên: input rỗng/null, kiểu dữ liệu sai, giá trị ngoại lệ — đa số bug đến từ đây.`,
          `Về hiệu năng: ưu tiên cấu trúc dữ liệu phù hợp (Map/Set tra cứu O(1)) thay vì vòng lặp lồng nhau O(n²).`,
        ],
        codeBlock: [
          '```js',
          `// Khung xử lý cho: ${c.topic}`,
          'function xuLyChinh(input) {',
          "  if (input == null || input === '') throw new Error('Input khong hop le');",
          '  // TODO: điền logic chính tại đây',
          '  return input;',
          '}',
          '```',
        ].join('\n'),
        suggestions: [
          `Làm bản minimal chạy được end-to-end trước, tối ưu sau — đừng refactor cái chưa tồn tại.`,
          `Viết 3–5 test case nhỏ ngay khi có bản chạy được (luôn gồm 1 case biên).`,
          `Đặt tên biến/hàm nói được mục đích; code đọc được quan trọng hơn code ngắn.`,
        ],
        steps: [
          `Dựng khung hàm như ví dụ trên và chạy thử với vài input mẫu.`,
          `Liệt kê các case biên riêng cho **${c.topic}** mà bạn đoán sẽ gặp trong thực tế.`,
          `Gửi mình đoạn code hiện tại nếu muốn review, debug hoặc tối ưu thêm.`,
        ],
      }),
      sql: (c) => ({
        opening: `Yêu cầu về **${c.topic}** thuộc nhóm truy vấn/dữ liệu — dưới đây là phân tích cùng truy vấn mẫu bạn có thể chỉnh ngay.`,
        analysis: [
          `Với **${c.topic}**, bước quan trọng nhất là chốt rõ: dữ liệu nằm ở bảng nào, quan hệ giữa chúng, và kết quả cuối cần dạng nào.`,
          `Lọc sớm (WHERE trước khi JOIN/gom nhóm) để giảm lượng dữ liệu phải xử lý downstream.`,
          `Cột xuất hiện trong WHERE/JOIN/ORDER BY là ứng viên hàng đầu để tạo index.`,
        ],
        codeBlock: [
          '```sql',
          `-- Mẫu truy vấn cho: ${c.topic}`,
          'SELECT b.id, b.ten, COUNT(c.id) AS so_luong',
          'FROM bang_chinh b',
          'LEFT JOIN bang_con c ON c.bang_chinh_id = b.id',
          "WHERE b.trang_thai = 'active'",
          'GROUP BY b.id, b.ten',
          'ORDER BY so_luong DESC',
          'LIMIT 20;',
          '```',
        ].join('\n'),
        suggestions: [
          `Chạy EXPLAIN (hoặc EXPLAIN ANALYZE) để xem kế hoạch thực thi trước khi tối ưu "theo cảm tính".`,
          `Tránh SELECT * ở production — chỉ chọn đúng cột cần dùng.`,
          `Bọc truy vấn ad-hoc trong transaction khi sửa/xoá dữ liệu thật.`,
        ],
        steps: [
          `Thay tên bảng/cột trong truy vấn mẫu bằng schema thật của bạn rồi chạy thử.`,
          `Đo thời gian chạy ban đầu làm baseline trước khi tối ưu.`,
          `Nếu kết quả lớn, thêm phân trang (LIMIT/OFFSET hoặc keyset pagination).`,
        ],
      }),
      plan: (c) => ({
        opening: `Mình đã cấu trúc yêu cầu "**${c.topic}**" thành một kế hoạch hành động rõ ràng bên dưới.`,
        analysisHeadingKey: 'planName',
        analysis: [
          `**Giai đoạn 1 — Làm rõ mục tiêu:** chốt kết quả mong đợi của "${c.topic}" trong 1 câu và định nghĩa "xong" là gì.`,
          `**Giai đoạn 2 — Chuẩn bị:** liệt kê nguồn lực cần có (thông tin, công cụ, con người) và rào cản lớn nhất cần vượt trước.`,
          `**Giai đoạn 3 — Thực thi nhịp nhỏ:** chia việc thành các mảnh hoàn thành được trong 1–2 ngày, mỗi mảnh có sản phẩm nhìn thấy được.`,
          `**Giai đoạn 4 — Kiểm tra & điều chỉnh:** đặt điểm kiểm tra cố định (hàng tuần) để đối chiếu tiến độ với mục tiêu và chỉnh lộ trình kịp thời.`,
        ],
        suggestions: [
          `Ưu tiên việc có tác động lớn nhất với công sức vừa phải trước (ma trận ưu tiên).`,
          `Đặt deadline mềm cho từng giai đoạn thay vì chỉ một deadline tổng — tránh dồn việc cuối kỳ.`,
          `Chuẩn bị sẵn phương án dự phòng cho rủi ro lớn nhất bạn nghĩ tới.`,
        ],
        steps: [
          `Viết mục tiêu theo dạng SMART cho "${c.topic}".`,
          `Liệt kê 3 việc nhỏ nhất có thể bắt đầu ngay hôm nay và gán khung giờ cho chúng.`,
          `Hẹn lịch review tiến độ lần đầu, sau đó quay lại nhờ mình soi lại kế hoạch.`,
        ],
      }),
      summary: (c, input) => {
        const sentences = splitSentences(input)
          .map((s) => truncate(s, 110))
          .filter(Boolean);
        const seen = new Set();
        const bullets = [];
        for (const s of sentences) {
          const key = s.slice(0, 28).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          bullets.push(s);
          if (bullets.length >= 4) break;
        }
        if (bullets.length < 2) {
          // fallback: trích từ khoá tần suất cao
          const freq = new Map();
          for (const w of input.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []) {
            if (VI_STOPWORDS.has(w) || EN_STOPWORDS.has(w)) continue;
            freq.set(w, (freq.get(w) || 0) + 1);
          }
          const tops = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]);
          if (tops.length) bullets.push(`Từ khoá nổi bật trong nội dung: ${tops.map((t) => `**${t}**`).join(', ')}.`);
        }
        if (!bullets.length) bullets.push(`Nội dung gửi tới quá ngắn để rút trích — chủ đề được ghi nhận là "${c.topic}".`);
        return {
          opening: `Dưới đây là bản tóm tắt nội dung bạn gửi (≈${c.wordLen} từ, ${c.charLen} ký tự):`,
          analysisHeadingKey: 'keyPoints',
          analysis: bullets,
          suggestions: [
            `Nếu bản tóm tắt còn lệch trọng tâm, cho mình biết bạn muốn nhấn khía cạnh nào (kỹ thuật, nghiệp vụ, hay hành động cần làm).`,
            `Có thể rút gọn nữa xuống 1–2 câu, hoặc mở rộng thành outline chi tiết — tùy mục đích sử dụng.`,
          ],
          steps: [
            `Xác nhận lại trọng tâm cần giữ trong bản tóm tắt.`,
            `Chọn độ dài mong muốn (1 câu / 1 đoạn / full outline).`,
            `Gửi lại văn bản gốc kèm yêu cầu chỉnh — mình sẽ làm ngay.`,
          ],
        };
      },
      api: (c) => ({
        opening: `Câu hỏi về **${c.topic}** liên quan tới thiết kế/tích hợp API — dưới đây là phân tích và ví dụ hợp đồng endpoint cụ thể.`,
        analysis: [
          `Thiết kế API cho **${c.topic}** nên bám nguyên tắc: tài nguyên danh từ rõ ràng, động từ chuẩn HTTP (GET/POST/PUT/DELETE), mã trạng thái đúng ngữ nghĩa.`,
          `Mọi endpoint cần hợp đồng vào/ra rõ ràng (schema) để client và server phát triển song song mà không hiểu lầm.`,
          `Cân nhắc sẵn phân trang, lọc, và format lỗi thống nhất ({ error }) ngay từ đầu — sửa sau rất tốn kém.`,
        ],
        codeBlock: [
          '```json',
          'POST /api/v1/items',
          '{ "name": "vi du", "tags": ["a", "b"] }',
          '',
          '200 OK',
          '{ "id": "itm_123", "createdAt": "2025-01-01T00:00:00Z" }',
          '```',
        ].join('\n'),
        suggestions: [
          `Phiên bản hoá đường dẫn (/v1/) để giữ tương thích ngược khi cấu trúc thay đổi.`,
          `Log request/response dạng cấu trúc (JSON) để debug tích hợp nhanh hơn.`,
          `Thêm rate-limit + timeout ở tầng gateway trước khi mở API ra ngoài.`,
        ],
        steps: [
          `Vẽ danh sách resource + action chính cho "${c.topic}" (một bảng CRUD đơn giản cũng đủ khởi động).`,
          `Định nghĩa schema JSON cho 1–2 endpoint quan trọng nhất.`,
          `Thử nghiệm bằng curl/Postman trước khi viết client.`,
        ],
      }),
      generic: (c) => ({
        opening: pick([
          `Mình đã đọc kỹ yêu cầu về **${c.topic}** — dưới đây là câu trả lời có cấu trúc để bạn dễ theo dõi.`,
          `Cảm ơn câu hỏi về **${c.topic}**. Mình xin trình bày ngắn gọn theo từng phần.`,
        ], c.seed),
        analysis: [
          `Nội dung chính của yêu cầu xoay quanh **${c.topic}** — mình chia thành các khía cạnh nhỏ nhất có thể xử lý riêng lẻ.`,
          `Thông tin bạn cung cấp (~${c.wordLen} từ) đủ để định hướng; những chỗ còn thiếu mình sẽ nêu ngay ở phần Đề xuất.`,
          `Cách tiếp cận an toàn: xác định mục tiêu → liệt kê các lựa chọn → chọn phương án khớp ràng buộc của bạn.`,
        ],
        suggestions: [
          `Bổ sung thêm ngữ cảnh (mục tiêu, môi trường, ràng buộc) nếu có — câu trả lời sẽ chính xác hơn đáng kể.`,
          `Nếu **${c.topic}** liên quan tới code, SQL hay API, nhắc tới từ khoá đó để mình đổi sang template chuyên biệt.`,
        ],
        steps: [
          `Cho biết bạn muốn đi sâu khía cạnh nào của **${c.topic}**.`,
          `Cung cấp thêm ví dụ hoặc dữ liệu cụ thể nếu có.`,
          `Mình sẽ triển khai chi tiết theo hướng bạn chọn ngay ở lượt sau.`,
        ],
      }),
    },
  },

  en: {
    headings: { analysis: 'Analysis', suggestions: 'Suggestions', nextSteps: 'Next steps', example: 'Example', keyPoints: 'Key points', planName: 'Proposed plan' },
    greeting: "Hi there! I'm **ox-alpha** running locally (mock) — responses are generated fully offline.",
    closings: [
      'If you want me to go deeper on any part — full implementation, a step-by-step walkthrough, or tuning — just say the word.',
      'Need more detail on a specific section? Ask away and I will expand it right away.',
      'That wraps up the structured answer; tell me which direction to push further and I will follow up.',
    ],
    categories: {
      explain: (c) => ({
        opening: pick([
          `Here is a concise, practical explanation of **${c.topic}**, with suggestions you can apply right away.`,
          `Good question about **${c.topic}** — I will walk from first principles to real-world usage.`,
        ], c.seed),
        analysis: [
          `Core idea: approach **${c.topic}** in three layers — definition, how it works, and where it is used in practice.`,
          `Common confusion: the boundary between **${c.topic}** and adjacent concepts; separating them clearly builds durable understanding.`,
          `Quick mental model: picture **${c.topic}** as a pipeline *input → processing → output* where each stage can be verified independently.`,
        ],
        suggestions: [
          `Read the formal definition before the examples — that order improves retention.`,
          `Restate **${c.topic}** in your own words in 2–3 sentences; fluent restatement means you got it.`,
          `Anchor **${c.topic}** against something you already know well.`,
        ],
        steps: [
          `Decide the context where you need **${c.topic}** (study, production project, interview prep…).`,
          `Work through one small example yourself and note anything still fuzzy.`,
          `Come back with those fuzzy points — concrete examples get sharper answers.`,
        ],
      }),
      code: (c) => ({
        opening: pick([
          `Got your request about **${c.topic}** — below is the problem breakdown and a concrete implementation sketch.`,
          `For **${c.topic}**, here is how I would decompose the problem, a starter snippet, and how to verify it.`,
        ], c.seed),
        analysis: [
          `Split **${c.topic}** into small single-responsibility functions — easier to test and maintain.`,
          `Handle edge cases first: empty/null input, wrong types, out-of-range values — most bugs live there.`,
          `Performance: prefer the right data structure (Map/Set for O(1) lookups) over nested loops.`,
        ],
        codeBlock: [
          '```js',
          `// Starter scaffold for: ${c.topic}`,
          'function processMain(input) {',
          "  if (input == null || input === '') throw new Error('invalid input');",
          '  // TODO: core logic goes here',
          '  return input;',
          '}',
          '```',
        ].join('\n'),
        suggestions: [
          `Make a minimal end-to-end version work first; optimize later.`,
          `Add 3–5 small tests as soon as it runs (include at least one edge case).`,
          `Name variables and functions after intent; readable beats clever.`,
        ],
        steps: [
          `Scaffold the function like the example and run it on sample inputs.`,
          `List the edge cases specific to **${c.topic}** you expect in production.`,
          `Send me your current code if you want a review or optimization pass.`,
        ],
      }),
      sql: (c) => ({
        opening: `Your question about **${c.topic}** is query/data shaped — below is the breakdown plus a sample query you can adapt directly.`,
        analysis: [
          `For **${c.topic}**, pin down three things first: which tables hold the data, how they relate, and the exact output shape you need.`,
          `Filter early (WHERE before JOIN/aggregation) to shrink the data volume flowing downstream.`,
          `Columns appearing in WHERE/JOIN/ORDER BY are prime candidates for indexes.`,
        ],
        codeBlock: [
          '```sql',
          `-- Sample query for: ${c.topic}`,
          'SELECT o.id, o.total, c.name',
          'FROM orders o',
          'JOIN customers c ON c.id = o.customer_id',
          "WHERE o.status = 'paid'",
          'ORDER BY o.total DESC',
          'LIMIT 20;',
          '```',
        ].join('\n'),
        suggestions: [
          `Run EXPLAIN (ANALYZE) to see the execution plan before blind optimization.`,
          `Avoid SELECT * in production — select only the columns you use.`,
          `Wrap ad-hoc UPDATE/DELETE statements in a transaction.`,
        ],
        steps: [
          `Swap in your real table/column names and run the sample query.`,
          `Record the baseline runtime before optimizing anything.`,
          `For large result sets, add pagination (LIMIT/OFFSET or keyset).`,
        ],
      }),
      plan: (c) => ({
        opening: `I structured your request "**${c.topic}**" into an actionable plan below.`,
        analysisHeadingKey: 'planName',
        analysis: [
          `**Phase 1 — Clarify the goal:** state the desired outcome of "${c.topic}" in one sentence and define what "done" means.`,
          `**Phase 2 — Prepare:** list required resources (information, tools, people) and the biggest blocker to clear first.`,
          `**Phase 3 — Execute in small slices:** break work into pieces finishable within 1–2 days, each producing something visible.`,
          `**Phase 4 — Review & adjust:** fix a recurring checkpoint (weekly) to compare progress against the goal and correct course early.`,
        ],
        suggestions: [
          `Prioritize high-impact/medium-effort items first (priority matrix).`,
          `Set soft deadlines per phase instead of one big deadline.`,
          `Prepare a fallback plan for the largest risk you can imagine.`,
        ],
        steps: [
          `Write a SMART goal statement for "${c.topic}".`,
          `List the three smallest actions you can start today and timebox them.`,
          `Schedule the first progress review, then ask me to sanity-check the plan.`,
        ],
      }),
      summary: (c, input) => {
        const sentences = splitSentences(input).map((s) => truncate(s, 110)).filter(Boolean);
        const seen = new Set();
        const bullets = [];
        for (const s of sentences) {
          const key = s.slice(0, 28).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          bullets.push(s);
          if (bullets.length >= 4) break;
        }
        if (bullets.length < 2) {
          const freq = new Map();
          for (const w of input.toLowerCase().match(/[a-z]{4,}/g) || []) {
            if (EN_STOPWORDS.has(w)) continue;
            freq.set(w, (freq.get(w) || 0) + 1);
          }
          const tops = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]);
          if (tops.length) bullets.push(`Salient keywords: ${tops.map((t) => `**${t}**`).join(', ')}.`);
        }
        if (!bullets.length) bullets.push(`The text was too short to extract — recorded topic: "${c.topic}".`);
        return {
          opening: `Here is a summary of what you sent (≈${c.wordLen} words, ${c.charLen} chars):`,
          analysisHeadingKey: 'keyPoints',
          analysis: bullets,
          suggestions: [
            `Tell me which angle to emphasize (technical, business, or action items) if this drifted off-center.`,
            `I can compress it to 1–2 sentences or expand it into a detailed outline.`,
          ],
          steps: [
            `Confirm the focus that must survive the summary.`,
            `Pick the target length (one line / one paragraph / full outline).`,
            `Resend the source text with the adjustment request and I will redo it.`,
          ],
        };
      },
      api: (c) => ({
        opening: `Your question about **${c.topic}** touches API design/integration — here is the analysis plus a concrete endpoint contract.`,
        analysis: [
          `Design APIs around **${c.topic}** with noun resources, standard HTTP verbs (GET/POST/PUT/DELETE), and semantically correct status codes.`,
          `Every endpoint needs an explicit input/output contract (schema) so client and server can evolve in parallel.`,
          `Plan pagination, filtering, and a unified error shape ({ error }) from day one — retrofitting is expensive.`,
        ],
        codeBlock: [
          '```json',
          'POST /api/v1/items',
          '{ "name": "example", "tags": ["a", "b"] }',
          '',
          '200 OK',
          '{ "id": "itm_123", "createdAt": "2025-01-01T00:00:00Z" }',
          '```',
        ].join('\n'),
        suggestions: [
          `Version the paths (/v1/) to preserve backward compatibility.`,
          `Log requests/responses as structured JSON for faster integration debugging.`,
          `Add rate limiting + timeouts at the gateway before exposing the API publicly.`,
        ],
        steps: [
          `Sketch the main resources + actions for "${c.topic}" (a simple CRUD table is enough to start).`,
          `Define JSON schemas for the one or two most critical endpoints.`,
          `Validate with curl/Postman before writing any client code.`,
        ],
      }),
      generic: (c) => ({
        opening: pick([
          `I read your request about **${c.topic}** — here is a structured answer you can follow easily.`,
          `Thanks for the question about **${c.topic}**. Here it is, section by section.`,
        ], c.seed),
        analysis: [
          `Your request centers on **${c.topic}** — I broke it into the smallest aspects that can be tackled independently.`,
          `What you sent (~${c.wordLen} words) is enough to orient the answer; gaps are flagged under Suggestions.`,
          `Safe approach: clarify the goal → enumerate options → pick the option matching your constraints.`,
        ],
        suggestions: [
          `Adding context (goal, environment, constraints) would sharpen the answer considerably.`,
          `If **${c.topic}** involves code, SQL or APIs, mention that keyword and I will switch to the specialized template.`,
        ],
        steps: [
          `Tell me which aspect of **${c.topic}** to go deep on.`,
          `Share concrete examples or data if available.`,
          `I will expand in full detail along the direction you pick.`,
        ],
      }),
    },
  },
};

/**
 * Sinh reply mock deterministic-theo-nội-dung: markdown có heading/bullet,
 * nhắc lại chủ đề người dùng, luôn có mục "Đề xuất" và "Bước tiếp theo".
 */
function buildMockReply(userText) {
  const text = typeof userText === 'string' ? userText : '';
  const ctx = analyzePrompt(text.trim());
  const tpl = TPL[ctx.lang] || TPL.en;
  const gen = tpl.categories[ctx.category] || tpl.categories.generic;
  const part = gen(ctx, text);

  const lines = [];
  lines.push(`## ${cap(ctx.topic)}`, '');

  let opening = part.opening;
  if (ctx.wordLen <= 2) opening = `${tpl.greeting}\n\n${opening}`;
  lines.push(opening, '');

  const analysisHeading = tpl.headings[part.analysisHeadingKey || 'analysis'];
  lines.push(`### ${analysisHeading}`);
  for (const b of part.analysis) lines.push(`- ${b}`);
  lines.push('');

  if (part.codeBlock) lines.push(`### ${tpl.headings.example}`, '', part.codeBlock, '');

  lines.push(`### ${tpl.headings.suggestions}`);
  for (const s of part.suggestions) lines.push(`- ${s}`);
  lines.push('');

  lines.push(`### ${tpl.headings.nextSteps}`);
  part.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('', pick(tpl.closings, ctx.seed >> 3));

  return lines.join('\n');
}

/* ============================== ModelHub ============================== */

export class ModelHub {
  /** @param {{dataDir:string}} opts — KHÔNG throw trong constructor. */
  constructor(opts = {}) {
    this.opts = opts || {};
    this.dataDir = this.opts.dataDir || path.join(process.cwd(), 'data');
    this.file = path.join(this.dataDir, 'models.json');
    this.config = defaultConfig();
    this.ready = false;
  }

  /** Đọc data/models.json; thiếu/lỗi → tạo config mặc định và ghi lại. */
  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      this.config = sanitizeConfig(JSON.parse(raw));
    } catch {
      this.config = defaultConfig();
      try {
        await this.#persist();
      } catch (e) {
        console.warn(`[modelhub] cannot persist default config: ${e.message}`);
      }
    }
    this.ready = true;
    return this.config;
  }

  getConfig() {
    return structuredClone(this.config);
  }

  /** @returns {Promise<{models:{id:string,provider:string,label:string,available:boolean}[], config:object}>} */
  async listModels() {
    const config = this.getConfig();
    const models = [];
    const mockCfg = (config.providers || []).find((p) => p.id === MOCK_ID);
    models.push({
      id: MOCK_ID,
      provider: MOCK_ID,
      label: (mockCfg && mockCfg.label) || MOCK_LABEL,
      available: true, // mock luôn available
    });
    const seen = new Set([MOCK_ID]);
    for (const p of config.providers || []) {
      if (!p || !p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      models.push({
        id: p.id,
        provider: p.id,
        label: p.label || p.id,
        available: Boolean((p.baseUrl || '').trim()), // external cần đủ baseUrl
      });
    }
    return { models, config };
  }

  /** Validate + persist. Ném Error (message rõ) nếu config bất hợp lệ. */
  async saveConfig(cfg) {
    const clean = sanitizeConfig(cfg);
    this.config = clean;
    await mkdir(this.dataDir, { recursive: true });
    await this.#persist();
    return { ok: true };
  }

  /**
   * Chat qua provider (mock hoặc OpenAI-compatible). stream=true → bơm onChunk({delta}).
   * @returns {Promise<{content:string, usage:{prompt_tokens:number, completion_tokens:number}}>}
   */
  async chat(options = {}, onChunk = () => {}) {
    const emit = typeof onChunk === 'function' ? onChunk : () => {};
    const { messages, model, temperature, stream, signal } = options || {};
    const msgs = normalizeMessages(messages);
    const provider = this.#resolveProvider(model);
    const useMock =
      !provider ||
      provider.id === MOCK_ID ||
      !(provider.baseUrl || '').trim(); // không key/baseUrl → mock
    if (useMock) return this.#mockChat(msgs, !!stream, emit);

    const ctrl = signal ? null : new AbortController();
    const timer = ctrl ? setTimeout(() => ctrl.abort(new Error('timeout')), REMOTE_TIMEOUT_MS) : null;
    try {
      return await this.#remoteChat(provider, msgs, temperature ?? 0.7, !!stream, emit, signal ?? ctrl.signal);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Chuẩn bị phản hồi cho POST /v1/chat/completions (chuẩn OpenAI).
   * stream → SSE text gom toàn bộ rồi trả 1 lần (router sẽ ghi).
   */
  async handleChatCompletion(body) {
    const jsonHeaders = { 'content-type': 'application/json' };
    try {
      if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
        return {
          status: 400,
          headers: jsonHeaders,
          body: JSON.stringify({ error: 'Invalid request: "messages" must be an array of {role, content}.' }),
        };
      }
      const msgs = normalizeMessages(body.messages);
      if (!msgs.length) {
        return {
          status: 400,
          headers: jsonHeaders,
          body: JSON.stringify({ error: 'Invalid request: "messages" is empty or contains no valid {role, content} items.' }),
        };
      }

      const model =
        typeof body.model === 'string' && body.model.trim()
          ? body.model.trim()
          : this.config.default || MOCK_ID;
      const id = `chatcmpl-mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const created = Math.floor(Date.now() / 1000);

      if (body.stream) {
        const deltas = [];
        const { usage } = await this.chat(
          { messages: msgs, model, temperature: body.temperature, stream: true },
          (c) => deltas.push(c.delta),
        );
        const frame = (delta) =>
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ delta, index: 0 }],
          })}\n\n`;
        const parts = [frame({ role: 'assistant' })];
        for (const d of deltas) parts.push(frame({ content: d }));
        parts.push('data: [DONE]\n\n');
        return {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
          body: parts.join(''),
        };
      }

      const { content, usage } = await this.chat({
        messages: msgs,
        model,
        temperature: body.temperature,
        stream: false,
      });
      return {
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage,
        }),
      };
    } catch (err) {
      return {
        status: 502,
        headers: jsonHeaders,
        body: JSON.stringify({ error: err && err.message ? err.message : String(err) }),
      };
    }
  }

  /** Ping 1 prompt nhỏ, timeout 8s (AbortController), đo latencyMs. */
  async testProvider(providerId) {
    const provider = this.#resolveProvider(providerId);
    const target = provider || { id: MOCK_ID, label: MOCK_LABEL, baseUrl: '', apiKey: '', model: MOCK_ID };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${REMOTE_TIMEOUT_MS}ms`)), REMOTE_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const { content } = await this.chat(
        { messages: [{ role: 'user', content: 'ping' }], model: target.id, stream: false, signal: ctrl.signal },
      );
      const latencyMs = Date.now() - t0;
      return {
        ok: true,
        latencyMs,
        detail: `provider "${target.id}" replied in ${latencyMs}ms (${content.length} chars)`,
      };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const msg = err && err.message ? err.message : String(err);
      return { ok: false, latencyMs, detail: `provider "${target.id}" failed: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- private ---------- */

  #resolveProvider(model) {
    const providers = (this.config && this.config.providers) || [];
    if (typeof model === 'string' && model.trim()) {
      const want = model.trim();
      const hit = providers.find((p) => p && (p.id === want || p.model === want));
      if (hit) return hit;
    }
    const defId = this.config && this.config.default;
    return (
      providers.find((p) => p && p.id === defId) ||
      providers.find((p) => p && p.id === MOCK_ID) ||
      providers[0] ||
      null
    );
  }

  async #persist() {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }

  /** Mock 'ox-local-mock': KHÔNG network, deterministic theo nội dung. */
  async #mockChat(msgs, stream, emit) {
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const lastAny = msgs.length ? msgs[msgs.length - 1] : null;
    const userText = (lastUser || lastAny || { content: '' }).content || '';
    const reply = buildMockReply(userText);

    if (stream) {
      for (const part of chunkText(reply)) {
        emit({ delta: part });
        await sleep(STREAM_TICK_MS);
      }
    }
    return { content: reply, usage: estimateUsage(msgs, reply) };
  }

  /** Provider ngoài chuẩn OpenAI: POST {baseUrl}/chat/completions, parse SSE lẫn JSON. */
  async #remoteChat(provider, msgs, temperature, stream, emit, signal) {
    const base = (provider.baseUrl || '').replace(/\/+$/, '');
    const url = `${base}/chat/completions`;
    const headers = { 'content-type': 'application/json' };
    if ((provider.apiKey || '').trim()) headers.authorization = `Bearer ${provider.apiKey}`;
    const payload = {
      model: provider.model || provider.id,
      messages: msgs,
      temperature,
      stream,
    };

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      const why = err && err.name === 'AbortError' ? 'request aborted/timeout' : (err && err.message) || String(err);
      throw new Error(`ModelHub: cannot reach provider "${provider.id}" at ${url}: ${why}`);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `ModelHub: provider "${provider.id}" returned HTTP ${resp.status} for ${url}: ${truncate(text || resp.statusText, 300)}`,
      );
    }

    if (!stream) {
      let data;
      try {
        data = JSON.parse(await resp.text());
      } catch (err) {
        throw new Error(`ModelHub: provider "${provider.id}" returned invalid JSON: ${err.message}`);
      }
      const choice = data && Array.isArray(data.choices) && data.choices[0];
      const content =
        (choice && choice.message && typeof choice.message.content === 'string' && choice.message.content) ||
        (choice && typeof choice.text === 'string' ? choice.text : '') ||
        '';
      const usage =
        data &&
        data.usage &&
        Number.isFinite(data.usage.prompt_tokens) &&
        Number.isFinite(data.usage.completion_tokens)
          ? { prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens }
          : estimateUsage(msgs, content);
      return { content, usage };
    }

    // stream: parse SSE từng dòng "data: {...}", lấy choices[0].delta.content
    // LƯU Ý: chunk là Uint8Array — Uint8Array.toString() cho chuỗi số, PHẢI dùng TextDecoder.
    let content = '';
    let done = false;
    let buffer = '';
    const decoder = new TextDecoder();
    const src = resp.body && typeof resp.body[Symbol.asyncIterator] === 'function' ? resp.body : Readable.fromWeb(resp.body);
    const consumeLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, '');
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') {
        done = true;
        return;
      }
      try {
        const json = JSON.parse(data);
        const ch = Array.isArray(json.choices) ? json.choices[0] : null;
        if (!ch) return;
        const piece =
          (ch.delta && typeof ch.delta.content === 'string' && ch.delta.content) ||
          (ch.message && typeof ch.message.content === 'string' && ch.message.content) ||
          '';
        if (piece) {
          content += piece;
          emit({ delta: piece });
        }
      } catch {
        /* bỏ qua dòng SSE không parse được */
      }
    };

    for await (const chunk of src) {
      if (done) break;
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        consumeLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        if (done) break;
      }
    }
    if (!done && buffer) consumeLine(buffer);

    return { content, usage: estimateUsage(msgs, content) };
  }
}

/* ----- demo nhỏ khi chạy trực tiếp: node server/src/modelhub/modelhub.js ----- */
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const hub = new ModelHub({ dataDir: '/tmp/upio-modelhub-demo' });
  await hub.init();
  const { models } = await hub.listModels();
  console.log('[demo] models:', models.map((m) => `${m.id}${m.available ? '' : ' (offline)'}`).join(', '));
  const r = await hub.chat({ messages: [{ role: 'user', content: 'Giải thích REST API là gì?' }] });
  console.log('--- sample mock reply ---');
  console.log(r.content);
  console.log('--- usage ---', r.usage);
}
