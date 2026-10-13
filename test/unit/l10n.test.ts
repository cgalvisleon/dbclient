import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { l10nKeys } from './l10nKeys';

const root = path.join(__dirname, '../..');
const json = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as Record<string, string>;
const placeholders = (text: string) => [...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort();

describe('Spanish translation', () => {
  it('translates every text shown by the extension, its webviews and the driver forms', () => {
    const { keys, dynamic } = l10nKeys();
    const es = json('l10n/bundle.l10n.es.json');
    expect(dynamic, 'l10n.t / t need literal strings').toEqual([]);
    expect(keys.filter((k) => !(k in es)), 'missing from l10n/bundle.l10n.es.json').toEqual([]);
    expect(Object.keys(es).filter((k) => !keys.includes(k)), 'stale keys in l10n/bundle.l10n.es.json').toEqual([]);
    for (const [en, translated] of Object.entries(es)) {
      expect(placeholders(translated), en).toEqual(placeholders(en));
      expect(translated.trim(), en).not.toBe('');
    }
  });

  it('translates every manifest string', () => {
    const en = json('package.nls.json');
    const es = json('package.nls.es.json');
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const used = [...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);
    expect(used.filter((k) => !(k in en)), 'keys used in package.json').toEqual([]);
    expect(Object.keys(en).filter((k) => !used.includes(k)), 'unused keys in package.nls.json').toEqual([]);
  });

  it('webviews read the injected bundle and fill placeholders', () => {
    const dom = new JSDOM(
      `<!doctype html><script type="application/json" id="dbclient-l10n">${JSON.stringify({ 'Showing {0} of {1}': 'Se muestran {0} de {1}' })}</script>`,
      { runScripts: 'outside-only' },
    );
    const window = dom.window as unknown as { eval(code: string): unknown; t(text: string, ...args: unknown[]): string };
    window.eval(fs.readFileSync(path.join(root, 'media/l10n.js'), 'utf8'));
    expect(window.t('Showing {0} of {1}', 3, 10)).toBe('Se muestran 3 de 10');
    expect(window.t('Untranslated {0}', 'x')).toBe('Untranslated x');
  });
});
