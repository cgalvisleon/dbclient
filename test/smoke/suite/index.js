// Runs inside the extension host. Plain assertions; any throw fails the run.
// Engines are exercised when their DBCLIENT_* variables are set (see test/integration).
// Secrets are injected by overriding store.getSecrets, so the test never touches the OS keychain.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const vscode = require('vscode');

const env = process.env;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36);

async function until(check, what, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await wait(100);
  }
}

const tabLabels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));

exports.run = async function () {
  const ext = vscode.extensions.getExtension('cgalvisleon.dbclient');
  assert.ok(ext, 'extension found');
  const api = await ext.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const c of ext.packageJSON.contributes.commands) {
    assert.ok(commands.includes(c.command), `command registered: ${c.command}`);
  }
  console.log(`✓ ${ext.packageJSON.contributes.commands.length} commands registered`);

  const secrets = new Map();
  const realGetSecrets = api.store.getSecrets.bind(api.store);
  api.store.getSecrets = async (id, fields) => (secrets.has(id) ? secrets.get(id) : realGetSecrets(id, fields));

  async function addConnection(name, type, options, password) {
    const config = await api.store.save({ name, type, options });
    secrets.set(config.id, { password });
    return config;
  }

  async function rootOf(config) {
    const roots = await api.tree.getChildren();
    const item = roots.find((r) => r.connectionId === config.id);
    assert.ok(item, `${config.name} in tree`);
    return item;
  }

  async function sqlEngine({ name, type, options, password, database, ok, bad, badLine }) {
    const config = await addConnection(`smoke-${name}`, type, options, password);
    const item = await rootOf(config);
    const children = await api.tree.getChildren(item);
    assert.ok(children.length > 0 && children[0].node, `${name}: tree children (${children.map((c) => c.label).join(', ')})`);
    assert.ok(api.manager.isConnected(config.id), `${name}: connected after expanding`);

    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `${ok};\n${bad};\n` });
    await vscode.window.showTextDocument(doc);
    await api.bindings.set(doc, { connectionId: config.id, database });
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
    assert.strictEqual(lenses.length, 2, `${name}: code lens per statement`);

    await vscode.commands.executeCommand('dbclient.runFile');
    const diags = await until(() => {
      const d = vscode.languages.getDiagnostics(doc.uri);
      return d.length ? d : undefined;
    }, `${name} error diagnostic`);
    const okLines = ok.split('\n').length;
    if (badLine !== undefined) {
      assert.strictEqual(diags[0].range.start.line, okLines + badLine - 1, `${name}: error line (${diags[0].message})`);
    }
    console.log(`✓ ${name}: tree, run, error at line ${diags[0].range.start.line + 1}: ${diags[0].message.split('\n')[0].slice(0, 70)}`);

    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(0, 1, 0, 1);
    await vscode.commands.executeCommand('dbclient.run');
    assert.strictEqual(vscode.languages.getDiagnostics(doc.uri).length, 0, `${name}: diagnostics cleared after a clean run`);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('dbclient.disconnect', item);
    await api.store.delete(config.id, []);
  }

  if (env.DBCLIENT_PG_HOST) {
    await sqlEngine({
      name: 'postgres',
      type: 'postgres',
      options: { host: env.DBCLIENT_PG_HOST, port: 5432, database: env.DBCLIENT_PG_DATABASE, user: env.DBCLIENT_PG_USER },
      password: env.DBCLIENT_PG_PASSWORD,
      ok: 'select 1 as one, now()',
      bad: 'select\n  nope\nfrom pg_class',
      badLine: 2,
    });
    // Completion for the postgres dialect.
    const config = await addConnection('smoke-pg-completion', 'postgres', { host: env.DBCLIENT_PG_HOST, database: env.DBCLIENT_PG_DATABASE, user: env.DBCLIENT_PG_USER }, env.DBCLIENT_PG_PASSWORD);
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
    await api.bindings.set(doc, { connectionId: config.id });
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(0, 0));
    const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(labels.includes('GENERATE_SERIES') && labels.includes('jsonb'), 'postgres completion');
    await api.store.delete(config.id, []);
    console.log(`✓ postgres completion: ${labels.length} items`);
  }
  if (env.DBCLIENT_MYSQL_HOST) {
    await sqlEngine({
      name: 'mysql',
      type: 'mysql',
      options: { host: env.DBCLIENT_MYSQL_HOST, port: 3306, user: env.DBCLIENT_MYSQL_USER },
      password: env.DBCLIENT_MYSQL_PASSWORD,
      database: 'mysql',
      ok: 'select 1 as one',
      bad: 'select 1\nfrom user\nwhere ((',
      badLine: 3,
    });
  }
  if (env.DBCLIENT_MSSQL_HOST) {
    await sqlEngine({
      name: 'mssql',
      type: 'mssql',
      options: { host: env.DBCLIENT_MSSQL_HOST, port: 1433, database: 'master', user: env.DBCLIENT_MSSQL_USER, encrypt: false, trustServerCertificate: true },
      password: env.DBCLIENT_MSSQL_PASSWORD,
      ok: 'select 1 as one',
      bad: 'select 1\nfrom sys.objects\nwhere ((',
      badLine: 3,
    });
  }
  if (env.DBCLIENT_ORACLE_HOST) {
    await sqlEngine({
      name: 'oracle',
      type: 'oracle',
      options: { host: env.DBCLIENT_ORACLE_HOST, port: 1521, service: env.DBCLIENT_ORACLE_SERVICE, user: env.DBCLIENT_ORACLE_USER, autoCommit: true },
      password: env.DBCLIENT_ORACLE_PASSWORD,
      ok: 'select 1 as one from dual',
      bad: 'select 1\nfrom dual\nwhere ((',
      badLine: 3,
    });
  }
  {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-smoke-')), 'smoke.db');
    await sqlEngine({
      name: 'sqlite',
      type: 'sqlite',
      options: { file },
      ok: 'create table if not exists t (id integer primary key)',
      bad: 'select nope from t',
    });
  }

  if (env.DBCLIENT_REDIS_HOST) {
    const config = await addConnection('smoke-redis', 'redis', { host: env.DBCLIENT_REDIS_HOST, port: 6379, db: 15, separator: ':' }, env.DBCLIENT_REDIS_PASSWORD);
    const item = await rootOf(config);
    const dbs = await api.tree.getChildren(item);
    assert.ok(dbs.some((d) => d.label === 'db15'), 'redis: db15 listed');

    const key = `dbclient:smoke:${run}`;
    const doc = await vscode.workspace.openTextDocument({
      language: 'redis',
      content: `# smoke\nHSET ${key} name "Ana Maria" age 30\nHGETALL ${key}\nTTL ${key}\nNOPE\n`,
    });
    await vscode.window.showTextDocument(doc);
    await api.bindings.set(doc, { connectionId: config.id, database: '15' });

    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(5, 0));
    const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(labels.includes('HGETALL') && labels.includes('XADD'), 'redis command completion');
    const optionDoc = await vscode.workspace.openTextDocument({ language: 'redis', content: 'SET k v ' });
    await api.bindings.set(optionDoc, { connectionId: config.id, database: '15' });
    const options = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', optionDoc.uri, new vscode.Position(0, 8));
    assert.ok(options.items.some((i) => i.label === 'KEEPTTL'), 'redis option completion');

    await vscode.commands.executeCommand('dbclient.runFile');
    const diags = await until(() => {
      const d = vscode.languages.getDiagnostics(doc.uri);
      return d.length ? d : undefined;
    }, 'redis error diagnostic');
    assert.strictEqual(diags[0].range.start.line, 4, 'redis: error on the NOPE line');
    const driver = await api.manager.connectKv(config.id);
    assert.deepStrictEqual(await driver.command(15, ['HGETALL', key]), ['name', 'Ana Maria', 'age', '30']);
    console.log(`✓ redis: tree, completion (${labels.length}), run file, error on line 5`);

    // Value viewer opens from a key node.
    await vscode.commands.executeCommand('dbclient.openValue', { connectionId: config.id, node: { meta: { db: '15', key } } });
    await until(() => tabLabels().includes(key), 'value viewer tab');
    console.log('✓ redis: value viewer opened');

    await driver.command(15, ['DEL', key]);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.manager.disconnect(config.id);
    await api.store.delete(config.id, []);
  }

  if (env.DBCLIENT_NATS_SERVERS) {
    const config = await addConnection('smoke-nats', 'nats', { servers: env.DBCLIENT_NATS_SERVERS, auth: 'none' });
    const item = await rootOf(config);
    const root = await api.tree.getChildren(item);
    assert.deepStrictEqual(root.slice(0, 2).map((n) => n.label), ['Subscriptions', 'JetStream']);

    await vscode.commands.executeCommand('dbclient.newQuery', item);
    await until(() => tabLabels().includes('NATS · smoke-nats'), 'NATS console tab');

    const driver = await api.manager.connectPubSub(config.id);
    const got = [];
    const sub = driver.subscribe(`smoke.${run}.>`, undefined, (m) => got.push(m));
    await driver.publish(`smoke.${run}.a`, 'hello');
    await until(() => got.length, 'NATS message');
    const subs = await api.tree.getChildren(root[0]);
    assert.strictEqual(subs[0].label, `smoke.${run}.>`);
    driver.unsubscribe(sub.id);
    console.log('✓ nats: tree, console opened, subscribe/publish');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.manager.disconnect(config.id);
    await api.store.delete(config.id, []);
  }
};
