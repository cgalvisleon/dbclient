// Builds media/icons/*.png from the icon set in img/: each source PNG is a 256×256 crop of a
// sheet with the file name printed under the glyph, so this keeps only the glyph (the rows
// above the first transparent gap), squares it with a small margin, and lets `sips` (macOS)
// scale it. Run with `npm run icons` after changing img/.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = path.join(root, 'img');
const out = path.join(root, 'media', 'icons');
const SIZE = 64;

function decode(file) {
  const buf = fs.readFileSync(file);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error(`${file}: only 8-bit non-interlaced PNGs`);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const channels = { 6: 4, 2: 3 }[colorType];
  if (!channels) throw new Error(`${file}: unsupported color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      line[i] = (line[i] + [0, a, b, (a + b) >> 1, paeth][filter]) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      pixels[o] = line[x * channels];
      pixels[o + 1] = line[x * channels + 1];
      pixels[o + 2] = line[x * channels + 2];
      pixels[o + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prev = line;
  }
  return { width, height, pixels };
}

function encode({ width, height, pixels }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
  if (file === 'db-client.png') {
    execFileSync('sips', ['-z', '128', '128', full, '--out', path.join(root, 'media', 'icon.png')], { stdio: 'ignore' });
  }
  console.log(`${file}: glyph ${squared.width}px → ${SIZE}px`);
}
fs.rmSync(tmp, { recursive: true, force: true });
