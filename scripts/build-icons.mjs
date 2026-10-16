// Builds media/icons/*.png from the icon set in img/: each source PNG is a 256×256 crop of a
// sheet with the file name printed under the glyph, so this keeps only the glyph (the rows
// above the first transparent gap), squares it with a small margin, and lets `sips` (macOS)
// scale it. Run with `npm run icons` after changing img/.
// media/icon.png (the store icon, 256×256) is not built here: it is img/db-client.svg exported
// to PNG, because the raster glyph is too small and looks blurry on retina screens.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildColorIcons } from './build-icon-colors.mjs';
import { decode, encode } from './png.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = path.join(root, 'img');
const out = path.join(root, 'media', 'icons');
const SIZE = 64;

/**
 * Bounding box of the glyph. Rows are split into blocks separated by ≥6 empty rows (labels of
 * this icon and of the sheet row above end up as separate blocks); the glyph is the heaviest one.
 */
function glyphBox({ width, height, pixels }) {
  const solid = (x, y) => pixels[(y * width + x) * 4 + 3] > 60;
  const counts = Array.from({ length: height }, (_, y) => {
    let n = 0;
    for (let x = 0; x < width; x++) n += solid(x, y) ? 1 : 0;
    return n;
  });
  const blocks = [];
  let current;
  let empty = 0;
  for (let y = 0; y < height; y++) {
    if (counts[y] >= 3) {
      if (!current || empty >= 6) {
        current = { top: y, bottom: y, weight: 0 };
        blocks.push(current);
      }
      current.bottom = y;
      current.weight += counts[y];
      empty = 0;
    } else {
      empty++;
    }
  }
  const { top, bottom } = blocks.reduce((a, b) => (b.weight > a.weight ? b : a));
  let left = width;
  let right = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = 0; x < width; x++) {
      if (solid(x, y)) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return { left, top, right, bottom };
}

function cropSquare(image, box) {
  const w = box.right - box.left + 1;
  const h = box.bottom - box.top + 1;
  const side = Math.ceil(Math.max(w, h) * 1.08);
  const pixels = Buffer.alloc(side * side * 4);
  const ox = Math.floor((side - w) / 2);
  const oy = Math.floor((side - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = ((box.top + y) * image.width + box.left + x) * 4;
      const to = ((oy + y) * side + ox + x) * 4;
      image.pixels.copy(pixels, to, from, from + 4);
    }
  }
  return { width: side, height: side, pixels };
}

/** Light-theme variant: drops the dark halo the sheet's navy background left around shapes. */
function withoutDarkFringe({ width, height, pixels }) {
  const copy = Buffer.from(pixels);
  for (let o = 0; o < copy.length; o += 4) {
    const luminance = 0.2126 * copy[o] + 0.7152 * copy[o + 1] + 0.0722 * copy[o + 2];
    if (luminance < 70) {
      copy[o + 3] = 0;
    } else if (luminance < 110) {
      copy[o + 3] = Math.round(copy[o + 3] * ((luminance - 70) / 40));
    }
  }
  return { width, height, pixels: copy };
}

fs.mkdirSync(path.join(out, 'light'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'dbclient-icons-'));
for (const file of fs.readdirSync(src).filter((f) => f.endsWith('.png') && !f.startsWith('preview'))) {
  const image = decode(path.join(src, file));
  const squared = cropSquare(image, glyphBox(image));
  const full = path.join(tmp, file);
  fs.writeFileSync(full, encode(squared));
  execFileSync('sips', ['-z', String(SIZE), String(SIZE), full, '--out', path.join(out, file)], { stdio: 'ignore' });
  const light = path.join(tmp, `light-${file}`);
  fs.writeFileSync(light, encode(withoutDarkFringe(squared)));
  execFileSync('sips', ['-z', String(SIZE), String(SIZE), light, '--out', path.join(out, 'light', file)], { stdio: 'ignore' });
  console.log(`${file}: glyph ${squared.width}px → ${SIZE}px`);
}
fs.rmSync(tmp, { recursive: true, force: true });
buildColorIcons();
