#!/usr/bin/env node
/**
 * Generates the PWA icons under public/icons/ without any dependency:
 *   icon-192.png, icon-512.png            -> rounded green square, white leaf ("any" purpose)
 *   icon-192-maskable.png, icon-512-maskable.png -> full-bleed green, leaf inside the 80 % safe zone
 *
 * Pure PNG encoder: RGBA raster -> filter-0 scanlines -> zlib deflate -> IHDR/IDAT/IEND chunks with CRC32.
 * Usage: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const GREEN = [0x16, 0x65, 0x34]; // #166534 (brand / theme colour)
const WHITE = [0xff, 0xff, 0xff];

// ---------- PNG encoding ----------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** rgba: Uint8Array of size w*h*4 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- Drawing ----------
/**
 * Coverage (0..1) of the leaf at a point, in icon-relative coordinates (0..1).
 * The leaf is a vesica (intersection of two discs) rotated 45 degrees, with a midrib cut out.
 */
function leafShape(px, py, scale) {
  // Centre + rotate so the tip points to the top-right.
  const cx = 0.5;
  const cy = 0.52;
  const s = scale;
  const dx = (px - cx) / s;
  const dy = (py - cy) / s;
  const cos = Math.SQRT1_2;
  const sin = Math.SQRT1_2;
  const u = dx * cos - dy * sin; // along the leaf axis
  const v = dx * sin + dy * cos; // across the leaf
  const a = 0.34; // half-length
  const b = 0.145; // half-width
  const r = (a * a + b * b) / (2 * b);
  const d = r - b;
  const inLens = Math.hypot(u, v - d) <= r && Math.hypot(u, v + d) <= r;
  if (!inLens) {
    // Stem: short bar continuing the axis below the lower tip.
    const stem = u < -a && u > -a - 0.09 && Math.abs(v) < 0.022;
    return stem ? 1 : 0;
  }
  // Midrib: a thin cut-out along the axis (leaves the tip solid).
  const rib = Math.abs(v) < 0.014 && u > -a * 0.85 && u < a * 0.55;
  return rib ? 0 : 1;
}

function roundedSquareMask(px, py, radius) {
  const x = Math.min(px, 1 - px);
  const y = Math.min(py, 1 - py);
  if (x >= radius || y >= radius) return 1;
  return Math.hypot(radius - x, radius - y) <= radius ? 1 : 0;
}

function render(size, { maskable }) {
  const rgba = new Uint8Array(size * size * 4);
  const SS = 3; // 3x3 supersampling for smooth edges
  const leafScale = maskable ? 0.8 : 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let leaf = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          const inBg = maskable ? 1 : roundedSquareMask(px, py, 0.2);
          bg += inBg;
          if (inBg) leaf += leafShape(px, py, leafScale);
        }
      }
      const n = SS * SS;
      const alpha = bg / n;
      const leafFrac = bg ? leaf / bg : 0;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(GREEN[0] + (WHITE[0] - GREEN[0]) * leafFrac);
      rgba[i + 1] = Math.round(GREEN[1] + (WHITE[1] - GREEN[1]) * leafFrac);
      rgba[i + 2] = Math.round(GREEN[2] + (WHITE[2] - GREEN[2]) * leafFrac);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-192-maskable.png', 192, { maskable: true }],
  ['icon-512-maskable.png', 512, { maskable: true }],
];
for (const [name, size, opts] of targets) {
  const png = render(size, opts);
  writeFileSync(resolve(OUT_DIR, name), png);
  console.log(`wrote public/icons/${name} (${size}x${size}, ${png.length} bytes)`);
}
