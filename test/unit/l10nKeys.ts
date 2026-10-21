import * as fs from 'fs';
import * as path from 'path';
import { allDrivers } from '../../src/drivers/registry';
import { TREE_WORDS } from '../../src/tree/words';

// Every English text shown to users, as the key of the translation bundles.
const root = path.join(__dirname, '../..');

function files(dir: string, ext: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? files(full, ext) : full.endsWith(ext) ? [full] : [];
  });
}

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

/** String literals passed to `call(` (first argument); dynamic templates are reported. */
function literals(source: string, call: RegExp, file: string, dynamic: string[]): string[] {
  const found: string[] = [];
  const re = new RegExp(`${call.source}\\(\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`, 'g');
  for (const m of source.matchAll(re)) {
    if (m[1] === '`' && m[2].includes('${')) {
      dynamic.push(`${path.relative(root, file)}: ${m[2]}`);
    } else {
      found.push(unescape(m[2]));
    }
  }
  return found;
}

export function l10nKeys(): { keys: string[]; dynamic: string[] } {
  const dynamic: string[] = [];
  const keys = new Set<string>();
  for (const file of files(path.join(root, 'src'), '.ts')) {
    literals(fs.readFileSync(file, 'utf8'), /(?<![\w.])t/, file, dynamic).forEach((k) => keys.add(k));
  }
  for (const file of files(path.join(root, 'media'), '.js')) {
    literals(fs.readFileSync(file, 'utf8'), /(?<![\w.])t/, file, dynamic).forEach((k) => keys.add(k));
  }
  for (const driver of allDrivers()) {
    for (const f of driver.fields) {
      [f.label, f.hint, f.placeholder, f.section, ...(f.choices ?? [])].forEach((k) => k && keys.add(k));
    }
  }
  // Redis value viewer column names and add-row placeholders go through t() as variables.
  ['field', 'value', '#', 'member', 'score', 'id', 'fields', '{"field": "value"}'].forEach((k) => keys.add(k));
  TREE_WORDS.forEach((k) => keys.add(k));
  return { keys: [...keys].sort(), dynamic };
}

if (process.argv[1]?.endsWith('l10nKeys.ts')) {
  // npx tsx test/unit/l10nKeys.ts [bundle]  → prints the keys missing from a bundle (all when none).
  const bundleFile = process.argv[2];
  const bundle = bundleFile && fs.existsSync(bundleFile) ? JSON.parse(fs.readFileSync(bundleFile, 'utf8')) : {};
  const { keys, dynamic } = l10nKeys();
  console.log(JSON.stringify({ missing: keys.filter((k) => !(k in bundle)), dynamic }, null, 2));
}
