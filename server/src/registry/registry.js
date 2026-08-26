// registry.js — nạp & truy vấn registries (plugins/mcps/skills). Xem docs/SPEC.md §5.1
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {import('../types.js').Plugin} Plugin
 * @typedef {import('../types.js').McpDescriptor} McpDescriptor
 * @typedef {import('../types.js').Skill} Skill
 */

/** @typedef {{plugins?:Record<string,{enabled:boolean}>, mcps?:Record<string,{state:string}>}} StateOverrides */
/** @typedef {{q?:string, category?:string, status?:string}} RegistryFilter */

export async function loadRegistries(dataDir) {
  const read = async (f) => JSON.parse(await readFile(path.join(dataDir, f), 'utf8'));
  const [plugins, mcps, skills] = await Promise.all([
    read('plugins.json'), read('mcps.json'), read('skills.json'),
  ]);
  return { plugins: plugins.items ?? plugins, mcps: mcps.items ?? mcps, skills: skills.items ?? skills };
}

const norm = (v) => String(v ?? '').toLowerCase();
const asItems = (x) => (Array.isArray(x) ? x : Array.isArray(x?.items) ? x.items : []);

export class Registry {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, 'state.json');
    /** @type {Plugin[]} */ this._plugins = [];
    /** @type {(McpDescriptor&{state:string})[]} */ this._mcps = [];
    /** @type {Skill[]} */ this._skills = [];
    /** @type {StateOverrides} */ this._state = { plugins: {}, mcps: {} };
    /** @type {Promise<void>|null} serialize các lần ghi state.json */ this._pendingWrite = null;
    this._initialized = false;
  }

  /** load files + state overrides */
  async init() {
    const reg = await loadRegistries(this.dataDir);
    this._plugins = asItems(reg.plugins).map((p) => ({ ...p }));
    this._mcps = asItems(reg.mcps)
      .map((m) => ({ ...m, tools: Array.isArray(m.tools) ? m.tools : [], state: 'disconnected' }));
    this._skills = asItems(reg.skills).map((s) => ({ ...s }));

    // merge override từ data/state.json (plugin.enabled, mcp.state)
    let saved = {};
    try { saved = JSON.parse(await readFile(this.statePath, 'utf8')); } catch { /* chưa có state */ }
    this._state = {
      plugins: saved.plugins ?? {},
      mcps: saved.mcps ?? {},
    };
    for (const p of this._plugins) {
      const o = this._state.plugins[p.id];
      if (o && typeof o.enabled === 'boolean') p.enabled = o.enabled;
      else if (typeof p.enabled !== 'boolean') p.enabled = false;
    }
    for (const m of this._mcps) {
      const o = this._state.mcps[m.id];
      if (o && typeof o.state === 'string') m.state = o.state;
    }
    this._initialized = true;
  }

  _ensureInit() {
    if (!this._initialized) throw new Error('Registry: gọi init() trước khi dùng');
  }

  /**
   * Lọc danh sách chung theo q (name/description, không phân biệt hoa thường) + category.
   * @template T
   * @param {T[]} items
   * @param {RegistryFilter} filter
   * @returns {T[]}
   */
  _filter(items, filter = {}) {
    let out = items;
    const q = norm(filter.q).trim();
    if (q) out = out.filter((x) => norm(x.name).includes(q) || norm(x.description).includes(q));
    const cat = norm(filter.category).trim();
    if (cat) out = out.filter((x) => norm(x.category) === cat);
    return out;
  }

  /** Ghi bất đồng bộ an toàn: nối tiếp các lần ghi, ghi tmp rồi rename (atomic-ish). */
  _persistState() {
    const doWrite = async () => {
      try {
        await mkdir(this.dataDir, { recursive: true });
        const tmp = `${this.statePath}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(this._state, null, 2), 'utf8');
        await rename(tmp, this.statePath);
      } catch {/* không bao giờ làm hỏng luồng chính vì lỗi ghi state */}
    };
    this._pendingWrite = (this._pendingWrite ?? Promise.resolve()).then(doWrite, doWrite);
    return this._pendingWrite;
  }

  /** Chờ các lần ghi state.json đang chờ (dùng cho test/graceful shutdown). */
  async flushState() {
    if (this._pendingWrite) { try { await this._pendingWrite; } catch { /* ignore */ } }
  }

  /** @returns {Plugin[]} */
  plugins(filter = {}) {
    this._ensureInit();
    let out = this._filter(this._plugins, filter);
    if (filter && filter.id != null && `${filter.id}` !== '') out = out.filter((p) => p.id === filter.id); // khớp chính xác
    return out;
  }

  /** @returns {Plugin|undefined} */
  plugin(id) {
    this._ensureInit();
    return this._plugins.find((p) => p.id === id);
  }

  setPluginEnabled(id, enabled) {
    const p = this.plugin(id);
    if (!p) return null;
    p.enabled = !!enabled;
    this._state.plugins[id] = { enabled: p.enabled };
    void this._persistState();
    return p;
  }

  /** @returns {(McpDescriptor&{state:string})[]} */
  mcps(filter = {}) {
    this._ensureInit();
    let out = this._filter(this._mcps, filter);
    const status = norm(filter.status).trim();
    if (status) out = out.filter((m) => norm(m.state ?? 'disconnected') === status);
    return out;
  }

  /** @returns {(McpDescriptor&{state:string})|undefined} */
  mcp(id) {
    this._ensureInit();
    return this._mcps.find((m) => m.id === id);
  }

  setMcpState(id, state) {
    const m = this.mcp(id);
    if (!m) return;
    m.state = state === 'connected' ? 'connected' : 'disconnected';
    this._state.mcps[id] = { state: m.state };
    void this._persistState();
  }

  /** @returns {Skill[]} */
  skills(filter = {}) {
    this._ensureInit();
    return this._filter(this._skills, filter);
  }

  skill(id) {
    this._ensureInit();
    return this._skills.find((s) => s.id === id);
  }

  counts() {
    this._ensureInit();
    return { plugins: this._plugins.length, mcps: this._mcps.length, skills: this._skills.length };
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  console.log('registry.js demo — node -e "new (await import(...)).Registry()"');
}
