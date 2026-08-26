// builtin-servers/handlers/db.js — họ op `db.*`: SQL/tables/explain/backup mô phỏng.
import { int, float, pick, picks, chance, hex, agoMs, isoAgo, clamp, str, word, titleCase, numOr } from '../util.js';

const TABLE_COLS = {
  users: ['id', 'name', 'email', 'created_at', 'is_active'],
  orders: ['id', 'user_id', 'total', 'status', 'created_at'],
  products: ['id', 'name', 'price', 'stock', 'category'],
  events: ['id', 'type', 'payload', 'occurred_at'],
  sessions: ['id', 'user_id', 'started_at', 'expires_at'],
  invoices: ['id', 'order_id', 'amount_usd', 'issued_at'],
  teams: ['id', 'name', 'plan', 'member_count'],
  audit_log: ['id', 'actor', 'action', 'target', 'logged_at'],
};

/** Parse SELECT rất nhẹ: trả { cols, table } — không bao giờ throw. */
function parseSql(sql) {
  const m = /select\s+(.+?)\s+from\s+([a-zA-Z_][\w.]*)/i.exec(String(sql || ''));
  if (!m) return { cols: null, table: null };
  let cols = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  if (!cols.length || cols.includes('*')) cols = null;
  if (cols && (cols.length > 8 || cols.some((c) => /[^\w.]/.test(c)))) cols = null;
  return { cols, table: m[2].includes('.') ? m[2].split('.').pop() : m[2] };
}

function valueFor(r, col) {
  const c = col.toLowerCase();
  if (/^id$|_id$/.test(c)) return int(r, 1, 9999);
  if (c === 'email') return `${word(r)}.${word(r)}@${pick(r, ['example.com', 'upio.io', 'mail.test'])}`;
  if (/^is_|^has_|active$/.test(c)) return chance(r, 0.7);
  if (c === 'status') return pick(r, ['active', 'pending', 'shipped', 'archived']);
  if (/price|total|amount|cost/.test(c)) return float(r, 5, 950);
  if (/stock|count|qty|quantity/.test(c)) return int(r, 0, 480);
  if (/payload/.test(c)) return `{"event":"${word(r)}","v":${int(r, 1, 99)}}`;
  if (/actor$|^user$/.test(c)) return '@' + word(r);
  if (/_at$|_date$|^date$/.test(c)) return isoAgo(r, 180);
  if (/name|title|category|plan|action|type/.test(c)) return titleCase(r, int(r, 1, 2));
  return word(r);
}

export default {
  async query(args, r) {
    const sql = str(args.sql, 'SELECT id, name, created_at FROM events');
    const { cols, table } = parseSql(sql);
    const columns = cols ?? TABLE_COLS[String(table || '').toLowerCase()] ?? ['id', 'name', 'created_at'];
    const rowCount = clamp(int(r, 4, 12), 1, 20);
    const rows = Array.from({ length: rowCount }, () => {
      const row = {};
      for (const col of columns) row[col] = valueFor(r, col);
      return row;
    });
    return { sql, table: table ?? 'result_set', columns, rows, rowCount: rows.length, ms: int(r, 1, 35) };
  },

  async insert_row(args, r) {
    const table = str(args.table, 'rows');
    const row = args.row && typeof args.row === 'object' ? args.row : {};
    return {
      table,
      insertedId: int(r, 1000, 99_999),
      affected: 1,
      receivedColumns: Object.keys(row),
      ms: int(r, 1, 9),
    };
  },

  async list_tables(args, r) {
    const database = str(args.database, 'postgres/main');
    const names = picks(r, Object.keys(TABLE_COLS), int(r, 4, 8));
    const tables = names.map((name) => ({
      name,
      rows: int(r, 120, 1_900_000),
      sizeBytes: int(r, 24_000, 4_200_000_000),
    }));
    return { database, tables, total: tables.length };
  },

  async describe_table(args, r) {
    const table = str(args.table, 'orders');
    const names = TABLE_COLS[table.toLowerCase().replace(/s$/, '')] ??
      TABLE_COLS[table.toLowerCase()] ??
      ['id', 'name', 'value', 'updated_at'];
    const columns = names.map((name, i) => ({
      name,
      type: /^id$|_id$/.test(name) ? 'bigint' : /_at$|date/.test(name) ? 'timestamp'
        : /price|amount|total/.test(name) ? 'numeric(12,2)' : /^is_|active/.test(name) ? 'boolean' : 'varchar(255)',
      nullable: i > 0 && chance(r, 0.3),
      key: /^id$/.test(name) ? 'PRI' : /_id$/.test(name) ? 'MUL' : null,
      default: null,
    }));
    return { table, columns, primaryKey: columns[0]?.name ?? null, rowCount: int(r, 1000, 900_000) };
  },

  async explain_query(args, r) {
    const sql = str(args.sql, 'SELECT * FROM orders');
    const { table } = parseSql(sql);
    const t = table ?? 'orders';
    const plan = [
      { step: `Seq Scan on ${t}`, detail: `cost=0.00..${float(r, 120, 9800)} rows=${int(r, 10, 90_000)} width=${int(r, 24, 220)}` },
      { step: 'Filter', detail: `(${pick(r, ["status = 'active'", 'created_at > now() - interval \'30 days\''])})` },
    ];
    if (chance(r, 0.5)) plan.push({ step: 'Sort', detail: `${t}.${pick(r, ['created_at', 'total'])} DESC` });
    plan.push({ step: 'Limit', detail: `rows=${int(r, 10, 500)}` });
    return { sql, plan, estimatedRows: int(r, 12, 80_000), executionTimeMs: float(r, 0.08, 42, 2) };
  },

  async backup(args, r) {
    const database = str(args.database, 'main');
    const slug = database.replace(/[^\w-]+/g, '-').toLowerCase();
    const day = new Date(agoMs(r, 3)).toISOString().slice(0, 10);
    return {
      database,
      file: `backups/${slug}-${day}.sql.gz`,
      tables: int(r, 4, 40),
      bytes: int(r, 1_000_000, 8_000_000_000),
      durationSec: float(r, 1.2, 240, 1),
      checksum: hex(r, 16),
      status: 'completed',
    };
  },
};
