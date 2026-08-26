// gen-icons.js — sinh icon PNG cho PWA KHÔNG cần thư viện ngoài (zlib + CRC32 tự viết)
// Kết quả: web/icons/icon-192.png, web/icons/icon-512.png (gradient teal→violet, ring "executor")
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'icons');

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Mã hoá mảng RGBA (Uint8Array 4*w*h) thành PNG buffer. */
export function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bitdepth 8, RGBA
  // scanline: mỗi dòng prefix filter byte 0
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy ? rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
      : raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** SDF rounded rectangle tại điểm (px,py) tâm (cx,cy), nửa kích thước (hx,hy), bo góc r. */
const sdRoundRect = (px, py, cx, cy, hx, hy, r) => {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
};

function drawIcon(S) {
  const px = Buffer.alloc(S * S * 4);
  const BG = [17, 17, 19];        // nền đen #111113
  const WHITE = [255, 255, 255];
  const R = S * 0.225;              // bo góc icon
  const half = S / 2;
  const ringOuter = S * 0.27, ringInner = S * 0.175, ringR = S * 0.09;
  const dotR = S * 0.062;
  const aa = 1;                     // khử răng cưa 1px
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      // nền phẳng trong hình vuông bo góc (trắng–đen tối giản)
      const dCorner = sdRoundRect(x + 0.5, y + 0.5, half, half, half - 0.5, half - 0.5, R);
      const bgA = clamp01(0.5 - dCorner / aa);
      if (bgA <= 0) { px[i + 3] = 0; continue; }
      let r = BG[0], g = BG[1], b = BG[2];
      // vòng "executor" trắng
      const sdO = sdRoundRect(x + 0.5, y + 0.5, half, half, ringOuter, ringOuter, ringR);
      const sdI = sdRingInner(x + 0.5, y + 0.5, half, ringInner, ringR * 0.8);
      const ring = clamp01(0.5 - Math.abs(sdO + Math.max(sdI, 0) * 0) / aa) * (sdI > 0 ? 1 : 0);
      // chấm trung tâm
      const dc = Math.hypot(x + 0.5 - half, y + 0.5 - half) - dotR;
      const dot = clamp01(0.5 - dc / aa);
      const fg = Math.min(1, ring + dot);
      r = lerp(r, WHITE[0], fg); g = lerp(g, WHITE[1], fg); b = lerp(b, WHITE[2], fg);
      px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(bgA * 255);
    }
  }
  return px;

  /** inner cut: rounded rect nhỏ hơn (lỗ giữa của ring) — dương khi ở TRONG lỗ */
  function sdRingInner(x, y, c, h, rr) {
    return -sdRoundRect(x, y, c, c, h, h, rr);
  }
}

await mkdir(OUT, { recursive: true });
for (const S of [192, 512]) {
  const png = encodePNG(S, S, drawIcon(S));
  await writeFile(path.join(OUT, `icon-${S}.png`), png);
  console.log(`✔ web/icons/icon-${S}.png (${(png.length / 1024).toFixed(1)} KB)`);
}
console.log('done.');
