import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, it } from 'vitest';

// Drives the Settings and About webview (media/settings.js) in jsdom.
const media = (file: string) => fs.readFileSync(path.join(__dirname, '../../media', file), 'utf8');

describe('settings webview', () => {
  it('shows paths, settings, environment and GitHub links, and posts the actions', () => {
    const dom = new JSDOM(
      `<!doctype html><script type="application/json" id="dbclient-l10n">${JSON.stringify({ Persistence: 'Persistencia' })}</script><div id="app"></div>`,
      { runScripts: 'outside-only' },
    );
    const window = dom.window as unknown as Window & typeof globalThis & { acquireVsCodeApi: unknown; eval(code: string): unknown };
    const posted: unknown[] = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined });
    window.eval(media('l10n.js'));
    window.eval(media('settings.js'));
    const doc = window.document;
    assert.deepStrictEqual(posted, [{ type: 'ready' }]);
    posted.length = 0;

    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'data',
          data: {
            paths: [
              { label: 'Extension storage', path: '/g', kind: 'dir', exists: true },
              { label: 'Connections file', path: '/g/connections.json', kind: 'file', exists: false, hint: '2 connections' },
            ],
            secrets: 'secret storage',
            settings: [{ key: 'dbclient.sqlFolder', label: 'Folder', value: '~/sql', defaultValue: '', source: 'User' }],
            environment: [['Node.js', '24.0.0']],
            about: {
              name: 'DB Client',
              description: 'd',
              version: '1.2.3',
              author: 'Cesar Galvis Leon',
              github: { user: 'cgalvisleon', profile: 'https://github.com/cgalvisleon' },
              links: [{ label: 'Source code', url: 'https://github.com/cgalvisleon/dbclient' }],
            },
          },
        },
      }),
    );

    const text = doc.body.textContent!;
    assert.deepStrictEqual([...doc.querySelectorAll('h2')].map((h) => h.textContent), ['Persistencia', 'Settings', 'Environment', 'About']);
    for (const s of ['/g/connections.json', 'not created yet', '2 connections', 'secret storage', '~/sql', '(empty)', '24.0.0', 'v1.2.3', 'Cesar Galvis Leon', '@cgalvisleon']) {
      assert.ok(text.includes(s), s);
    }
    const buttons = [...doc.querySelectorAll('button')];
    const click = (label: string, index = 0) => buttons.filter((b) => b.textContent === label)[index].click();
    click('Copy', 1);
    click('Show in folder');
    click('Open in Settings');
    const github = [...doc.querySelectorAll('a')].find((a) => a.textContent === '@cgalvisleon')!;
    github.click();
    assert.deepStrictEqual(posted, [
      { type: 'copy', text: '/g/connections.json' },
      { type: 'reveal', path: '/g/connections.json' },
      { type: 'openSettings' },
      { type: 'link', url: 'https://github.com/cgalvisleon' },
    ]);
  });
});
