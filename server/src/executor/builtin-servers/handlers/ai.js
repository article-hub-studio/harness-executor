// builtin-servers/handlers/ai.js — họ op `ai.*`: generate/summarize/translate/classify/embed/...
import { int, float, pick, chance, hex, clamp, str, word, titleCase, numOr, keywords } from '../util.js';
import { fnv1a } from '../util.js';

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function topicOf(text) {
  const kw = keywords(text, 3);
  return kw.length ? kw.join(', ') : 'yêu cầu của bạn';
}

export default {
  async generate_text(args, r) {
    const prompt = str(args.prompt, 'Write something helpful.');
    const topic = topicOf(prompt);
    const maxTokens = clamp(Math.round(numOr(args.maxTokens, 512)), 16, 8192);
    const text = [
      `Dưới đây là nội dung mô phỏng xoay quanh chủ đề: ${topic}.`,
      '',
      `1) Bối cảnh — yêu cầu "${truncate(prompt, 90)}" được xử lý hoàn toàn offline, không có lời gọi mạng nào.`,
      `2) Cách tiếp cận — văn bản sinh từ seeded PRNG nên chạy lại với cùng input sẽ cho cùng kết quả, phục vụ kiểm thử hồi quy.`,
      `3) Kết luận — với chủ đề ${topic}, simulator duy trì cấu trúc ổn định: mở đầu phản chiếu từ khóa, thân bài theo mẫu 3 điểm.`,
    ].join('\n');
    return {
      text,
      model: 'upio-sim-1',
      stopReason: 'end_turn',
      usage: {
        inputTokens: clamp(Math.round(prompt.split(/\s+/).length * 1.3), 1, maxTokens),
        outputTokens: clamp(Math.round(text.length / 3.6), 8, maxTokens),
      },
    };
  },

  async summarize(args, r) {
    const src = str(args.text, str(args.url, 'Chưa có nội dung nguồn được cung cấp.'));
    const topic = topicOf(src);
    const summary =
      `Nội dung chính xoay quanh ${topic}: tác giả lập luận rằng tính lặp lại được kiểm chứng quan trọng hơn tối ưu vi mô, ` +
      `kèm ${int(r, 2, 6)} khuyến nghị hành động.`;
    return {
      summary,
      bullets: [
        `${cap(word(r))} là yếu tố ảnh hưởng mạnh nhất đến ${topic.split(',')[0]}.`,
        `Quy trình gồm ${int(r, 3, 7)} bước, mỗi bước đều đo lường được.`,
        `Rủi ro chính nằm ở khâu ${word(r)}-${word(r)}.`,
      ],
      keywords: keywords(src, 5),
      compressionRatio: Number(Math.min(0.85, Math.max(0.02, summary.length / Math.max(1, src.length))).toFixed(2)),
    };
  },

  async translate(args, r) {
    const text = str(args.text, '');
    const targetLang = str(args.targetLang || args.to || args.lang, 'en');
    const topic = topicOf(text);
    return {
      translatedText: `[${targetLang}] Simulated translation of the provided content about ${topic}.`,
      detectedSourceLang: pick(r, ['vi', 'en']),
      targetLang,
      confidence: float(r, 0.72, 0.98),
      characters: text.length,
    };
  },

  async classify(args, r) {
    const labels = Array.isArray(args.labels) && args.labels.length
      ? args.labels.map(String)
      : ['positive', 'neutral', 'negative'];
    let weights = labels.map(() => 0.2 + r());
    const sum = weights.reduce((a, b) => a + b, 0);
    const scores = weights
      .map((w, i) => ({ label: labels[i], score: Number((w / sum).toFixed(4)) }))
      .sort((a, b) => b.score - a.score);
    return { topClass: scores[0].label, scores, textChars: String(args.text ?? '').length };
  },

  async embed(args, r) {
    const text = str(args.text ?? args.input ?? args.query, '');
    const dims = 16;
    const embedding = Array.from({ length: dims }, () => float(r, -1, 1, 3));
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    return { embedding, dims, norm: Number(norm.toFixed(3)), model: 'embed-sim-v1', inputPreview: truncate(text, 60) };
  },

  async image_gen(args, r) {
    const prompt = str(args.prompt, 'abstract landscape');
    return {
      imageRef: `gen/${hex(r, 10)}.png`,
      prompt,
      revisedPrompt: `${prompt}, styled with ${word(r)} tones and ${word(r)} lighting`,
      size: str(args.size, '1024x1024'),
      format: 'png',
      seed: fnv1a(prompt + hex(r, 6)) >>> 1,
    };
  },

  async transcribe(args, r) {
    const audioUrl = str(args.audioUrl ?? args.file ?? args.src, 'audio/interview.mp3');
    const nameWords = audioUrl.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2).slice(-2);
    const about = nameWords.join(' ') || 'cuộc trò chuyện';
    const durationSec = float(r, 8, 95, 1);
    const segments = [];
    let t = 0;
    for (let i = 0, n = int(r, 2, 4); i < n; i++) {
      const len = Number(((durationSec - t) / (n - i)).toFixed(1));
      segments.push({
        start: Number(t.toFixed(1)),
        end: Number((t + len).toFixed(1)),
        text: i === 0
          ? `Bản ghi mô phỏng đoạn đầu về ${about}.`
          : `Tiếp tục phần ${word(r)} với vài ví dụ ngắn.`,
      });
      t += len;
    }
    return {
      transcript: segments.map((s) => s.text).join(' '),
      language: str(args.lang, pick(r, ['vi', 'en'])),
      durationSec,
      segments,
    };
  },

  async rerank(args, r) {
    const query = str(args.query, 'relevance');
    const candidatesRaw = Array.isArray(args.candidates) ? args.candidates : Array.isArray(args.documents) ? args.documents : null;
    const candidates = candidatesRaw && candidatesRaw.length
      ? candidatesRaw.slice(0, 12).map((c) => (typeof c === 'string' ? truncate(c, 80) : JSON.stringify(c).slice(0, 80)))
      : [1, 2, 3, 4].map(() => `Tài liệu về ${word(r)}-${word(r)} (mẫu)`);
    let score = float(r, 0.9, 0.97, 3);
    const results = candidates.map((doc, index) => {
      const item = { index, document: doc, score };
      score = Number(Math.max(0.21, score - (0.05 + r() * 0.08)).toFixed(3));
      return item;
    });
    results.sort((a, b) => b.score - a.score);
    return { query, results, model: 'rerank-sim-v1' };
  },
};
