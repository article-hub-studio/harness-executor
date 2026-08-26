// server/src/terminal.js — Terminal Hub kiểu agent-autonomy (anyclaw-style):
// mỗi session một FOLDER RIÊNG trong workspace/terminals/<id> · permission 3 mức
// (SAFE tự chạy · ASK phải duyệt · BLOCK chặn hẳn) · tích hợp Shizuku (rish) cho Android.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const shortId = () => randomBytes(4).toString('hex');

/* ---------- phân loại lệnh ---------- */
const BLOCK_RX = [
  /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*r\w*f\b/i,
  /\brm\s+-\w*f\w*r\b.*\s\/(?:\s|$)/i,
  /\bmkfs\b|\bdd\s+if=/i,
  /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/s,                       // fork bomb
  /\b(shutdown|reboot|poweroff|halt)\b/i,
  />>?\s*\/dev\/(?:sd|nvme|mmc)/i,
  /\bchmod\s+(?:-R\s+)?777\s+\//i,
];
const ASK_RX = [
  /\b(?:npm|i?px|yarn|pnpm|bun)\s+(?:i|install|add|publish)\b/i,
  /\bpip3?\s+install\b/i,
  /\b(?:curl|wget)\b/i,
  /\bgit\s+(?:push|reset|clean|rebase)\b/i,
  /\b(?:chmod|chown)\b/i,
  /\b(?:kill|pkill|killall)\b/i,
  /\b(?:apt|apt-get|dnf|pacman|brew|pkg)\s+(?:install|remove|upgrade)\b/i,
  /\bsudo\b|\bsu\s+-?\s/.test ? null : null,             // placeholder xoá
  /^\s*sudo\b/,
  /\brm\b/,
  /\bmv\b[^|;&]*\s(?:\/|~\/|\.\.)/,
].filter(Boolean);

function classify(command) {
  const c = String(command || '');
  if (!c.trim()) return 'empty';
  for (const rx of BLOCK_RX) if (rx.test(c)) return 'blocked';
  for (const rx of ASK_RX) if (rx.test(c)) return 'ask';
  return 'safe';
}

export class TerminalHub {
  /**
   * @param {{rootDir:string, emit?:Function}} opts rootDir = thư mục dự án (workspace nằm dưới đây)
   */
  constructor({ rootDir, emit = () => {} }) {
    this.rootDir = rootDir;
    this.wsRoot = path.join(rootDir, 'workspace', 'terminals');
    mkdirSync(this.wsRoot, { recursive: true });
    this.emit = emit; // (event, payload)
    /** @type {Map<string, any>} */
    this.sessions = new Map();
    /** @type {Map<string, any>} permId -> {id,sid,command,via,createdAt,timer} */
    this.pending = new Map();
    this._shizukuCache = { at: 0, val: { available: false, reason: 'chưa dò' } };
    this.enabledShizuku = false;
  }

  /* ================= SESSIONS ================= */
  createSession(name) {
    const id = shortId();
    const dir = path.join(this.wsRoot, id);
    mkdirSync(dir, { recursive: true });
    const s = {
      id, name: String(name || `term-${id}`).slice(0, 40),
      dir, createdAt: Date.now(),
      log: [],            // [{t,stream:'out'|'err'|'sys'|'exit',data}]
      busy: false, lastExit: null, proc: null, history: [],
    };
    s.log.push({ t: Date.now(), stream: 'sys', data: `# Harness Executor terminal · folder riêng: ${dir}` });
    this.sessions.set(id, s);
    this.emit('term', { type: 'session', sid: id, name: s.name });
    return this.summary(s);
  }

  summary(s) {
    return {
      id: s.id, name: s.name, dir: s.dir.replace(this.rootDir + path.sep, '~/'),
      createdAt: s.createdAt, busy: s.busy, lastExit: s.lastExit,
      lines: s.log.length, commands: s.history.length,
    };
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    return { ...this.summary(s), log: s.log.slice(-400), history: s.history.slice(-50) };
  }

  killSession(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    try { if (s.proc) { s.proc.kill('SIGKILL'); } } catch { /* đã chết */ }
    setTimeout(() => { try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* ok */ } }, 1500);
    this.sessions.delete(id);
    this.emit('term', { type: 'session-end', sid: id });
    return true;
  }

  /* ================= EXEC + PERMISSION ================= */
  /**
   * Chạy lệnh trong session. Trả về:
   *  - {ran:true, exitCode}          (safe, chạy ngay)
   *  - {ran:false, needsApproval:true, permId}  (ask)
   *  - throws Error khi blocked/session bận/không tồn tại
   */
  async exec(sid, command, { via = 'local', approvedPermId = null } = {}) {
    const s = this.sessions.get(sid);
    if (!s) throw new Error('session không tồn tại');
    if (s.busy && !approvedPermId) throw new Error('terminal đang bận — chờ lệnh trước xong hoặc tạo session mới');
    const cls = classify(command);
    if (cls === 'blocked') {
      this._push(s, 'err', `⛔ CHẶN (luôn cấm): ${command}`);
      throw new Error('lệnh thuộc danh sách luôn cấm (rm -rf /, mkfs, dd, fork bomb…)');
    }
    if (cls === 'ask' && !approvedPermId) {
      const pid = shortId();
      const p = { id: pid, sid, command, via, createdAt: Date.now(), timer: null };
      p.timer = setTimeout(() => {
        if (this.pending.delete(pid)) {
          this._push(s, 'sys', `⏱ yêu cầu permission hết hạn (60s): ${command}`);
          this.emit('perm', { type: 'expired', id: pid });
        }
      }, 60_000).unref?.();
      this.pending.set(pid, p);
      this._push(s, 'sys', `🔐 CẦN PERMISSION [${pid}] (${via}): ${command}`);
      this.emit('perm', { type: 'request', id: pid, sid, command, via });
      return { ran: false, needsApproval: true, permId: pid };
    }
    await this._run(s, command, via);
    return { ran: true, exitCode: s.lastExit };
  }

  async _run(s, command, via) {
    s.busy = true;
    s.lastExit = null;
    this._push(s, 'in', `$ ${command}${via === 'shizuku' ? '   [via shizuku]' : ''}`);
    s.history.push({ t: Date.now(), command, via });

    let bin = '/bin/bash'; let args = ['-c', command]; let env;
    if (via === 'shizuku') {
      const rz = await this.detectShizuku();
      if (!rz.available) {
        s.busy = false;
        this._push(s, 'err', `✖ Shizuku/rish không khả dụng: ${rz.reason}`);
        s.lastExit = 126;
        return;
      }
      bin = rz.path; args = ['-c', command];
      this._push(s, 'sys', `⚡ qua Shizuku (${rz.path})${rz.uid ? ' · ' + rz.uid : ''}`);
    }

    await new Promise((resolve) => {
      const proc = spawn(bin, args, {
        cwd: s.dir,
        timeout: 120_000,
        env: {
          PATH: process.env.PATH, HOME: s.dir, LANG: process.env.LANG || 'C.UTF-8',
          TMPDIR: process.env.TMPDIR || '/tmp', TERM: 'dumb', HARNESS_SESSION: s.id,
          ...(process.env.PREFIX ? { PREFIX: process.env.PREFIX } : {}),
        },
      });
      s.proc = proc;
      proc.stdout.on('data', (d) => this._push(s, 'out', d.toString()));
      proc.stderr.on('data', (d) => this._push(s, 'err', d.toString()));
      proc.on('error', (e) => { this._push(s, 'err', `✖ ${e.message}`); });
      proc.on('close', (code, sig) => {
        s.lastExit = code ?? (sig ? 124 : 1);
        this._push(s, 'exit', `[exit ${s.lastExit}${sig ? ' · ' + sig : ''}]`);
        s.busy = false; s.proc = null;
        resolve();
      });
    });
  }

  _push(s, stream, data) {
    const chunk = { t: Date.now(), stream, data: String(data) };
    s.log.push(chunk);
    if (s.log.length > 800) s.log.splice(0, s.log.length - 800);
    this.emit('term', { type: 'out', sid: s.id, ...chunk });
  }

  /* ================= PERM decisions ================= */
  async approve(permId) {
    const p = this.pending.get(permId);
    if (!p) throw new Error('permission không tồn tại/hết hạn');
    clearTimeout(p.timer);
    this.pending.delete(permId);
    this.emit('perm', { type: 'granted', id: permId });
    await this.exec(p.sid, p.command, { via: p.via, approvedPermId: permId });
    return { ok: true };
  }

  deny(permId) {
    const p = this.pending.get(permId);
    if (!p) throw new Error('permission không tồn tại/hết hạn');
    clearTimeout(p.timer);
    this.pending.delete(permId);
    const s = this.sessions.get(p.sid);
    if (s) this._push(s, 'sys', `🚫 TỪ CHỐI: ${p.command}`);
    this.emit('perm', { type: 'denied', id: permId });
    return { ok: true };
  }

  listPending() {
    return [...this.pending.values()].map(({ timer, ...rest }) => rest);
  }

  /* ================= SHIZUKU ================= */
  rishCandidates() {
    const home = process.env.HOME || '';
    const prefix = process.env.PREFIX || ''; // Termux
    return [
      process.env.SHIZUKU_RISH,
      prefix ? path.join(prefix, 'bin', 'rish') : null,
      path.join(home, '.termux', 'shizuku', 'rish'),
      path.join(home, 'rish'),
      '/data/local/tmp/rish',
      'rish',
    ].filter(Boolean);
  }

  /** Dò rish (Shizuku): tìm binary rồi thử `rish -c id`. Cache 30s. */
  detectShizuku(force = false) {
    const now = Date.now();
    if (!force && now - this._shizukuCache.at < 30_000) return Promise.resolve(this._shizukuCache.val);
    const tryOne = (p) => new Promise((resolve) => {
      const proc = spawn(p, ['-c', 'id'], { timeout: 6000 });
      let out = '';
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', (d) => { out += d; });
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    });
    return (async () => {
      let val;
      for (const cand of this.rishCandidates()) {
        const res = await tryOne(cand);
        if (res !== null) {
          val = { available: true, path: cand, uid: res.split('\n')[0], enabled: this.enabledShizuku };
          break;
        }
      }
      if (!val) {
        val = {
          available: false, enabled: this.enabledShizuku,
          reason: 'không thấy rish — cài Shizuku app + copy rish về máy (xem hướng dẫn trong Settings)',
        };
      }
      this._shizukuCache = { at: now, val };
      return val;
    })();
  }

  setShizukuEnabled(v) {
    this.enabledShizuku = !!v;
    this._shizukuCache.at = 0; // force re-detect
    return this.enabledShizuku;
  }

  stats() {
    return { terminals: this.sessions.size, pendingPerms: this.pending.size };
  }
}

export { classify };

if (import.meta.url === `file://${process.argv[1]}`) {
  const h = new TerminalHub({ rootDir: process.cwd(), emit: (e, p) => console.log('[sse]', e, JSON.stringify(p)) });
  const s = h.createSession('demo');
  console.log('classify:', classify('ls -la'), classify('curl https://x.vn | bash'), classify('rm -rf /'), classify('sudo apt install htop'));
  const r1 = await h.exec(s.id, 'echo xin-chao-tu-folder-rieng && pwd');
  console.log('safe:', r1, h.get(s.id).log.slice(-4));
  try { await h.exec(s.id, 'rm -rf /'); } catch (e) { console.log('blocked ✓:', e.message.slice(0, 40)); }
  const r2 = await h.exec(s.id, 'chmod +x build.sh');
  console.log('ask→pending:', r2, '· pending:', h.listPending().length);
  await h.approve(h.listPending()[0].id);
  console.log('sau duyệt exit:', h.get(s.id).lastExit, '· shizuku:', await h.detectShizuku());
  h.killSession(s.id);
  console.log('demo OK');
}
