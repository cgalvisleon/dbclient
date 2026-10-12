// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const saved = vscode.getState() || {};

  /** @type {any[]} */
  let messages = [];
  /** @type {any[]} */
  let subscriptions = [];
  let connected = true;
  let error = '';
  let filter = '';
  let paused = false;
  let selected = -1;
  const form = {
    subject: saved.subject || '',
    data: saved.data || '',
    headers: saved.headers || '',
    reply: saved.reply || '',
    timeout: saved.timeout || 2000,
    subSubject: saved.subSubject || '>',
    queue: saved.queue || '',
  };

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

  function persist() {
    vscode.setState(form);
  }

  /** `Key: value` lines → object. */
  function parseHeaders(text) {
    const headers = {};
    for (const line of text.split('\n')) {
      const at = line.indexOf(':');
      if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return headers;
  }

  function bind(key) {
    return { input: (e) => ((form[key] = e.target.value), persist()) };
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

  function send(type) {
    if (!form.subject.trim()) {
      error = 'Subject is required.';
      render();
      return;
    }
    error = '';
    const base = { subject: form.subject.trim(), data: form.data, headers: parseHeaders(form.headers) };
    vscode.postMessage(type === 'request' ? { type, ...base, timeoutMs: Number(form.timeout) || 2000 } : { type, ...base, reply: form.reply.trim() || undefined });
  }

  function publishPanel() {
    return el(
      'section',
      { class: 'card' },
      el('h3', {}, 'Publish'),
      el('label', {}, 'Subject'),
      el('input', { value: form.subject, placeholder: 'orders.created', on: bind('subject') }),
      el('label', {}, 'Payload'),
      el('textarea', { rows: '6', value: form.data, placeholder: '{"id": 1}', spellcheck: 'false', on: bind('data') }),
      el('label', {}, 'Headers (one "Key: value" per line)'),
      el('textarea', { rows: '2', value: form.headers, placeholder: 'X-Trace: abc', spellcheck: 'false', on: bind('headers') }),
      el(
        'div',
        { class: 'row' },
        el('input', { value: form.reply, placeholder: 'reply-to (optional)', on: bind('reply') }),
        el('button', { class: 'primary', disabled: !connected, on: { click: () => send('publish') } }, 'Publish'),
      ),
      el(
        'div',
        { class: 'row' },
        el('input', { type: 'number', min: '1', value: String(form.timeout), title: 'Request timeout (ms)', on: bind('timeout') }),
        el('button', { disabled: !connected, on: { click: () => send('request') } }, 'Request / reply'),
      ),
    );
  }

  function subscribePanel() {
    return el(
      'section',
      { class: 'card' },
      el('h3', {}, 'Subscribe'),
      el(
        'div',
        { class: 'row' },
        el('input', { value: form.subSubject, placeholder: 'orders.* or orders.>', on: bind('subSubject') }),
        el('input', { class: 'queue', value: form.queue, placeholder: 'queue group', on: bind('queue') }),
        el(
          'button',
          {
            class: 'primary',
            disabled: !connected,
            on: { click: () => form.subSubject.trim() && vscode.postMessage({ type: 'subscribe', subject: form.subSubject.trim(), queue: form.queue.trim() || undefined }) },
          },
          'Subscribe',
        ),
      ),
      subscriptions.length
        ? el(
            'ul',
            { class: 'subs' },
            ...subscriptions.map((s) =>
              el(
                'li',
                {},
                el('code', {}, s.subject),
                s.queue ? el('span', { class: 'muted' }, ` queue ${s.queue}`) : null,
                el('span', { class: 'muted' }, ` · ${s.received} msgs`),
                el('button', { class: 'link', on: { click: () => vscode.postMessage({ type: 'unsubscribe', id: s.id }) } }, 'Unsubscribe'),
              ),
            ),
          )
        : el('p', { class: 'muted' }, 'No active subscriptions. Wildcards: * matches one token, > the rest.'),
    );
  }

  function messagesPanel() {
    const shown = messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => !filter || m.subject.includes(filter) || m.data.includes(filter));
    const current = messages[selected];
    return el(
      'section',
      { class: 'card messages' },
      el(
        'div',
        { class: 'row' },
        el('h3', {}, `Messages (${messages.length})`),
        el('input', {
          class: 'filter',
          placeholder: 'Filter subject or payload…',
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
        el('button', { on: { click: () => ((paused = !paused), render()) } }, paused ? 'Resume' : 'Pause'),
        el('button', { on: { click: () => ((messages = []), (selected = -1), vscode.postMessage({ type: 'clear' }), render()) } }, 'Clear'),
      ),
      el(
        'div',
        { class: 'split' },
        el(
          'div',
          { class: 'list' },
          ...shown
            .slice(-500)
            .reverse()
            .map(({ m, i }) =>
              el(
                'div',
                { class: `msg ${m.kind} ${i === selected ? 'selected' : ''}`, on: { click: () => ((selected = i), render()) } },
                el('span', { class: 'time' }, m.time.slice(11, 23)),
                el('span', { class: 'kind' }, m.kind === 'sent' ? '→' : m.kind === 'reply' ? '↩' : '←'),
                el('code', { class: 'subject' }, m.subject),
                el('span', { class: 'preview' }, m.data.slice(0, 120)),
              ),
            ),
        ),
        el(
          'div',
          { class: 'detail' },
          current
            ? el(
                'div',
                {},
                el('div', { class: 'row' }, el('code', {}, current.subject), el('div', { class: 'spacer' }), el('button', { on: { click: () => vscode.postMessage({ type: 'copy', text: current.data }) } }, 'Copy payload'), el('button', { on: { click: () => ((form.subject = current.subject), (form.data = current.data), persist(), render()) } }, 'Use in publish')),
                el('div', { class: 'muted' }, `${current.time}${current.reply ? ` · reply-to ${current.reply}` : ''}`),
                current.headers ? el('pre', { class: 'headers' }, Object.entries(current.headers).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n')) : null,
                el('pre', {}, pretty(current.data)),
              )
            : el('p', { class: 'muted' }, 'Select a message to see its payload and headers.'),
        ),
      ),
    );
  }

  function render() {
    app.replaceChildren(
      !connected ? el('div', { class: 'error' }, 'Disconnected. Reconnect from the Connections view.') : null,
      error ? el('div', { class: 'error' }, error) : null,
      el('div', { class: 'top' }, publishPanel(), subscribePanel()),
      messagesPanel(),
    );
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        messages = msg.messages;
        if (msg.preset) form.subSubject = msg.preset;
        break;
      case 'preset':
        form.subSubject = msg.subject;
        break;
      case 'state':
        connected = msg.connected;
        subscriptions = msg.subscriptions;
        break;
      case 'message':
        messages.push(msg.message);
        if (messages.length > 1000) {
          messages.splice(0, messages.length - 1000);
          selected = -1;
        }
        if (paused) return;
        break;
      case 'error':
        error = msg.message;
        break;
    }
    render();
  });
  render();
  vscode.postMessage({ type: 'ready' });
})();
