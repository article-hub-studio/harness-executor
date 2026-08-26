// builtin-servers/handlers/web.js — họ op `web.*`: fetch/markdown/links/status offline.
import { int, pick, chance, hex, agoMs, str, word, titleCase, cap } from '../util.js';

/** Parse URL an toàn — không bao giờ throw. */
export function parseUrl(raw) {
  const s = str(raw, 'https://example.com/');
  try {
    return new URL(s);
  } catch {
    try {
      return new URL('https://' + String(raw));
    } catch {
      return new URL('https://example.com/');
    }
  }
}

function contentTypeFor(u) {
  const p = u.pathname.toLowerCase();
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.pdf')) return 'application/pdf';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (p.endsWith('.txt') || p.endsWith('.log')) return 'text/plain; charset=utf-8';
  return 'text/html; charset=utf-8';
}

function slugWords(u) {
  return u.pathname.split(/[^a-z0-9]+/i).filter((w) => w.length > 2).slice(0, 4);
}

function bodyMarkdown(u, r) {
  const words = slugWords(u);
  const heading = words.length ? words.map(cap).join(' ') : titleCase(r, 2);
  return [
    `# ${heading}`,
    '',
    `Nội dung mô phỏng lấy từ **${u.host}${u.pathname || '/'}** — sinh hoàn toàn offline, không có request mạng nào được thực hiện.`,
    '',
    '## Key points',
    '',
    `- Trang nhấn mạnh vai trò của ${word(r)} trong việc chuẩn hóa dữ liệu đầu vào.`,
    `- Tài liệu liệt kê ${int(r, 3, 9)} bước cấu hình, mỗi bước đều idempotent.`,
    `- Phụ lục chứa bảng so sánh hiệu năng giữa ${word(r)} và ${word(r)}.`,
    '',
    `> Đọc thêm tại [phần tham chiếu](${u.origin}/docs/${slugWords(u).join('-') || 'index'}) — đường dẫn mô phỏng.`,
    '',
    `Cập nhật lần cuối: ${new Date(agoMs(r, 30)).toISOString().slice(0, 10)}.`,
  ].join('\n');
}

function errorBody(status, u) {
  return `# ${status} ${status === 404 ? 'Not Found' : status === 500 ? 'Internal Server Error' : 'Error'}\n\n` +
    `Simulator trả về lỗi ${status} cho ${u.host}${u.pathname} để phản ánh trạng thái seeded hiện tại.\n`;
}

export default {
  async fetch_url(args, r) {
    const u = parseUrl(args.url);
    const status = chance(r, 0.92) ? 200 : pick(r, [301, 403, 404, 500, 503]);
    return {
      url: u.href,
      status,
      contentType: status >= 400 ? 'text/html; charset=utf-8' : contentTypeFor(u),
      body: status >= 400 ? errorBody(status, u) : bodyMarkdown(u, r),
      ms: int(r, 18, 420),
    };
  },

  async to_markdown(args, r) {
    const u = parseUrl(args.url);
    const status = chance(r, 0.94) ? 200 : pick(r, [301, 404]);
    return {
      url: u.href,
      status,
      title: u.pathname.split('/').filter(Boolean).slice(-1)[0]?.replace(/[-_]/g, ' ').replace(/\.\w+$/, '') || titleCase(r, 2),
      markdown: status >= 400 ? errorBody(status, u) : bodyMarkdown(u, r),
      ms: int(r, 12, 260),
    };
  },

  async extract_links(args, r) {
    const u = parseUrl(args.url);
    const links = [];
    for (let i = 0, n = int(r, 4, 10); i < n; i++) {
      const slugs = `${word(r)}-${word(r)}`;
      links.push({ text: titleCase(r, int(r, 2, 4)), href: `${u.origin}/${slugs}` });
    }
    return { url: u.href, status: 200, links, total: links.length };
  },

  async http_request(args, r) {
    const u = parseUrl(args.url);
    const method = str(args.method, 'GET').toUpperCase();
    const STATUS = { GET: 200, HEAD: 200, POST: 201, PUT: 200, PATCH: 200, DELETE: 204 };
    const status = STATUS[method] ?? 200;
    const reqHeaders = args.headers && typeof args.headers === 'object' ? args.headers : {};
    const bodyRaw = typeof args.body === 'string' ? args.body : args.body != null ? JSON.stringify(args.body) : '';
    return {
      url: u.href,
      method,
      requestHeaders: reqHeaders,
      status,
      statusText: status === 201 ? 'Created' : status === 204 ? 'No Content' : 'OK',
      headers: {
        date: new Date(agoMs(r, 0.001)).toUTCString(),
        'content-type': contentTypeFor(u),
        server: 'upio-sim',
        'x-request-id': `req_${hex(r, 10)}`,
        'cache-control': pick(r, ['no-store', 'max-age=300', 'max-age=3600']),
      },
      bodySnippet: method === 'HEAD' || status === 204 ? '' : (bodyRaw || '{"ok":true,"simulated":true}').slice(0, 160),
      ms: int(r, 15, 380),
    };
  },

  async check_status(args, r) {
    const u = parseUrl(args.url);
    const status = chance(r, 0.9) ? 200 : pick(r, [502, 503, 500]);
    return {
      url: u.href,
      status,
      ok: status < 400,
      latencyMs: int(r, 8, 300),
      checkedAtMs: agoMs(r, 0.02),
    };
  },

  async download_file(args, r) {
    const u = parseUrl(args.url);
    const fileName = u.pathname.split('/').filter(Boolean).pop() || `download-${hex(r, 4)}.bin`;
    return {
      url: u.href,
      status: 200,
      fileName,
      dest: str(args.dest, `./downloads/${fileName}`),
      bytes: int(r, 5_000, 250_000_000),
      sha256: hex(r, 64),
      contentType: contentTypeFor(u),
      ms: int(r, 40, 900),
    };
  },
};
