// builtin-servers/handlers/msg.js — họ op `msg.*`: send_channel/send_dm/send_email/broadcast/inbox/invite.
import { int, pick, chance, hex, agoMs, isoAgo, aheadMs, clamp, str, word, titleCase } from '../util.js';

export default {
  async send_channel(args, r) {
    let channel = str(args.channel, '#general');
    if (!channel.startsWith('#') && !channel.startsWith('@')) channel = '#' + channel;
    const text = str(args.text ?? args.message, '(no text)');
    return {
      channel,
      messageId: `msg_${hex(r, 10)}`,
      text,
      status: 'sent',
      ts: isoAgo(r, 0.001),
    };
  },

  async send_dm(args, r) {
    let user = str(args.user ?? args.to, '@user');
    if (!user.startsWith('@')) user = '@' + user;
    return {
      user,
      messageId: `dm_${hex(r, 10)}`,
      text: str(args.text ?? args.message, '(no text)'),
      status: 'delivered',
    };
  },

  async send_email(args, r) {
    const to = str(args.to ?? args.recipient, 'someone@example.com');
    return {
      to,
      subject: str(args.subject, '(no subject)'),
      messageId: `<${hex(r, 12)}@smtp.upio.mock>`,
      provider: 'smtp-sim',
      status: 'queued',
      attempts: 1,
      queuedAtMs: agoMs(r, 0.001),
    };
  },

  async broadcast(args, r) {
    const channels = Array.isArray(args.channels) && args.channels.length
      ? args.channels.map(String)
      : ['#announcements'];
    return {
      messageId: `bc_${hex(r, 8)}`,
      channels,
      recipients: int(r, 40, 9000),
      text: str(args.text ?? args.message, '(no text)'),
      status: 'broadcasting',
    };
  },

  async fetch_inbox(args, r) {
    const limit = clamp(Math.round(Number(args.limit) || 10), 1, 25);
    const messages = Array.from({ length: limit }, () => ({
      id: `in_${hex(r, 8)}`,
      from: '@' + word(r),
      subject: titleCase(r, int(r, 2, 4)),
      preview: `Tóm tắt nhanh về ${word(r)}-${word(r)} kèm ${int(r, 1, 4)} việc cần xử lý.`,
      receivedAtMs: agoMs(r, 3),
      unread: chance(r, 0.35),
    }));
    messages.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
    return { messages, unread: messages.filter((m) => m.unread).length, total: messages.length };
  },

  async create_invite(args, r) {
    const code = hex(r, 8).toUpperCase();
    return {
      code,
      url: `https://chat.upio.mock/inv/${code}`,
      title: str(args.title, 'Team sync'),
      when: str(args.when, null),
      expiresAtMs: aheadMs(r, int(r, 1, 14)),
      maxUses: pick(r, [1, 5, 25, 100]),
    };
  },
};
