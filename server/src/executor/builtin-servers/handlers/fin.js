// builtin-servers/handlers/fin.js — họ op `fin.*`: quote/fx/portfolio/expense (thị trường mô phỏng).
import { int, float, pick, picks, hex, agoMs, clamp, str, word, numOr } from '../util.js';
import { fnv1a } from '../util.js';

/** Bảng dải giá "hợp lý" theo mã — giúp giá quanh mức quen thuộc thay vì ngẫu nhiên trần trụi. */
const BANDS = [
  [/^(AAPL|MSFT|GOOGL|AMZN|META|NVDA|TSLA)$/, [110, 520], 'USD', 2],
  [/^(SPY|QQQ|VOO)$/, [430, 610], 'USD', 2],
  [/^(BTC)$/, [42_000, 74_000], 'USD', 2],
  [/^(ETH)$/, [2100, 4300], 'USD', 2],
  [/^(SOL|BNB|ADA)$/, [60, 640], 'USD', 2],
  [/^EURUSD$/, [1.03, 1.12], 'USD', 4],
  [/^GBPUSD$/, [1.2, 1.32], 'USD', 4],
  [/^USDJPY$/, [138, 162], 'JPY', 2],
  [/^USDVND$/, [24_000, 25_500], 'VND', 0],
];

const HIGH_UNIT_CCY = new Set(['VND', 'IDR', 'KRW', 'JPY']);
const KNOWN_FX = {
  'USD/EUR': 0.92, 'EUR/USD': 1.09, 'USD/GBP': 0.79, 'GBP/USD': 1.27,
  'USD/JPY': 151.2, 'JPY/USD': 0.0066, 'USD/VND': 24_750, 'VND/USD': 0.00004,
  'EUR/VND': 27_000, 'USD/CNY': 7.24,
};

const EXPENSE_RULES = [
  [/uber|lyft|grab|taxi|fuel|gasoline|xang/i, 'Transport'],
  [/coffee|restaurant|lunch|dinner|food|pizza|ca phe/i, 'Food & Drink'],
  [/rent|mortgage|thue nha/i, 'Housing'],
  [/netflix|spotify|subscription|movie/i, 'Entertainment'],
  [/electric|water bill|internet|utility|dien nuoc/i, 'Utilities'],
  [/salary|payroll|bonus|luong/i, 'Income'],
  [/hotel|flight|airbnb|train|ve may bay/i, 'Travel'],
  [/amazon|shopping|store|market/i, 'Shopping'],
];
const FALLBACK_CATEGORIES = ['Groceries', 'Health', 'Education', 'Other'];

export default {
  async quote(args, r) {
    const symbol = str(args.symbol ?? args.ticker, 'AAPL').toUpperCase();
    let band = null;
    for (const [re, range, currency, dp] of BANDS) {
      if (re.test(symbol)) { band = { range, currency, dp }; break; }
    }
    if (!band) {
      // fallback: equity giả lập quanh mức hash-stable 12–850
      const anchor = 12 + (fnv1a(symbol) % 838);
      band = { range: [anchor * 0.9, anchor * 1.1], currency: 'USD', dp: 2 };
    }
    const price = float(r, band.range[0], band.range[1], band.dp);
    return {
      symbol,
      price,
      changePercent: float(r, -4.2, 4.2),
      currency: band.currency,
      dayLow: Number((price * (1 - float(r, 0.002, 0.02))).toFixed(band.dp)),
      dayHigh: Number((price * (1 + float(r, 0.002, 0.02))).toFixed(band.dp)),
      volume: int(r, 120_000, 88_000_000),
      marketState: pick(r, ['open', 'open', 'closed', 'pre-market']),
      asOfMs: agoMs(r, 0.02),
    };
  },

  async fx_rate(args, r) {
    const from = str(args.from ?? args.base, 'USD').toUpperCase();
    const to = str(args.to ?? args.quote, 'EUR').toUpperCase();
    const pairKey = `${from}/${to}`;
    let rate;
    if (KNOWN_FX[pairKey] != null) {
      rate = KNOWN_FX[pairKey] * float(r, 0.985, 1.015, 4);
    } else if (HIGH_UNIT_CCY.has(to)) {
      rate = float(r, 900, 28_000, 2);
    } else if (HIGH_UNIT_CCY.has(from)) {
      rate = float(r, 0.00002, 0.001, 8);
    } else {
      rate = float(r, 0.4, 4, 4);
    }
    const amount = clamp(numOr(args.amount, 1), 0, 1e9);
    return {
      from,
      to,
      rate: Number(rate.toFixed(rate >= 100 ? 2 : rate <= 0.001 ? 8 : 4)),
      amount,
      converted: Number((rate * amount).toFixed(rate * amount >= 100 ? 0 : 2)),
      inverseRate: Number((1 / rate).toPrecision(6)),
      asOfMs: agoMs(r, 2),
      source: 'ecb-sim',
    };
  },

  async portfolio_summary(args, r) {
    const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'SPY', 'BTC', 'ETH'];
    const positions = picks(r, SYMBOLS, int(r, 3, 6)).map((symbol) => {
      const qty = int(r, 1, 400);
      const avgCost = float(r, 20, 480);
      const price = Number((avgCost * float(r, 0.75, 1.55)).toFixed(2));
      return {
        symbol,
        qty,
        avgCost,
        price,
        valueUsd: Number((qty * price).toFixed(2)),
        plPercent: Number((((price - avgCost) / avgCost) * 100).toFixed(2)),
      };
    });
    const cashUsd = float(r, 200, 25_000);
    const totalValueUsd = Number((positions.reduce((s, p) => s + p.valueUsd, 0) + cashUsd).toFixed(2));
    return {
      account: str(args.account ?? args.portfolio, 'main'),
      currency: 'USD',
      positions,
      cashUsd: Number(cashUsd.toFixed(2)),
      totalValueUsd,
      dayChangePercent: float(r, -3.4, 3.4),
      asOfMs: agoMs(r, 0.02),
    };
  },

  async expense_categorize(args, r) {
    const raw = Array.isArray(args.transactions) && args.transactions.length
      ? args.transactions
      : ['coffee at roastery', 'uber ride downtown', 'monthly rent', 'spotify subscription', 'grocery store run'];
    const totals = new Map();
    let uncategorized = 0;
    for (const item of raw.slice(0, 200)) {
      const memo = typeof item === 'string' ? item
        : typeof item === 'object' && item !== null ? String(item.memo ?? item.description ?? item.name ?? '') : String(item);
      const category = EXPENSE_RULES.find(([re]) => re.test(memo))?.[1] ?? pick(r, FALLBACK_CATEGORIES);
      if (!EXPENSE_RULES.some(([re]) => re.test(memo))) uncategorized += 1;
      const amount = typeof item === 'object' && item !== null && Number.isFinite(Number(item.amount))
        ? Math.abs(Number(item.amount))
        : float(r, 3, 180);
      const agg = totals.get(category) ?? { category, totalUsd: 0, count: 0 };
      agg.totalUsd = Number((agg.totalUsd + amount).toFixed(2));
      agg.count += 1;
      totals.set(category, agg);
    }
    const categories = [...totals.values()].sort((a, b) => b.totalUsd - a.totalUsd);
    return {
      processed: raw.length,
      categories,
      uncategorized,
      topCategory: categories[0]?.category ?? null,
      period: 'statement-current',
    };
  },
};
