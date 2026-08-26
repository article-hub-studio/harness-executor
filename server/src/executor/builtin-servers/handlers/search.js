// builtin-servers/handlers/search.js — họ op `search.*`: web/images/news/semantic/trends.
import { int, float, pick, picks, chance, hex, agoMs, clamp, str, word, titleCase, cap } from '../util.js';

const DOMAINS = [
  'docs.example.dev', 'blog.upio.io', 'news.daily.test', 'wiki.knowledge.net',
  'forum.community.org', 'guides.howto.dev', 'research.papers.ai', 'changelog.software.run',
];
const NEWS_SOURCES = ['TechDaily', 'The Signal', 'DevWire', 'Global Post', 'Upio Times'];
const ANGLES = ['explained simply', '— practical guide', 'in production', 'what changed in 2026',
  'for busy engineers', ': patterns and pitfalls'];

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'query';
}

export default {
  async web(args, r) {
    const query = str(args.query, 'deterministic simulation');
    const n = clamp(int(r, 5, 8), 1, 8);
    const results = [];
    for (let i = 0; i < n; i++) {
      results.push({
        title: `${cap(query)} ${pick(r, ANGLES)}`,
        url: `https://${pick(r, DOMAINS)}/${slugify(query)}-${hex(r, 4)}`,
        snippet:
          `${cap(query)} được trình bày qua ${int(r, 3, 9)} ví dụ thực tế; tài liệu nhấn mạnh ` +
          `${word(r)}, ${word(r)} và các bước kiểm chứng kết quả.`,
      });
    }
    return { query, results, tookMs: int(r, 40, 700), total: results.length };
  },

  async images(args, r) {
    const query = str(args.query, 'abstract gradient');
    const results = [];
    for (let i = 0, n = clamp(int(r, 4, 8), 1, 8); i < n; i++) {
      const width = int(r, 20, 96) * 16;
      const height = int(r, 15, 68) * 16;
      results.push({
        title: `${cap(query)} ${titleCase(r, 1)}`,
        imageUrl: `https://${pick(r, DOMAINS)}/img/${hex(r, 10)}.jpg`,
        thumbUrl: `https://${pick(r, DOMAINS)}/img/${hex(r, 6)}_t.jpg`,
        width,
        height,
        alt: `${cap(word(r))} ${word(r)} illustration`,
      });
    }
    return { query, results, total: results.length };
  },

  async news(args, r) {
    const topic = str(args.topic, str(args.query, 'technology'));
    const results = [];
    for (let i = 0, n = clamp(int(r, 4, 8), 1, 8); i < n; i++) {
      results.push({
        title: `${cap(topic)} ${pick(r, ANGLES)}`,
        source: pick(r, NEWS_SOURCES),
        url: `https://news.${word(r)}.example/${slugify(topic)}/${hex(r, 5)}`,
        publishedAtMs: agoMs(r, 7),
        snippet: `Nguồn tin cho biết ${topic} tiếp tục tăng trưởng ${int(r, 3, 28)}% quý này.`,
      });
    }
    return { topic, results, total: results.length };
  },

  async semantic(args, r) {
    const query = str(args.query, 'semantic search');
    const matches = [];
    let score = float(r, 0.88, 0.95, 3);
    for (let i = 0, n = clamp(int(r, 4, 6), 1, 10); i < n; i++) {
      matches.push({
        id: `doc_${hex(r, 6)}`,
        score,
        text: `Đoạn văn khớp ngữ nghĩa với "${query}": đề cập ${word(r)}, ${word(r)} và đánh giá ${word(r)}.`,
      });
      score = Number(Math.max(0.32, score - (0.07 + r() * 0.06)).toFixed(3));
    }
    return { query, matches, model: 'upio-embed-sim-v1' };
  },

  async trends(args, r) {
    const keyword = str(args.keyword, 'edge computing');
    const timeline = [];
    const base = new Date(Date.UTC(2026, 0, 1));
    for (let i = 11; i >= 0; i--) {
      const d = new Date(base);
      d.setUTCMonth(d.getUTCMonth() - i);
      timeline.push({
        date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        value: int(r, 15, 100),
      });
    }
    const avgInterest = Math.round(timeline.reduce((s, p) => s + p.value, 0) / timeline.length);
    return {
      keyword,
      region: str(args.region, 'global'),
      timeline,
      avgInterest,
      relatedQueries: picks(r, [
        `${keyword} tutorial`, `${keyword} vs ${word(r)}`, `${keyword} pricing`,
        `${keyword} alternative`, `${keyword} roadmap`, `best ${keyword} tools`,
      ], 4),
    };
  },
};
