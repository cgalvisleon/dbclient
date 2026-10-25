import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, it } from 'vitest';

// Drives the DB Client SQL editor page (media/sqlEditor.js + the embedded media/results.js) in
// jsdom, with a small stand-in for the CodeMirror bundle.
const media = (file: string) => fs.readFileSync(path.join(__dirname, '../../media', file), 'utf8');

/** Plain-text document with the parts of CodeMirror's `Text` the page uses. */
function textDoc(text: string) {
  const lines = text.split('\n');
  const starts = lines.reduce<number[]>((acc, line, i) => (acc.push(i ? acc[i - 1] + lines[i - 1].length + 1 : 0), acc), []);
  const line = (n: number) => ({ number: n, from: starts[n - 1], to: starts[n - 1] + lines[n - 1].length, text: lines[n - 1] });
  return {
    length: text.length,
    lines: lines.length,
    line,
    lineAt: (pos: number) => line(starts.filter((s) => s <= pos).length),
    sliceString: (from = 0, to = text.length, sep = '\n') => text.slice(from, to).replace(/\n/g, sep),
    toString: () => text,
  };
}

function fakeCodeMirror() {
  const created: any[] = [];
  return {
    created,
    api: {
      setDialect: (view: any, dialect: string) => (view.dialect = dialect),
      create(options: any) {
        const view: any = {
          options,
          dialect: options.dialect,
          dispatched: [] as any[],
          state: { doc: textDoc(options.doc), selection: { main: { anchor: 0, head: 0, from: 0, to: 0, empty: true } } },
          dispatch(spec: any) {
            view.dispatched.push(spec);
            const changes = spec.changes ? [].concat(spec.changes).sort((a: any, b: any) => b.from - a.from) : [];
            let text = view.state.doc.toString();
            for (const c of changes as any[]) text = text.slice(0, c.from) + (c.insert ?? '') + text.slice(c.to ?? c.from);
            view.state.doc = textDoc(text);
          },
          focus() {},
        };
        created.push(view);
        return view;
      },
    },
  };
}

function load() {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only' });
  const window = dom.window as unknown as Window & typeof globalThis & { acquireVsCodeApi: unknown; DbCodeMirror: unknown; eval(code: string): unknown };
  const posted: any[] = [];
  let state: unknown;
  window.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => state, setState: (s: unknown) => (state = s) });
  const cm = fakeCodeMirror();
  window.DbCodeMirror = cm.api;
  window.eval(media('l10n.js'));
  window.eval(media('sqlEditor.js'));
  window.eval(media('results.js'));
  const send = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  return { window, doc: window.document, posted, cm, send };
}

const STATE = {
  connections: [
    { id: 'a', name: 'local', engine: 'PostgreSQL' },
    { id: 'b', name: 'prod', engine: 'MySQL', folder: 'Work' },
  ],
  connectionId: 'a',
  database: 'sales',
  databases: ['sales'],
  connected: false,
  running: false,
  dialect: 'postgres',
};

describe('SQL editor webview', () => {
  it('builds the toolbar from the state and posts its actions', () => {
    const { doc, posted, send } = load();
    assert.deepStrictEqual(
      posted.map((m) => m.type),
      ['editorReady', 'ready'],
      'page and embedded results announce themselves',
    );
    send({ type: 'state', state: STATE });
    const connection = doc.getElementById('connection') as HTMLSelectElement;
    const database = doc.getElementById('database') as HTMLSelectElement;
    assert.strictEqual(connection.value, 'a');
    assert.deepStrictEqual(
      [...connection.querySelectorAll('optgroup')].map((g) => g.label),
      ['Work'],
      'connections grouped by folder',
    );
    assert.ok([...connection.options].some((o) => o.value === '+add'), 'Add Connection… at the end');
    assert.strictEqual(database.value, 'sales');
    assert.ok(database.disabled, 'one database: nothing to choose');
    const tool = (name: string) => doc.querySelector(`.codicon-${name}`)!.parentElement as HTMLButtonElement;
    assert.ok(!tool('plug').hidden && tool('debug-disconnect').hidden, 'Connect while closed');
    assert.ok(tool('debug-stop').hidden, 'Stop only while running');

    posted.length = 0;
    connection.value = 'b';
    connection.dispatchEvent(new doc.defaultView!.Event('change'));
    connection.value = '+add';
    connection.dispatchEvent(new doc.defaultView!.Event('change'));
    assert.deepStrictEqual(posted, [{ type: 'setConnection', connectionId: 'b' }, { type: 'addConnection' }]);
    assert.strictEqual(connection.value, 'a', 'Add Connection… does not stay selected');

    send({ type: 'state', state: { ...STATE, connected: true, running: true, databases: ['sales', 'hr'] } });
    assert.ok(tool('plug').hidden && !tool('debug-disconnect').hidden);
    assert.ok(!tool('debug-stop').hidden && tool('play').disabled, 'Stop shown, runs disabled while running');
    assert.ok(!database.disabled);
    posted.length = 0;
    database.value = 'hr';
    database.dispatchEvent(new doc.defaultView!.Event('change'));
    tool('debug-stop').click();
    tool('history').click();
    assert.deepStrictEqual(posted, [{ type: 'setDatabase', database: 'hr' }, { type: 'cancel' }, { type: 'history' }]);
  });

  it('creates the editor, sends edits before a run and inserts text', () => {
    const { doc, posted, cm, send } = load();
    send({ type: 'state', state: STATE });
    send({ type: 'init', text: 'select 1;\n', eol: '\n', document: 'file:///q.sql', placeholder: 'Write SQL' });
    const view = cm.created[0];
    assert.strictEqual(view.options.doc, 'select 1;\n');
    assert.strictEqual(view.options.dialect, 'postgres');
    assert.ok(posted.some((m) => m.type === 'editorLoaded'));

    // A typed change, as CodeMirror reports it, goes out with the next run.
    const before = view.state.doc;
    view.dispatch({ changes: { from: 10, insert: 'select 2;' } });
    view.options.onChange({
      startState: { doc: before },
      changes: { iterChanges: (f: Function) => f(10, 10, 10, 19, textDoc('select 2;')), compose: () => undefined },
    });
    view.state.selection.main = { anchor: 12, head: 12, from: 12, to: 12, empty: true };
    posted.length = 0;
    (doc.querySelector('.codicon-play')!.parentElement as HTMLButtonElement).click();
    assert.deepStrictEqual(posted, [
      { type: 'edit', changes: [{ from: { line: 1, ch: 0 }, to: { line: 1, ch: 0 }, insert: 'select 2;' }], text: 'select 1;\nselect 2;' },
      { type: 'run', mode: 'statement', anchor: { line: 1, ch: 2 }, head: { line: 1, ch: 2 } },
    ]);

    // Inserted text (history, paste, import) goes on the next line when the caret's line has code.
    send({ type: 'insert', text: 'select 3;' });
    assert.strictEqual(view.state.doc.toString(), 'select 1;\nselect 2;\nselect 3;');
    // Changes from the document replace what the page has when they do not line up.
    send({ type: 'update', changes: [], text: 'select 9;' });
    assert.strictEqual(view.state.doc.toString(), 'select 9;');
  });

  it('shows results in the lower pane with the document in the cell context', () => {
    const { doc, send } = load();
    send({ type: 'init', text: '', eol: '\n', document: 'file:///q.sql' });
    send({
      type: 'result',
      tab: { title: 'select 1', sql: 'select 1', columns: [{ name: 'one' }], rows: [[1]], rowCount: 1, truncated: false, durationMs: 1 },
    });
    const pane = doc.querySelector('.results')!;
    const cell = pane.querySelector('[data-vscode-context]')!;
    assert.ok(cell, 'grid rendered inside the results pane');
    assert.strictEqual(JSON.parse(cell.getAttribute('data-vscode-context')!).document, 'file:///q.sql');
  });

  it('shows tooltips on toolbar buttons, with their shortcut, also on disabled ones', async () => {
    const { window, doc, send } = load();
    send({ type: 'state', state: { ...STATE, running: true } });
    const runAll = doc.querySelector('[aria-label="Run every statement of the file"]') as HTMLButtonElement;
    assert.ok(runAll.disabled, 'run buttons disabled while running');
    assert.ok(!doc.querySelector('.sql-toolbar [title]'), 'no native titles left in the toolbar');
    const tip = doc.querySelector('.tooltip') as HTMLElement;
    (doc as any).elementsFromPoint = () => [runAll.firstChild, runAll];
    doc.querySelector('.sql-toolbar')!.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 550));
    assert.ok(!tip.hidden, 'tooltip shown after the hover delay');
    assert.match(tip.textContent ?? '', /^Run every statement of the file(Ctrl\+Shift\+Enter|⌘⇧↩)$/);
    doc.querySelector('.sql-toolbar')!.dispatchEvent(new window.MouseEvent('pointerleave'));
    assert.ok(tip.hidden, 'hidden when the pointer leaves');

    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab' }));
    (doc.querySelector('[aria-label="Query History…"]') as HTMLElement).focus();
    assert.ok(!tip.hidden && tip.textContent === 'Query History…', 'keyboard focus shows it at once');
  });

  it('moves the results to the top, left, right or bottom of the SQL', () => {
    const { doc, posted, send } = load();
    const work = doc.querySelector('.work') as HTMLElement;
    const splitter = doc.querySelector('.splitter') as HTMLElement;
    const layout = doc.querySelector('[aria-label="Move the results: bottom, top, left or right"]') as HTMLButtonElement;
    assert.strictEqual(work.dataset.position, 'bottom', 'below the SQL by default');
    assert.deepStrictEqual([...work.children].map((c) => c.className), ['editor', 'splitter', 'results']);
    for (const [position, icon, orientation] of [
      ['left', 'layout-sidebar-left', 'vertical'],
      ['right', 'layout-sidebar-right', 'vertical'],
      ['top', 'layout-menubar', 'horizontal'],
      ['bottom', 'layout-panel', 'horizontal'],
    ]) {
      send({ type: 'position', position });
      assert.strictEqual(work.dataset.position, position);
      assert.ok(layout.firstElementChild!.classList.contains(`codicon-${icon}`), `${position}: button icon`);
      assert.strictEqual(splitter.getAttribute('aria-orientation'), orientation, `${position}: splitter orientation`);
    }
    send({ type: 'position', position: 'diagonal' });
    assert.strictEqual(work.dataset.position, 'bottom', 'unknown positions fall back to bottom');
    layout.click();
    assert.strictEqual(posted.at(-1).type, 'resultsPosition', 'the button asks the extension');
  });

  it('asks the extension for completions after sending the pending edits', async () => {
    const { posted, cm, send } = load();
    send({ type: 'state', state: STATE });
    send({ type: 'init', text: 'select 1;\n', eol: '\n', document: 'file:///q.sql', placeholder: 'Write SQL' });
    const view = cm.created[0];
    const before = view.state.doc;
    view.dispatch({ changes: { from: 10, insert: 'select * from ' } });
    view.options.onChange({
      startState: { doc: before },
      changes: { iterChanges: (f: Function) => f(10, 10, 10, 24, textDoc('select * from ')), compose: () => undefined },
    });
    posted.length = 0;
    const answer = view.options.complete(24, false);
    assert.deepStrictEqual(
      posted.map((m) => m.type),
      ['edit', 'complete'],
      'typed text first, then the request',
    );
    const request = posted[1];
    assert.deepStrictEqual({ line: request.line, ch: request.ch, explicit: request.explicit }, { line: 1, ch: 14, explicit: false });
    const items = [{ label: 'orders', type: 'class', boost: 99 }];
    send({ type: 'completions', id: request.id + 1, items: [] });
    send({ type: 'completions', id: request.id, items });
    assert.deepStrictEqual(await answer, items);
  });
});
