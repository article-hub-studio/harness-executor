/* ============================================================
   upio web — md.js: Markdown renderer zero-dependency AN TOÀN.
   Nguyên tắc: ESCAPE TRƯỚC — mọi ký tự HTML-dangerous được escape
   trước khi áp dụng format ⇒ không thể inject thẻ/attribute.
   Export: renderMarkdown(src) → chuỗi HTML khối;
           mdInline(s) → HTML inline (bold/italic/code/link/escape).
   Hỗ trợ: fenced code (có nút Copy), heading # ## ###, **bold**,
   *italic*, ~~strike~~, `code`, list gạch/ngôi sao/đánh số (lồng 1 cấp),
   blockquote >, hr ---, link CHỈ http(s) (target=_blank,
   rel=noopener noreferrer), bảng |a|b| tối thiểu, đoạn văn \n\n,
   xuống dòng đơn trong đoạn → <br>. Fence không đóng → tới hết văn bản.
   Không phụ thuộc module nào khác.
   ============================================================ */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape HTML (dùng nội bộ + export tiện cho caller ngoài). */
export function escMd(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/* ---------- inline engine (chạy trên văn bản ĐÃ escape) ---------- */

/**
 * Áp dụng format inline lên chuỗi đã escape.
 * Kỹ thuật "stash": các span đặc biệt (inline code, link) được thay bằng
 * placeholder điều khiển trước, rồi khôi phục sau — để bold/italic/strike
 * không ăn vào bên trong code/link.
 */
function inlineRuns(escaped) {
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0001`;
  };

  // 1) inline code `…` (nội dung đã escape sẵn)
  let s = escaped.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${c}</code>`));

  // 2) link [text](url) — CHỈ http/https; sai scheme → giữ nguyên văn (đã escape)
  s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (raw, text, urlEsc) => {
    const url = urlEsc.replace(/&amp;/g, '&'); // decode tạm chỉ để kiểm tra scheme
    if (!/^https?:\/\//i.test(url)) return raw;
    return keep(`<a href="${urlEsc}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  });

  // 3) bold **…** → italic *…* → strike ~~…~~
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^\n*]+)\*/g, '<em>$1</em>');
  s = s.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');

  // 4) khôi phục stash
  s = s.replace(/\u0000(\d+)\u0001/g, (_, i) => stash[Number(i)] ?? '');
  return s;
}

/** mdInline: chỉ bold/italic/code/link/escape — cho tiêu đề card, nhãn ngắn. */
export function mdInline(s) {
  return inlineRuns(escMd(s));
}

/* ---------- khối helpers ---------- */

/** Fenced code block — đúng template hợp đồng (lang + nút Copy). */
function codeBlock(lang, rawCode) {
  const l = escMd(lang);
  return (
    `<div class="md-code"><div class="md-code-head"><span>${l}</span>` +
    `<button class="md-copy" type="button">Copy</button></div>` +
    `<pre><code>${escMd(rawCode)}</code></pre></div>`
  );
}

/** Tách ô bảng từ dòng "| a | b |". */
function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

const isSepCell = (c) => /^:?-{2,}:?$/.test(c);

/* ---------- block parser ---------- */

/**
 * renderMarkdown(src) → HTML string an toàn (escape-first).
 * Output KHÔNG chứa xuống dòng trần giữa các khối (an toàn khi nhét vào
 * container có white-space: pre-wrap).
 */
export function renderMarkdown(src) {
  const text = String(src ?? '').replace(/[\u0000\u0001]/g, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const out = [];
  const para = [];
  let i = 0;

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map((l) => inlineRuns(escMd(l))).join('<br>')}</p>`);
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    /* ----- fenced code ----- */
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      flushPara();
      const lang = fence[1].trim();
      i++;
      const buf = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++; // bỏ dòng đóng fence (nếu có — không đóng ⇒ hết văn bản)
      out.push(codeBlock(lang, buf.join('\n')));
      continue;
    }

    /* ----- heading # ## ### ----- */
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flushPara();
      const lv = Math.min(h[1].length, 3);
      out.push(`<h${lv}>${inlineRuns(escMd(h[2]))}</h${lv}>`);
      i++;
      continue;
    }

    /* ----- hr --- *** ___ ----- */
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      out.push('<hr class="md-hr">');
      i++;
      continue;
    }

    /* ----- blockquote > (đệ quy nội dung) ----- */
    if (/^\s*>/.test(line)) {
      flushPara();
      const inner = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(inner.join('\n'))}</blockquote>`);
      continue;
    }

    /* ----- bảng | a | b | (header + separator + hàng) ----- */
    if (
      /^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]) &&
      splitRow(lines[i + 1]).every(isSepCell) && splitRow(lines[i + 1]).length > 0
    ) {
      flushPara();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      out.push(
        `<table class="md-table"><thead><tr>` +
        head.map((c) => `<th>${inlineRuns(escMd(c))}</th>`).join('') +
        `</tr></thead>` +
        (rows.length
          ? `<tbody>${rows.map((r) =>
              `<tr>${head.map((_, ci) => `<td>${inlineRuns(escMd(r[ci] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody>`
          : '') +
        `</table>`,
      );
      continue;
    }

    /* ----- danh sách - / * / 1. (lồng 1 cấp theo indent ≥ 2 space) ----- */
    const asItem = (l) => l.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (asItem(line)) {
      flushPara();
      const items = [];
      while (i < lines.length) {
        const m = asItem(lines[i]);
        if (!m) break;
        const ordered = /\d/.test(m[2]);
        if (m[1].length >= 2 && items.length) {
          items[items.length - 1].children.push({ ordered, text: m[3], children: [] });
        } else {
          items.push({ ordered, text: m[3], children: [] });
        }
        i++;
      }
      const renderItems = (arr, tag) =>
        `<${tag}>${arr.map((it) =>
          `<li>${inlineRuns(escMd(it.text))}${(it.children || []).length ? renderItems(it.children, it.children[0].ordered ? 'ol' : 'ul') : ''}</li>`,
        ).join('')}</${tag}>`;
      out.push(renderItems(items, items[0].ordered ? 'ol' : 'ul'));
      continue;
    }

    /* ----- đoạn văn / dòng trắng ----- */
    if (line.trim() === '') { flushPara(); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join('');
}

/* ---------- demo CLI nhỏ ---------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  const demo = [
    '# Demo', '',
    'Đoạn **bold**, *italic*, ~~xóa~~, `code`, link [upio](https://upio.dev).', '',
    '- một', '  - con', '- hai', '', '```js',
    'console.log("<script>")', '```', '',
    '| a | b |', '|---|---|', '| 1 | 2 |', '',
    '> trích dẫn', '', '---',
  ].join('\n');
  console.log(renderMarkdown(demo));
}
