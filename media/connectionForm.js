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

  function collect() {
    const options = {};
    const secrets = {};
    for (const f of driver().fields) {
      const input = /** @type {HTMLInputElement} */ (document.getElementById(`f-${f.key}`));
      let v;
      if (f.kind === 'checkbox') v = input.checked;
      else if (f.kind === 'number') v = input.value === '' ? undefined : Number(input.value);
      else v = input.value;
      if (f.secret) secrets[f.key] = v || undefined;
      else options[f.key] = v;
    }
    const name = /** @type {HTMLInputElement} */ (document.getElementById('f-name')).value;
    return { value: { name, type: value.type, options }, secrets };
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
      input = el('select', { id }, ...(f.choices || []).map((c) => el('option', { value: c, selected: c === current }, c)));
    } else if (f.kind === 'checkbox') {
      input = el('input', { id, type: 'checkbox', checked: Boolean(current) });
    } else {
      const saved = f.secret && !value.isNew && init.savedSecrets[f.key];
      input = el('input', {
        id,
        type: f.kind === 'password' ? 'password' : f.kind === 'number' ? 'number' : 'text',
        value: f.secret ? '' : current ?? '',
        placeholder: saved ? `•••••• (${init.labels.saved})` : f.placeholder || '',
        required: f.required && !f.secret,
        autocomplete: 'off',
      });
    }
    return el('div', { class: 'row' }, el('label', { for: id }, f.label + (f.required && !f.secret ? ' *' : '')), input);
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
            value = { ...value, name, type: e.target.value, options: defaults(e.target.value) };
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
        ...driver().fields.map(fieldRow),
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
      value = msg.value ? { ...msg.value, isNew: false } : { name: '', type, options: defaults(type), isNew: true };
      render();
    } else if (msg.type === 'status') {
      setStatus(msg.message, msg.ok);
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
