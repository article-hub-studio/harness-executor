// builtin-servers/handlers/etl.js — họ op `etl.*`: pipeline/profile/export/validate/diff/schedule.
import { int, float, pick, chance, hex, agoMs, aheadMs, clamp, str, word } from '../util.js';

const COLS = ['user_id', 'event_name', 'amount', 'country_code', 'created_at'];

export default {
  async run_pipeline(args, r) {
    const pipeline = str(args.pipeline ?? args.name, 'nightly-sync');
    const dryRun = Boolean(args.dryRun);
    const rowsIn = int(r, 10_000, 9_000_000);
    const dropped = Math.floor(rowsIn * float(r, 0, 0.04, 3));
    const rowsOut = rowsIn - dropped;
    return {
      runId: `etl_${hex(r, 8)}`,
      pipeline,
      status: dryRun ? 'dry-run-complete' : 'succeeded',
      dryRun,
      rowsIn,
      rowsOut,
      durationSec: float(r, 8, 1800, 1),
      stages: [
        { name: 'extract', rows: rowsIn, ms: int(r, 800, 60_000) },
        { name: 'transform', rows: rowsOut, ms: int(r, 900, 90_000) },
        { name: 'load', rows: rowsOut, ms: int(r, 300, 40_000) },
      ],
      startedAtMs: agoMs(r, 0.05),
    };
  },

  async profile_column(args, r) {
    const dataset = str(args.dataset, 'warehouse.orders');
    const column = str(args.column, 'user_id');
    const type = /id|count|qty/i.test(column) ? 'integer'
      : /amount|price|rate|score/i.test(column) ? 'float'
      : /_at$|date/i.test(column) ? 'date' : pick(r, ['string', 'string', 'boolean']);
    const totalRows = int(r, 5000, 4_000_000);
    const nullCount = Math.floor(totalRows * float(r, 0, 0.03, 3));
    const out = {
      dataset,
      column,
      type,
      distinct: int(r, 20, Math.max(21, Math.floor(totalRows * 0.7))),
      nullCount,
      nullPct: Number(((nullCount / totalRows) * 100).toFixed(3)),
      sampledRows: int(r, 10_000, totalRows),
    };
    if (type === 'integer' || type === 'float') {
      out.min = type === 'integer' ? int(r, 0, 50) : float(r, 0, 10);
      out.max = type === 'integer' ? out.min + int(r, 100, 99_999) : Number((out.min + float(r, 10, 500)).toFixed(2));
      out.mean = Number((((out.min + out.max) / 2) + float(r, -3, 3)).toFixed(3));
      out.stddev = float(r, 0.5, 240, 3);
    } else if (type === 'string') {
      out.topValues = [0, 1, 2].map(() => ({ value: word(r), count: int(r, 50, 90_000) }));
    }
    return out;
  },

  async export_csv(args, r) {
    const source = str(args.query ?? args.dataset, 'SELECT * FROM orders');
    const dest = str(args.dest, './exports/orders-export.csv');
    const rows = int(r, 100, 1_900_000);
    return {
      source,
      dest,
      file: dest.split('/').pop(),
      rows,
      bytes: rows * int(r, 32, 140),
      delimiter: ',',
      encoding: 'utf-8',
      status: 'completed',
    };
  },

  async validate_schema(args, r) {
    const dataset = str(args.dataset, 'warehouse.orders');
    const rulesTotal = int(r, 8, 14);
    const violations = chance(r, 0.72)
      ? []
      : Array.from({ length: int(r, 1, 2) }, () => ({
          field: pick(r, COLS),
          rule: pick(r, ['not_null', 'type', 'range', 'unique']),
          message: 'Giá trị vi phạm ràng buộc mô phỏng trong lượt kiểm tra này.',
        }));
    return {
      dataset,
      schemaRef: str(args.schemaRef, null),
      valid: violations.length === 0,
      rulesPassed: rulesTotal - violations.length,
      rulesTotal,
      violations,
    };
  },

  async diff_datasets(args, r) {
    const left = str(args.left, 'orders_2025_12');
    const right = str(args.right, 'orders_2026_01');
    const added = int(r, 0, 4200);
    const removed = int(r, 0, 900);
    const changed = int(r, 0, 2600);
    return {
      left,
      right,
      key: str(args.key, 'id'),
      added,
      removed,
      changed,
      unchanged: int(r, 10_000, 900_000),
      samples: [0, 1, 2].map(() => ({
        keyValue: int(r, 1, 99_999),
        leftValue: word(r),
        rightValue: word(r),
      })),
    };
  },

  async schedule_job(args, r) {
    const job = str(args.job ?? args.pipeline, 'nightly-sync');
    return {
      jobId: `job_${hex(r, 6)}`,
      job,
      cron: str(args.cron, '0 3 * * *'),
      nextRunAtMs: aheadMs(r, 1),
      status: 'scheduled',
    };
  },
};
