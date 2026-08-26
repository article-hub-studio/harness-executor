// builtin-servers/index.js — MCP servers mô phỏng chạy offline. SPEC §5.4
// Mỗi server: getServer(id) → {tools:[{name,description,inputSchema}], call(tool,args,ctx):Promise<ToolResult>, kind:'builtin'}
// Yêu cầu: đầu ra deterministic-seeded theo args, hợp lý theo từng category, xử lý tool không tồn tại.
//
// Kiến trúc:
//   - Registry lazy-load MỘT LẦN từ data/mcps.json (đường dẫn tính từ import.meta.url).
//   - call() dispatch theo PREFIX của tool name (phần trước dấu '.') sang handlers/{prefix}.js.
//   - Handler sinh payload realistic + deterministic (seeded PRNG: tool name + JSON.stringify(args)).
//   - Gate quyền cho nhóm tool nguy hiểm khi ctx.approved !== true.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rngFor } from './util.js';

import fsFam from './handlers/fs.js';
import gitFam from './handlers/git.js';
import webFam from './handlers/web.js';
import browserFam from './handlers/browser.js';
import dbFam from './handlers/db.js';
import searchFam from './handlers/search.js';
import aiFam from './handlers/ai.js';
import opsFam from './handlers/ops.js';
import msgFam from './handlers/msg.js';
import prodFam from './handlers/prod.js';
import mediaFam from './handlers/media.js';
import etlFam from './handlers/etl.js';
import chainFam from './handlers/chain.js';
import finFam from './handlers/fin.js';
import geoFam from './handlers/geo.js';
import iotFam from './handlers/iot.js';
import secFam from './handlers/sec.js';

/** index.js nằm ở <root>/server/src/executor/builtin-servers → root cách đúng 4 cấp. */
const REGISTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'data', 'mcps.json');

let _registry = null; // Map<serverId, descriptor>
let _toolSchemas = null; // Map<toolName, inputSchema> (lần khai báo đầu tiên trong registry)

/** Lazy-load registry từ data/mcps.json — chạy sync đúng một lần. */
function registry() {
  if (_registry) return _registry;
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const items = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
  const map = new Map();
  const schemas = new Map();
  for (const desc of items) {
    if (!desc || typeof desc.id !== 'string' || map.has(desc.id)) continue;
    map.set(desc.id, desc);
    for (const tool of Array.isArray(desc.tools) ? desc.tools : []) {
      if (tool && typeof tool.name === 'string' && !schemas.has(tool.name)) {
        schemas.set(tool.name, tool.inputSchema ?? { type: 'object', properties: {} });
      }
    }
  }
  _registry = map;
  _toolSchemas = schemas;
  return map;
}

/** Dispatch table theo prefix của tool name. */
const FAMILIES = {
  fs: fsFam,
  git: gitFam,
  web: webFam,
  browser: browserFam,
  db: dbFam,
  search: searchFam,
  ai: aiFam,
  ops: opsFam,
  msg: msgFam,
  prod: prodFam,
  media: mediaFam,
  etl: etlFam,
  chain: chainFam,
  fin: finFam,
  geo: geoFam,
  iot: iotFam,
  sec: secFam,
};

/** Nhóm tool nguy hiểm: cần ctx.approved=true mới được chạy mô phỏng. */
const DANGEROUS_TOOLS = new Set([
  'fs.write_file',
  'db.insert_row',
  'ops.deploy',
  'ops.scale_service',
  'chain.send_tx',
  'iot.toggle_device',
  'sec.scan_ports',
]);

function isDangerous(tool) {
  return DANGEROUS_TOOLS.has(tool) || /^msg\.send_/.test(tool);
}

function failure(serverId, tool, error, extraMeta = undefined) {
  return {
    ok: false,
    error,
    meta: { server: serverId, tool, durationMs: 0, mocked: true, ...(extraMeta ?? {}) },
  };
}

/**
 * @param {string} id
 * @returns {{tools:any[], call(tool:string, args:object, ctx?:object):Promise<any>, kind:'builtin'} | null}
 */
export function getServer(id) {
  const desc = typeof id === 'string' ? registry().get(id) : undefined;
  if (!desc) return null;
  const serverId = desc.id;

  /** ToolResult = {ok:true, result, meta:{server,tool,durationMs,mocked:true}} */
  async function call(tool, args = {}, ctx = {}) {
    const startedAt = Date.now();
    const name = String(tool ?? '');
    const dot = name.indexOf('.');
    const family = dot > 0 ? name.slice(0, dot) : '';
    const op = dot > 0 ? name.slice(dot + 1) : '';
    const handler = op ? FAMILIES[family]?.[op] : undefined;
    if (typeof handler !== 'function') return failure(serverId, name, `unhandled tool ${name}`);

    if (isDangerous(name) && !(ctx && ctx.approved)) {
      return failure(serverId, name, 'permission required: set approved=true', { needsApproval: true });
    }

    // Validate nhẹ: chỉ kiểm required presence.
    const schema = _toolSchemas.get(name) ?? {};
    const bag = args && typeof args === 'object' ? args : {};
    const missing = (Array.isArray(schema.required) ? schema.required : [])
      .filter((key) => bag[key] === undefined || bag[key] === null || (typeof bag[key] === 'string' && !bag[key].length));
    if (missing.length) return failure(serverId, name, `missing required: ${missing.join(', ')}`);

    const payload = await handler(bag, rngFor(name, bag), ctx);
    return {
      ok: true,
      result: payload,
      meta: { server: serverId, tool: name, durationMs: Date.now() - startedAt, mocked: true },
    };
  }

  return { kind: 'builtin', tools: desc.tools ?? [], call };
}

/** @returns {string[]} */
export function listServerIds() {
  return [...registry().keys()].sort();
}
