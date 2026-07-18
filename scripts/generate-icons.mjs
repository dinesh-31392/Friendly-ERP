/**
 * Generate the PWA app icons as real PNGs.
 *
 * There is no image tooling in this project (no sharp / canvas / ImageMagick),
 * and installability requires actual PNG bitmaps — Android needs 192 + 512, and
 * iOS ignores the manifest and only reads <link rel="apple-touch-icon">, which
 * must be a PNG. So this writes the PNGs directly: PNG is just chunks of
 * zlib-deflated scanlines, and zlib is a Node built-in.
 *
 *   npm run icons
 *
 * Re-run after changing BRAND below. Output: public/icons/*.png
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// Brand: matches the app's indigo→violet gradient (tailwind indigo-500 → violet-600)
const BRAND = { from: [99, 102, 241], to: [124, 58, 237], glyph: [255, 255, 255] };

// ── Minimal PNG encoder ──────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
/** rgba: Uint8Array of w*h*4 → PNG buffer */
function encodePng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                                   // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing ──────────────────────────────────────────────────────────────────
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/**
 * @param size    px (square)
 * @param inset   fraction of the canvas to keep clear around the glyph.
 *                Maskable icons get cropped to a circle by the launcher, so the
 *                glyph must sit inside the central 80% "safe zone" — anything
 *                outside can be shaved off.
 * @param radius  corner radius fraction; 0 = full-bleed square (maskable wants
 *                full bleed because the launcher supplies the mask).
 */
function drawIcon(size, { inset = 0.22, radius = 0.22 } = {}) {
  const px = new Uint8Array(size * size * 4);
  const r = radius * size;
  const set = (x, y, [cr, cg, cb], a = 255) => {
    const i = (y * size + x) * 4;
    px[i] = cr; px[i + 1] = cg; px[i + 2] = cb; px[i + 3] = a;
  };
  // Background: vertical gradient, optional rounded corners
  for (let y = 0; y < size; y++) {
    const col = mix(BRAND.from, BRAND.to, y / (size - 1));
    for (let x = 0; x < size; x++) {
      let a = 255;
      if (r > 0) {
        // distance outside the rounded-rect corner → transparent
        const dx = Math.max(r - x, x - (size - 1 - r), 0);
        const dy = Math.max(r - y, y - (size - 1 - r), 0);
        const d = Math.hypot(dx, dy);
        if (d > r) a = 0;
        else if (d > r - 1) a = Math.round(255 * (r - d));   // cheap AA
      }
      set(x, y, col, a);
    }
  }
  // Glyph: a simple building — tower block + windows. Geometric on purpose;
  // it stays legible at 48px in a launcher.
  const S = size * (1 - inset * 2);          // glyph box
  const O = size * inset;                    // glyph origin
  const rect = (fx, fy, fw, fh) => {
    const x0 = Math.round(O + fx * S), y0 = Math.round(O + fy * S);
    const x1 = Math.round(O + (fx + fw) * S), y1 = Math.round(O + (fy + fh) * S);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (x >= 0 && y >= 0 && x < size && y < size) set(x, y, BRAND.glyph);
    }
  };
  const clear = (fx, fy, fw, fh) => {
    const x0 = Math.round(O + fx * S), y0 = Math.round(O + fy * S);
    const x1 = Math.round(O + (fx + fw) * S), y1 = Math.round(O + (fy + fh) * S);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (x >= 0 && y >= 0 && x < size && y < size) {
        const col = mix(BRAND.from, BRAND.to, y / (size - 1));
        set(x, y, col);
      }
    }
  };
  rect(0.10, 0.16, 0.44, 0.84);   // tall tower
  rect(0.56, 0.40, 0.34, 0.60);   // shorter wing
  // windows (punched back to the gradient)
  for (let row = 0; row < 4; row++) {
    clear(0.18, 0.26 + row * 0.16, 0.10, 0.08);
    clear(0.34, 0.26 + row * 0.16, 0.10, 0.08);
  }
  for (let row = 0; row < 3; row++) {
    clear(0.63, 0.50 + row * 0.16, 0.09, 0.08);
    clear(0.77, 0.50 + row * 0.16, 0.09, 0.08);
  }
  return encodePng(px, size, size);
}

mkdirSync(OUT, { recursive: true });
const ICONS = [
  // [file, size, opts, why]
  ['icon-192.png', 192, { inset: 0.20, radius: 0.20 }, 'Android home screen (required)'],
  ['icon-512.png', 512, { inset: 0.20, radius: 0.20 }, 'splash + store listing (required)'],
  ['icon-192-maskable.png', 192, { inset: 0.28, radius: 0 }, 'adaptive icon, safe zone'],
  ['icon-512-maskable.png', 512, { inset: 0.28, radius: 0 }, 'adaptive icon, safe zone'],
  ['apple-touch-icon.png', 180, { inset: 0.20, radius: 0 }, 'iOS ignores the manifest; needs this'],
  ['favicon-32.png', 32, { inset: 0.14, radius: 0.18 }, 'browser tab'],
];
for (const [file, size, opts, why] of ICONS) {
  const png = drawIcon(size, opts);
  writeFileSync(join(OUT, file), png);
  console.log(`  ${file.padEnd(24)} ${String(size + 'px').padEnd(6)} ${String(png.length).padStart(6)} bytes   ${why}`);
}
console.log(`\n${ICONS.length} icons written to public/icons/`);
