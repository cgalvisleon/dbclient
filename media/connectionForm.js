// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  /** @type {any} */
  let init;
  /** @type {any} */
  let value;

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'on') {
        for (const [event, handler] of Object.entries(v)) node.addEventListener(event, handler);
      } else if (v !== undefined && v !== false) {
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const child of children) node.append(child);
    return node;
  }

  function driver() {
    return init.drivers.find((d) => d.type === value.type) || init.drivers[0];
  }

  function defaults(type) {
    const d = init.drivers.find((x) => x.type === type);
    const options = {};
    for (const f of d.fields) if (f.default !== undefined && !f.secret) options[f.key] = f.default;
    return options;
  }

  /** Whether a field applies given the current form values (`showWhen`). */
  function visible(f, options) {
    if (!f.showWhen) return true;
    return f.showWhen.values.includes(options[f.showWhen.field]);
  }

  function readInput(f) {
    const input = /** @type {HTMLInputElement} */ (document.getElementById(`f-${f.key}`));
    if (!input) return undefined;
    if (f.kind === 'checkbox') return input.checked;
    if (f.kind === 'number') return input.value === '' ? undefined : Number(input.value);
    return input.value;
  }

  function collect() {
    const options = {};
    const secrets = {};
    for (const f of driver().fields) {
      if (f.secret) continue;
      // A field that is not on screen yet (just became visible) keeps its value or default.
      const read = readInput(f);
      options[f.key] = read !== undefined ? read : value.options[f.key] !== undefined ? value.options[f.key] : f.default;
    }
    for (const f of driver().fields) {
      if (!visible(f, options)) {
        delete options[f.key];
        continue;
      }
      if (f.secret) secrets[f.key] = readInput(f) || undefined;
    }
    const name = /** @type {HTMLInputElement} */ (document.getElementById('f-name')).value;
    const folder = /** @type {HTMLSelectElement} */ (document.getElementById('f-folder'));
    const folderId = folder ? folder.value || undefined : value.folderId;
    const result = { name, type: value.type, options, folderId };
    if (driver().category === 'sql') {
      const save = /** @type {HTMLInputElement} */ (document.getElementById('f-sqlSave'));
      const links = /** @type {HTMLTextAreaElement} */ (document.getElementById('f-sqlLocations'));
      result.sqlSaveLocation = save ? save.value.trim() || undefined : value.sqlSaveLocation;
      if (links) {
        // Keep labels of folders that are still listed.
        const labels = new Map((value.sqlLocations || []).map((l) => [l.path, l.label]));
        result.sqlLocations = links.value
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => (labels.get(p) ? { path: p, label: labels.get(p) } : { path: p }));
      } else {
        result.sqlLocations = value.sqlLocations;
      }
    }
    return { value: result, secrets };
  }

  function setStatus(text, ok) {
    const status = /** @type {HTMLElement} */ (document.getElementById('status'));
    status.textContent = text;
    status.className = ok === undefined ? 'status' : ok ? 'status ok' : 'status error';
  }

  function fieldRow(f) {
    const id = `f-${f.key}`;
    const current = value.options[f.key];
    let input;
    if (f.kind === 'select') {
      input = el(
        'select',
        { id, on: { change: rerender } },
        ...(f.choices || []).map((c) => el('option', { value: c, selected: c === current }, t(c))),
      );
    } else if (f.kind === 'file') {
      input = el(
        'div',
        { class: 'file' },
        el('input', { id, type: 'text', value: current ?? '', placeholder: f.placeholder ? t(f.placeholder) : '', required: f.required, autocomplete: 'off' }),
        el('button', { type: 'button', class: 'secondary', on: { click: () => vscode.postMessage({ type: 'browse', field: f.key }) } }, init.labels.browse),
      );
    } else if (f.kind === 'checkbox') {
      input = el('input', { id, type: 'checkbox', checked: Boolean(current), on: { change: rerender } });
    } else {
      const saved = f.secret && !value.isNew && init.savedSecrets[f.key];
      input = el('input', {
        id,
        type: f.kind === 'password' ? 'password' : f.kind === 'number' ? 'number' : 'text',
        value: f.secret ? '' : current ?? '',
        placeholder: saved ? `•••••• (${init.labels.saved})` : f.placeholder ? t(f.placeholder) : '',
        required: f.required && !f.secret,
        autocomplete: 'off',
      });
    }
    const row = el('div', { class: 'row' }, el('label', { for: id }, t(f.label) + (f.required && !f.secret ? ' *' : '')), input);
    return f.hint ? [row, el('div', { class: 'hint' }, t(f.hint))] : [row];
  }

  /** Visible fields: those without a section first, then one heading per section. */
  function fieldRows() {
    const fields = driver().fields;
    const plain = fields.filter((f) => !f.section && visible(f, value.options)).flatMap(fieldRow);
    const sections = [...new Set(fields.map((f) => f.section).filter(Boolean))];
    return [
      ...plain,
      ...sections.flatMap((name) => {
        const rows = fields.filter((f) => f.section === name && visible(f, value.options)).flatMap(fieldRow);
        return rows.length ? [el('h4', { class: 'section' }, t(name)), ...rows] : [];
      }),
    ];
  }

  /** Where this connection's .sql files are saved and which folders are linked to it. */
  function sqlFilesSection() {
    const l = init.labels;
    return [
      el('h4', { class: 'section' }, l.sqlFiles),
      el(
        'div',
        { class: 'row' },
        el('label', { for: 'f-sqlSave' }, l.sqlSave),
        el(
          'div',
          { class: 'file' },
          el('input', { id: 'f-sqlSave', type: 'text', value: value.sqlSaveLocation || '', placeholder: l.sqlSaveDefault, autocomplete: 'off' }),
          el('button', { type: 'button', class: 'secondary', on: { click: () => vscode.postMessage({ type: 'browse', field: 'sqlSave', folder: true }) } }, l.browse),
        ),
      ),
      el(
        'div',
        { class: 'row top' },
        el('label', { for: 'f-sqlLocations' }, l.sqlLinked),
        el(
          'div',
          { class: 'stack' },
          el('textarea', { id: 'f-sqlLocations', rows: '3', spellcheck: 'false', placeholder: '${workspaceFolder}/sql\n~/projects/reports' }, (value.sqlLocations || []).map((x) => x.path).join('\n')),
          el('button', { type: 'button', class: 'secondary', on: { click: () => vscode.postMessage({ type: 'browse', field: 'sqlLocations', folder: true, append: true }) } }, l.sqlAddFolder),
        ),
      ),
      el('div', { class: 'hint' }, l.sqlHint),
    ];
  }

  /** Re-renders keeping what was typed, so `showWhen` fields follow select changes. */
  function rerender() {
    const { value: current, secrets } = collect();
    value = {
      ...value,
      name: current.name,
      folderId: current.folderId,
      sqlSaveLocation: current.sqlSaveLocation ?? value.sqlSaveLocation,
      sqlLocations: current.sqlLocations ?? value.sqlLocations,
      options: { ...value.options, ...current.options },
    };
    render();
    for (const [k, v] of Object.entries(secrets)) {
      const input = /** @type {HTMLInputElement} */ (document.getElementById(`f-${k}`));
      if (input && v) input.value = v;
    }
  }

  function render() {
    const typeSelect = el(
      'select',
      {
        id: 'f-type',
        disabled: !value.isNew,
        on: {
          change: (e) => {
            const name = /** @type {HTMLInputElement} */ (document.getElementById('f-name')).value;
            value = { ...value, name, type: e.target.value, options: defaults(e.target.value), folderId: collect().value.folderId };
            render();
          },
        },
      },
      ...init.drivers.map((d) => el('option', { value: d.type, selected: d.type === value.type }, d.label)),
    );
    const send = (type) => {
      const data = collect();
      if (type === 'test') setStatus(init.labels.testing);
      vscode.postMessage({ type, ...data });
    };
    app.replaceChildren(
      el(
        'form',
        { on: { submit: (e) => (e.preventDefault(), send('save')) } },
        el('div', { class: 'row' }, el('label', { for: 'f-name' }, `${init.labels.name} *`), el('input', { id: 'f-name', value: value.name, required: true, autofocus: true })),
        el('div', { class: 'row' }, el('label', { for: 'f-type' }, init.labels.type), typeSelect),
        init.folders.length
          ? el(
              'div',
              { class: 'row' },
              el('label', { for: 'f-folder' }, init.labels.folder),
              el(
                'select',
                { id: 'f-folder' },
                el('option', { value: '', selected: !value.folderId }, init.labels.noFolder),
                ...init.folders.map((f) => el('option', { value: f.id, selected: f.id === value.folderId }, f.path)),
              ),
            )
          : '',
        ...fieldRows(),
        ...(driver().category === 'sql' ? sqlFilesSection() : []),
        el(
          'div',
          { class: 'actions' },
          el('button', { type: 'button', class: 'secondary', on: { click: () => send('test') } }, init.labels.test),
          el('button', { type: 'submit' }, init.labels.save),
          el('button', { type: 'button', class: 'secondary', on: { click: () => vscode.postMessage({ type: 'cancel' }) } }, init.labels.cancel),
        ),
        el('div', { id: 'status', class: 'status' }),
      ),
    );
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      init = msg;
      const type = msg.value ? msg.value.type : msg.drivers[0].type;
      value = msg.value ? { ...msg.value, isNew: false } : { name: '', type, options: defaults(type), folderId: msg.folderId, isNew: true };
      render();
    } else if (msg.type === 'status') {
      setStatus(msg.message, msg.ok);
    } else if (msg.type === 'browsed') {
      const input = /** @type {HTMLInputElement} */ (document.getElementById(`f-${msg.field}`));
      if (input && msg.append) {
        const lines = input.value.split('\n').map((x) => x.trim()).filter(Boolean);
        if (!lines.includes(msg.path)) lines.push(msg.path);
        input.value = lines.join('\n');
      } else if (input) {
        input.value = msg.path;
      }
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
