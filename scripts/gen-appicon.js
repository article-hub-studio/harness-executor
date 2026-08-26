// gen-appicon.js — Icon app nền ĐEN + glyph TRẮNG giống VS Code (simple-icons path)
// Sinh: web/icons/icon-{192,512}.png · favicon.svg · toàn bộ mipmap Android (legacy + round + foreground)
// Thuần node:zlib — rasterizer path tự viết (M/m L/l A/a Z/z, even-odd, supersample AA)
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- VS Code mark (simple-icons, viewBox 0 0 24 24) ----
const VSC_PATH = 'M23.15 2.587L18.21.21a1.49 1.49 0 0 0-1.705.29l-9.46 8.63l-4.12-3.128a1 1 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12L.326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a1 1 0 0 0 1.276.057l4.12-3.128l9.46 8.63a1.49 1.49 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352m-5.146 14.861L10.826 12l7.178-5.448z';

// ---------- CRC/PNG ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const tb = Buffer.from(type, 'ascii'); const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data]))); return Buffer.concat([len, tb, data, cb]); };
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- path interpreter: trả danh sách polygon (mỗi polygon = mảng điểm) ----------
function flattenPath(d) {
  const tokens = d.match(/[MmLlAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  const next = () => parseFloat(tokens[i++]);
  const polys = []; let cur = []; let cx = 0, cy = 0, sx = 0, sy = 0;
  const arcToLines = (x1, y1, rx, ry, phiDeg, fA, fS, x2, y2) => {
    // endpoint-parameterization → sample thẳng N điểm (arc nhỏ nên đủ mượt)
    if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x2, y2]];
    const phi = phiDeg * Math.PI / 180;
    const X1 = Math.cos(phi) * (x1 - x2) / 2 + Math.sin(phi) * (y1 - y2) / 2;
    const Y1 = -Math.sin(phi) * (x1 - x2) / 2 + Math.cos(phi) * (y1 - y2) / 2;
    let rx2 = Math.abs(rx), ry2 = Math.abs(ry);
    const lam = X1 * X1 / (rx2 * rx2) + Y1 * Y1 / (ry2 * ry2);
    if (lam > 1) { const s = Math.sqrt(lam); rx2 *= s; ry2 *= s; }
    const sign = (fA !== fS) ? 1 : -1;
    const den = rx2 * rx2 * ry2 * ry2 - rx2 * rx2 * Y1 * Y1 - ry2 * ry2 * X1 * X1;
    const co = Math.sqrt(Math.max(0, den / den === Infinity ? 0 : (den / (rx2 * rx2 * Y1 * Y1 + ry2 * ry2 * X1 * X1))));
    const cxp = sign * co * rx2 * Y1 / ry2;
    const cyp = sign * -co * ry2 * X1 / rx2;
    const ccx = Math.cos(phi) * cxp - Math.sin(phi) * cyp + (x1 + x2) / 2;
    const ccy = Math.sin(phi) * cxp + Math.cos(phi) * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => {
      const dot = ux * vx + uy * vy, len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      let a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1))));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    };
    const th1 = ang(1, 0, (X1 - cxp) / rx2, (Y1 - cyp) / ry2);
    let dth = ang((X1 - cxp) / rx2, (Y1 - cyp) / ry2, (-X1 - cxp) / rx2, (-Y1 - cyp) / ry2);
    if (!fS && dth > 0) dth -= 2 * Math.PI;
    if (fS && dth < 0) dth += 2 * Math.PI;
    const N = 14; const pts = [];
    for (let k = 1; k <= N; k++) {
      const t = th1 + dth * k / N;
      pts.push([
        ccx + rx2 * Math.cos(t) * Math.cos(phi) - ry2 * Math.sin(t) * Math.sin(phi),
        ccy + rx2 * Math.cos(t) * Math.sin(phi) + ry2 * Math.sin(t) * Math.cos(phi),
      ]);
    }
    return pts;
  };
  while (i < tokens.length) {
    const cmd = tokens[i];
    if (/^[Mm]$/.test(cmd)) {
      i++; if (cur.length) polys.push(cur);
      cur = [];
      const x = next(), y = next();
      cx = cmd === 'M' ? x : cx + x; cy = cmd === 'M' ? y : cy + y;
      sx = cx; sy = cy; cur.push([cx, cy]);
    } else if (/^[Ll]$/.test(cmd)) {
      i++; const x = next(), y = next();
      cx = cmd === 'L' ? x : cx + x; cy = cmd === 'L' ? y : cy + y;
      cur.push([cx, cy]);
    } else if (/^[Aa]$/.test(cmd)) {
      i++; const rx = next(), ry = next(), rot = next(), fA = next(), fS = next(), x = next(), y = next();
      const ax = cmd === 'A' ? x : cx + x, ay = cmd === 'A' ? y : cy + y;
      for (const p of arcToLines(cx, cy, rx, ry, rot, fA, fS, ax, ay)) cur.push(p);
      cx = ax; cy = ay;
    } else if (/^[Zz]$/.test(cmd)) {
      i++; cur.push([sx, sy]); polys.push(cur); cur = [];
      cx = sx; cy = sy;
    } else i++;
  }
  if (cur.length) polys.push(cur);
  return polys.filter((p) => p.length >= 3);
}

/** Rasterizer even-odd: glyph trắng trên bg tuỳ chọn (mask rounded-rect | circle | none) */
function renderIcon(S, { mask = 'roundrect', bg = [10, 10, 10], scaleRatio = 0.64, ss = 3 }) {
  const px = Buffer.alloc(S * S * 4);
  const polys = flattenPath(VSC_PATH);
  // transform 24-unit → S với padding
  const k = (S * scaleRatio) / 24;
  const off = (S - 24 * k) / 2;
  // edges đã transform (supersample theo trục y)
  const edges = [];
  for (const poly of polys) {
    for (let j = 0; j < poly.length; j++) {
      const [xa, ya] = poly[j]; const [xb, yb] = poly[(j + 1) % poly.length];
      edges.push([xa * k + off, ya * k + off, xb * k + off, yb * k + off]);
    }
  }
  const R = S * 0.225, half = S / 2;
  const sdRR = (x, y) => {
    const qx = Math.abs(x - half) - (half - R); const qy = Math.abs(y - half) - (half - R);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R;
  };
  const step = 1 / ss;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = (y * S + x) * 4;
      let aBg = 0, aFg = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const pxp = x + (sx + 0.5) * step, pyp = y + (sy + 0.5) * step;
        // mask nền
        let m = 1;
        if (mask === 'roundrect') m = sdRR(pxp, pyp) <= 0 ? 1 : 0;
        else if (mask === 'circle') m = Math.hypot(pxp - half, pyp - half) <= half ? 1 : 0;
        aBg += m;
        // even-odd crossing cho glyph
        let cross = 0;
        for (const e of edges) {
          const [ex1, ey1, ex2, ey2] = e;
          if ((ey1 <= pyp && ey2 > pyp) || (ey2 <= pyp && ey1 > pyp)) {
            const t = (pyp - ey1) / (ey2 - ey1);
            if (ex1 + t * (ex2 - ex1) > pxp) cross++;
          }
        }
        if (cross % 2 === 1) aFg++;
      }
      const tot = ss * ss;
      const bgA = aBg / tot;
      if (bgA <= 0) { px[idx + 3] = 0; continue; }
      const fg = aFg / tot;
      px[idx] = Math.round(bg[0] + (255 - bg[0]) * fg);
      px[idx + 1] = Math.round(bg[1] + (255 - bg[1]) * fg);
      px[idx + 2] = Math.round(bg[2] + (255 - bg[2]) * fg);
      px[idx + 3] = Math.round(bgA * 255);
    }
  }
  return px;
}

// ---------- sinh file ----------
await mkdir(path.join(ROOT, 'web', 'icons'), { recursive: true });
for (const S of [192, 512]) {
  const png = encodePNG(S, S, renderIcon(S, { mask: 'roundrect' }));
  await writeFile(path.join(ROOT, 'web', 'icons', `icon-${S}.png`), png);
  console.log(`✔ web/icons/icon-${S}.png (${(png.length / 1024).toFixed(1)} KB)`);
}
await writeFile(path.join(ROOT, 'web', 'icons', 'favicon.svg'),
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.4" fill="#0a0a0a"/><g transform="translate(4.32 4.32) scale(0.64)"><path fill="#ffffff" d="${VSC_PATH}"/></g></svg>
`);
console.log('✔ web/icons/favicon.svg');

// Android mipmaps
const RES = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'res');
const DENS = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];
for (const [dpi, size] of DENS) {
  const dir = path.join(RES, `mipmap-${dpi}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'ic_launcher.png'), encodePNG(size, size, renderIcon(size, { mask: 'roundrect' })));
  await writeFile(path.join(dir, 'ic_launcher_round.png'), encodePNG(size, size, renderIcon(size, { mask: 'circle' })));
  await writeFile(path.join(dir, 'ic_launcher_foreground.png'), encodePNG(size, size, renderIcon(size, { mask: 'none', scaleRatio: 0.52 })));
  console.log(`✔ mipmap-${dpi} (launcher · round · foreground @${size}px)`);
}
// Adaptive background màu đen thuần
await writeFile(path.join(RES, 'values', 'ic_launcher_background.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0A0A0A</color>
</resources>
`);
console.log('✔ values/ic_launcher_background.xml (#0A0A0A)');
console.log('done.');
