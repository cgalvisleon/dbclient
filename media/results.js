// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /**
   * @typedef {{ title: string, sql: string, command?: string, columns: {name: string, type?: string}[],
   *   rows: any[][], rowCount: number|null, truncated: boolean, durationMs: number }} Tab
   * @typedef {Tab & { seq: number, page: number, sort?: {col: number, dir: 1|-1}, order?: number[], selected: number[], anchor?: number }} TabState
   */

  const saved = vscode.getState() || {};
  /** @type {TabState[]} */
  let tabs = saved.tabs || [];
  /** @type {any[]} */
  let log = saved.log || [];
  /** @type {number|'log'} */
  let active = saved.active ?? 'log';
  let keep = Boolean(saved.keep);
  let pageSize = saved.pageSize || 100;
  let seq = saved.seq || 0;

  function persist() {
    vscode.setState({ tabs, log: log.slice(-500), active, keep, pageSize, seq });
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

  function json(tab) {
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
    return JSON.stringify(order(tab).map((i) => Object.fromEntries(keys.map((k, c) => [k, parse(tab.rows[i][c], c)]))), null, 2);
  }

  // ---------- rendering ----------

  function render() {
    const bar = el(
      'div',
      { class: 'tabbar' },
      ...tabs.map((t, i) =>
        el(
          'div',
          { class: `tab ${active === i ? 'active' : ''}`, title: t.sql, on: { click: () => select(i) } },
          el('span', {}, `${t.seq}. ${t.title}`),
          el('span', { class: 'close', title: 'Close', on: { click: (e) => (e.stopPropagation(), closeTab(i)) } }, '×'),
        ),
      ),
      el(
        'div',
        { class: `tab ${active === 'log' ? 'active' : ''}`, on: { click: () => select('log') } },
        el('span', {}, 'Output'),
        log.some((e) => !e.ok) ? el('span', { class: 'badge' }, String(log.filter((e) => !e.ok).length)) : null,
      ),
      el('div', { class: 'spacer' }),
      el(
        'label',
        { class: 'keep', title: 'Keep previous result tabs when running again' },
        el('input', { type: 'checkbox', checked: keep, on: { change: (e) => ((keep = e.target.checked), persist()) } }),
        ' Keep tabs',
      ),
      el('button', { class: 'icon', title: 'Close all result tabs', on: { click: () => ((tabs = []), (active = 'log'), persist(), render()) } }, '⌫'),
    );
    const body = active === 'log' ? renderLog() : tabs[active] ? renderTab(tabs[active]) : el('div', { class: 'empty' }, 'Run a statement to see results here.');
    app.replaceChildren(bar, body);
    if (active === 'log') {
      const list = app.querySelector('.log');
      if (list) list.scrollTop = list.scrollHeight;
    }
  }

  function renderLog() {
    if (!log.length) return el('div', { class: 'empty' }, 'SQL output will appear here.');
    return el(
      'div',
      { class: 'log' },
      ...log.map((e) =>
        el(
          'div',
          {
            class: `entry ${e.ok ? 'ok' : 'error'} ${e.location ? 'link' : ''}`,
            title: e.location ? 'Go to statement' : undefined,
            on: e.location ? { click: () => vscode.postMessage({ type: 'reveal', location: e.location }) } : {},
          },
          el('span', { class: 'time' }, e.time),
          el('span', { class: 'mark' }, e.ok ? '✓' : '✗'),
          el('span', { class: 'conn' }, e.connection),
          el('span', { class: 'msg' }, e.message + (e.durationMs !== undefined ? ` (${e.durationMs} ms)` : '')),
          el('div', { class: 'sql' }, e.sql),
        ),
      ),
    );
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
      tab.rowCount === null && tab.truncated ? `first ${tab.rows.length} rows (truncated)` : `${tab.rows.length} rows`,
      `${tab.durationMs} ms`,
    ].join(' · ');

    const toolbar = el(
      'div',
      { class: 'toolbar' },
      el('button', { title: 'First page', disabled: tab.page === 0, on: { click: go(0) } }, '«'),
      el('button', { title: 'Previous page', disabled: tab.page === 0, on: { click: go(tab.page - 1) } }, '‹'),
      el('span', { class: 'pager' }, `${ids.length ? from + 1 : 0}–${from + visible.length} of ${ids.length}`),
      el('button', { title: 'Next page', disabled: tab.page >= pages - 1, on: { click: go(tab.page + 1) } }, '›'),
      el('button', { title: 'Last page', disabled: tab.page >= pages - 1, on: { click: go(pages - 1) } }, '»'),
      el('span', { class: `info ${tab.truncated ? 'warn' : ''}` }, info),
      el('div', { class: 'spacer' }),
      el('button', { title: 'Copy selected rows (or the page) as TSV', on: { click: () => copy(tab, visible) } }, 'Copy'),
      el('button', { title: 'Export all rows to CSV', on: { click: () => save(tab, 'csv') } }, 'CSV'),
      el('button', { title: 'Export all rows to JSON', on: { click: () => save(tab, 'json') } }, 'JSON'),
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
    const rows = visible.map((rowIndex, n) =>
      el(
        'tr',
        { class: selected.has(rowIndex) ? 'selected' : '', on: { click: (e) => selectRow(tab, ids, from + n, e) } },
        el('td', { class: 'rownum' }, String(from + n + 1)),
        ...tab.rows[rowIndex].map((v) =>
          el(
            'td',
            {
              class: v === null ? 'null' : typeof v === 'number' ? 'num' : '',
              title: v === null ? 'NULL' : String(v).slice(0, 2000),
              on: { dblclick: () => vscode.postMessage({ type: 'copy', text: text(v) }) },
            },
            v === null ? 'NULL' : String(v),
          ),
        ),
      ),
    );
    return el('div', { class: 'result' }, toolbar, el('div', { class: 'grid' }, el('table', {}, el('thead', {}, header), el('tbody', {}, ...rows))));
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

  function save(tab, format) {
    vscode.postMessage({ type: 'save', format, content: format === 'csv' ? csv(tab) : json(tab), name: `result-${tab.seq}` });
  }

  document.addEventListener('keydown', (e) => {
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
        active = tabs.length - 1;
        break;
      case 'log':
        log.push(msg.entry);
        if (log.length > 1000) log = log.slice(-1000);
        break;
      case 'focusLog':
        active = 'log';
        break;
    }
    persist();
    render();
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
