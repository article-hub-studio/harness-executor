// builtin-servers/handlers/prod.js — họ op `prod.*`: task/doc/sheet/calendar/thread.
import { int, float, pick, picks, chance, hex, agoMs, aheadMs, clamp, str, word, titleCase, cap, pad2 } from '../util.js';

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function slotLabel(d) {
  return `${DAY_NAMES[d.getUTCDay()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

export default {
  async create_task(args, r) {
    const taskId = `TASK-${int(r, 100, 999)}`;
    return {
      taskId,
      title: str(args.title ?? args.name, 'Untitled task'),
      priority: pick(r, PRIORITIES),
      status: 'todo',
      due: str(args.due ?? args.dueDate, null),
      assignee: str(args.assignee, null),
      url: `https://tasks.upio.mock/T/${taskId}`,
      createdAtMs: agoMs(r, 0.001),
    };
  },

  async list_tasks(args, r) {
    const tasks = Array.from({ length: int(r, 3, 8) }, () => ({
      id: `TASK-${int(r, 100, 999)}`,
      title: `${titleCase(r, 2)} ${pick(r, ['review', 'migration', 'rollout', 'audit', 'draft'])}`,
      status: pick(r, ['todo', 'todo', 'in_progress', 'done']),
      priority: pick(r, PRIORITIES),
      dueAtMs: aheadMs(r, 14),
    }));
    const filter = str(args.status, null);
    const visible = filter ? tasks.filter((t) => t.status === filter) : tasks;
    return {
      filter: filter ?? 'all',
      tasks: visible,
      total: visible.length,
      openCount: visible.filter((t) => t.status !== 'done').length,
    };
  },

  async update_sheet(args, r) {
    const rowsRaw = Array.isArray(args.rows) ? args.rows : [];
    const updatedRows = rowsRaw.length || 1;
    const updatedCells = rowsRaw.reduce((sum, row) => sum + (Array.isArray(row) ? row.length : 1), 0) || 1;
    return {
      sheet: str(args.sheet ?? args.spreadsheetId, 'sheet_main'),
      updatedCells,
      updatedRows,
      revision: int(r, 2, 400),
      status: 'updated',
    };
  },

  async calendar_find_slot(args, r) {
    const durationMin = clamp(Math.round(Number(args.durationMin) || 30), 5, 480);
    const dayOffset = int(r, 1, 5);
    const base = new Date(Date.UTC(2026, 0, 1) + dayOffset * 86_400_000);
    const slots = [[9, 0], [13, 30], [15, 0]].map(([h, m]) => {
      const start = new Date(base);
      start.setUTCHours(h, m, 0, 0);
      return { startMs: start.getTime(), endMs: start.getTime() + durationMin * 60_000, label: slotLabel(start) };
    });
    return { durationMin, timeZone: 'UTC', slots, total: slots.length };
  },

  async create_doc(args, r) {
    const docId = `doc_${hex(r, 8)}`;
    const content = str(args.content, '');
    return {
      docId,
      title: str(args.title, 'Untitled document'),
      url: `https://docs.upio.mock/d/${docId}`,
      words: content ? content.trim().split(/\s+/).length : int(r, 40, 1200),
      revision: int(r, 1, 30),
      status: 'created',
    };
  },

  async summarize_thread(args, r) {
    const participants = picks(r, ['@an', '@binh', '@chi', '@david', '@emma', '@giang'], int(r, 3, 5));
    return {
      threadId: str(args.threadId ?? args.thread, 'thrd-1'),
      participants,
      messageCount: int(r, 4, 40),
      summary: `Nhóm thảo luận về ${word(r)}-${word(r)}: thống nhất tiếp cận theo từng giai đoạn và chốt deadline trước cuối tháng.`,
      decisions: [
        `Chấp nhận phương án ${word(r)} cho phần tích hợp.`,
        chance(r, 0.5) ? `Hoãn phần ${word(r)} sang chu kỳ sau.` : `Giữ nguyên cấu hình hiện tại.`,
      ],
      actionItems: Array.from({ length: int(r, 1, 3) }, () => ({
        task: `${titleCase(r, 2)} checklist`,
        assignee: pick(r, participants),
      })),
    };
  },
};
