// builtin-servers/handlers/fs.js — họ op `fs.*`: mô phỏng filesystem (không đụng disk thật).
import { int, chance, hex, pick, agoMs, isoAgo, clamp, str, word } from '../util.js';
import { Buffer } from 'node:buffer';

const FILE_NAMES = [
  'report.pdf', 'notes.md', 'config.yaml', 'index.ts', 'logo.svg', 'budget.csv',
  'backup.sql', 'photo.png', 'archive.tar.gz', 'README.txt', 'app.log', 'schema.json',
];
const DIR_NAMES = ['src', 'docs', 'assets', 'build', 'tests', 'config', 'scripts', 'logs', 'data', '.github'];

function uniqueName(r, used, isDir) {
  for (let i = 0; i < 12; i++) {
    const n = isDir ? pick(r, DIR_NAMES) : pick(r, FILE_NAMES);
    if (!used.has(n)) { used.add(n); return n; }
  }
  const n = `${isDir ? 'dir' : 'file'}-${hex(r, 4)}`;
  used.add(n);
  return n;
}

function entry(r, name, isDir) {
  return { name, type: isDir ? 'dir' : 'file', size: isDir ? 0 : int(r, 128, 8_800_000), mtimeMs: agoMs(r, 120) };
}

export default {
  async list_dir(args, r) {
    const path = str(args.path, '/');
    const total = int(r, 6, 14);
    const used = new Set();
    const entries = [];
    for (let i = 0; i < total; i++) {
      const isDir = i < 2 || chance(r, 0.28);
      entries.push(entry(r, uniqueName(r, used, isDir), isDir));
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path, entries, total: entries.length };
  },

  async read_file(args, r) {
    const path = str(args.path, '/tmp/notes.md');
    const maxBytes = clamp(Math.round(Number(args.maxBytes) || 2048), 64, 262_144);
    const base = path.split('/').pop() || 'file';
    let content = [
      `# ${base}`,
      '',
      `Snapshot mô phỏng của "${base}" sinh offline bởi upio builtin server.`,
      '',
      `- revision: r${int(r, 100, 999)}`,
      `- checksum: sha256:${hex(r, 16)}...`,
      `- generated: ${isoAgo(r, 14)}`,
      '',
      'Phần nội dung còn lại được simulator cắt ngắn một cách có chủ đích.',
    ].join('\n');
    const truncated = content.length > maxBytes;
    if (truncated) content = content.slice(0, Math.max(0, maxBytes - 3)) + '...';
    return { path, encoding: 'utf-8', size: Buffer.byteLength(content) + int(r, 240, 90_000), truncated, content };
  },

  async write_file(args, r) {
    const path = str(args.path, '/tmp/out.txt');
    const bytesWritten = Buffer.byteLength(String(args.content ?? ''), 'utf8');
    return { path, bytesWritten, created: chance(r, 0.5), mode: '0644', mtimeMs: agoMs(r, 0.01) };
  },

  async tree(args, r) {
    const root = str(args.root, '.');
    const depth = clamp(Math.round(Number(args.depth) || 3), 1, 4);
    const nodes = [{ path: root, type: 'dir', depth: 0 }];
    let dirs = 1;
    let files = 0;
    const walk = (prefix, d) => {
      const used = new Set();
      const count = int(r, 2, 6);
      for (let i = 0; i < count; i++) {
        const isDir = d < depth && chance(r, 0.35);
        const p = `${prefix}/${uniqueName(r, used, isDir)}`;
        if (isDir) {
          dirs += 1;
          nodes.push({ path: p, type: 'dir', depth: d });
          walk(p, d + 1);
        } else {
          files += 1;
          nodes.push({ path: p, type: 'file', depth: d, size: int(r, 64, 500_000) });
        }
      }
    };
    walk(root, 1);
    return { root, depth, nodes, dirs, files };
  },

  async get_info(args, r) {
    const path = str(args.path, '/srv/data');
    const isFile = /\.[a-z0-9]{1,5}$/i.test(path) || chance(r, 0.5);
    return {
      path,
      type: isFile ? 'file' : 'dir',
      size: isFile ? int(r, 256, 4_000_000) : 4096,
      createdAtMs: agoMs(r, 365),
      modifiedAtMs: agoMs(r, 60),
      permissions: isFile ? '-rw-r--r--' : 'drwxr-xr-x',
      owner: `${word(r)}-${word(r)}`,
      exists: true,
    };
  },

  async search_files(args, r) {
    const pattern = str(args.pattern, '*');
    const root = str(args.root, '.');
    const stem = pattern.replace(/[*?.]/g, '').trim() || 'entry';
    const ext = pattern.includes('.') ? pattern.split('.').pop() : pick(r, ['txt', 'log', 'json', 'ts']);
    const matches = [];
    for (let i = 0, n = int(r, 2, 8); i < n; i++) {
      matches.push({
        path: `${root}/${pick(r, DIR_NAMES)}/${stem}-${hex(r, 4)}.${ext.replace(/[*?]/g, '') || 'txt'}`,
        type: 'file',
        size: int(r, 32, 200_000),
        mtimeMs: agoMs(r, 30),
      });
    }
    return { pattern, root, matches, total: matches.length, truncated: false };
  },
};
