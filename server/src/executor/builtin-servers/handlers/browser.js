// builtin-servers/handlers/browser.js — họ op `browser.*`: mô phỏng headless browser.
import { int, pick, chance, hex, str, word, titleCase } from '../util.js';
import { parseUrl } from './web.js';

export default {
  async open_page(args, r) {
    const u = parseUrl(args.url);
    const consoleErrors = chance(r, 0.75)
      ? []
      : [{ level: 'error', text: `Uncaught TypeError: ${word(r)} of null at /assets/app.${hex(r, 6)}.js:1:${int(r, 100, 9000)}` }];
    return {
      url: u.href,
      title: titleCase(r, int(r, 2, 4)),
      loadMs: int(r, 120, 1800),
      elements: int(r, 40, 900),
      consoleErrors,
    };
  },

  async click(args, r) {
    const navigated = chance(r, 0.4);
    return {
      selector: str(args.selector, 'body'),
      clicked: true,
      navigated,
      newUrl: navigated ? `https://example.com/${word(r)}/${word(r)}` : null,
      ms: int(r, 15, 400),
    };
  },

  async screenshot(args, r) {
    const fullPage = Boolean(args.fullPage);
    return {
      format: 'png',
      width: 1280,
      height: fullPage ? int(r, 1600, 4200) : 720,
      bytes: int(r, 40_000, 2_400_000),
      imageRef: `screenshots/${hex(r, 10)}.png`,
      fullPage,
    };
  },

  async fill_form(args, r) {
    const fields = args.fields && typeof args.fields === 'object' ? Object.keys(args.fields) : [];
    const filled = fields.map((name) => ({
      name,
      value: /pass|secret|token|card|cvv/i.test(name) ? '••••••••' : `sim-${name}`,
    }));
    return { filled, count: filled.length, submitted: chance(r, 0.5) };
  },

  async extract_text(args, r) {
    const selector = args.selector == null ? null : str(args.selector);
    const blocks = Array.from({ length: int(r, 2, 5) }, () =>
      `${titleCase(r, int(r, 3, 6))} mô tả chi tiết về ${word(r)}, kèm số liệu ${int(r, 10, 98)}% ` +
      `và ghi chú cho phần ${word(r)}-${word(r)}.`
    );
    const text = blocks.join('\n\n');
    return { selector, blocks, text, chars: text.length };
  },
};
