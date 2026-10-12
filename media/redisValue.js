// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  /** @type {any} */
  let data;
  let error = '';
  let filter = '';

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'on') {
        for (const [event, handler] of Object.entries(v)) node.addEventListener(event, handler);
      } else if (k === 'class') {
        node.className = v;
      } else if (k === 'value') {
        node.value = v;
      } else if (v !== undefined && v !== false) {
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }

  const edit = (e) => vscode.postMessage({ type: 'edit', edit: e, valueType: data.type });

  function ttlText(ttl) {
    if (ttl === -1) return 'no expiry';
    if (ttl < 0) return '—';
    const d = Math.floor(ttl / 86400);
    const h = Math.floor((ttl % 86400) / 3600);
    const m = Math.floor((ttl % 3600) / 60);
    const s = ttl % 60;
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
  }

  function pretty(text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
    } catch {
      // not JSON
    }
    return text;
  }

  function header() {
    const name = el('input', { class: 'keyname', value: data.key, title: 'Key name (Enter to rename)' });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && name.value && name.value !== data.key) edit({ op: 'rename', name: name.value });
    });
    const ttl = el('input', { class: 'ttl', type: 'number', min: '-1', placeholder: 'seconds', value: data.ttl >= 0 ? String(data.ttl) : '' });
    return el(
      'div',
      { class: 'header' },
      el('span', { class: `badge type-${data.type}` }, data.type),
      name,
      el('span', { class: 'meta' }, `db${data.db} · ${data.type === 'string' ? `${data.length} bytes` : `${data.length} items`} · TTL ${ttlText(data.ttl)}`),
      el('div', { class: 'spacer' }),
      ttl,
      el('button', { title: 'Set TTL in seconds (empty = no expiry)', on: { click: () => edit({ op: 'ttl', seconds: ttl.value === '' ? null : Number(ttl.value) }) } }, 'Set TTL'),
      el('button', { on: { click: () => vscode.postMessage({ type: 'reload' }) } }, 'Reload'),
      el('button', { class: 'danger', on: { click: () => edit({ op: 'delete' }) } }, 'Delete key'),
    );
  }

  function stringView() {
    const area = el('textarea', { class: 'value', spellcheck: 'false' });
    area.value = data.value;
    const toggle = el('button', { on: { click: () => (area.value = pretty(area.value)) } }, 'Format JSON');
    return el(
      'div',
      { class: 'body' },
      area,
      el(
        'div',
        { class: 'actions' },
        toggle,
        el('button', { class: 'primary', disabled: data.truncated, on: { click: () => edit({ op: 'setString', value: area.value }) } }, 'Save'),
        data.truncated ? el('span', { class: 'warn' }, 'Showing the first 1 MB; saving is disabled.') : null,
      ),
    );
  }

  /** Editable table: each row has inputs for its cells plus save/delete buttons. */
  function tableView(columns, rows, opts) {
    const visible = rows.filter((r) => !filter || r.some((c) => String(c).toLowerCase().includes(filter.toLowerCase())));
    const body = visible.map((row) => {
      const inputs = row.map((cell, i) => (opts.editable[i] ? el('textarea', { rows: '1', spellcheck: 'false', value: String(cell) }) : el('span', { class: 'ro' }, String(cell))));
      return el(
        'tr',
        {},
        ...inputs.map((i) => el('td', {}, i)),
        el(
          'td',
          { class: 'rowactions' },
          opts.save ? el('button', { title: 'Save', on: { click: () => opts.save(row, inputs.map((i) => (i.tagName === 'TEXTAREA' ? i.value : null))) } }, '✓') : null,
          el('button', { class: 'danger', title: 'Delete', on: { click: () => opts.remove(row) } }, '✕'),
        ),
      );
    });
    const addInputs = opts.add ? opts.add.fields.map((f) => el('input', { placeholder: f })) : [];
    return el(
      'div',
      { class: 'body' },
      el(
        'div',
        { class: 'actions' },
        el('input', {
          class: 'filter',
          placeholder: 'Filter…',
          value: filter,
          on: {
            input: (e) => {
              filter = e.target.value;
              render();
              const f = /** @type {HTMLInputElement} */ (document.querySelector('.filter'));
              f.focus();
              f.setSelectionRange(filter.length, filter.length);
            },
          },
        }),
        data.truncated ? el('span', { class: 'warn' }, `Showing ${rows.length} of ${data.length}`) : null,
      ),
      el('div', { class: 'grid' }, el('table', {}, el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', {}, c)), el('th', {}))), el('tbody', {}, ...body))),
      opts.add
        ? el(
            'div',
            { class: 'actions add' },
            ...addInputs,
            el('button', { class: 'primary', on: { click: () => opts.add.submit(addInputs.map((i) => i.value)) } }, opts.add.label),
          )
        : null,
    );
  }

  function valueView() {
    switch (data.type) {
      case 'string':
        return stringView();
      case 'hash':
        return tableView(['field', 'value'], data.value, {
          editable: [true, true],
          save: (row, [field, value]) => edit({ op: 'setField', oldField: row[0], field, value }),
          remove: (row) => edit({ op: 'delField', field: row[0] }),
          add: { fields: ['field', 'value'], label: 'Add field', submit: ([field, value]) => field && edit({ op: 'setField', field, value }) },
        });
      case 'list':
        return tableView(['#', 'value'], data.value, {
          editable: [false, true],
          save: (row, [, value]) => edit({ op: 'setIndex', index: row[0], value }),
          remove: (row) => edit({ op: 'delIndex', index: row[0] }),
          add: { fields: ['value'], label: 'Push (RPUSH)', submit: ([value]) => edit({ op: 'push', value }) },
        });
      case 'set':
        return tableView(['member'], data.value, {
          editable: [true],
          save: (row, [member]) => edit({ op: 'addMember', oldMember: row[0], member }),
          remove: (row) => edit({ op: 'delMember', member: row[0] }),
          add: { fields: ['member'], label: 'Add member', submit: ([member]) => member && edit({ op: 'addMember', member }) },
        });
      case 'zset':
        return tableView(['member', 'score'], data.value, {
          editable: [true, true],
          save: (row, [member, score]) => edit({ op: 'addMember', oldMember: row[0], member, score }),
          remove: (row) => edit({ op: 'delMember', member: row[0] }),
          add: { fields: ['member', 'score'], label: 'Add member', submit: ([member, score]) => member && edit({ op: 'addMember', member, score: score || '0' }) },
        });
      case 'stream':
        return tableView(['id', 'fields'], data.value, {
          editable: [false, false],
          remove: (row) => edit({ op: 'delEntry', id: row[0] }),
          add: {
            fields: ['{"field": "value"}'],
            label: 'Add entry (XADD *)',
            submit: ([json]) => {
              try {
                edit({ op: 'addEntry', fields: JSON.parse(json) });
              } catch {
                error = 'Entry must be a JSON object of field/value pairs.';
                render();
              }
            },
          },
        });
      default:
        return el('div', { class: 'body' }, el('p', {}, String(data.value)));
    }
  }

  function render() {
    if (!data) {
      app.replaceChildren(el('div', { class: 'empty' }, error || 'Loading…'));
      return;
    }
    app.replaceChildren(header(), error ? el('div', { class: 'error' }, error) : null, valueView());
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'value') {
      data = msg.data;
      error = '';
    } else if (msg.type === 'error') {
      error = msg.message;
    }
    render();
  });
  render();
  vscode.postMessage({ type: 'ready' });
})();
