// builtin-servers/handlers/git.js — họ op `git.*`: mô phỏng repository metadata.
import { int, float, pick, picks, chance, hex, isoAgo, clamp, str, word, titleCase, cap } from '../util.js';

const AUTHORS = ['An Tran', 'Binh Nguyen', 'Chi Le', 'David Pham', 'Emma Vo', 'Giang Hoang'];
const MESSAGES = [
  'feat: add seeded RNG dispatcher', 'fix: clamp row limits in db.query', 'chore: bump toolchain',
  'refactor: split handler modules by family', 'test: cover permission gates', 'docs: describe builtin transports',
  'perf: cache registry lookups', 'fix: stabilize diff ordering', 'feat: expose listServerIds',
];
const BRANCHES = ['main', 'develop', 'release/1.4', 'feature/seeded-rng', 'fix/meta-duration', 'chore/cleanup'];
const FILE_EXT = ['js', 'ts', 'json', 'md', 'yaml', 'css'];
const FUNCS = ['dispatch', 'loadRegistry', 'validateArgs', 'buildMeta', 'renderDiff'];

function commit(r) {
  return {
    hash: hex(r, 7),
    msg: pick(r, MESSAGES),
    author: pick(r, AUTHORS),
    date: isoAgo(r, 60),
    filesChanged: int(r, 1, 9),
  };
}

export default {
  async log(args, r) {
    const repo = str(args.repo, '.');
    const limit = clamp(Math.round(Number(args.limit) || 10), 1, 20);
    const commits = Array.from({ length: limit }, () => commit(r));
    commits.sort((a, b) => (a.date < b.date ? 1 : -1)); // mới nhất trước
    return { repo, branch: pick(r, ['main', 'develop']), commits, total: commits.length };
  },

  async status(args, r) {
    const repo = str(args.repo, '.');
    const staged = picks(r, ['server/src/index.js', 'data/mcps.json', 'README.md'], int(r, 0, 2))
      .map((f) => ({ file: f, change: pick(r, ['modified', 'added']) }));
    const unstaged = picks(r, ['handlers/db.js', 'util.js', 'tests/builtin.test.mjs'], int(r, 0, 3))
      .map((f) => ({ file: f, change: 'modified' }));
    const untracked = chance(r, 0.55) ? [`notes-${hex(r, 3)}.md`] : [];
    return {
      repo,
      branch: pick(r, ['main', 'develop']),
      clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
      ahead: int(r, 0, 4),
      behind: chance(r, 0.7) ? 0 : int(r, 1, 3),
      staged,
      unstaged,
      untracked,
    };
  },

  async diff(args, r) {
    const repo = str(args.repo, '.');
    const base = str(args.base, 'HEAD~1');
    const head = str(args.head, 'worktree');
    const files = [];
    let additions = 0;
    let deletions = 0;
    for (let i = 0, n = int(r, 2, 6); i < n; i++) {
      const a = int(r, 1, 80);
      const d = int(r, 0, 40);
      additions += a;
      deletions += d;
      files.push({
        file: `src/${word(r)}-${word(r)}.${pick(r, FILE_EXT)}`,
        additions: a,
        deletions: d,
        patch: `@@ -${int(r, 10, 200)},${d + 1} +${int(r, 10, 200)},${a + 1} @@ ${pick(r, FUNCS)}()`,
      });
    }
    return { repo, base, head, files, additions, deletions };
  },

  async branch_list(args, r) {
    const repo = str(args.repo, '.');
    const names = picks(r, BRANCHES, int(r, 3, 6));
    if (!names.includes('main')) names.unshift('main');
    const branches = names.map((name) => ({
      name,
      lastCommitHash: hex(r, 7),
      author: pick(r, AUTHORS),
      lastCommitAtMs: Date.parse(isoAgo(r, 45)),
    }));
    return { repo, current: 'main', branches, total: branches.length };
  },

  async commit_create(args, r) {
    const message = str(args.message, 'wip: simulated commit');
    return {
      repo: str(args.repo, '.'),
      branch: pick(r, ['main', 'develop']),
      hash: hex(r, 7),
      message,
      author: pick(r, AUTHORS),
      date: isoAgo(r, 0.001),
      filesChanged: int(r, 1, 5),
      status: 'created',
    };
  },

  async pr_summary(args, r) {
    const pr = clamp(Math.round(Number(args.pr) || 42), 1, 99_999);
    const additions = int(r, 20, 900);
    const state = pick(r, ['open', 'open', 'open', 'merged', 'draft']);
    return {
      repo: str(args.repo, '.'),
      pr,
      title: `${cap(word(r))} ${word(r)}: ${titleCase(r, 2).toLowerCase()} pipeline`,
      author: pick(r, AUTHORS),
      state,
      additions,
      deletions: int(r, 0, Math.floor(additions / 2)),
      commits: int(r, 1, 14),
      comments: int(r, 0, 23),
      reviewers: picks(r, AUTHORS, int(r, 1, 3)),
      summaryText:
        `PR #${pr} ${state === 'merged' ? 'đã được merge' : 'đang chờ review'} với ${int(r, 2, 9)} file thay đổi, ` +
        `tập trung vào ${word(r)} và ${word(r)}. Kiểm thử mô phỏng đều xanh.`,
    };
  },
};
