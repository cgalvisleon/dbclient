// @ts-check
// DB Client SQL editor (NetBeans style): toolbar with the connection and database drop-downs and
// icon buttons, the SQL in CodeMirror (media/vendor/codemirror.js), and the results of its runs
// below (media/results.js, loaded after this script into the lower pane).
//
// The extension owns the text document: edits made here are sent in batches (one undo step each,
// since undo/redo run on the document), and changes made elsewhere come back as `update`.
(function () {
  const vscode = acquireVsCodeApi();
  const page = /** @type {HTMLElement} */ (document.getElementById('app'));
  const CM = /** @type {any} */ (window).DbCodeMirror;
  /** Webview state: `results` belongs to results.js, `split` is the editor's share of the height. */
  let state = vscode.getState() || {};
  const saveState = () => vscode.setState(state);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'on') {
        for (const [event, handler] of Object.entries(v)) node.addEventListener(event, handler);
      } else if (k === 'class') {
        node.className = v;
      } else if (v !== undefined && v !== false) {
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }

  const post = (m) => vscode.postMessage(m);
  const icon = (name) => el('span', { class: `codicon codicon-${name}` });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  /** A shortcut written for this platform: `Mod` is Cmd on macOS, Ctrl elsewhere. */
  const keys = (shortcut) => shortcut.replace('Mod', mac ? '⌘' : 'Ctrl').replace(/\+/g, mac ? '' : '+').replace('Shift', mac ? '⇧' : 'Shift').replace('Enter', mac ? '↩' : 'Enter');
  /** Icon button with a tooltip (`data-tip`); `message` is posted on click unless `action` is given. */
  const button = (name, title, message, action, shortcut) =>
    el(
      'button',
      { class: 'tool', 'data-tip': title, 'data-keys': shortcut && keys(shortcut), 'aria-label': title, on: { click: () => (action ? action() : (flush(), post(message))) } },
      icon(name),
    );
  const separator = () => el('span', { class: 'separator' });

  // ---------- layout ----------

  const connectionSelect = /** @type {HTMLSelectElement} */ (el('select', { id: 'connection', 'data-tip': t('Connection for this editor') }));
  const databaseSelect = /** @type {HTMLSelectElement} */ (el('select', { id: 'database', 'data-tip': t('Database') }));
  const runAll = button('run-all', t('Run every statement of the file'), undefined, () => run('file'), 'Mod+Shift+Enter');
  const runStatement = button('play', t('Run the statement at the cursor'), undefined, () => run('statement'), 'Mod+Enter');
  const runSelection = button('list-selection', t('Run the selected statements'), undefined, () => run('auto'), 'Mod+Enter');
  const stop = button('debug-stop', t('Stop the running query'), { type: 'cancel' });
  const connect = button('plug', t('Connect'), { type: 'connect' });
  const disconnect = button('debug-disconnect', t('Disconnect'), { type: 'disconnect' });
  /** Where the results go around the SQL (`dbclient.sqlEditor.resultsPosition`), and its icon. */
  const POSITION_ICONS = { bottom: 'layout-panel', top: 'layout-menubar', left: 'layout-sidebar-left', right: 'layout-sidebar-right' };
  let position = 'bottom';
  const layoutButton = button(POSITION_ICONS.bottom, t('Move the results: bottom, top, left or right'), { type: 'resultsPosition' });
  const toolbar = el(
    'div',
    { class: 'sql-toolbar', role: 'toolbar' },
    el('label', { for: 'connection' }, t('Connection:')),
    connectionSelect,
    el('label', { for: 'database' }, t('Database:')),
    databaseSelect,
    separator(),
    runAll,
    runStatement,
    runSelection,
    stop,
    separator(),
    connect,
    disconnect,
    button('history', t('Query History…'), { type: 'history' }),
    button('save', t('Save in the SQL folder of the connection'), { type: 'saveToFolder' }),
    separator(),
    button('copy', t('Copy the selection, or the whole file when nothing is selected'), undefined, copy),
    button('clippy', t('Paste at the cursor'), { type: 'paste' }),
    button('export', t('Save the content to a file of your choice'), { type: 'export' }),
    button('go-to-file', t('Insert a file at the cursor'), { type: 'import' }),
    el('span', { class: 'grow' }),
    layoutButton,
    button('file-code', t('Open in the text editor'), { type: 'openAsText' }),
  );

  // Tooltips of the toolbar (native `title` tooltips do not show in every webview host). Found by
  // position, so disabled buttons get theirs too; keyboard focus shows them as well.
  const tooltip = el('div', { class: 'tooltip', role: 'tooltip', hidden: true });
  let tipTarget = null;
  let tipTimer = 0;
  function showTip(target, delay) {
    if (target === tipTarget) return;
    hideTip();
    tipTarget = target;
    const show = () => {
      tooltip.replaceChildren(target.dataset.tip, ...(target.dataset.keys ? [el('span', { class: 'keys' }, target.dataset.keys)] : []));
      tooltip.hidden = false;
      const box = target.getBoundingClientRect();
      const left = Math.min(Math.max(4, box.left + box.width / 2 - tooltip.offsetWidth / 2), window.innerWidth - tooltip.offsetWidth - 4);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${box.bottom + 4}px`;
    };
    if (delay) tipTimer = window.setTimeout(show, delay);
    else show();
  }
  function hideTip() {
    window.clearTimeout(tipTimer);
    tipTarget = null;
    tooltip.hidden = true;
  }
  toolbar.addEventListener('pointermove', (e) => {
    const target = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n instanceof HTMLElement && n.dataset.tip && toolbar.contains(n));
    if (target) showTip(target, 500);
    else hideTip();
  });
  toolbar.addEventListener('pointerleave', hideTip);
  toolbar.addEventListener('pointerdown', hideTip);
  /** True when the last input was the keyboard, so focus (Tab) shows the tooltip but a click does not. */
  let keyboard = false;
  document.addEventListener('pointerdown', () => (keyboard = false), true);
  document.addEventListener('keydown', (e) => {
    keyboard = true;
    if (e.key === 'Escape') hideTip();
  }, true);
  toolbar.addEventListener('focusin', (e) => keyboard && e.target instanceof HTMLElement && e.target.dataset.tip && showTip(e.target, 0));
  toolbar.addEventListener('focusout', hideTip);

  const editorPane = el('div', { class: 'editor' });
  const splitter = el('div', { class: 'splitter', role: 'separator', title: t('Drag to resize') });
  const resultsPane = el('div', { class: 'results' });
  // The SQL and its results, laid out by `position` (CSS flex direction).
  const work = el('div', { class: 'work', 'data-position': position }, editorPane, splitter, resultsPane);
  page.append(toolbar, work, tooltip);

  const sideBySide = () => position === 'left' || position === 'right';
  function applySplit() {
    const share = Math.min(0.9, Math.max(0.1, state.split ?? 0.55));
    editorPane.style.flexBasis = `${share * 100}%`;
  }
  applySplit();
  function applyPosition(next) {
    position = POSITION_ICONS[next] ? next : 'bottom';
    work.dataset.position = position;
    splitter.setAttribute('aria-orientation', sideBySide() ? 'vertical' : 'horizontal');
    /** @type {HTMLElement} */ (layoutButton.firstChild).className = `codicon codicon-${POSITION_ICONS[position]}`;
  }
  splitter.addEventListener('pointerdown', (e) => {
    splitter.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const box = work.getBoundingClientRect();
      const size = sideBySide() ? box.width : box.height;
      const at = sideBySide() ? ev.clientX - box.left : ev.clientY - box.top;
      // `split` is the SQL's share; it comes first unless the results are on top or on the left.
      state.split = (position === 'top' || position === 'left' ? size - at : at) / size;
      applySplit();
    };
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      saveState();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });

  // results.js renders into the lower pane and keeps its state inside ours.
  /** @type {any} */ (window).dbclientResultsHost = {
    api: vscode,
    root: resultsPane,
    document: undefined,
    getState: () => state.results,
    setState: (results) => {
      state.results = results;
      saveState();
    },
  };

  // ---------- toolbar state ----------

  /** @type {{ connections: {id: string, name: string, engine: string, folder?: string}[], connectionId?: string, database?: string, databases: string[], connected: boolean, running: boolean, dialect?: string }} */
  let toolbarState = { connections: [], databases: [], connected: false, running: false };

  function renderToolbar() {
    const s = toolbarState;
    const options = [];
    if (!s.connectionId) options.push(el('option', { value: '', selected: true, disabled: true }, t('Select connection')));
    const groups = new Map();
    for (const c of s.connections) {
      const option = el('option', { value: c.id, selected: c.id === s.connectionId }, `${c.name} (${c.engine})`);
      if (!c.folder) options.push(option);
      else {
        if (!groups.has(c.folder)) groups.set(c.folder, el('optgroup', { label: c.folder }));
        groups.get(c.folder).append(option);
      }
    }
    options.push(...groups.values(), el('option', { value: '+add' }, t('Add Connection…')));
    connectionSelect.replaceChildren(...options);

    databaseSelect.replaceChildren(
      ...(s.databases.length ? s.databases.map((d) => el('option', { value: d, selected: d === s.database }, d)) : [el('option', { value: '' }, '—')]),
    );
    databaseSelect.disabled = s.databases.length < 2;
    databaseSelect.dataset.tip = s.connected || !s.connectionId ? t('Database') : t('Connect to list the databases');

    const bound = Boolean(s.connectionId);
    connect.hidden = !bound || s.connected;
    disconnect.hidden = !bound || !s.connected;
    stop.hidden = !s.running;
    for (const b of [runAll, runStatement, runSelection]) b.toggleAttribute('disabled', s.running);
    if (view && s.dialect !== currentDialect) {
      currentDialect = s.dialect;
      CM.setDialect(view, s.dialect);
    }
  }

  connectionSelect.addEventListener('change', () => {
    const value = connectionSelect.value;
    if (value === '+add') {
      renderToolbar();
      post({ type: 'addConnection' });
    } else if (value) {
      post({ type: 'setConnection', connectionId: value });
    }
  });
  databaseSelect.addEventListener('change', () => databaseSelect.value && post({ type: 'setDatabase', database: databaseSelect.value }));

  // ---------- editor and document sync ----------

  /** @type {any} */
  let view;
  let currentDialect;
  let eol = '\n';
  /** Local edits not sent yet: composed change set and the document they apply to. */
  let pending = null;
  let pendingStart = null;
  let timer = 0;
  /** True while applying an update from the extension, so it is not sent back. */
  let applying = false;

  const pos = (doc, offset) => {
    const line = doc.lineAt(offset);
    return { line: line.number - 1, ch: offset - line.from };
  };
  const offsetOf = (doc, p) => {
    const line = doc.line(Math.min(Math.max(p.line + 1, 1), doc.lines));
    return Math.min(line.from + p.ch, line.to);
  };
  const text = () => view.state.doc.sliceString(0, view.state.doc.length, eol);

  /** Sends the pending edits now (before running, saving or any toolbar action). */
  function flush() {
    clearTimeout(timer);
    if (!pending || !view) return;
    const changes = [];
    pending.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ from: pos(pendingStart, fromA), to: pos(pendingStart, toA), insert: inserted.sliceString(0, inserted.length, eol) });
    });
    pending = null;
    pendingStart = null;
    post({ type: 'edit', changes, text: text() });
  }

  function onChange(update) {
    if (applying) return;
    if (pending) pending = pending.compose(update.changes);
    else {
      pending = update.changes;
      pendingStart = update.startState.doc;
    }
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  }

  function selectionPositions() {
    const range = view.state.selection.main;
    return { anchor: pos(view.state.doc, range.anchor), head: pos(view.state.doc, range.head) };
  }

  function run(mode) {
    if (!view) return;
    flush();
    post({ type: 'run', mode, ...selectionPositions() });
  }

  function copy() {
    if (!view) return;
    const range = view.state.selection.main;
    const doc = view.state.doc;
    post({ type: 'copy', text: range.empty ? text() : doc.sliceString(range.from, range.to, eol) });
  }

  function insert(value) {
    if (!view) return;
    const range = view.state.selection.main;
    const line = view.state.doc.lineAt(range.head);
    // On a line with code and nothing selected, the text goes on the next line.
    const tail = range.empty && line.text.trim() ? { from: line.to, to: line.to, insert: `\n${value}` } : { from: range.from, to: range.to, insert: value };
    view.dispatch({ changes: tail, selection: { anchor: tail.from + tail.insert.length }, scrollIntoView: true });
    view.focus();
  }

  function create(initial, placeholder) {
    const nonce = document.querySelector('meta[name="dbclient-nonce"]')?.getAttribute('content') || undefined;
    view = CM.create({
      parent: editorPane,
      doc: initial,
      dialect: toolbarState.dialect,
      nonce,
      placeholder,
      keys: [
        { key: 'Mod-Enter', run: () => (run('auto'), true) },
        { key: 'Shift-Mod-Enter', run: () => (run('file'), true) },
      ],
      onChange,
    });
    currentDialect = toolbarState.dialect;
    view.focus();
    post({ type: 'editorLoaded' });
  }

  function update(msg) {
    if (!view) return;
    // Local edits not sent yet would no longer line up: the document wins.
    clearTimeout(timer);
    pending = null;
    pendingStart = null;
    applying = true;
    try {
      const doc = view.state.doc;
      const changes = msg.changes.map((c) => ({ from: offsetOf(doc, c.from), to: offsetOf(doc, c.to), insert: c.insert }));
      try {
        view.dispatch({ changes });
      } catch {
        // Overlapping or stale ranges: fall through to the full text.
      }
      if (text() !== msg.text) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: msg.text } });
      }
    } finally {
      applying = false;
    }
  }

  // Undo/redo run on the document: send what was typed first so they undo it.
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.metaKey || e.ctrlKey) && ['z', 'y', 's'].includes(e.key.toLowerCase())) flush();
    },
    true,
  );
  window.addEventListener('blur', flush);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        eol = msg.eol;
        // Lets the grid's context menu commands find this editor.
        /** @type {any} */ (window).dbclientResultsHost.document = msg.document;
        if (view) update({ changes: [], text: msg.text });
        else create(msg.text, msg.placeholder);
        break;
      case 'position':
        applyPosition(msg.position);
        break;
      case 'state':
        toolbarState = msg.state;
        renderToolbar();
        break;
      case 'update':
        update(msg);
        break;
      case 'insert':
        insert(msg.text);
        break;
      case 'goto':
        if (view) {
          const at = offsetOf(view.state.doc, { line: msg.line, ch: msg.character });
          view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
          view.focus();
        }
        break;
      case 'showResults':
        if ((state.split ?? 0.55) > 0.85) {
          state.split = 0.55;
          applySplit();
          saveState();
        }
        break;
    }
  });

  renderToolbar();
  post({ type: 'editorReady' });
})();
