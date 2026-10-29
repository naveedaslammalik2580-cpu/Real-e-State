// Draws the RealtorOS app mark and writes every size the install flow
// needs. Run it after changing the mark:
//
//   node tools/make-pwa-icons.mjs
//
// WHY A SCRIPT RATHER THAN AN EXPORTED SET. The mark is four shapes and
// two colours. A generator keeps the sizes honest - change the roof and
// every icon changes with it - and means nobody has to install a design
// tool, or a rasteriser, to touch an icon. It writes PNGs with node's own
// zlib and nothing else.
//
// WHAT IT DRAWS. A rounded square in the sidebar's midnight ink, with a
// house outline in the sidebar's emerald: a roof, two walls, and a gap
// where the door is. It reads at 32px, which is the only size that is
// genuinely hard.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "app", "assets", "icons");

// Straight from the CSS tokens: --sidebar-bg and --sidebar-accent.
const INK = [0x0b, 0x1f, 0x33];
const EMERALD = [0x34, 0xd3, 0x99];

/**
 * The mark, in a 0..1 square. Returns the colour at (x, y) or null for
 * "background here". Everything is a half-plane or a box test, which is
 * all a house needs.
 */
function markColorAt(x, y, stroke) {
  // Roof: the band between two parallel chevrons, clipped to the eaves.
  const roofApexY = 0.26;
  const roofBaseY = 0.50;
  const slope = (roofBaseY - roofApexY) / 0.26;       // half-width 0.26
  const roofEdge = roofApexY + Math.abs(x - 0.5) * slope;
  const onRoof = y >= roofEdge && y <= roofEdge + stroke
    && y <= roofBaseY + stroke && Math.abs(x - 0.5) <= 0.30;
  if (onRoof) return EMERALD;

  // Walls: two verticals from under the eaves to the floor. wallTop sits
  // below where the roof band crosses the wall (0.26 + 0.215 * slope +
  // stroke) so the walls do not poke through the roof as two nubs.
  const wallTop = 0.52;
  const wallBottom = 0.76;
  const wallX = 0.215;
  const onWall = y >= wallTop && y <= wallBottom
    && (Math.abs(x - (0.5 - wallX)) <= stroke / 2 || Math.abs(x - (0.5 + wallX)) <= stroke / 2);
  if (onWall) return EMERALD;

  // Floor, with the doorway left open in the middle.
  const onFloor = Math.abs(y - wallBottom) <= stroke / 2
    && Math.abs(x - 0.5) <= wallX + stroke / 2
    && Math.abs(x - 0.5) >= 0.075;
  if (onFloor) return EMERALD;

  return null;
}

/** A rounded square covering the whole canvas, in 0..1 coordinates. */
function insideRoundedSquare(x, y, radius) {
  const dx = Math.max(radius - x, 0, x - (1 - radius));
  const dy = Math.max(radius - y, 0, y - (1 - radius));
  if (dx === 0 || dy === 0) return true;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * @param size      pixels square
 * @param maskable  true: the background bleeds to the edges and the mark
 *                  shrinks into the safe zone, which is what a maskable
 *                  icon is for - the launcher may crop it to a circle.
 */
function render(size, { maskable = false, transparent = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  // 4x4 supersampling: the diagonals of the roof are the whole mark, and
  // unsampled diagonals at 32px look like a staircase.
  const S = 4;
  const radius = maskable ? 0 : 0.22;
  const markScale = maskable ? 0.58 : 0.78;
  const stroke = 0.075;

  for (let yi = 0; yi < size; yi++) {
    for (let xi = 0; xi < size; xi++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (xi + (sx + 0.5) / S) / size;
          const y = (yi + (sy + 0.5) / S) / size;
          if (!insideRoundedSquare(x, y, radius)) continue;
          bg++;
          // The mark, scaled about the centre of the square.
          const mx = 0.5 + (x - 0.5) / markScale;
          const my = 0.5 + (y - 0.5) / markScale;
          if (mx < 0 || mx > 1 || my < 0 || my > 1) continue;
          if (markColorAt(mx, my, stroke / markScale)) fg++;
        }
      }
      const total = S * S;
      const bgA = bg / total;
      const fgA = fg / total;
      const i = (yi * size + xi) * 4;
      if (bgA === 0) continue;                      // fully outside: transparent
      // Emerald over ink, both inside the rounded square.
      const base = transparent ? null : INK;
      for (let c = 0; c < 3; c++) {
        const under = base ? base[c] : EMERALD[c];
        px[i + c] = Math.round(under * (1 - fgA) + EMERALD[c] * fgA);
      }
      px[i + 3] = Math.round(255 * (transparent ? Math.max(fgA, bgA * 0) : bgA));
    }
  }
  return pngFromRgba(px, size, size);
}

/** A minimal PNG encoder: one IHDR, one IDAT, one IEND. */
function pngFromRgba(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 6;        // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** The same mark as SVG, for the favicon and as the source of truth. */
function svg() {
  const s = 0.075, apex = 0.26, base = 0.50, half = 0.26;
  const p = (n) => (n * 512).toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="RealtorOS">
  <rect width="512" height="512" rx="${p(0.22)}" fill="#0B1F33"/>
  <g fill="none" stroke="#34D399" stroke-width="${p(s)}" stroke-linecap="square">
    <path d="M ${p(0.5 - half)} ${p(base)} L ${p(0.5)} ${p(apex + s / 2)} L ${p(0.5 + half)} ${p(base)}"/>
    <path d="M ${p(0.285)} ${p(0.52)} L ${p(0.285)} ${p(0.76)}"/>
    <path d="M ${p(0.715)} ${p(0.52)} L ${p(0.715)} ${p(0.76)}"/>
    <path d="M ${p(0.285)} ${p(0.76)} L ${p(0.425)} ${p(0.76)}"/>
    <path d="M ${p(0.575)} ${p(0.76)} L ${p(0.715)} ${p(0.76)}"/>
  </g>
</svg>
`;
}

fs.mkdirSync(OUT, { recursive: true });
const written = [];
const write = (name, data) => {
  fs.writeFileSync(path.join(OUT, name), data);
  written.push(name + " (" + data.length + " bytes)");
};
write("icon-192.png", render(192));
write("icon-512.png", render(512));
write("icon-maskable-512.png", render(512, { maskable: true }));
write("apple-touch-icon-180.png", render(180, { maskable: true }));  // iOS crops its own corners
write("favicon-32.png", render(32));
write("icon.svg", Buffer.from(svg(), "utf8"));
console.log(written.join("\n"));
