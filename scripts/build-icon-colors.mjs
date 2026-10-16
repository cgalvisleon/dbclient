// Builds media/icons/colors/<color>/(light/)<icon>.png: the connection icons of media/icons in
// other colors. The set is blue (hue ≈ 212°); each colored pixel keeps its shading and only its
// hue (and, for some colors, saturation/lightness) moves, so highlights, white glyph details and
// transparency stay as they are. Runs at the end of `npm run icons`, or alone:
// `node scripts/build-icon-colors.mjs` (no sips needed).
import * as fs from 'fs';
import * as path from 'path';
import { decode, encode } from './png.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const icons = path.join(root, 'media', 'icons');

const BASE_HUE = 212;

/** Keep in sync with CONNECTION_COLORS in src/icons.ts (blue is the original set). */
export const COLORS = {
  green: { hue: 140, lightness: -0.06 },
  red: { hue: 2, lightness: 0.02 },
  orange: { hue: 28, lightness: 0.03 },
  purple: { hue: 272 },
  yellow: { hue: 46, lightness: 0.06 },
  gray: { saturation: 0.08 },
};

/** Keep in sync with CONNECTION_SHAPES in src/icons.ts (plus their -connect variants). */
export const COLOR_ICONS = [
  'database',
  'database-connect',
  'server',
  'server-connect',
  'cloud-database',
  'database-settings',
  'server-settings',
  'search-database',
];

function toHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function fromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
}

/** Recolors the bluish pixels of an RGBA buffer (returns a copy). */
export function recolor(pixels, color) {
  const out = Buffer.from(pixels);
  for (let o = 0; o < out.length; o += 4) {
    if (!out[o + 3]) continue;
    const [h, s, l] = toHsl(out[o] / 255, out[o + 1] / 255, out[o + 2] / 255);
    // Whites, greys and the dark fringe have no meaningful hue: leave them.
    if (s < 0.2 || h < 170 || h > 260) continue;
    const hue = color.hue === undefined ? h : (color.hue + (h - BASE_HUE) + 360) % 360;
    const sat = color.saturation ?? s;
    const light = Math.min(0.95, l + (color.lightness ?? 0));
    [out[o], out[o + 1], out[o + 2]] = fromHsl(hue, sat, light);
  }
  return out;
}

export function buildColorIcons() {
  for (const [name, color] of Object.entries(COLORS)) {
    for (const variant of ['', 'light']) {
      const dir = path.join(icons, 'colors', name, variant);
      fs.mkdirSync(dir, { recursive: true });
      for (const icon of COLOR_ICONS) {
        const image = decode(path.join(icons, variant, `${icon}.png`));
        fs.writeFileSync(path.join(dir, `${icon}.png`), encode({ ...image, pixels: recolor(image.pixels, color) }));
      }
    }
  }
  console.log(`colors: ${Object.keys(COLORS).length} × ${COLOR_ICONS.length} icons`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  buildColorIcons();
}
