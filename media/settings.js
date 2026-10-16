// @ts-check
// Settings and About panel: where the extension keeps its data, the dbclient.* settings, the
// environment and the author's GitHub links. Read-only; changes go through the editor settings.
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

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
  const button = (label, message, title) => el('button', { title, on: { click: () => post(message) } }, label);
  const link = (label, url) =>
    el('a', { href: url, title: url, on: { click: (e) => { e.preventDefault(); post({ type: 'link', url }); } } }, label);
  const show = (value) => (value === '' ? t('(empty)') : typeof value === 'string' ? value : JSON.stringify(value));

  function section(title, ...children) {
    return el('section', {}, el('h2', {}, title), ...children);
  }

  function storage(data) {
    const rows = data.paths.map((p) =>
      el(
        'div',
        { class: 'path' },
        el('div', { class: 'label' }, p.label, p.exists ? null : el('span', { class: 'tag' }, t('not created yet'))),
        el('code', { class: 'value' }, p.path),
        p.hint ? el('div', { class: 'hint' }, p.hint) : null,
        el(
          'div',
          { class: 'actions' },
          button(t('Copy'), { type: 'copy', text: p.path }),
          button(p.kind === 'file' ? t('Show in folder') : t('Open folder'), { type: 'reveal', path: p.path }),
        ),
      ),
    );
    return section(t('Persistence'), ...rows, el('p', { class: 'hint secret' }, data.secrets));
  }

  function settings(data) {
    const table = el(
      'table',
      {},
      el('thead', {}, el('tr', {}, el('th', {}, t('Setting')), el('th', {}, t('Value')), el('th', {}, t('Default')))),
      el(
        'tbody',
        {},
        ...data.settings.map((s) =>
          el(
            'tr',
            {},
            el('td', {}, el('div', {}, s.label), el('code', { class: 'key' }, s.key)),
            el('td', {}, el('code', {}, show(s.value)), s.source ? el('span', { class: 'tag' }, s.source) : null),
            el('td', {}, el('code', {}, show(s.defaultValue))),
          ),
        ),
      ),
    );
    return section(t('Settings'), table, el('div', { class: 'actions' }, button(t('Open in Settings'), { type: 'openSettings' })));
  }

  function environment(data) {
    return section(
      t('Environment'),
      el('table', { class: 'pairs' }, el('tbody', {}, ...data.environment.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, v))))),
    );
  }

  function about(data) {
    const a = data.about;
    return section(
      t('About'),
      el('div', { class: 'title' }, el('strong', {}, a.name), el('span', { class: 'tag' }, `v${a.version}`)),
      el('p', {}, a.description),
      el(
        'table',
        { class: 'pairs' },
        el(
          'tbody',
          {},
          el('tr', {}, el('th', {}, t('Author')), el('td', {}, a.author)),
          a.github ? el('tr', {}, el('th', {}, t('GitHub')), el('td', {}, link(`@${a.github.user}`, a.github.profile))) : null,
        ),
      ),
      el('ul', { class: 'links' }, ...a.links.map((l) => el('li', {}, link(l.label, l.url)))),
    );
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type === 'data') {
      app.replaceChildren(el('h1', {}, t('DB Client Settings')), storage(m.data), settings(m.data), environment(m.data), about(m.data));
    }
  });
  post({ type: 'ready' });
})();
