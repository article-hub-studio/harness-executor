// sse.js — Server-Sent Events hub: broadcast toàn cục cho mọi client /api/events
export class SseHub {
  constructor() { this.clients = new Set(); this.seq = 0; }

  /** Thêm một response client; trả hàm remove. */
  add(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);
    this.clients.add(res);
    const keepAlive = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* noop */ } }, 25000);
    const remove = () => {
      clearInterval(keepAlive);
      this.clients.delete(res);
      try { res.end(); } catch { /* noop */ }
    };
    res.on('close', remove);
    res.on('error', remove);
    return remove;
  }

  /** Phát event tới toàn bộ client. Tên event chỉ [a-z-]. */
  broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify({ seq: ++this.seq, ts: Date.now(), ...payload })}\n\n`;
    for (const res of this.clients) {
      try { res.write(frame); } catch { this.clients.delete(res); }
    }
    return this.clients.size;
  }

  get size() { return this.clients.size; }
}
