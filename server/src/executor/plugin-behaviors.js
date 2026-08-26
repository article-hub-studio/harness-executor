// plugin-behaviors.js — bộ behavior middleware gắn vào plugin pipeline (Task A — SA-backend2).
// Mỗi behavior: BEHAVIORS[id] = { hook:'preInvoke'|'postInvoke', label, description, fn(value, ctx) }
//   - preInvoke : value = args  → có thể trả args (đã transform) HOẶC ném Error để CHẶN call
//                 trước khi tới transport (executor bắt → short-circuit {ok:false}).
//   - postInvoke: value = res   (ToolResult) → mutate an toàn trên res rồi trả về.
// ctx = { server, tool, schema?, plugin, executor, behaviorLabel?, source? }
// Zero-dependency: chỉ node: core (ở đây không cần module nào).

/** Key nhạy cảm: mask giá trị chuỗi nằm dưới các key này. */
export const SENSITIVE_KEY_RX = /pass|secret|token|key|auth/i;
/** Email regex dùng cho redact-output. */
export const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const MASK = '•••';

// ---------------------------------------------------------------- deep helpers

/** Đi sâu mọi cấp object/array, biến đổi từng chuỗi (nhận kèm key cha nếu có). */
function mapStrings(value, fn, key = null) {
  if (typeof value === 'string') return fn(value, key);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn, k);
    return out;
  }
  return value;
}

/** Bản sao JSON an toàn; hỏng thì trả nguyên bản (không bao giờ ném). */
function deepCopy(x) {
  if (x === undefined || x === null) return x;
  try { return JSON.parse(JSON.stringify(x)); } catch { return x; }
}

/** JSON.stringify không ném (vòng lặp tham chiếu → '[Circular]'). */
function safeStringify(v) {
  try { return JSON.stringify(v) ?? String(v); } catch {
    try { return JSON.stringify(v, () => '[Circular]') ?? String(v); } catch { return String(v); }
  }
}

// ---------------------------------------------------------------- rate limit

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_CALLS = 20;

/** @type {Map<string, number[]>} bucket timestamp theo server — module-level, dọn định kỳ. */
const rateBuckets = new Map();
let rateSweeperTimer = null;

function sweepRateBuckets() {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [k, arr] of rateBuckets) {
    const alive = arr.filter((t) => t > cutoff);
    if (alive.length) rateBuckets.set(k, alive);
    else rateBuckets.delete(k);
  }
}

function ensureRateSweeper() {
  if (rateSweeperTimer) return;
  rateSweeperTimer = setInterval(sweepRateBuckets, RATE_WINDOW_MS);
  rateSweeperTimer.unref?.(); // không giữ process sống chỉ vì sweeper
}

/** @returns {boolean} true nếu được phép gọi (đã ghi nhận 1 slot), false nếu vượt hạn mức. */
function takeRateSlot(serverKey) {
  ensureRateSweeper();
  const now = Date.now();
  const key = String(serverKey ?? '*');
  const arr = (rateBuckets.get(key) ?? []).filter((t) => t > now - RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX_CALLS) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}

// ---------------------------------------------------------------- BEHAVIORS

/**
 * Map id → behavior. Executor tra cứu theo `plugin.behavior` từ data/plugins.json.
 * @type {Record<string, {hook:'preInvoke'|'postInvoke', label:string, description:string,
 *         fn:(value:any, ctx:any)=>any}>}
 */
export const BEHAVIORS = {
  // ---------------------------------------------------------- preInvoke
  'validate-required': {
    hook: 'preInvoke',
    label: 'Kiểm tra tham số bắt buộc',
    description: 'Chặn call khi thiếu tham số khai báo required trong JSON Schema của tool.',
    fn(args, ctx) {
      const required = Array.isArray(ctx?.schema?.required) ? ctx.schema.required : [];
      if (!required.length) return args;
      const src = (args && typeof args === 'object') ? args : {};
      const missing = required.filter((k) => src[k] === undefined || src[k] === null);
      if (!missing.length) return args;
      throw new Error(`[validate-required] missing required: ${missing.join(', ')}`);
    },
  },

  'defaults-fill': {
    hook: 'preInvoke',
    label: 'Tự điền giá trị mặc định',
    description: 'Điền args[k] = schema.properties[k].default khi tham số còn undefined (chỉ khi có default khai báo).',
    fn(args, ctx) {
      const props = ctx?.schema?.properties;
      if (!props || typeof props !== 'object') return args;
      const out = { ...(args && typeof args === 'object' ? args : {}) };
      for (const [k, def] of Object.entries(props)) {
        if (out[k] !== undefined) continue;
        if (def && typeof def === 'object' && !Array.isArray(def) && 'default' in def) {
          out[k] = deepCopy(def.default); // không đoán bừa kiểu — chỉ dùng default khai báo
        }
      }
      return out;
    },
  },

  'trim-strings': {
    hook: 'preInvoke',
    label: 'Chuẩn hoá chuỗi',
    description: 'Trim mọi giá trị chuỗi lồng sâu trong args.',
    fn(args) {
      return mapStrings(args ?? {}, (s) => s.trim());
    },
  },

  'rate-limit': {
    hook: 'preInvoke',
    label: 'Giới hạn tần suất',
    description: 'Tối đa 20 lần gọi/10s cho mỗi MCP server (bucket sliding-window, dọn định kỳ).',
    fn(_args, ctx) {
      if (!takeRateSlot(ctx?.server)) {
        throw new Error(`[rate-limit] ${ctx?.server ?? '?'} vượt 20 gọi/10s`);
      }
      return _args;
    },
  },

  'snapshot-args': {
    hook: 'preInvoke',
    label: 'Chụp nhanh tham số',
    description: 'Lưu executor._lastPluginSnapshot = {plugin, at, args} phục vụ debug/audit.',
    fn(args, ctx) {
      if (ctx?.executor) {
        try {
          ctx.executor._lastPluginSnapshot = {
            plugin: ctx.plugin ?? null,
            at: Date.now(),
            args: deepCopy(args ?? {}),
          };
        } catch { /* snapshot lỗi không chặn call */ }
      }
      return args;
    },
  },

  'redact-input': {
    hook: 'preInvoke',
    label: 'Che dữ liệu nhạy cảm (input)',
    description: "Mask giá trị chuỗi có KEY khớp /pass|secret|token|key|auth/i thành '•••' (đệ quy).",
    fn(args) {
      return mapStrings(args ?? {}, (s, k) => (k && SENSITIVE_KEY_RX.test(k) ? MASK : s));
    },
  },

  // ---------------------------------------------------------- postInvoke
  'redact-output': {
    hook: 'postInvoke',
    label: 'Che dữ liệu nhạy cảm (output)',
    description: "Mask email và giá trị dưới key nhạy cảm trong res.result thành '•••'.",
    fn(res) {
      if (res && res.ok && res.result !== undefined && res.result !== null) {
        res.result = mapStrings(res.result, (s, k) => {
          let out = s;
          if (k && SENSITIVE_KEY_RX.test(k)) out = MASK;
          if (typeof out === 'string' && out.includes('@')) out = out.replace(EMAIL_RX, MASK);
          return out;
        });
      }
      return res;
    },
  },

  'clip-output': {
    hook: 'postInvoke',
    label: 'Cắt kết quả quá dài',
    description: 'JSON.stringify(res.result) dài hơn 4000 ký tự → thay bằng {clipped:true, preview}.',
    fn(res) {
      if (res && res.ok && res.result !== undefined) {
        const json = safeStringify(res.result);
        if (typeof json === 'string' && json.length > 4000) {
          res.result = { clipped: true, preview: `${json.slice(0, 4000)}…[clipped]` };
        }
      }
      return res;
    },
  },

  'flatten-error': {
    hook: 'postInvoke',
    label: 'Làm phẳng lỗi',
    description: 'res.error là object → rút về chuỗi message (fallback JSON.stringify).',
    fn(res) {
      if (res && !res.ok && res.error && typeof res.error === 'object') {
        const e = /** @type {any} */ (res.error);
        res.error = typeof e.message === 'string' && e.message ? e.message : safeStringify(e);
      }
      return res;
    },
  },

  'annotate-meta': {
    hook: 'postInvoke',
    label: 'Ghi chú meta',
    description: 'Đẩy nhãn behavior/plugin vào res.meta.pluginNotes.',
    fn(res, ctx) {
      if (res) {
        res.meta = { ...(res.meta ?? {}) };
        res.meta.pluginNotes = [...(res.meta.pluginNotes ?? []), String(ctx?.behaviorLabel ?? 'Ghi chú plugin')];
      }
      return res;
    },
  },
};

export default BEHAVIORS;

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  console.log('plugin-behaviors.js demo —', Object.keys(BEHAVIORS).join(', '));
}
