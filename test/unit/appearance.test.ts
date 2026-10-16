import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module script without types
import { COLOR_ICONS, COLORS, recolor } from '../../scripts/build-icon-colors.mjs';
import { postgresFactory } from '../../src/drivers/postgres';

// Connection icon shapes and colors: the generated images, the recoloring and the form section.
const root = path.join(__dirname, '../..');
const iconsTs = fs.readFileSync(path.join(root, 'src/icons.ts'), 'utf8');
const listOf = (name: string) => JSON.parse(new RegExp(`${name} = (\\[[^\\]]*\\])`).exec(iconsTs)![1].replace(/'/g, '"')) as string[];

describe('connection icons', () => {
  it('exist for every shape and color, dark and light, with their connected variants', () => {
    const shapes = listOf('CONNECTION_SHAPES');
    const colors = listOf('CONNECTION_COLORS');
    expect(colors.filter((c) => c !== 'blue').sort()).toEqual(Object.keys(COLORS).sort());
    expect([...shapes, 'explorer'].every((s) => COLOR_ICONS.includes(s))).toBe(true);
    for (const color of colors) {
      for (const variant of ['', 'light']) {
        for (const icon of [...shapes, 'database-connect', 'server-connect', 'explorer']) {
          const file = path.join(root, 'media/icons', color === 'blue' ? '' : `colors/${color}`, variant, `${icon}.png`);
          assert.ok(fs.existsSync(file), file);
        }
      }
    }
  });

  it('moves the blue hue and keeps whites, greys and transparency', () => {
    const pixels = Buffer.from([
      40, 120, 230, 255, // blue
      255, 255, 255, 255, // white
      90, 90, 90, 255, // grey
      40, 120, 230, 0, // transparent
    ]);
    const red = recolor(pixels, COLORS.red);
    expect(red[0]).toBeGreaterThan(red[2]); // red channel now dominates
    expect(red[0]).toBeGreaterThan(red[1]);
    expect([...red.subarray(4)]).toEqual([...pixels.subarray(4)]);
    const gray = recolor(pixels, COLORS.gray);
    expect(Math.max(gray[0], gray[1], gray[2]) - Math.min(gray[0], gray[1], gray[2])).toBeLessThan(30);
  });
});

describe('connection form appearance', () => {
  it('picks a shape and a color, previews them and sends them on save', () => {
    const dom = new JSDOM('<!doctype html><body class="vscode-dark"><div id="app"></div></body>', { runScripts: 'outside-only' });
    const window = dom.window as unknown as Window & typeof globalThis & { acquireVsCodeApi: unknown; eval(code: string): unknown };
    const posted: any[] = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined });
    window.eval(fs.readFileSync(path.join(root, 'media/l10n.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(root, 'media/connectionForm.js'), 'utf8'));
    const doc = window.document;
    const labels = { name: 'Name', type: 'Type', test: 'Test', save: 'Save', cancel: 'Cancel', saved: 'saved', testing: 'Testing', browse: 'Browse', folder: 'Folder', sqlFiles: 'SQL files', sqlSave: 'Save', sqlSaveDefault: '', sqlLinked: 'Linked', sqlAddFolder: 'Add', sqlHint: '', noFolder: '(none)', appearance: 'Appearance', icon: 'Icon', color: 'Color', automatic: 'Automatic' };
    const appearance = {
      iconsBase: 'res://icons',
      shapes: listOf('CONNECTION_SHAPES').map((id) => ({ id, label: id })),
      colors: listOf('CONNECTION_COLORS').map((id) => ({ id, label: id })),
      defaults: { postgres: 'database' },
    };
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { type: 'init', drivers: [{ type: 'postgres', label: 'PostgreSQL', category: 'sql', fields: postgresFactory.fields }], folders: [], savedSecrets: {}, labels, appearance },
      }),
    );
    const icons = () => [...doc.querySelectorAll<HTMLButtonElement>('#f-icon button')];
    const colors = () => [...doc.querySelectorAll<HTMLButtonElement>('#f-color button')];
    const selected = (buttons: HTMLButtonElement[]) => buttons.filter((b) => b.classList.contains('selected')).map((b) => b.title);
    expect(icons()).toHaveLength(7);
    expect(colors()).toHaveLength(7);
    expect(selected(icons())).toEqual(['Automatic']);
    expect(selected(colors())).toEqual(['blue']);
    expect(icons()[0].querySelector('img')!.getAttribute('src')).toBe('res://icons/database.png');

    (doc.getElementById('f-name') as HTMLInputElement).value = 'typed';
    colors().find((b) => b.title === 'red')!.click();
    icons().find((b) => b.title === 'server')!.click();
    expect((doc.getElementById('f-name') as HTMLInputElement).value).toBe('typed'); // kept across re-renders
    expect(selected(icons())).toEqual(['server']);
    expect(selected(colors())).toEqual(['red']);
    expect(icons().map((b) => b.querySelector('img')!.getAttribute('src'))).toContain('res://icons/colors/red/server.png');
    expect(colors().find((b) => b.title === 'green')!.querySelector('img')!.getAttribute('src')).toBe('res://icons/colors/green/server.png');

    doc.querySelector('form')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
    expect(posted.at(-1)).toMatchObject({ type: 'save', value: { name: 'typed', icon: 'server', color: 'red' } });

    // Back to automatic and blue: both fields are cleared.
    icons()[0].click();
    colors().find((b) => b.title === 'blue')!.click();
    doc.querySelector('form')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
    expect(posted.at(-1).value.icon).toBeUndefined();
    expect(posted.at(-1).value.color).toBeUndefined();
  });
});
