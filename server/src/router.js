// router.js — router tối giản không phụ thuộc: route(method, pattern, handler) với :param
// handler(ctx) với ctx = {req,res,params,query,body,url,send,json,sse}

/** @returns {{routes:Array}} router instance */
export function createRouter() {
  const routes = [];

  const compile = (pattern) => {
    const keys = [];
    // ':' không thuộc tập escape nên giữ nguyên; thay :param bằng group bắt
    const rx = new RegExp('^' + pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    return { rx, keys };
  };

  return {
    routes,
    add(method, pattern, handler) {
      const { rx, keys } = compile(pattern);
      routes.push({ method, rx, keys, handler });
    },
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.rx.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { ...r, params };
      }
      return null;
    },
  };
}

/** Đọc body JSON (giới hạn mặc định 2MB). */
export function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
