import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, it } from 'vitest';

// Drives the results webview script (media/results.js) in jsdom: editing cells, adding and
// deleting rows, NULL, commit and its answer, cancel, errors and read-only results.
const source = fs.readFileSync(path.join(__dirname, '../../media/results.js'), 'utf8');

describe('results webview grid editing', () => {
  it('edits, commits, cancels and explains read-only results', () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as unknown as Window & typeof globalThis & { acquireVsCodeApi: unknown; eval(code: string): unknown };
    const posted: unknown[] = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined });
    window.eval(fs.readFileSync(path.join(__dirname, '../../media/l10n.js'), 'utf8'));
    window.eval(source);
    const doc = window.document;


    const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
    const rowsEl = () => [...doc.querySelectorAll<HTMLTableRowElement>('tbody tr')];
    const cell = (r: number, c: number) => rowsEl()[r].querySelectorAll('td')[c + 1];
    const click = (el: Element, opts = {}) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ...opts }));
    const dbl = (r: number, c: number) => { click(cell(r, c)); click(cell(r, c)); };
    const button = (label: string) => [...doc.querySelectorAll('button')].find((b) => b.textContent!.startsWith(label)) as HTMLButtonElement;
    const input = () => doc.querySelector<HTMLInputElement>('.cell-input')!;
    const type = (value: string, key = 'Enter', shift = false) => {
      const i = input();
      i.value = value;
      i.dispatchEvent(new window.Event('input', { bubbles: true }));
      i.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true }));
    };
    const texts = () => rowsEl().map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

    post({ type: 'run', title: 'c', pageSize: 100 });
    post({
      type: 'result',
      tab: { title: 'select * from items', sql: 'select * from items', columns: [{ name: 'id' }, { name: 'name' }, { name: 'qty' }], rows: [[1, 'a', 5], [2, 'b', null]], rowCount: 2, truncated: false, durationMs: 1,
        edit: { id: 7, columns: ['id', 'name', null], key: [0], table: 'public.items' } },
    });
    for (const b of ['+ Row', 'Delete', 'NULL', 'Commit', 'Cancel']) assert.ok(button(b), `button ${b}`);
    assert.ok(button('Commit').disabled && button('Cancel').disabled, 'nothing pending');

    // Edit a cell with a double click.
    dbl(0, 1);
    assert.strictEqual(input().value, 'a', 'editor shows the value');
    type('A');
    assert.ok(!input(), 'editor closed');
    assert.strictEqual(cell(0, 1).textContent, 'A');
    assert.ok(cell(0, 1).classList.contains('dirty'), 'dirty mark');
    assert.strictEqual(button('Commit').textContent, 'Commit (1)');

    // Read-only column: double click copies instead of editing.
    posted.length = 0;
    dbl(0, 2);
    assert.ok(!input(), 'read-only column not editable');
    assert.deepStrictEqual(posted, [{ type: 'copy', text: '5' }]);

    // The same number typed back is not a change; Escape discards.
    dbl(0, 0);
    type('1');
    assert.ok(!cell(0, 0).classList.contains('dirty'), 'unchanged number not dirty');
    dbl(0, 0);
    type('9', 'Escape');
    assert.strictEqual(cell(0, 0).textContent, '1', 'escape discards');

    // NULL on the focused cell.
    click(cell(1, 1));
    button('NULL').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(cell(1, 1).textContent, 'NULL');
    assert.ok(cell(1, 1).classList.contains('dirty'));

    // New row: editor opens on the first editable column; Tab moves to the next one.
    button('+ Row').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(rowsEl().length, 3);
    assert.strictEqual(input()?.closest('tr'), rowsEl()[2], 'editor in the new row');
    type('3', 'Tab');
    assert.strictEqual(input()?.closest('td'), cell(2, 1), 'Tab moved to name');
    type('c');
    assert.deepStrictEqual(texts()[2], ['+', '3', 'c', 'DEFAULT']);

    // Delete the second row (its NULL edit is then dropped).
    click(cell(1, 2));
    button('Delete').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.ok(rowsEl()[1].classList.contains('deleted'), 'row marked deleted');
    assert.strictEqual(button('Commit').textContent, 'Commit (3)');

    posted.length = 0;
    button('Commit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(posted, [{ type: 'commit', editId: 7, changes: [
      { kind: 'delete', key: { 0: 2 } },
      { kind: 'update', key: { 0: 1 }, values: { 1: 'A' } },
      { kind: 'insert', values: { 0: '3', 1: 'c' } },
    ] }]);
    assert.ok(button('Saving').disabled, 'saving state');

    post({ type: 'committed', editId: 7, ok: true, rows: [[1, 'A', 5], [3, 'c', null]], rowCount: 2, truncated: false });
    assert.deepStrictEqual(texts(), [['1', '1', 'A', '5'], ['2', '3', 'c', 'NULL']]);
    assert.ok(!doc.querySelector('.dirty, .deleted, .inserted'), 'clean after save');
    assert.ok(button('Commit').disabled);

    // A failed save keeps the edits and shows the error; Cancel restores.
    dbl(1, 1);
    type('changed');
    button('Commit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    post({ type: 'committed', editId: 7, ok: false, message: 'UPDATE affected 0 rows instead of 1; nothing was saved.' });
    assert.match(doc.querySelector('.edit-error')!.textContent!, /affected 0 rows/);
    assert.strictEqual(cell(1, 1).textContent, 'changed');
    button('+ Row').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    type('4');
    button('Cancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(texts(), [['1', '1', 'A', '5'], ['2', '3', 'c', 'NULL']], 'cancel restores');
    assert.ok(!doc.querySelector('.edit-error'));

    // Typed text survives a re-render (a log line arriving while editing).
    dbl(0, 1);
    const i = input();
    i.value = 'draft';
    i.dispatchEvent(new window.Event('input', { bubbles: true }));
    post({ type: 'log', entry: { time: 't', connection: 'c', sql: 'x', ok: true, message: 'm' } });
    // The log message does not switch tabs here (active stays on the result); the draft is kept.
    assert.strictEqual(input().value, 'draft', 'draft kept');
    type('draft');
    assert.strictEqual(cell(0, 1).textContent, 'draft');

    // Read-only results explain why; 'select' picks a tab from the end.
    post({ type: 'result', tab: { title: 'v', sql: 'select * from v', columns: [{ name: 'a' }], rows: [[1]], rowCount: 1, truncated: false, durationMs: 0, readOnly: 'public.v is a view.' } });
    const ro = doc.querySelector<HTMLElement>('.readonly');
    assert.ok(ro && ro.title === 'public.v is a view.', 'read-only badge');
    assert.ok(!button('+ Row'), 'no edit buttons');
    post({ type: 'select', tab: -2 });
    assert.ok(button('Commit'), 'first tab selected again');
  });
});

describe('results webview tabs', () => {
  it('keeps Output first, piles up result tabs across runs and reorders them by dragging', () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as unknown as Window & typeof globalThis & { acquireVsCodeApi: unknown; eval(code: string): unknown };
    let state: { keepTabs?: boolean } = {};
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => undefined, setState: (s: typeof state) => (state = s) });
    window.eval(fs.readFileSync(path.join(__dirname, '../../media/l10n.js'), 'utf8'));
    window.eval(source);
    const doc = window.document;
    const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
    const tabEls = () => [...doc.querySelectorAll<HTMLElement>('.tabbar .tab')];
    const labels = () => tabEls().map((x) => x.querySelector('span')!.textContent);
    const activeLabel = () => doc.querySelector('.tabbar .tab.active span')!.textContent;
    const fire = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
    const drag = (from: number, onto: number) => {
      fire(tabEls()[from], 'dragstart');
      fire(tabEls()[onto], 'dragover');
      fire(tabEls()[onto], 'drop');
    };
    const result = (title: string) => post({ type: 'result', tab: { title, sql: title, columns: [{ name: 'x' }], rows: [[1]], rowCount: 1, truncated: false, durationMs: 1 } });

    assert.deepStrictEqual(labels(), ['Output']);
    post({ type: 'run', title: 'c', pageSize: 100 });
    result('a');
    post({ type: 'run', title: 'c', pageSize: 100 });
    result('b');
    result('c');
    assert.deepStrictEqual(labels(), ['Output', '1. a', '2. b', '3. c'], 'Output first, tabs kept across runs');
    assert.strictEqual(activeLabel(), '3. c');
    assert.ok(tabEls()[1].draggable && !tabEls()[0].draggable, 'only result tabs drag');

    // jsdom has no layout: a drop lands after the tab it is dropped on; on Output it goes first.
    drag(1, 2);
    assert.deepStrictEqual(labels(), ['Output', '2. b', '1. a', '3. c']);
    drag(3, 0);
    assert.deepStrictEqual(labels(), ['Output', '3. c', '2. b', '1. a']);
    assert.strictEqual(activeLabel(), '3. c', 'the active tab stays active after moving');

    // Turning Keep tabs off clears result tabs on the next run.
    const keep = doc.querySelector<HTMLInputElement>('.keep input')!;
    assert.ok(keep.checked, 'kept by default');
    keep.checked = false;
    fire(keep, 'change');
    assert.strictEqual(state.keepTabs, false);
    post({ type: 'run', title: 'c', pageSize: 100 });
    result('d');
    assert.deepStrictEqual(labels(), ['Output', '4. d']);
  });

  it('closes the oldest tabs past 50', () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as unknown as Window & typeof globalThis & { acquireVsCodeApi: unknown; eval(code: string): unknown };
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => undefined, setState: () => undefined });
    window.eval(fs.readFileSync(path.join(__dirname, '../../media/l10n.js'), 'utf8'));
    window.eval(source);
    for (let i = 1; i <= 52; i++) {
      window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'result', tab: { title: `q${i}`, sql: '', columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0 } } }));
    }
    const labels = [...window.document.querySelectorAll('.tabbar .tab span:first-child')].map((x) => x.textContent);
    assert.strictEqual(labels.length, 51);
    assert.deepStrictEqual(labels.slice(0, 2), ['Output', '3. q3']);
  });
});
