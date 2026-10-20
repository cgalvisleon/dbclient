// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /**
   * @typedef {{ title: string, sql: string, command?: string, columns: {name: string, type?: string}[],
   *   rows: any[][], rowCount: number|null, truncated: boolean, durationMs: number,
   *   edit?: { id: number, columns: (string|null)[], key: number[], table: string }, readOnly?: string, source?: number }} Tab
   * @typedef {{ orig: Record<number, any[]>, changed: Record<number, Record<number, true>>, inserted: number[], deleted: number[] }} Pending
   * @typedef {Tab & { seq: number, page: number, sort?: {col: number, dir: 1|-1}, order?: number[], selected: number[], anchor?: number,
   *   pending?: Pending, focus?: {row: number, col: number}, committing?: boolean, editError?: string }} TabState
   */

  const saved = vscode.getState() || {};
  /** @type {TabState[]} */
  let tabs = saved.tabs || [];
  /** @type {any[]} */
  let log = saved.log || [];
  /** @type {number|'log'} */
  let active = saved.active ?? 'log';
  // Result tabs pile up across runs unless the user turns it off.
  let keep = saved.keepTabs ?? true;
  let pageSize = saved.pageSize || 100;
  let seq = saved.seq || 0;
  /** Cell being typed into: { seq, row, col } (not persisted). */
  let editing = null;
  /** Index of the result tab being dragged. */
  let dragging = -1;
  /** Oldest result tabs (without pending edits) are closed past this many. */
  const MAX_TABS = 50;

  function persist() {
    vscode.setState({ tabs, log: log.slice(-500), active, keepTabs: keep, pageSize, seq });
  }

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


  // ---------- data helpers ----------

  function order(tab) {
    if (tab.order) return tab.order;
    const idx = tab.rows.map((_, i) => i);
    if (tab.sort) {
      const { col, dir } = tab.sort;
      idx.sort((a, b) => compare(tab.rows[a][col], tab.rows[b][col]) * dir);
    }
    tab.order = idx;
    return idx;
  }

  function compare(a, b) {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  function text(v) {
    return v === null ? '' : String(v);
  }

  function tsv(tab, rowIndexes) {
    const clean = (v) => text(v).replace(/[\t\r\n]+/g, ' ');
    return [tab.columns.map((c) => c.name).join('\t'), ...rowIndexes.map((i) => tab.rows[i].map(clean).join('\t'))].join('\n');
  }

  function csv(tab) {
    const quote = (v) => {
      const s = text(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [tab.columns.map((c) => quote(c.name)).join(','), ...order(tab).map((i) => tab.rows[i].map(quote).join(','))].join('\r\n');
  }

  /** All rows (in the current order) as a JSON array, or one row as an object. */
  function json(tab, row) {
    const seen = new Map();
    const keys = tab.columns.map((c) => {
      const n = (seen.get(c.name) || 0) + 1;
      seen.set(c.name, n);
      return n === 1 ? c.name : `${c.name}_${n}`;
    });
    const parse = (v, col) => {
      const type = tab.columns[col].type;
      if (typeof v === 'string' && (type === 'json' || type === 'jsonb')) {
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      }
      return v;
    };
    const object = (i) => Object.fromEntries(keys.map((k, c) => [k, parse(tab.rows[i][c], c)]));
    return JSON.stringify(row === undefined ? order(tab).map(object) : object(row), null, 2);
  }

  // ---------- grid editing ----------

  /** @returns {Pending} */
  function pend(tab) {
    return (tab.pending ||= { orig: {}, changed: {}, inserted: [], deleted: [] });
  }

  function editableCol(tab, col) {
    return Boolean(tab.edit && tab.edit.columns[col] !== null && tab.edit.columns[col] !== undefined);
  }

  function isDeleted(tab, row) {
    return Boolean(tab.pending && tab.pending.deleted.includes(row));
  }

  function isInserted(tab, row) {
    return Boolean(tab.pending && tab.pending.inserted.includes(row));
  }

  function isDirty(tab, row, col) {
    return Boolean(tab.pending && tab.pending.changed[row] && tab.pending.changed[row][col]);
  }

  function pendingCount(tab) {
    const p = tab.pending;
    if (!p) return 0;
    const live = (r) => !p.deleted.includes(r);
    const inserts = p.inserted.filter(live).length;
    const updates = Object.keys(p.changed)
      .map(Number)
      .filter((r) => !p.inserted.includes(r) && live(r) && Object.keys(p.changed[r]).length).length;
    const deletes = p.deleted.filter((r) => !p.inserted.includes(r)).length;
    return inserts + updates + deletes;
  }

  /** Typed text back to a value: booleans stay booleans and an unchanged number stays the same number. */
  function parseInput(raw, previous) {
    if (typeof previous === 'boolean' && /^(true|false|1|0)$/i.test(raw.trim())) return /^(true|1)$/i.test(raw.trim());
    if (typeof previous === 'number' && raw.trim() !== '' && Number(raw) === previous) return previous;
    return raw;
  }

  function setCell(tab, row, col, value) {
    const p = pend(tab);
    const inserted = p.inserted.includes(row);
    if (!inserted && !(row in p.orig)) p.orig[row] = tab.rows[row].slice();
    tab.rows[row][col] = value;
    const changed = (p.changed[row] ||= {});
    if (!inserted && p.orig[row][col] === value) delete changed[col];
    else changed[col] = true;
  }

  function startEdit(tab, row, col) {
    if (!editableCol(tab, col) || isDeleted(tab, row) || tab.committing) return;
    tab.focus = { row, col };
    editing = { seq: tab.seq, row, col };
    render();
  }

  function nextEditable(tab, col, step) {
    for (let c = col + step; c >= 0 && c < tab.columns.length; c += step) if (editableCol(tab, c)) return c;
    return undefined;
  }

  function finishEdit(tab, input, save, move) {
    // Only the input of the cell being edited may finish it (a late blur of a replaced input must not).
    if (!editing || editing.seq !== tab.seq || input.dataset.cell !== `${editing.row}:${editing.col}`) return;
    const { row, col } = editing;
    editing = null;
    if (save) {
      const value = parseInput(input.value, tab.rows[row][col]);
      if (value !== tab.rows[row][col]) setCell(tab, row, col, value);
    }
    persist();
    const next = move ? nextEditable(tab, col, move) : undefined;
    if (next !== undefined) startEdit(tab, row, next);
    else render();
  }

  function addRow(tab) {
    const row = tab.rows.length;
    tab.rows.push(tab.columns.map(() => null));
    pend(tab).inserted.push(row);
    tab.order = undefined;
    tab.page = Math.max(0, Math.ceil(order(tab).length / pageSize) - 1);
    const first = nextEditable(tab, -1, 1);
    if (first !== undefined) startEdit(tab, row, first);
    else render();
    persist();
  }

  function toggleDelete(tab) {
    const rows = tab.selected.length ? tab.selected : tab.focus ? [tab.focus.row] : [];
    const p = pend(tab);
    for (const row of rows) {
      p.deleted = p.deleted.includes(row) ? p.deleted.filter((r) => r !== row) : [...p.deleted, row];
    }
    persist();
    render();
  }

  function setNull(tab) {
    const f = tab.focus;
    if (!f || !editableCol(tab, f.col) || isDeleted(tab, f.row)) return;
    setCell(tab, f.row, f.col, null);
    persist();
    render();
  }

  function cancelEdits(tab) {
    const p = tab.pending;
    if (!p) return;
    for (const [row, orig] of Object.entries(p.orig)) tab.rows[Number(row)] = orig;
    // Inserted rows are always the last ones.
    for (const row of [...p.inserted].sort((a, b) => b - a)) tab.rows.splice(row, 1);
    tab.pending = undefined;
    tab.order = undefined;
    tab.selected = [];
    tab.editError = undefined;
    editing = null;
    persist();
    render();
  }

  function commitEdits(tab) {
    const p = tab.pending;
    if (!p || !tab.edit || tab.committing) return;
    const keyOf = (row) => Object.fromEntries(tab.edit.key.map((c) => [c, (p.orig[row] || tab.rows[row])[c]]));
    const valuesOf = (row) => Object.fromEntries(Object.keys(p.changed[row] || {}).map((c) => [c, tab.rows[row][Number(c)]]));
    const changes = [];
    for (const row of p.deleted.filter((r) => !p.inserted.includes(r))) changes.push({ kind: 'delete', key: keyOf(row) });
    for (const row of Object.keys(p.changed).map(Number)) {
      if (p.inserted.includes(row) || p.deleted.includes(row) || !Object.keys(p.changed[row]).length) continue;
      changes.push({ kind: 'update', key: keyOf(row), values: valuesOf(row) });
    }
    for (const row of p.inserted.filter((r) => !p.deleted.includes(r))) changes.push({ kind: 'insert', values: valuesOf(row) });
    if (!changes.length) {
      cancelEdits(tab);
      return;
    }
    tab.committing = true;
    tab.editError = undefined;
    vscode.postMessage({ type: 'commit', editId: tab.edit.id, changes });
    render();
  }

  function committed(msg) {
    const tab = tabs.find((x) => x.edit && x.edit.id === msg.editId);
    if (!tab) return;
    tab.committing = false;
    if (!msg.ok) {
      tab.editError = msg.message;
      return;
    }
    if (msg.rows) {
      tab.rows = msg.rows;
      if (msg.rowCount !== undefined) tab.rowCount = msg.rowCount;
      if (msg.truncated !== undefined) tab.truncated = msg.truncated;
    } else if (tab.pending) {
      for (const row of [...tab.pending.deleted].sort((a, b) => b - a)) tab.rows.splice(row, 1);
    }
    tab.pending = undefined;
    tab.order = undefined;
    tab.selected = [];
    tab.editError = undefined;
  }

  // ---------- rendering ----------

  function render() {
    const bar = el(
      'div',
      { class: 'tabbar' },
      // Output always stays first; dropping a result tab on it moves that tab to the front.
      el(
        'div',
        { class: `tab output ${active === 'log' ? 'active' : ''}`, on: { click: () => select('log'), ...dropTarget(0, () => 0) } },
        el('span', {}, t('Output')),
        log.some((e) => !e.ok) ? el('span', { class: 'badge' }, String(log.filter((e) => !e.ok).length)) : null,
      ),
      ...tabs.map((x, i) =>
        el(
          'div',
          {
            class: `tab ${active === i ? 'active' : ''}`,
            title: `${x.sql}\n\n${t('Drag to reorder')}`,
            draggable: 'true',
            on: {
              click: () => select(i),
              auxclick: (e) => e.button === 1 && closeTab(i),
              dragstart: (e) => {
                dragging = i;
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', x.title);
                }
              },
              dragend: () => ((dragging = -1), clearDropMarks()),
              ...dropTarget(i, (e, node) => {
                const rect = node.getBoundingClientRect();
                return e.clientX < rect.left + rect.width / 2 ? i : i + 1;
              }),
            },
          },
          el('span', {}, `${x.seq}. ${x.title}`),
          el('span', { class: 'close', title: t('Close'), on: { click: (e) => (e.stopPropagation(), closeTab(i)) } }, '×'),
        ),
      ),
      el('div', { class: 'spacer' }),
      el(
        'label',
        { class: 'keep', title: t('Keep previous result tabs when running again') },
        el('input', { type: 'checkbox', checked: keep, on: { change: (e) => ((keep = e.target.checked), persist()) } }),
        ` ${t('Keep tabs')}`,
      ),
      el('button', { class: 'icon', title: t('Close all result tabs'), on: { click: () => ((tabs = []), (active = 'log'), persist(), render()) } }, '⌫'),
    );
    const body = active === 'log' ? renderLog() : tabs[active] ? renderTab(tabs[active]) : el('div', { class: 'empty' }, t('Run a statement to see results here.'));
    app.replaceChildren(bar, body);
    const input = /** @type {HTMLInputElement|null} */ (app.querySelector('.cell-input'));
    if (input && document.activeElement !== input) {
      input.focus();
      if (editing && editing.draft === undefined) input.select();
    }
    if (active === 'log') {
      const list = app.querySelector('.log');
      if (list) list.scrollTop = list.scrollHeight;
    }
  }

  function renderLog() {
    const toolbar = el(
      'div',
      { class: 'toolbar' },
      el('span', { class: 'info' }, t('{0} entries', log.length)),
      el('div', { class: 'spacer' }),
      el('button', { title: t('Clear the output log and restart the query numbering'), on: { click: clearOutput } }, t('Clear')),
    );
    if (!log.length) return el('div', { class: 'result' }, toolbar, el('div', { class: 'empty' }, t('SQL output will appear here.')));
    return el('div', { class: 'result' }, toolbar, el(
      'div',
      { class: 'log' },
      ...log.map((e) =>
        el(
          'div',
          {
            class: `entry ${e.ok ? 'ok' : 'error'} ${e.location ? 'link' : ''}`,
            title: e.location ? t('Go to statement') : undefined,
            on: e.location ? { click: () => vscode.postMessage({ type: 'reveal', location: e.location }) } : {},
          },
          el('span', { class: 'time' }, e.time),
          el('span', { class: 'mark' }, e.ok ? '✓' : '✗'),
          el('span', { class: 'conn' }, e.connection),
          el('span', { class: 'msg' }, e.message + (e.durationMs !== undefined ? ` (${e.durationMs} ms)` : '')),
          el('div', { class: 'sql' }, e.sql),
        ),
      ),
    ));
  }

  function renderTab(tab) {
    const ids = order(tab);
    const pages = Math.max(1, Math.ceil(ids.length / pageSize));
    tab.page = Math.min(tab.page, pages - 1);
    const from = tab.page * pageSize;
    const visible = ids.slice(from, from + pageSize);
    const selected = new Set(tab.selected);

    const go = (page) => () => {
      tab.page = Math.max(0, Math.min(pages - 1, page));
      persist();
      render();
    };
    const info = [
      tab.rowCount === null && tab.truncated ? t('first {0} rows (truncated)', tab.rows.length) : t('{0} rows', tab.rows.length),
      `${tab.durationMs} ms`,
    ].join(' · ');

    const toolbar = el(
      'div',
      { class: 'toolbar' },
      el('button', { title: t('First page'), disabled: tab.page === 0, on: { click: go(0) } }, '«'),
      el('button', { title: t('Previous page'), disabled: tab.page === 0, on: { click: go(tab.page - 1) } }, '‹'),
      el('span', { class: 'pager' }, t('{0}–{1} of {2}', ids.length ? from + 1 : 0, from + visible.length, ids.length)),
      el('button', { title: t('Next page'), disabled: tab.page >= pages - 1, on: { click: go(tab.page + 1) } }, '›'),
      el('button', { title: t('Last page'), disabled: tab.page >= pages - 1, on: { click: go(pages - 1) } }, '»'),
      el('span', { class: `info ${tab.truncated ? 'warn' : ''}` }, info),
      ...editControls(tab),
      el('div', { class: 'spacer' }),
      el('button', { title: t('Copy selected rows (or the page) as TSV'), on: { click: () => copy(tab, visible) } }, t('Copy')),
      el('button', { title: t('Export all rows to CSV'), on: { click: () => save(tab, 'csv') } }, 'CSV'),
      el('button', { title: t('Export all rows to JSON'), on: { click: () => save(tab, 'json') } }, 'JSON'),
      el('button', { title: t('Export all rows to an Excel workbook (.xlsx)'), on: { click: () => saveExcel(tab) } }, 'Excel'),
    );

    const header = el(
      'tr',
      {},
      el('th', { class: 'rownum' }, '#'),
      ...tab.columns.map((c, i) =>
        el(
          'th',
          { title: c.type ? `${c.name} : ${c.type}` : c.name, on: { click: () => sortBy(tab, i) } },
          c.name,
          tab.sort && tab.sort.col === i ? el('span', { class: 'sort' }, tab.sort.dir === 1 ? ' ▲' : ' ▼') : null,
        ),
      ),
    );
    const rows = visible.map((rowIndex, n) => {
      const inserted = isInserted(tab, rowIndex);
      const rowClass = [selected.has(rowIndex) ? 'selected' : '', inserted ? 'inserted' : '', isDeleted(tab, rowIndex) ? 'deleted' : ''].join(' ');
      return el(
        'tr',
        { class: rowClass, on: { click: (e) => selectRow(tab, ids, from + n, e) } },
        el('td', { class: 'rownum' }, inserted ? '+' : String(from + n + 1)),
        ...tab.rows[rowIndex].map((v, col) => {
          if (editing && editing.seq === tab.seq && editing.row === rowIndex && editing.col === col) {
            return el('td', { class: 'editing' }, editorInput(tab, v));
          }
          const dirty = isDirty(tab, rowIndex, col);
          const untouched = inserted && !dirty;
          const focused = tab.focus && tab.focus.row === rowIndex && tab.focus.col === col;
          return el(
            'td',
            {
              class: [untouched ? 'null default' : v === null ? 'null' : typeof v === 'number' ? 'num' : '', dirty ? 'dirty' : '', focused ? 'focus' : '', editableCol(tab, col) ? 'editable' : ''].join(' '),
              title: untouched ? 'DEFAULT' : v === null ? 'NULL' : String(v).slice(0, 2000),
              // Read by VS Code for the context menu (webview/context in package.json).
              'data-vscode-context': JSON.stringify({ webviewSection: 'cell', seq: tab.seq, row: rowIndex, col, rowSql: tab.source !== undefined, preventDefaultContextMenuItems: true }),
              // Double clicks are detected by hand: the first click re-renders the grid, so the
              // browser would not see both clicks on the same element.
              on: { click: () => cellClick(tab, rowIndex, col, v) },
            },
            untouched ? 'DEFAULT' : v === null ? 'NULL' : String(v),
          );
        }),
      );
    });
    return el('div', { class: 'result' }, toolbar, el('div', { class: 'grid' }, el('table', {}, el('thead', {}, header), el('tbody', {}, ...rows))));
  }

  let lastClick = { seq: -1, row: -1, col: -1, time: 0 };

  function cellClick(tab, row, col, value) {
    const now = Date.now();
    const double = lastClick.seq === tab.seq && lastClick.row === row && lastClick.col === col && now - lastClick.time < 450;
    lastClick = { seq: tab.seq, row, col, time: double ? 0 : now };
    if (tab.edit) tab.focus = { row, col };
    if (!double) return;
    if (editableCol(tab, col)) startEdit(tab, row, col);
    else vscode.postMessage({ type: 'copy', text: text(value) });
  }

  function editControls(tab) {
    if (!tab.edit) {
      return tab.readOnly ? [el('span', { class: 'readonly', title: tab.readOnly }, t('read-only'))] : [];
    }
    const count = pendingCount(tab);
    const busy = Boolean(tab.committing);
    return [
      el('span', { class: 'sep' }),
      el('button', { title: t('Insert a row into {0}', tab.edit.table), disabled: busy, on: { click: () => addRow(tab) } }, t('+ Row')),
      el('button', { title: t('Mark the selected rows for deletion (again to undo)'), disabled: busy || !(tab.selected.length || tab.focus), on: { click: () => toggleDelete(tab) } }, t('Delete')),
      el('button', { title: t('Set the focused cell to NULL'), disabled: busy || !tab.focus || !editableCol(tab, tab.focus.col), on: { click: () => setNull(tab) } }, 'NULL'),
      el('button', { class: count ? 'primary' : '', title: t('Save the changes to {0} in one transaction', tab.edit.table), disabled: busy || !count, on: { click: () => commitEdits(tab) } }, busy ? t('Saving…') : count ? t('Commit ({0})', count) : t('Commit')),
      el('button', { title: t('Discard the pending changes'), disabled: busy || !tab.pending, on: { click: () => cancelEdits(tab) } }, t('Cancel')),
      tab.editError ? el('span', { class: 'edit-error', title: tab.editError }, tab.editError.split('\n')[0]) : null,
    ];
  }

  function editorInput(tab, value) {
    // Keeps what was typed if the grid re-renders meanwhile (e.g. a log entry arrives).
    const current = editing.draft !== undefined ? editing.draft : value === null ? '' : String(value);
    const input = /** @type {HTMLInputElement} */ (el('input', { class: 'cell-input', value: current, placeholder: value === null ? 'NULL' : undefined }));
    input.dataset.cell = `${editing.row}:${editing.col}`;
    input.addEventListener('input', () => editing && (editing.draft = input.value));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finishEdit(tab, input, true);
      else if (e.key === 'Escape') finishEdit(tab, input, false);
      else if (e.key === 'Tab') {
        e.preventDefault();
        finishEdit(tab, input, true, e.shiftKey ? -1 : 1);
      }
    });
    input.addEventListener('blur', () => finishEdit(tab, input, true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    return input;
  }

  // ---------- output and context menu ----------

  /** Empties the output log and numbers the open result tabs again from 1. */
  function clearOutput() {
    log = [];
    tabs.forEach((x, i) => (x.seq = i + 1));
    seq = tabs.length;
    editing = null;
    lastClick = { seq: -1, row: -1, col: -1, time: 0 };
    persist();
    render();
  }

  function rowAction(msg) {
    const tab = tabs.find((x) => x.seq === msg.seq);
    if (!tab || !tab.rows[msg.row]) return;
    switch (msg.action) {
      case 'copyValue':
        vscode.postMessage({ type: 'copy', text: text(tab.rows[msg.row][msg.col]) });
        break;
      case 'copyRow':
        vscode.postMessage({ type: 'copy', text: tsv(tab, [msg.row]) });
        break;
      case 'copyRowJson':
        vscode.postMessage({ type: 'copy', text: json(tab, msg.row) });
        break;
      default:
        if (tab.source !== undefined) vscode.postMessage({ type: 'rowSql', source: tab.source, kind: msg.action, row: tab.rows[msg.row] });
    }
  }

  // ---------- reordering ----------

  /**
   * Drag handlers for the tab at `index`: a dragged result tab lands before the tab at the
   * index `position` returns (indexes before the move), marked on the left or right edge.
   */
  function dropTarget(index, position) {
    return {
      dragover: (e) => {
        if (dragging < 0) return;
        e.preventDefault();
        const node = /** @type {HTMLElement} */ (e.currentTarget);
        clearDropMarks();
        node.classList.add(position(e, node) > index ? 'drop-after' : 'drop-before');
      },
      dragleave: (e) => /** @type {HTMLElement} */ (e.currentTarget).classList.remove('drop-before', 'drop-after'),
      drop: (e) => {
        if (dragging < 0) return;
        e.preventDefault();
        const to = position(e, /** @type {HTMLElement} */ (e.currentTarget));
        const from = dragging;
        dragging = -1;
        moveTab(from, to);
      },
    };
  }

  function clearDropMarks() {
    app.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  }

  /** Moves result tab `from` so it lands before the tab at index `to` (indexes before the move). */
  function moveTab(from, to) {
    const current = typeof active === 'number' ? tabs[active] : undefined;
    const [tab] = tabs.splice(from, 1);
    tabs.splice(to > from ? to - 1 : to, 0, tab);
    if (current) active = tabs.indexOf(current);
    persist();
    render();
  }

  /** Closes the oldest result tabs without pending edits beyond MAX_TABS. */
  function trimTabs() {
    while (tabs.length > MAX_TABS) {
      const candidates = tabs.filter((x) => !x.pending && x !== tabs[tabs.length - 1]);
      if (!candidates.length) return;
      tabs.splice(tabs.indexOf(candidates.reduce((a, b) => (a.seq < b.seq ? a : b))), 1);
    }
  }

  // ---------- actions ----------

  function select(target) {
    active = target;
    persist();
    render();
  }

  function closeTab(i) {
    tabs.splice(i, 1);
    if (active === i || active === tabs.length) active = tabs.length ? Math.min(i, tabs.length - 1) : 'log';
    else if (typeof active === 'number' && active > i) active--;
    persist();
    render();
  }

  function sortBy(tab, col) {
    if (!tab.sort || tab.sort.col !== col) tab.sort = { col, dir: 1 };
    else if (tab.sort.dir === 1) tab.sort = { col, dir: -1 };
    else tab.sort = undefined;
    tab.order = undefined;
    tab.page = 0;
    persist();
    render();
  }

  function selectRow(tab, ids, position, e) {
    const rowIndex = ids[position];
    if (e.shiftKey && tab.anchor !== undefined) {
      const [a, b] = [Math.min(tab.anchor, position), Math.max(tab.anchor, position)];
      tab.selected = ids.slice(a, b + 1);
    } else if (e.metaKey || e.ctrlKey) {
      tab.selected = tab.selected.includes(rowIndex) ? tab.selected.filter((r) => r !== rowIndex) : [...tab.selected, rowIndex];
      tab.anchor = position;
    } else {
      tab.selected = [rowIndex];
      tab.anchor = position;
    }
    render();
  }

  function copy(tab, fallback) {
    const ids = order(tab).filter((i) => tab.selected.includes(i));
    vscode.postMessage({ type: 'copy', text: tsv(tab, ids.length ? ids : fallback) });
  }

  function saveExcel(tab) {
    vscode.postMessage({
      type: 'saveXlsx',
      name: `result-${tab.seq}`,
      sheet: tab.title,
      columns: tab.columns.map((c) => c.name),
      types: tab.columns.map((c) => c.type),
      rows: order(tab).map((i) => tab.rows[i]),
    });
  }

  function save(tab, format) {
    vscode.postMessage({ type: 'save', format, content: format === 'csv' ? csv(tab) : json(tab), name: `result-${tab.seq}` });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F2' && typeof active === 'number' && tabs[active] && tabs[active].focus && !editing) {
      const tab = tabs[active];
      startEdit(tab, tab.focus.row, tab.focus.col);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && typeof active === 'number' && tabs[active]) {
      const tab = tabs[active];
      if (tab.selected.length && !String(window.getSelection())) {
        e.preventDefault();
        copy(tab, []);
      }
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'run':
        pageSize = msg.pageSize;
        if (!keep) {
          tabs = [];
          active = 'log';
        }
        break;
      case 'result':
        tabs.push({ ...msg.tab, seq: ++seq, page: 0, selected: [] });
        trimTabs();
        active = tabs.length - 1;
        break;
      case 'log':
        log.push(msg.entry);
        if (log.length > 1000) log = log.slice(-1000);
        break;
      case 'focusLog':
        active = 'log';
        break;
      case 'select':
        if (tabs.length) active = msg.tab < 0 ? Math.max(0, tabs.length + msg.tab) : Math.min(msg.tab, tabs.length - 1);
        break;
      case 'committed':
        committed(msg);
        break;
      case 'rowAction':
        rowAction(msg);
        return;
    }
    persist();
    render();
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
