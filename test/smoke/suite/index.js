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
    assert.strictEqual(children[0].contextValue, 'sqlFolder', `${name}: SQL node first`);
    assert.ok(children.slice(1).some((c) => c.node), `${name}: tree children (${children.map((c) => c.label).join(', ')})`);
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

    // History: newest first, the failed statement with its error; picking inserts into a bound editor.
    const entries = api.history.list(config.id);
    assert.deepStrictEqual(entries.slice(0, 3).map((e) => [e.text, e.ok]), [[ok, true], [bad, false], [ok, true]], `${name}: history`);
    assert.ok(entries[1].error && entries[0].durationMs >= 0, `${name}: history error and duration`);
    const target = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
    await vscode.window.showTextDocument(target);
    await api.bindings.set(target, { connectionId: config.id, database });
    await vscode.commands.executeCommand('dbclient.showHistory');
    await new Promise((r) => setTimeout(r, 300));
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await until(() => (target.getText().trim() === `${ok};` ? true : undefined), `${name}: history inserted`);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    console.log(`✓ ${name}: history recorded and inserted from Query History`);

    await vscode.commands.executeCommand('dbclient.disconnect', item);
    await api.store.delete(config.id, []);
    api.history.clear(config.id);
  }

  // Export / import (C5): no secrets in the file, ids kept on restore, replace deletes the rest.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-export-'));
    const folder = api.store.createFolder(`smoke-export-${run}`);
    const a = await api.store.save({ name: `smoke-export-a-${run}`, type: 'postgres', folderId: folder.id, options: { host: 'h', port: 5432, database: 'd', user: 'u' } }, { password: 'never-exported' });
    const b = await api.store.save({ name: `smoke-export-b-${run}`, type: 'sqlite', options: { file: path.join(dir, 'b.db') } });
    const all = vscode.Uri.file(path.join(dir, 'all.json'));
    await vscode.commands.executeCommand('dbclient.exportConnections', undefined, all);
    const text = fs.readFileSync(all.fsPath, 'utf8');
    assert.ok(!text.includes('never-exported') && !/"password"/.test(text), 'export has no secrets');
    assert.ok(JSON.parse(text).connections.some((c) => c.id === a.id), 'export has the connection');
    const onlyFolder = vscode.Uri.file(path.join(dir, 'folder.json'));
    const folderItem = (await api.tree.getChildren()).find((r) => r.folderId === folder.id);
    await vscode.commands.executeCommand('dbclient.exportConnections', folderItem, onlyFolder);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(onlyFolder.fsPath, 'utf8')).connections.map((c) => c.id), [a.id], 'folder export');

    await api.store.delete(a.id, []); // the secret stays, as after deleting by mistake without cleanup
    await vscode.commands.executeCommand('dbclient.importConnections', all, 'merge');
    assert.strictEqual(api.store.get(a.id)?.folderId, folder.id, 'restored with its id and folder');
    assert.strictEqual((await api.store.getSecrets(a.id, [{ key: 'password', secret: true }])).password, 'never-exported', 'secret matches again');
    const count = api.store.list().length;
    await vscode.commands.executeCommand('dbclient.importConnections', all, 'merge');
    assert.strictEqual(api.store.list().length, count, 'identical import adds nothing');

    await vscode.commands.executeCommand('dbclient.importConnections', onlyFolder, 'replace');
    assert.deepStrictEqual(api.store.list().map((c) => c.id), [a.id], 'replace keeps only the file');
    assert.ok(!api.store.get(b.id), 'other connection deleted');
    await api.store.delete(a.id, [{ key: 'password', secret: true }]);
    for (const f of api.store.listFolders()) api.store.deleteFolder(f.id);
    console.log('✓ export/import: no secrets, folder export, restore with ids and secrets, identical skipped, replace');
  }

  // Folders: nesting in the tree and drag and drop.
  {
    const prod = api.store.createFolder(`smoke-prod-${run}`);
    const eu = api.store.createFolder('EU', prod.id);
    const conn = await addConnection(`smoke-folder-${run}`, 'sqlite', { file: path.join(os.tmpdir(), `dbclient-${run}.db`) });
    api.store.moveConnection(conn.id, eu.id);

    const roots = await api.tree.getChildren();
    const prodItem = roots.find((r) => r.folderId === prod.id);
    assert.ok(prodItem && prodItem.label === `smoke-prod-${run}`, 'folder at the top level');
    assert.ok(!roots.some((r) => r.connectionId === conn.id), 'connection not at the top level');
    const euItem = (await api.tree.getChildren(prodItem)).find((r) => r.folderId === eu.id);
    assert.ok(euItem, 'subfolder inside folder');
    const connItem = (await api.tree.getChildren(euItem)).find((r) => r.connectionId === conn.id);
    assert.ok(connItem, 'connection inside subfolder');

    // Drag the connection to the top level, then the subfolder out of its parent.
    const drag = new vscode.DataTransfer();
    await api.dragAndDrop.handleDrag([connItem], drag);
    await api.dragAndDrop.handleDrop(undefined, drag);
    assert.strictEqual(api.store.get(conn.id).folderId, undefined, 'dropped at the top level');
    const drag2 = new vscode.DataTransfer();
    await api.dragAndDrop.handleDrag([euItem], drag2);
    await api.dragAndDrop.handleDrop(undefined, drag2);
    assert.strictEqual(api.store.getFolder(eu.id).parentId, undefined, 'folder moved to the top level');
    // Dropping a parent into its own child is refused.
    api.store.moveFolder(eu.id, prod.id);
    const drag3 = new vscode.DataTransfer();
    await api.dragAndDrop.handleDrag([prodItem], drag3);
    await api.dragAndDrop.handleDrop(euItem, drag3);
    assert.strictEqual(api.store.getFolder(prod.id).parentId, undefined, 'cycle refused');

    api.store.deleteFolder(prod.id);
    assert.strictEqual(api.store.getFolder(eu.id).parentId, undefined, 'children move up on delete');
    api.store.deleteFolder(eu.id);
    await api.store.delete(conn.id, []);
    console.log('✓ folders: nesting, drag and drop, cycle refused, delete moves content up');
  }

  // Saved SQL files: SQL node per connection, implicit binding when opened, running them.
  {
    const conn = await addConnection(`smoke-sqlfiles-${run}`, 'sqlite', { file: path.join(os.tmpdir(), `dbclient-files-${run}.db`) });
    const item = await rootOf(conn);
    const children = await api.tree.getChildren(item);
    const sqlNode = children[0];
    assert.strictEqual(sqlNode.contextValue, 'sqlFolder', 'SQL node first under a SQL connection');
    assert.strictEqual(sqlNode.description, '0');

    const file = api.sqlFiles.create(conn.id, 'report', 'create table if not exists r (id integer);\nselect count(*) as n from r;\n');
    assert.ok(file.includes(conn.id), 'file lives in the connection folder');
    await until(() => sqlNode.description === '1', 'SQL node count updated');
    const files = await api.tree.getChildren(sqlNode);
    assert.strictEqual(files[0].label, 'report');
    assert.strictEqual(files[0].command.command, 'vscode.open');

    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    assert.strictEqual(api.bindings.get(doc)?.connectionId, conn.id, 'saved file is bound to its connection');
    await vscode.commands.executeCommand('dbclient.runFile');
    await wait(500);
    assert.strictEqual(vscode.languages.getDiagnostics(doc.uri).length, 0, 'saved file runs without errors');

    // A Redis or other connection never shows the SQL node.
    const other = await addConnection(`smoke-sqlfiles-nats-${run}`, 'nats', { servers: 'nats://127.0.0.1:1', auth: 'none' });
    const otherChildren = await api.tree.getChildren(await rootOf(other));
    assert.ok(!otherChildren.some((c) => c.contextValue === 'sqlFolder'), 'no SQL node on non-SQL connections');
    await api.store.delete(other.id, []);

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.manager.disconnect(conn.id);
    await api.store.delete(conn.id, []);
    api.sqlFiles.deleteAll(conn.id);
    assert.deepStrictEqual(api.sqlFiles.list(conn.id), []);
    console.log('✓ sql files: SQL node, count refresh, implicit binding, run saved file');
  }

  // Linked SQL folders and save location.
  {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-repo-'));
    const sqlDir = path.join(repo, 'sql');
    fs.mkdirSync(path.join(sqlDir, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(sqlDir, '.git'));
    fs.mkdirSync(path.join(sqlDir, 'node_modules'));
    fs.writeFileSync(path.join(sqlDir, 'a.sql'), 'select 1;');
    fs.writeFileSync(path.join(sqlDir, 'reports', 'b.sql'), 'select 2;');
    fs.writeFileSync(path.join(sqlDir, '.git', 'x.sql'), '');
    fs.writeFileSync(path.join(sqlDir, 'node_modules', 'y.sql'), '');

    const one = await addConnection(`smoke-link-1-${run}`, 'sqlite', { file: path.join(repo, 'one.db') });
    api.store.patch(one.id, { sqlLocations: [{ path: sqlDir }, { path: '${workspaceFolder}/sql' }] });
    const sqlNode = (await api.tree.getChildren(await rootOf(one)))[0];
    assert.strictEqual(sqlNode.description, '3 locations');
    const locations = await api.tree.getChildren(sqlNode);
    assert.deepStrictEqual(locations.map((l) => l.label), ['Saved', 'sql', 'sql']);
    assert.ok(locations[0].contextValue.includes('save'), 'internal folder is the default save location');
    assert.ok(locations[2].contextValue.includes('missing'), '${workspaceFolder} without a workspace is flagged');
    const linked = locations[1];
    const entries = await api.tree.getChildren(linked);
    assert.deepStrictEqual(entries.map((e) => `${e.contextValue}:${e.label}`), ['sqlDir:reports', 'sqlFile:a']);
    const inReports = await api.tree.getChildren(entries[0]);
    assert.deepStrictEqual(inReports.map((e) => e.label), ['b']);

    // Opening a linked file binds it; a more specific link of another connection wins; equal links tie.
    const bDoc = await vscode.workspace.openTextDocument(path.join(sqlDir, 'reports', 'b.sql'));
    assert.strictEqual(api.bindings.get(bDoc)?.connectionId, one.id, 'linked file bound to its connection');
    const two = await addConnection(`smoke-link-2-${run}`, 'sqlite', { file: path.join(repo, 'two.db') });
    api.store.patch(two.id, { sqlLocations: [{ path: path.join(sqlDir, 'reports') }] });
    assert.strictEqual(api.bindings.get(bDoc)?.connectionId, two.id, 'most specific location wins');
    const aDoc = await vscode.workspace.openTextDocument(path.join(sqlDir, 'a.sql'));
    assert.strictEqual(api.bindings.get(aDoc)?.connectionId, one.id);
    api.store.patch(two.id, { sqlLocations: [{ path: sqlDir }] });
    assert.strictEqual(api.bindings.get(aDoc), undefined, 'a tie needs the user to choose');

    // Run a linked file.
    await vscode.window.showTextDocument(bDoc);
    api.store.patch(two.id, { sqlLocations: [] });
    await vscode.commands.executeCommand('dbclient.runFile');
    await wait(500);
    assert.strictEqual(vscode.languages.getDiagnostics(bDoc.uri).length, 0, 'linked file runs');

    // Save location: the linked folder.
    api.store.patch(one.id, { sqlSaveLocation: sqlDir });
    assert.strictEqual(api.sqlLocations.saveDir(one.id), sqlDir);
    const relisted = await api.tree.getChildren(sqlNode);
    assert.ok(relisted[1].contextValue.includes('save') && !relisted[0].contextValue.includes('save'), 'save marker moved');

    // Changes made outside the editor are noticed.
    const noticed = new Promise((resolve) => {
      const sub = api.sqlLocations.onDidChange((ids) => {
        if (ids && ids.includes(one.id)) {
          sub.dispose();
          resolve(true);
        }
      });
    });
    fs.writeFileSync(path.join(sqlDir, 'from-git.sql'), 'select 3;');
    await until(() => Promise.race([noticed, wait(100).then(() => false)]), 'watcher event for the linked folder', 10000);
    assert.ok((await api.tree.getChildren(relisted[1])).some((e) => e.label === 'from-git'));

    // Unlinking and deleting the connection never touch linked files.
    await vscode.commands.executeCommand('dbclient.removeSqlFolder', relisted[1]);
    assert.deepStrictEqual(api.store.get(one.id).sqlLocations.map((l) => l.path), ['${workspaceFolder}/sql']);
    assert.strictEqual(api.store.get(one.id).sqlSaveLocation, undefined, 'unlinking the save location resets it');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const c of [one, two]) {
      await api.manager.disconnect(c.id);
      await api.store.delete(c.id, []);
      api.sqlFiles.deleteAll(c.id);
    }
    assert.ok(fs.existsSync(path.join(sqlDir, 'a.sql')) && fs.existsSync(path.join(sqlDir, 'reports', 'b.sql')), 'linked files untouched');
    console.log('✓ sql locations: linked folders, subfolders, ignores, binding by most specific, tie, save location, watcher, unlink');
  }

  // Tables (S6), completion with real objects (S4) and grid editing (S8) on one engine.
  const posted = [];
  const realPost = api.results.post.bind(api.results);
  api.results.post = (m) => {
    posted.push(m);
    realPost(m);
  };

  async function tableFlow({ name, type, options, password, database, setup, teardown, path: labels, table }) {
    const config = await addConnection(`smoke-tables-${name}`, type, options, password);
    const driver = await api.manager.connectSql(config.id);
    for (const sql of setup) await driver.execute(sql, { maxRows: 1 });
    try {
      // Walk the tree down to the table node; its meta carries the real name.
      let item = await rootOf(config);
      for (const label of [...labels, table]) {
        const children = await api.tree.getChildren(item);
        item = children.find((c) => c.label === label);
        assert.ok(item, `${name}: tree node ${label} (${children.map((c) => c.label).join(', ')})`);
      }
      assert.strictEqual(item.contextValue, 'table sql', `${name}: table node`);
      assert.strictEqual(item.node.meta.name, table, `${name}: node meta`);

      const editorText = () => vscode.window.activeTextEditor.document.getText();
      await vscode.commands.executeCommand('dbclient.generateSelect', item);
      assert.match(editorText(), /^SELECT id, name\nFROM /i, `${name}: SELECT template`);
      await vscode.commands.executeCommand('dbclient.generateInsert', item);
      assert.match(editorText(), /^INSERT INTO .*\(id, name\)\nVALUES \(0, ''\);/i, `${name}: INSERT template`);
      await vscode.commands.executeCommand('dbclient.generateUpdate', item);
      assert.match(editorText(), /^UPDATE [^]*SET name = ''\nWHERE id = 0;/i, `${name}: UPDATE template`);
      await vscode.commands.executeCommand('dbclient.generateDelete', item);
      assert.match(editorText(), /^DELETE FROM [^]*WHERE id = 0;/i, `${name}: DELETE template`);
      await vscode.commands.executeCommand('dbclient.showDdl', item);
      assert.match(editorText(), /create table/i, `${name}: DDL`);
      assert.ok(api.bindings.get(vscode.window.activeTextEditor.document)?.connectionId === config.id, `${name}: DDL editor bound`);

      posted.length = 0;
      await vscode.commands.executeCommand('dbclient.showStructure', item);
      const structure = posted.filter((m) => m.type === 'result').map((m) => m.tab);
      assert.deepStrictEqual(structure.map((t) => t.columns[0].name), ['Column', 'Index'], `${name}: structure tabs`);
      assert.deepStrictEqual(structure[0].rows.map((r) => [String(r[0]).toLowerCase(), r[4]]), [['id', '1'], ['name', '']], `${name}: structure rows`);
      console.log(`✓ ${name} tables: tree node, SELECT/INSERT/UPDATE/DELETE templates, DDL, structure`);

      // Completion: tables after FROM, columns after an alias.
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `select x. from ${table} x;\nselect * from ` });
      await api.bindings.set(doc, { connectionId: config.id, database });
      const labelsAt = async (line, character) =>
        (await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, character))).items.map((i) =>
          typeof i.label === 'string' ? i.label : i.label.label,
        );
      const members = await labelsAt(0, 9);
      assert.deepStrictEqual(members.map((l) => l.toLowerCase()), ['id', 'name'], `${name}: alias columns (${members.join(', ')})`);
      const tables = await labelsAt(1, 14);
      assert.ok(tables.includes(table), `${name}: tables after FROM (${tables.slice(0, 8).join(", ")})`);
      console.log(`✓ ${name} completion: alias columns, tables after FROM (${tables.length} items)`);

      // Open Data runs SELECT * with an editable grid; the webview's Commit is simulated.
      posted.length = 0;
      await vscode.commands.executeCommand('dbclient.openData', item);
      const tab = await until(() => posted.find((m) => m.type === 'result')?.tab, `${name}: open data result`);
      assert.ok(tab.edit, `${name}: editable grid (${tab.readOnly ?? 'no reason'})`);
      const col = (n) => tab.columns.findIndex((c) => c.name.toLowerCase() === n);
      assert.deepStrictEqual(tab.edit.key, [col('id')], `${name}: key column`);
      const idOf = (row) => Number(row[col('id')]);
      const one = tab.rows.find((r) => idOf(r) === 1);
      posted.length = 0;
      await api.results.receive({
        type: 'commit',
        editId: tab.edit.id,
        changes: [
          { kind: 'update', key: { [col('id')]: one[col('id')] }, values: { [col('name')]: 'uno' } },
          { kind: 'insert', values: { [col('id')]: '3', [col('name')]: 'tres' } },
          { kind: 'delete', key: { [col('id')]: tab.rows.find((r) => idOf(r) === 2)[col('id')] } },
        ],
      });
      const done = posted.find((m) => m.type === 'committed');
      assert.ok(done && done.ok, `${name}: committed (${done && done.message})`);
      assert.deepStrictEqual(done.rows.map((r) => [idOf(r), r[col('name')]]).sort((a, b) => a[0] - b[0]), [[1, 'uno'], [3, 'tres']], `${name}: saved rows`);

      // A stale key rolls back and reports it.
      posted.length = 0;
      await api.results.receive({ type: 'commit', editId: tab.edit.id, changes: [{ kind: 'delete', key: { [col('id')]: 99 } }] });
      const failed = posted.find((m) => m.type === 'committed');
      assert.ok(failed && !failed.ok && /affected 0 rows/.test(failed.message), `${name}: stale key refused`);

      // A result without the key stays read-only and says why.
      posted.length = 0;
      const ro = await vscode.workspace.openTextDocument({ language: 'sql', content: `select name from ${table}` });
      await vscode.window.showTextDocument(ro);
      await api.bindings.set(ro, { connectionId: config.id, database });
      await vscode.commands.executeCommand('dbclient.runFile');
      const roTab = await until(() => posted.find((m) => m.type === 'result')?.tab, `${name}: read-only result`);
      assert.ok(!roTab.edit && /primary key/.test(roTab.readOnly), `${name}: read-only reason`);
      console.log(`✓ ${name} grid: editable Open Data, commit update/insert/delete, stale key rolled back, read-only reason`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      for (const sql of teardown) await driver.execute(sql, { maxRows: 1 }).catch(() => undefined);
      await api.manager.disconnect(config.id);
      await api.store.delete(config.id, []);
      api.history.clear(config.id);
    }
  }

  const tableRows = (t) => `insert into ${t} (id, name) values (1, 'one')`;
  const tableRows2 = (t) => `insert into ${t} (id, name) values (2, 'two')`;
  if (env.DBCLIENT_PG_HOST) {
    const schema = `smoke_${run}`;
    await tableFlow({
      name: 'postgres',
      type: 'postgres',
      options: { host: env.DBCLIENT_PG_HOST, port: 5432, database: env.DBCLIENT_PG_DATABASE, user: env.DBCLIENT_PG_USER },
      password: env.DBCLIENT_PG_PASSWORD,
      database: env.DBCLIENT_PG_DATABASE,
      setup: [`create schema ${schema}`, `create table ${schema}.items (id int primary key, name varchar(20))`, tableRows(`${schema}.items`), tableRows2(`${schema}.items`), `set search_path = ${schema}, public`],
      teardown: [`drop schema ${schema} cascade`],
      path: [env.DBCLIENT_PG_DATABASE, schema, 'Tables'],
      table: 'items',
    });
  }
  if (env.DBCLIENT_MYSQL_HOST) {
    const db = `smoke_${run}`;
    await tableFlow({
      name: 'mysql',
      type: 'mysql',
      options: { host: env.DBCLIENT_MYSQL_HOST, port: 3306, user: env.DBCLIENT_MYSQL_USER },
      password: env.DBCLIENT_MYSQL_PASSWORD,
      database: db,
      setup: [`create database ${db}`, `create table ${db}.items (id int primary key, name varchar(20))`, tableRows(`${db}.items`), tableRows2(`${db}.items`)],
      teardown: [`drop database ${db}`],
      path: [db, 'Tables'],
      table: 'items',
    });
  }
  if (env.DBCLIENT_MSSQL_HOST) {
    const db = `smoke_${run}`;
    await tableFlow({
      name: 'mssql',
      type: 'mssql',
      options: { host: env.DBCLIENT_MSSQL_HOST, port: 1433, database: 'master', user: env.DBCLIENT_MSSQL_USER, encrypt: false, trustServerCertificate: true },
      password: env.DBCLIENT_MSSQL_PASSWORD,
      database: db,
      setup: [`create database ${db}`, `create table ${db}.dbo.items (id int primary key, name nvarchar(20))`, tableRows(`${db}.dbo.items`), tableRows2(`${db}.dbo.items`)],
      teardown: [`alter database ${db} set single_user with rollback immediate`, `drop database ${db}`],
      path: [db, 'dbo', 'Tables'],
      table: 'items',
    });
  }
  if (env.DBCLIENT_ORACLE_HOST) {
    const t = `SMOKE_${run}`.toUpperCase();
    await tableFlow({
      name: 'oracle',
      type: 'oracle',
      options: { host: env.DBCLIENT_ORACLE_HOST, port: 1521, service: env.DBCLIENT_ORACLE_SERVICE, user: env.DBCLIENT_ORACLE_USER, autoCommit: true },
      password: env.DBCLIENT_ORACLE_PASSWORD,
      setup: [`create table ${t} (id number(10) primary key, name varchar2(20))`, tableRows(t), tableRows2(t)],
      teardown: [`drop table ${t} purge`],
      path: [env.DBCLIENT_ORACLE_USER.toUpperCase(), 'Tables'],
      table: t,
    });
  }
  {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-tables-')), 'tables.db');
    await tableFlow({
      name: 'sqlite',
      type: 'sqlite',
      options: { file },
      setup: ['create table items (id integer primary key, name varchar(20))', tableRows('items'), tableRows2('items')],
      teardown: [],
      path: ['Tables'],
      table: 'items',
    });
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
    const recorded = api.history.list(config.id);
    assert.deepStrictEqual(
      recorded.map((e) => [e.language, e.database, e.text.split(' ')[0], e.ok]),
      [['redis', '15', 'NOPE', false], ['redis', '15', 'TTL', true], ['redis', '15', 'HGETALL', true], ['redis', '15', 'HSET', true]],
      'redis: history',
    );
    console.log(`✓ redis: tree, completion (${labels.length}), run file, error on line 5, history`);

    // Value viewer opens from a key node.
    await vscode.commands.executeCommand('dbclient.openValue', { connectionId: config.id, node: { meta: { db: '15', key } } });
    await until(() => tabLabels().includes(key), 'value viewer tab');
    console.log('✓ redis: value viewer opened');

    await driver.command(15, ['DEL', key]);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.manager.disconnect(config.id);
    await api.store.delete(config.id, []);
    api.history.clear(config.id);
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

  // SSL/TLS (scripts/tls-fixture.sh) and SSH tunnels (scripts/ssh-fixture.sh) through the store, manager and tree.
  async function connectsThroughExtension(name, type, options, secret, check) {
    const config = await api.store.save({ name, type, options });
    secrets.set(config.id, secret);
    try {
      await api.tree.getChildren(await rootOf(config));
      assert.ok(api.manager.isConnected(config.id), `${name}: connected`);
      await check(api.manager.driver(config.id));
      await api.manager.test(config, secret);
    } finally {
      await api.manager.disconnect(config.id);
      await api.store.delete(config.id, []);
    }
  }
  const selectOne = async (driver) => assert.strictEqual(Number((await driver.execute('select 1 as one', { maxRows: 1 }))[0].rows[0][0]), 1);
  if (env.DBCLIENT_TLS_DIR) {
    const [host, port] = env.DBCLIENT_TLS_PG.split(':');
    await connectsThroughExtension(
      `smoke-tls-${run}`,
      'postgres',
      { host, port: Number(port), database: 'postgres', user: 'certuser', ssl: 'verify-full', sslCa: path.join(env.DBCLIENT_TLS_DIR, 'ca.crt'), sslCert: path.join(env.DBCLIENT_TLS_DIR, 'client.crt'), sslKey: path.join(env.DBCLIENT_TLS_DIR, 'client.key') },
      { password: env.DBCLIENT_TLS_PASSWORD },
      selectOne,
    );
    console.log('✓ ssl: postgres verify-full with client certificate');
  }
  if (env.DBCLIENT_SSH_HOST) {
    const ssh = { ssh: 'private key', sshHost: env.DBCLIENT_SSH_HOST, sshPort: Number(env.DBCLIENT_SSH_PORT), sshUser: env.DBCLIENT_SSH_USER, sshKeyFile: env.DBCLIENT_SSH_PROTECTED_KEY, sshHostKey: env.DBCLIENT_SSH_HOSTKEY };
    const target = env.DBCLIENT_SSH_TARGET_HOST;
    await connectsThroughExtension(
      `smoke-ssh-pg-${run}`,
      'postgres',
      { host: target, port: 5432, database: env.DBCLIENT_PG_DATABASE, user: env.DBCLIENT_PG_USER, ...ssh },
      { password: env.DBCLIENT_PG_PASSWORD, sshPassphrase: env.DBCLIENT_SSH_PASSPHRASE },
      selectOne,
    );
    await connectsThroughExtension(
      `smoke-ssh-redis-${run}`,
      'redis',
      { host: target, port: 6379, db: 15, ...ssh, ssh: 'password' },
      { password: env.DBCLIENT_REDIS_PASSWORD, sshPassword: env.DBCLIENT_SSH_PASSWORD },
      async (driver) => assert.strictEqual(await driver.command(15, ['PING']), 'PONG'),
    );
    if (env.DBCLIENT_TLS_DIR) {
      // TLS inside the tunnel (require: the test certificate does not name host.docker.internal).
      await connectsThroughExtension(
        `smoke-ssh-tls-${run}`,
        'postgres',
        { host: target, port: Number(env.DBCLIENT_TLS_PG.split(':')[1]), database: 'postgres', user: 'postgres', ssl: 'require', ...ssh },
        { password: env.DBCLIENT_TLS_PASSWORD, sshPassphrase: env.DBCLIENT_SSH_PASSPHRASE },
        selectOne,
      );
    }
    console.log('✓ ssh: postgres with protected key and host key check, redis with password' + (env.DBCLIENT_TLS_DIR ? ', TLS inside the tunnel' : ''));
  }

  // Servers from scripts/nats-auth-fixture.sh: every auth mode through the store's secrets and the tree.
  if (env.DBCLIENT_NATS_AUTH_USERS_SERVERS) {
    const modes = [
      ['user/password', { servers: env.DBCLIENT_NATS_AUTH_USERS_SERVERS, user: env.DBCLIENT_NATS_AUTH_USER }, { password: env.DBCLIENT_NATS_AUTH_PASSWORD }],
      ['nkey', { servers: env.DBCLIENT_NATS_AUTH_USERS_SERVERS }, { seed: env.DBCLIENT_NATS_AUTH_SEED }],
      ['token', { servers: env.DBCLIENT_NATS_AUTH_TOKEN_SERVERS }, { token: env.DBCLIENT_NATS_AUTH_TOKEN }],
      ['credentials file', { servers: env.DBCLIENT_NATS_AUTH_CREDS_SERVERS, credsFile: env.DBCLIENT_NATS_AUTH_CREDS_FILE }, {}],
    ];
    for (const [auth, options, secret] of modes) {
      const config = await api.store.save({ name: `smoke-nats-${auth}`, type: 'nats', options: { ...options, auth } });
      secrets.set(config.id, secret);
      const root = await api.tree.getChildren(await rootOf(config));
      assert.deepStrictEqual(root.slice(0, 1).map((n) => n.label), ['Subscriptions'], `nats ${auth}: tree`);
      assert.ok(api.manager.isConnected(config.id), `nats ${auth}: connected`);
      await api.manager.disconnect(config.id);
      await api.store.delete(config.id, []);
    }
    console.log('✓ nats auth: user/password, nkey, token, credentials file');
  }
};
