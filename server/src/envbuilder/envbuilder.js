// envbuilder.js — quét & dựng môi trường tự động. SPEC §5.5 (docs/SPEC.md)
// SA-env · zero-dependency: chỉ dùng node: core modules.
// Nguyên tắc: scan() và build() KHÔNG BAO GIỜ throw — mọi lỗi biến thành check/log có kiểm soát.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

// ---- Hằng số ---------------------------------------------------------------
const EXEC_TIMEOUT_MS = 5000;              // mọi lệnh ngoài tối đa 5s
const PORT_PROBE_TIMEOUT_MS = 3000;
const MIN_NODE_MAJOR = 20;
const DISK_WARN_BYTES = 5 * 1024 ** 3;     // <5GB → warn
const DISK_FAIL_BYTES = 1 * 1024 ** 3;     // <1GB → fail
const MEM_WARN_BYTES = 256 * 1024 ** 2;    // freemem <256MB → warn

/** @typedef {{id:string, label:string, status:'pass'|'warn'|'fail'|'fixable', detail:string, version?:string}} EnvCheck */

// ---- Helper ----------------------------------------------------------------
const execFileAsync = promisify(execFile);

/** Chạy lệnh ngoài qua execFile (timeout 5s) — trả kết quả, KHÔNG throw. */
async function execTool(cmd, args = []) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true });
    return { ok: true, code: 0, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
  } catch (err) {
    return {
      ok: false,
      code: err?.code ?? 'ERR',
      stdout: String(err?.stdout || '').trim(),
      stderr: String(err?.stderr || '').trim(),
      message: String(err?.message || err),
    };
  }
}

/** Tách '22.23.2' / '8.5.0' / '24.0' ra khỏi bất kỳ chuỗi version nào. */
function extractVersion(text) {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** human-readable bytes: 123 B · 4.2 GB ... */
function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Kiểm tra cổng còn trống: listen thử rồi đóng ngay. Không bao giờ reject. */
function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    let timer = null;
    const done = (status, detail) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { srv.close(); } catch { /* chưa listen thì bỏ qua */ }
      resolve({ status, detail });
    };
    srv.once('error', async (err) => {
      if (err?.code === 'EADDRINUSE') {
        // Cổng bị chiếm — nếu chính là harness này đang chạy thì coi như pass
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) });
          const j = await res.json().catch(() => null);
          if (res.ok && j?.ok && typeof j?.name === 'string' && j.name.includes('upio')) {
            done('pass', `Cổng ${port} đang phục vụ chính harness (server đang chạy)`);
            return;
          }
        } catch { /* không phải harness → fail như thường */ }
        done('fail', `Cổng ${port} đang bị chiếm bởi tiến trình khác`);
      }
      else done('fail', `Không kiểm tra được cổng ${port}: ${err?.code || err?.message}`);
    });
    srv.once('listening', () => done('pass', `Cổng ${port} đang trống, sẵn sàng cho server`));
    try {
      srv.listen(port); // bind mọi interface → phát hiện cả tiến trình ngoài
    } catch (err) {
      done('fail', `Không listen được cổng ${port}: ${err?.code || err?.message}`);
      return;
    }
    timer = setTimeout(() => done('warn', `Hết thời gian chờ khi thăm dò cổng ${port}`), PORT_PROBE_TIMEOUT_MS);
  });
}

// ---- EnvBuilder --------------------------------------------------------------
export class EnvBuilder {
  /** @param {{dataDir:string, rootDir:string, port:number}} opts */
  constructor(opts = {}) {
    this.opts = { ...opts };
    this.rootDir = path.resolve(String(opts.rootDir || process.cwd()));
    this.dataDir = path.resolve(String(opts.dataDir || path.join(this.rootDir, 'data')));
    const p = Number(opts.port);
    this.port = Number.isFinite(p) && p > 0 ? p : 8787;
  }

  /**
   * Quét môi trường. Luôn trả {checks, summary}; không bao giờ throw.
   * summary: 'fixable' được đếm vào warn.
   * @returns {Promise<{checks:EnvCheck[], summary:{pass:number, warn:number, fail:number}}>}
   */
  async scan() {
    try {
      /** @type {[string, string, () => Promise<EnvCheck>][]} */
      const defs = [
        ['node-version', 'Node.js runtime', () => this.#checkNode()],
        ['npm', 'npm package manager', () => this.#checkNpm()],
        ['python3', 'Python 3 runtime', () => this.#checkPython()],
        ['pip', 'pip package manager', () => this.#checkPip()],
        ['git', 'Git CLI', () => this.#checkPresence('git', ['--version'], 'git')],
        ['curl', 'curl CLI', () => this.#checkPresence('curl', ['--version'], 'curl')],
        ['luau-lsp', 'luau-lsp binary', () => this.#checkLuauLsp()],
        ['disk-space', 'Dung lượng đĩa', () => this.#checkDisk()],
        ['memory', 'Bộ nhớ khả dụng', () => this.#checkMemory()],
        ['port-free', `Cổng ${this.port}`, () => this.#checkPort()],
        ['data-dirs', 'Thư mục dữ liệu', () => this.#checkDataDirs()],
        ['env-file', 'Tệp .env', () => this.#checkEnvFile()],
        ['registries', 'Registry JSON (mcps/plugins/skills)', () => this.#checkRegistries()],
      ];
      // Chạy song song nhưng giữ thứ tự khai báo; từng check tự bọc try/catch.
      const checks = await Promise.all(defs.map(async ([id, label, fn]) => {
        try { return await fn(); } catch (err) {
          return { id, label, status: 'fail', detail: `Lỗi không mong muốn: ${err?.message || err}` };
        }
      }));
      const summary = { pass: 0, warn: 0, fail: 0 };
      for (const c of checks) {
        if (c.status === 'pass') summary.pass += 1;
        else if (c.status === 'fail') summary.fail += 1;
        else summary.warn += 1; // 'warn' lẫn 'fixable' đều tính vào warn
      }
      return { checks, summary };
    } catch (err) {
      // Lớp bảo vệ cuối: scan() vẫn trả shape đúng.
      return {
        checks: [{ id: 'envbuilder', label: 'Environment scan', status: 'fail', detail: `Scan thất bại: ${err?.message || err}` }],
        summary: { pass: 0, warn: 0, fail: 1 },
      };
    }
  }

  /**
   * Dựng môi trường: tạo dirs, ghi .env nếu thiếu, state.json, dọn tmp...
   * @param {{repair?:boolean}} options
   * @param {(event:string, payload:{level:'info'|'warn'|'error', line:string})=>void} emit — gọi emit('env',{level,line}) từng dòng
   * @returns {Promise<{buildId:string, ok:boolean, applied:string[], logs:string[]}>}
   */
  async build(options = {}, emit = () => {}) {
    const repair = options?.repair === true;
    const buildId = `bld-${Date.now().toString(36)}`;
    const logs = [];
    const appliedSet = new Set();
    let hadError = false;
    const t0 = Date.now();

    const say = (level, line) => {
      logs.push(line);
      try { emit('env', { level, line }); } catch { /* emitter hỏng không được làm rơi build */ }
    };
    const apply = (item) => appliedSet.add(item);

    say('info', `[${buildId}] Bắt đầu dựng môi trường tại ${this.rootDir}${repair ? ' (chế độ repair)' : ''}`);

    try {
      // 1) Tạo thư mục data/, logs/, tmp/ dưới rootDir (mkdir -p)
      const wanted = [
        ['data', this.dataDir],
        ['logs', path.join(this.rootDir, 'logs')],
        ['tmp', path.join(this.rootDir, 'tmp')],
      ];
      const seen = new Set();
      for (const [name, dir] of wanted) {
        const key = path.resolve(dir);
        if (seen.has(key)) continue; // dataDir === rootDir/data thì tránh log trùng
        seen.add(key);
        let existed = false;
        try { existed = (await fs.stat(dir)).isDirectory(); } catch { /* chưa có */ }
        try {
          await fs.mkdir(dir, { recursive: true });
          if (!existed) { apply(`directory ${name}/ created`); say('info', `Đã tạo thư mục ${name}/ → ${dir}`); }
          else say('info', `Thư mục đã sẵn sàng: ${name}/ → ${dir}`);
        } catch (err) {
          hadError = true;
          say('error', `Không tạo được thư mục ${name}/: ${err?.message || err}`);
        }
      }

      // 2) Ghi .env mẫu nếu thiếu
      const envPath = path.join(this.rootDir, '.env');
      let envExists = true;
      try { await fs.access(envPath); } catch { envExists = false; }
      if (!envExists) {
        const body = [
          `# upio executor — generated by EnvBuilder at ${new Date().toISOString()}`,
          `PORT=${this.port}`,
          `UPIO_HOME=${this.rootDir}`,
          'NODE_ENV=production',
          'LOG_LEVEL=info',
          'MODEL_DEFAULT=ox-local-mock',
          '',
        ].join('\n');
        try {
          await fs.writeFile(envPath, body, { encoding: 'utf8', mode: 0o600 });
          apply('.env created');
          say('info', `Đã ghi ${envPath} từ mẫu mặc định`);
        } catch (err) {
          hadError = true;
          say('error', `Không ghi được .env: ${err?.message || err}`);
        }
      } else {
        say('info', '.env đã tồn tại — giữ nguyên không ghi đè');
      }

      // 3) Ghi data/state.json gộp lastBuild (đọc giá trị cũ nếu có)
      const statePath = path.join(this.dataDir, 'state.json');
      let state = {};
      try {
        const old = JSON.parse(await fs.readFile(statePath, 'utf8'));
        if (old && typeof old === 'object' && !Array.isArray(old)) state = old;
      } catch { /* thiếu/hỏng → khởi tạo mới */ }
      state.lastBuild = { at: new Date().toISOString(), repair };
      try {
        await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        apply('state.json updated');
        say('info', `Đã cập nhật ${statePath} (lastBuild)`);
      } catch (err) {
        hadError = true;
        say('error', `Không ghi được state.json: ${err?.message || err}`);
      }

      // 4) Dọn file *.tmp trong tmp/
      const tmpDir = path.join(this.rootDir, 'tmp');
      try {
        const entries = await fs.readdir(tmpDir);
        const stale = entries.filter((e) => e.endsWith('.tmp'));
        let removed = 0;
        for (const f of stale) {
          try { await fs.rm(path.join(tmpDir, f), { force: true }); removed += 1; } catch { /* giữ lại, không fatal */ }
        }
        if (removed > 0) { apply(`cleaned ${removed} tmp file(s)`); say('info', `Đã dọn ${removed} file *.tmp trong tmp/`); }
        else say('info', 'tmp/ sạch — không có file *.tmp nào');
      } catch (err) {
        say('warn', `Không quét được tmp/: ${err?.message || err}`);
      }

      // 5) Kiểm tra lại registries parse
      const reg = await this.#checkRegistries();
      if (reg.status === 'pass') {
        say('info', `Registries OK — ${reg.detail}`);
      } else {
        say('warn', `Registries: ${reg.detail} → chạy \`npm run generate\` để tái tạo data/*.json`);
      }

      // 6) Repair: sửa các check fail/fixable nếu làm được, còn lại đề xuất lệnh cụ thể
      if (repair) {
        say('info', 'Repair: chạy lại toàn bộ checks...');
        let report = null;
        try { report = await this.scan(); } catch (err) { say('warn', `Repair không scan lại được: ${err?.message || err}`); }
        if (report) {
          let fixed = 0;
          let manual = 0;
          for (const c of report.checks) {
            if (c.status !== 'fail' && c.status !== 'fixable') continue;
            if (c.id === 'env-file' && c.status === 'fixable') {
              try {
                await fs.access(envPath);
                say('info', `Repair: [env-file] đã có .env (đã xử lý ở bước trước)`);
                fixed += 1;
              } catch { /* đã cố ghi ở bước 2 — nếu vẫn thiếu là hệ thống không cho ghi */ }
              continue;
            }
            if (c.id === 'data-dirs' && c.status !== 'pass') {
              try {
                await fs.mkdir(this.dataDir, { recursive: true });
                const probe = path.join(this.dataDir, '.write-test-repair');
                await fs.writeFile(probe, 'upio');
                await fs.rm(probe, { force: true });
                apply('repaired data directory');
                fixed += 1;
                say('info', `Repair: [data-dirs] data/ ghi được trở lại → ${this.dataDir}`);
              } catch (err) {
                manual += 1;
                say('warn', `Repair: [data-dirs] vẫn không ghi được → chmod u+w "${this.dataDir}" (${err?.code || err?.message})`);
              }
              continue;
            }
            manual += 1;
            say('warn', `Repair: [${c.id}] ${c.detail} → ${this.#suggest(c.id)}`);
          }
          say('info', `Repair xong: ${fixed} mục đã tự sửa, ${manual} mục cần can thiệp thủ công.`);
          say('info', `Scan sau repair: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}`);
        }
      }

      const ms = Date.now() - t0;
      say(hadError ? 'error' : 'info', `[${buildId}] Hoàn tất sau ${ms}ms — applied=${appliedSet.size}, ok=${!hadError}`);
      return { buildId, ok: !hadError, applied: [...appliedSet], logs };
    } catch (err) {
      // Lớp bảo vệ cuối của build().
      hadError = true;
      say('error', `Build thất bại bất ngờ: ${err?.stack || err?.message || err}`);
      return { buildId, ok: false, applied: [...appliedSet], logs };
    }
  }

  // ---- Các check riêng lẻ (mỗi cái trả về EnvCheck) -------------------------

  async #checkNode() {
    const r = await execTool('node', ['--version']);
    const ver = extractVersion(r.ok ? r.stdout : `${r.stdout}\n${r.stderr}`);
    if (!r.ok && !ver) return { id: 'node-version', label: 'Node.js runtime', status: 'fail', detail: `Không chạy được node: ${r.message}` };
    const major = ver ? Number.parseInt(ver.split('.')[0], 10) : Number.NaN;
    if (!Number.isFinite(major)) return { id: 'node-version', label: 'Node.js runtime', status: 'warn', detail: `Không đọc được phiên bản node (stdout: ${r.stdout || r.stderr || 'trống'})` };
    if (major < MIN_NODE_MAJOR) return { id: 'node-version', label: 'Node.js runtime', status: 'warn', version: ver, detail: `Node.js ${ver} thấp hơn khuyến nghị (cần >= ${MIN_NODE_MAJOR})` };
    return { id: 'node-version', label: 'Node.js runtime', status: 'pass', version: ver, detail: `Node.js ${ver} (yêu cầu >= ${MIN_NODE_MAJOR})` };
  }

  async #checkNpm() {
    const r = await execTool('npm', ['--version']);
    const ver = extractVersion(r.ok ? r.stdout : `${r.stdout}\n${r.stderr}`);
    if (!r.ok && !ver) return { id: 'npm', label: 'npm package manager', status: 'fail', detail: `npm không tìm thấy: ${r.message}` };
    return { id: 'npm', label: 'npm package manager', status: 'pass', version: ver || 'unknown', detail: `npm ${ver || '(không đọc được version)'}` };
  }

  async #checkPython() {
    const r = await execTool('python3', ['--version']);
    // Version có thể nằm ở stdout (Python >= 3.4) hoặc stderr (Python cũ) — xử lý cả hai.
    const text = `${r.stdout}\n${r.stderr}`;
    const ver = /Python\s+(\d[\d.]*)/i.exec(text)?.[1] || (r.ok ? extractVersion(text) : null);
    if (!r.ok && !ver) return { id: 'python3', label: 'Python 3 runtime', status: 'warn', detail: `python3 không tìm thấy (không bắt buộc): ${r.message}` };
    return { id: 'python3', label: 'Python 3 runtime', status: 'pass', version: ver || undefined, detail: `Python ${ver || '(không đọc được version)'}` };
  }

  async #checkPip() {
    let r = await execTool('pip3', ['--version']);
    let via = 'pip3';
    if (!r.ok) { r = await execTool('pip', ['--version']); via = 'pip'; }
    const text = `${r.stdout}\n${r.stderr}`;
    const ver = r.ok ? (text.match(/pip\s+(\d[\d.]*)/i)?.[1] || extractVersion(text)) : null;
    if (!r.ok) return { id: 'pip', label: 'pip package manager', status: 'warn', detail: 'pip/pip3 không tìm thấy (không bắt buộc)' };
    return { id: 'pip', label: 'pip package manager', status: 'pass', version: ver || undefined, detail: `pip ${ver || '(không đọc được version)'} (${via})` };
  }

  /**
   * luau-lsp là tiến trình THẬT mà MCP server bundled (server/mcp/luau-mcp) bọc lại.
   * Thiếu binary → luau-mcp phải fallback `npx -y luau-lsp` (~40s/lần gọi) nên chỉ 'warn',
   * kèm hướng dẫn sửa cụ thể thay vì báo chung chung.
   */
  async #checkLuauLsp() {
    const bin = process.env.LUAU_LSP_BIN || 'luau-lsp';
    const r = await execTool(bin, ['--version']);
    if (!r.ok) {
      return {
        id: 'luau-lsp',
        label: 'luau-lsp binary',
        status: 'warn',
        detail: `${bin} không có trên PATH — MCP luau-lsp sẽ chạy qua npx (chậm). Sửa: npm i -g luau-lsp`,
      };
    }
    const ver = extractVersion(`${r.stdout}\n${r.stderr}`);
    return {
      id: 'luau-lsp',
      label: 'luau-lsp binary',
      status: 'pass',
      version: ver || undefined,
      detail: `luau-lsp sẵn sàng${ver ? ` (${ver})` : ''} — MCP Luau chạy trực tiếp, không cần npx`,
    };
  }

  async #checkPresence(cmd, args, name) {
    const r = await execTool(cmd, args);
    if (!r.ok) return { id: cmd, label: `${name} CLI`, status: 'warn', detail: `${cmd} không tìm thấy trên PATH (không bắt buộc)` };
    const ver = extractVersion(`${r.stdout}\n${r.stderr}`);
    return { id: cmd, label: `${name} CLI`, status: 'pass', version: ver || undefined, detail: `${cmd} sẵn sàng${ver ? ` (${r.stdout.split('\n')[0]})` : ''}` };
  }

  /** Tổ tiên gần nhất của dir đang tồn tại trên đĩa (để statfs/df không ENOENT). */
  async #existingAncestor(dir) {
    let cur = path.resolve(dir);
    for (let i = 0; i < 64; i += 1) {
      try {
        if ((await fs.stat(cur)).isDirectory()) return cur;
      } catch { /* chưa có, leo lên cha */ }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  }

  async #checkDisk() {
    // Ưu tiên fs.statfs (Node >= 18.15/19.6); fallback parse `df -k -P`.
    // Nếu rootDir chưa tồn tại thì đo ở ancestor tồn tại gần nhất (cùng filesystem).
    let free = null;
    let total = null;
    let where = this.rootDir;
    const probeDir = (await this.#existingAncestor(where)) || where;
    if (probeDir !== where) where = `${probeDir} (đo tại tổ tiên của ${where})`;
    if (typeof fs.statfs === 'function') {
      try {
        const s = await fs.statfs(probeDir);
        // Lưu ý: Node trả field KHÔNG prefix f_ (bsize/bavail/blocks); giữ fallback f_* phòng runtime khác.
        const unit = Number(s.bsize || s.frsize || s.f_bsize || s.f_frsize || 4096);
        const avail = Number(s.bavail ?? s.f_bavail);
        const blocks = Number(s.blocks ?? s.f_blocks);
        if (Number.isFinite(avail) && avail >= 0) free = avail * unit;
        if (Number.isFinite(blocks) && blocks >= 0) total = blocks * unit;
      } catch { /* fallback bên dưới */ }
    }
    if (free == null) {
      const r = await execTool('df', ['-k', '-P', probeDir]);
      const line = r.stdout.split('\n').filter(Boolean).pop() || '';
      const cols = line.split(/\s+/);
      const kbAvail = Number(cols[3]); // Filesystem 1024-blocks Used Available Capacity Mounted
      if (Number.isFinite(kbAvail) && kbAvail >= 0) { free = kbAvail * 1024; total = null; }
    }
    if (free == null || !Number.isFinite(free) || free < 0) return { id: 'disk-space', label: 'Dung lượng đĩa', status: 'warn', detail: `Không xác định được dung lượng đĩa cho ${this.rootDir}` };
    if (free < DISK_FAIL_BYTES) return { id: 'disk-space', label: 'Dung lượng đĩa', status: 'fail', detail: `Chỉ còn ${humanBytes(free)} trống tại ${where} (cần tối thiểu ${humanBytes(DISK_FAIL_BYTES)})` };
    if (free < DISK_WARN_BYTES) return { id: 'disk-space', label: 'Dung lượng đĩa', status: 'warn', detail: `Còn ${humanBytes(free)} trống tại ${where} — dưới ngưỡng khuyến nghị ${humanBytes(DISK_WARN_BYTES)}` };
    return { id: 'disk-space', label: 'Dung lượng đĩa', status: 'pass', detail: `Còn ${humanBytes(free)} trống${total != null ? ` / tổng ${humanBytes(total)}` : ''} tại ${where}` };
  }

  #checkMemory() {
    const total = os.totalmem();
    const free = os.freemem();
    if (free < MEM_WARN_BYTES) return { id: 'memory', label: 'Bộ nhớ khả dụng', status: 'warn', detail: `RAM trống ${humanBytes(free)} / tổng ${humanBytes(total)} — dưới ngưỡng ${humanBytes(MEM_WARN_BYTES)}` };
    return { id: 'memory', label: 'Bộ nhớ khả dụng', status: 'pass', detail: `RAM trống ${humanBytes(free)} / tổng ${humanBytes(total)}` };
  }

  async #checkPort() {
    const { status, detail } = await probePort(this.port);
    return { id: 'port-free', label: `Cổng ${this.port}`, status, detail };
  }

  async #checkDataDirs() {
    const dir = this.dataDir;
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) return { id: 'data-dirs', label: 'Thư mục dữ liệu', status: 'fail', detail: `${dir} tồn tại nhưng không phải thư mục` };
    } catch {
      return { id: 'data-dirs', label: 'Thư mục dữ liệu', status: 'fixable', detail: `${dir} chưa tồn tại — sẽ được tạo khi Build Environment` };
    }
    try {
      const probe = path.join(dir, `.write-test-${process.pid}`);
      await fs.writeFile(probe, 'upio');
      await fs.rm(probe, { force: true });
      return { id: 'data-dirs', label: 'Thư mục dữ liệu', status: 'pass', detail: `Ghi/xóa file thử OK trong ${dir}` };
    } catch (err) {
      return { id: 'data-dirs', label: 'Thư mục dữ liệu', status: 'fail', detail: `Không ghi được vào ${dir}: ${err?.code || err?.message}` };
    }
  }

  async #checkEnvFile() {
    const p = path.join(this.rootDir, '.env');
    try {
      await fs.access(p, fs.constants.F_OK);
      return { id: 'env-file', label: 'Tệp .env', status: 'pass', detail: `${p} tồn tại` };
    } catch {
      return { id: 'env-file', label: 'Tệp .env', status: 'fixable', detail: `${p} chưa tồn tại — sẽ được tạo từ mẫu khi Build Environment` };
    }
  }

  async #checkRegistries() {
    const files = ['mcps.json', 'plugins.json', 'skills.json'];
    const parts = [];
    const bad = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.dataDir, f), 'utf8'));
        const n = Array.isArray(parsed?.items) ? parsed.items.length : (Array.isArray(parsed) ? parsed.length : null);
        if (n == null) { bad.push(`${f}: cấu trúc lạ`); parts.push(`${f}:?`); }
        else parts.push(`${f}:${n}`);
      } catch (err) {
        bad.push(err?.code === 'ENOENT' ? `${f}: thiếu` : `${f}: JSON hỏng`);
      }
    }
    if (bad.length === 0) return { id: 'registries', label: 'Registry JSON (mcps/plugins/skills)', status: 'pass', detail: `Parse OK (${parts.join(', ')})` };
    return { id: 'registries', label: 'Registry JSON (mcps/plugins/skills)', status: 'fail', detail: `Lỗi registry: ${bad.join('; ')}` };
  }

  /** Gợi ý lệnh cụ thể cho từng loại check khi repair không tự sửa được. */
  #suggest(id) {
    switch (id) {
      case 'node-version': return `nâng cấp runtime: nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR} (hoặc https://nodejs.org)`;
      case 'npm': return 'cài Node.js đầy đủ từ https://nodejs.org (npm đi kèm)';
      case 'python3': return 'apt-get install -y python3 (hoặc: brew install python)';
      case 'pip': return 'python3 -m ensurepip --upgrade (hoặc: apt-get install -y python3-pip)';
      case 'git': return 'apt-get install -y git';
      case 'curl': return 'apt-get install -y curl';
      case 'disk-space': return `giải phóng dung lượng: df -h ${this.rootDir}; npm cache clean --force; xóa log/tmp cũ`;
      case 'memory': return 'đóng tiến trình nặng hoặc thêm swap: fallocate -l 1G /swapfile && mkswap /swapfile && swapon /swapfile';
      case 'port-free': return `cổng ${this.port} bị chiếm: lsof -i :${this.port} rồi kill <PID>, hoặc đặt PORT khác trong .env`;
      case 'registries': return `cd "${path.dirname(this.rootDir) || '.'}" && npm run generate (tái tạo data/mcps.json, plugins.json, skills.json)`;
      default: return 'xem chi tiết các checks tại GET /api/env';
    }
  }
}

// Demo nhỏ khi chạy trực tiếp: `node server/src/envbuilder/envbuilder.js` (SPEC §7)
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rootDir = process.cwd();
  const builder = new EnvBuilder({
    dataDir: process.env.UPIO_DATA_DIR || path.join(rootDir, 'data'),
    rootDir,
    port: Number(process.env.PORT || 8787),
  });
  const report = await builder.scan();
  console.log(JSON.stringify(report, null, 2));
  const res = await builder.build({}, (_event, payload) => console.error(`[env:${payload.level}] ${payload.line}`));
  console.log(JSON.stringify({ buildId: res.buildId, ok: res.ok, applied: res.applied, logsCount: res.logs.length }, null, 2));
}
