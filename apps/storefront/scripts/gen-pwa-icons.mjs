// Sinh icon PWA (PNG) tự host, không phụ thuộc, không tải mạng: nền màu nhấn thương hiệu + chữ "X" trắng.
// Chạy: node apps/storefront/scripts/gen-pwa-icons.mjs  (kết quả commit vào public/icons).
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const ACCENT = [0x6d, 0x26, 0x35]; // --accent trong src/styles/tokens.css
const WHITE = [0xff, 0xff, 0xff];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Khoảng cách từ điểm tới đoạn thẳng (a→b). */
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** `span` = tỉ lệ cạnh icon mà chữ X chiếm (maskable cần nằm trong vùng an toàn ~80%). */
function png(size, span) {
  const m = (size * (1 - span)) / 2;
  const w = size * 0.11;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const d = Math.min(
        distSeg(x + 0.5, y + 0.5, m, m, size - m, size - m),
        distSeg(x + 0.5, y + 0.5, size - m, m, m, size - m),
      );
      const a = Math.max(0, Math.min(1, w / 2 + 0.5 - d)); // khử răng cưa
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(ACCENT[c] * (1 - a) + WHITE[c] * a);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "icon-192.png"), png(192, 0.5));
writeFileSync(join(OUT, "icon-512.png"), png(512, 0.5));
writeFileSync(join(OUT, "maskable-512.png"), png(512, 0.4));
writeFileSync(join(OUT, "apple-touch-icon.png"), png(180, 0.5));
