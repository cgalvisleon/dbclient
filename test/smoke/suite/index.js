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

  // Settings and About panel opens once (a second call reveals the same tab).
  await vscode.commands.executeCommand('dbclient.showSettings');
  await vscode.commands.executeCommand('dbclient.showSettings');
  await until(() => tabLabels().filter((l) => /DB Client/.test(l)).length === 1, 'settings panel tab');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  console.log('✓ settings panel');

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

  async function sqlEngine({ name, type, options, password, database, ok, bad, badLine, sleep }) {
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
    assert.strictEqual(lenses.filter((l) => l.command?.command === 'dbclient.runAt').length, 2, `${name}: code lens per statement`);
    // Line 0: the connection selector, then the SQL editor toolbar's buttons and, last, open in it.
    assert.deepStrictEqual(
      lenses.filter((l) => l.range.start.line === 0 && l.command?.command !== 'dbclient.runAt').map((l) => l.command?.command),
      [
        'dbclient.selectConnection',
        'dbclient.runFile',
        'dbclient.runStatement',
        'dbclient.runSelection',
        'dbclient.disconnect',
        'dbclient.showHistory',
        'dbclient.saveToSqlFolder',
        'dbclient.copyQuery',
        'dbclient.pasteQuery',
        'dbclient.exportQuery',
        'dbclient.importQuery',
        'dbclient.openSqlEditor',
      ],
      `${name}: connection selector and toolbar on line 0`,
    );
    const titleBar = ext.packageJSON.contributes.menus['editor/title'];
    for (const c of ['dbclient.runFile', 'dbclient.runStatement', 'dbclient.connect', 'dbclient.disconnect', 'dbclient.saveToSqlFolder', 'dbclient.copyQuery', 'dbclient.pasteQuery']) {
      assert.ok(titleBar.some((m) => m.command === c && m.group.startsWith('navigation')), `${name}: title bar button ${c}`);
    }
    // editorLangId is not in the title bar's context (the buttons never showed); resourceLangId is.
    assert.ok(titleBar.every((m) => !/editorLangId/.test(m.when) && /resourceLangId/.test(m.when)), `${name}: title bar buttons use resourceLangId`);

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

    if (sleep) {
      // Cancel from the running statement's lens, then run again on the same connection.
      const slow = await vscode.workspace.openTextDocument({ language: 'sql', content: `${sleep};\n${ok};\n` });
      await vscode.window.showTextDocument(slow);
      await api.bindings.set(slow, { connectionId: config.id, database });
      const running = vscode.commands.executeCommand('dbclient.runFile');
      const cancelLens = await until(async () => {
        const l = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', slow.uri);
        return l.find((x) => x.command?.command === 'dbclient.cancelQuery');
      }, `${name}: Cancel lens`);
      assert.strictEqual(cancelLens.range.start.line, 0, `${name}: Cancel on the running statement`);
      const started = Date.now();
      await vscode.commands.executeCommand('dbclient.cancelQuery', ...cancelLens.command.arguments);
      await running;
      assert.ok(Date.now() - started < 5000, `${name}: cancelled in ${Date.now() - started} ms`);
      assert.strictEqual(vscode.languages.getDiagnostics(slow.uri).length, 0, `${name}: a cancel is not an error diagnostic`);
      const afterCancel = api.history.list(config.id);
      assert.deepStrictEqual([afterCancel[0].text, afterCancel[0].ok], [sleep, false], `${name}: cancelled statement in history, next one not run`);
      const lensesAfter = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', slow.uri);
      assert.ok(!lensesAfter.some((x) => x.command?.command === 'dbclient.cancelQuery'), `${name}: Run lenses back after the cancel`);
      await vscode.commands.executeCommand('dbclient.runAt', slow.uri, slow.getText().indexOf(ok));
      assert.deepStrictEqual([api.history.list(config.id)[0].text, api.history.list(config.id)[0].ok], [ok, true], `${name}: runs again after the cancel`);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      console.log(`✓ ${name}: cancel from the lens in ${Date.now() - started} ms, then run again`);
    }

    const expandedId = (await rootOf(config)).id;
    await vscode.commands.executeCommand('dbclient.disconnect', item);
    assert.notStrictEqual((await rootOf(config)).id, expandedId, `${name}: new tree id after disconnect (collapsed)`);
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

    // One connection (as the tree passes it: item + selection), imported into another folder.
    api.store.patch(a.id, { icon: 'cloud-database', color: 'purple' });
    const aItem = (await api.tree.getChildren(folderItem)).find((i) => i.connectionId === a.id);
    assert.ok(/colors\/purple\/cloud-database\.png$/.test(aItem.iconPath.dark.path), `tree icon follows the choice: ${aItem.iconPath.dark.path}`);
    assert.ok(/colors\/purple\/light\/cloud-database\.png$/.test(aItem.iconPath.light.path), 'light theme icon');
    const single = vscode.Uri.file(path.join(dir, 'single.json'));
    await vscode.commands.executeCommand('dbclient.exportConnections', aItem, [aItem], single);
    const singleData = JSON.parse(fs.readFileSync(single.fsPath, 'utf8'));
    assert.deepStrictEqual(singleData.folders, [], 'single export has no folders');
    assert.deepStrictEqual(singleData.connections.map((c) => [c.id, c.folderId, c.color]), [[a.id, undefined, 'purple']], 'single export');
    const into = api.store.createFolder(`smoke-into-${run}`);
    let intoItem = (await api.tree.getChildren()).find((r) => r.folderId === into.id);
    await vscode.commands.executeCommand('dbclient.setFolderColor', intoItem, 'orange');
    assert.strictEqual(api.store.getFolder(into.id).color, 'orange', 'folder color saved');
    intoItem = (await api.tree.getChildren()).find((r) => r.folderId === into.id);
    assert.ok(/colors\/orange\/explorer\.png$/.test(intoItem.iconPath.dark.path), `folder icon: ${intoItem.iconPath.dark.path}`);
    assert.ok(/colors\/orange\/light\/explorer\.png$/.test(intoItem.iconPath.light.path), 'folder light icon');
    await vscode.commands.executeCommand('dbclient.setFolderColor', intoItem, 'blue');
    assert.ok(!('color' in api.store.getFolder(into.id)), 'blue clears the color');
    await vscode.commands.executeCommand('dbclient.importConnections', intoItem, undefined, onlyFolder);
    const copy = api.store.list().find((c) => c.id !== a.id && c.name.startsWith(`smoke-export-a-${run}`));
    assert.ok(copy, 'imported as a copy next to the original');
    assert.strictEqual(api.store.folderPath(copy.folderId), `smoke-into-${run} / smoke-export-${run}`, 'import into a folder');
    await api.store.delete(copy.id, []);
    api.store.deleteFolder(into.id);
    for (const f of api.store.listFolders().filter((f) => f.parentId === undefined && f.id !== folder.id)) api.store.deleteFolder(f.id);

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
    // A click opens it in the text editor (the default), or in the DB Client SQL editor when
    // dbclient.sqlEditor.openByDefault is on; either way in one tab.
    assert.strictEqual(files[0].command.command, 'dbclient.openSqlFile');
    const fileTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((tab) => tab.input?.uri?.fsPath === file);
    await vscode.commands.executeCommand(files[0].command.command, ...files[0].command.arguments);
    await until(() => (fileTabs().length === 1 && fileTabs()[0].input instanceof vscode.TabInputText ? true : undefined), 'tree SQL file opened in the text editor');
    await vscode.window.tabGroups.close(fileTabs());
    const smokeSettings = vscode.workspace.getConfiguration('dbclient');
    await smokeSettings.update('sqlEditor.openByDefault', true, vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand(files[0].command.command, ...files[0].command.arguments);
      await until(() => (fileTabs().length === 1 && fileTabs()[0].input instanceof vscode.TabInputCustom ? true : undefined), 'tree SQL file opened in the SQL editor');
      await vscode.commands.executeCommand(files[0].command.command, ...files[0].command.arguments);
      assert.strictEqual(fileTabs().length, 1, 'a second click keeps one tab');
    } finally {
      await smokeSettings.update('sqlEditor.openByDefault', undefined, vscode.ConfigurationTarget.Global);
    }
    await vscode.window.tabGroups.close(fileTabs());

    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    assert.strictEqual(api.bindings.get(doc)?.connectionId, conn.id, 'saved file is bound to its connection');
    await vscode.commands.executeCommand('dbclient.runFile');
    await wait(500);
    assert.strictEqual(vscode.languages.getDiagnostics(doc.uri).length, 0, 'saved file runs without errors');

    // A database's SQL folder binds its files to that database; unsaved files show a Save action.
    const dbFile = api.sqlFiles.createIn(api.sqlFiles.databaseDir(conn.id, 'main'), 'per database', 'select 1;\n');
    const dbDoc = await vscode.workspace.openTextDocument(dbFile);
    assert.deepStrictEqual(api.bindings.get(dbDoc), { connectionId: conn.id, database: 'main' }, 'database folder implies the database');
    assert.strictEqual(sqlNode.description, '1', 'database files are not counted on the connection');
    const dbEditor = await vscode.window.showTextDocument(dbDoc);
    await dbEditor.edit((e) => e.insert(new vscode.Position(0, 0), '-- edited\n'));
    await vscode.commands.executeCommand('dbclient.saveSqlFile', { file: dbFile });
    assert.ok(!dbDoc.isDirty && fs.readFileSync(dbFile, 'utf8').startsWith('-- edited'), 'Save writes the open editor');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

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

    // The connection shows on the first line; changing it asks for confirmation.
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', bDoc.uri);
    assert.ok(lenses.some((l) => l.range.start.line === 0 && l.command?.title.includes(one.name)), 'connection lens on line 0');
    // dbclient.language overrides the editor's language for the extension's own texts.
    const settings = vscode.workspace.getConfiguration('dbclient');
    await settings.update('language', 'pt-br', vscode.ConfigurationTarget.Global);
    try {
      const translated = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', bDoc.uri);
      assert.ok(translated.some((l) => l.range.start.line === 0 && l.command?.title.startsWith('Conexão:')), 'toolbar in pt-br');
    } finally {
      await settings.update('language', undefined, vscode.ConfigurationTarget.Global);
    }
    const english = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', bDoc.uri);
    assert.ok(english.some((l) => l.range.start.line === 0 && l.command?.title.startsWith('Connection:')), 'toolbar back to the editor language');
    const { showQuickPick, showWarningMessage } = vscode.window;
    let answer;
    let asked = 0;
    vscode.window.showQuickPick = async (items) => (await items).find((i) => i.id === two.id);
    vscode.window.showWarningMessage = async (...args) => (asked++, args.find((a) => a === answer));
    try {
      answer = undefined;
      await vscode.commands.executeCommand('dbclient.selectConnection');
      assert.strictEqual(asked, 1, 'change asks first');
      assert.strictEqual(api.bindings.get(bDoc)?.connectionId, one.id, 'cancelled change keeps the connection');
      answer = 'Change Connection';
      await vscode.commands.executeCommand('dbclient.selectConnection');
      assert.strictEqual(api.bindings.get(bDoc)?.connectionId, two.id, 'confirmed change applies');
      await vscode.commands.executeCommand('dbclient.selectConnection');
      assert.strictEqual(asked, 2, 'picking the same connection does not ask');
    } finally {
      Object.assign(vscode.window, { showQuickPick, showWarningMessage });
    }
    await api.bindings.set(bDoc, { connectionId: one.id });
    console.log('✓ editor connection shown and changed with confirmation');

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

  // Disconnect (toolbar and tree) and connect again: the SQL editor keeps its connection and runs.
  async function reconnectAndRun(session, id, name, sleep) {
    const got = [];
    const realPost = session.channel.post;
    session.channel.post = function (m) {
      got.push(m);
      return realPost.call(this, m);
    };
    try {
      const runOnce = async (what) => {
        got.length = 0;
        await session.receive({ type: 'run', mode: 'file', anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } });
        const done = await until(() => got.find((m) => m.type === 'result' || (m.type === 'log' && !m.entry.ok)), `${name}: run ${what}`);
        assert.strictEqual(done.type, 'result', `${name}: run ${what} (${done.entry?.message})`);
      };
      await runOnce('before disconnecting');
      await session.receive({ type: 'disconnect' });
      assert.strictEqual((await session.pushState()).connected, false, `${name}: toolbar disconnect`);
      assert.strictEqual((await session.pushState()).connectionId, id, `${name}: binding kept while disconnected`);
      await runOnce('after a disconnect (reconnects by itself)');
      await vscode.commands.executeCommand('dbclient.disconnect', await rootOf(api.store.get(id)));
      await session.receive({ type: 'connect' });
      assert.strictEqual((await session.pushState()).connected, true, `${name}: toolbar connect`);
      await runOnce('after a tree disconnect and toolbar connect');
      if (sleep) {
        // Disconnecting while a query runs ends that run; the next one works.
        const edit = new vscode.WorkspaceEdit();
        edit.replace(session.document.uri, new vscode.Range(0, 0, session.document.lineCount, 0), `${sleep};\n`);
        await vscode.workspace.applyEdit(edit);
        got.length = 0;
        await session.receive({ type: 'run', mode: 'file', anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } });
        await until(() => api.sqlEditors && (session.services ?? true) && got.some((m) => m.type === 'run'), `${name}: long run started`);
        await wait(500);
        await vscode.commands.executeCommand('dbclient.disconnect', await rootOf(api.store.get(id)));
        await until(() => ((async () => !(await session.pushState()).running)()), `${name}: run ended by the disconnect`, 8000);
        const back = new vscode.WorkspaceEdit();
        back.replace(session.document.uri, new vscode.Range(0, 0, session.document.lineCount, 0), 'select 1 as one;\n');
        await vscode.workspace.applyEdit(back);
        await runOnce('after disconnecting during a run');
      }
    } finally {
      session.channel.post = realPost;
    }
    console.log(`✓ ${name} sql editor: runs after disconnect + connect${sleep ? ', and after disconnecting during a run' : ''}`);
  }

  if (env.DBCLIENT_PG_HOST) {
    const conn = await addConnection(`smoke-sqleditor-pg-${run}`, 'postgres', { host: env.DBCLIENT_PG_HOST, port: 5432, database: env.DBCLIENT_PG_DATABASE, user: env.DBCLIENT_PG_USER }, env.DBCLIENT_PG_PASSWORD);
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: 'select 1 as one;\n' });
    await api.bindings.set(doc, { connectionId: conn.id });
    await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'dbclient.sqlEditor');
    const session = await until(() => api.sqlEditors.sessions.get(doc.uri.toString()), 'postgres SQL editor session');
    await session.loaded;
    try {
      await reconnectAndRun(session, conn.id, 'postgres', 'select pg_sleep(30)');
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await api.manager.disconnect(conn.id);
      await api.store.delete(conn.id, []);
      api.history.clear(conn.id);
    }
  }

  // DB Client SQL editor (custom editor): CodeMirror loads in the webview, edits reach the
  // document, runs land in the editor's own results.
  {
    const conn = await addConnection(`smoke-sqleditor-${run}`, 'sqlite', { file: path.join(os.tmpdir(), `dbclient-editor-${run}.db`) });
    const file = api.sqlFiles.create(conn.id, 'editor', 'select 1 as one;\n');
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.commands.executeCommand('dbclient.openSqlEditor', doc.uri);
    const session = await until(() => api.sqlEditors.sessions.get(doc.uri.toString()), 'SQL editor session');
    await Promise.race([session.loaded, wait(20000).then(() => Promise.reject(new Error('CodeMirror did not load in the SQL editor webview')))]);
    const state = await session.pushState();
    assert.strictEqual(state.connectionId, conn.id, 'editor shows its connection');
    assert.ok(state.connections.some((c) => c.id === conn.id), 'connection listed in the drop-down');
    assert.strictEqual(state.connected, false);

    await session.receive({
      type: 'edit',
      changes: [{ from: { line: 1, ch: 0 }, to: { line: 1, ch: 0 }, insert: 'select 2 as two;\n' }],
      text: 'select 1 as one;\nselect 2 as two;\n',
    });
    assert.strictEqual(doc.getText(), 'select 1 as one;\nselect 2 as two;\n', 'webview edit written to the document');
    assert.ok(doc.isDirty, 'document dirty after the edit');

    const mine = [];
    const realChannelPost = session.channel.post.bind(session.channel);
    session.channel.post = (m) => {
      mine.push(m);
      realChannelPost(m);
    };
    const panelPosts = [];
    const realPanelPost = api.results.post.bind(api.results);
    api.results.post = (m) => {
      panelPosts.push(m);
      realPanelPost(m);
    };
    try {
      await session.receive({ type: 'run', mode: 'file', anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } });
      await until(() => mine.filter((m) => m.type === 'result').length === 2, 'both results in the SQL editor');
      mine.length = 0;
      await session.receive({ type: 'run', mode: 'statement', anchor: { line: 1, ch: 3 }, head: { line: 1, ch: 3 } });
      const result = await until(() => mine.find((m) => m.type === 'result'), 'result of the statement at the caret');
      assert.strictEqual(result.tab.columns[0].name, 'two');
      assert.strictEqual(panelPosts.length, 0, 'the bottom panel gets nothing');
    } finally {
      api.results.post = realPanelPost;
    }
    assert.strictEqual((await session.pushState()).connected, true, 'running opened the connection');
    await doc.save();

    // The layout button asks where the results go and saves it for every SQL editor.
    const { showQuickPick: realQuickPick } = vscode.window;
    vscode.window.showQuickPick = async (items) => (await items).find((i) => i.position === 'right');
    try {
      await session.receive({ type: 'resultsPosition' });
    } finally {
      vscode.window.showQuickPick = realQuickPick;
    }
    assert.strictEqual(vscode.workspace.getConfiguration('dbclient').get('sqlEditor.resultsPosition'), 'right', 'results position saved');
    await vscode.workspace.getConfiguration('dbclient').update('sqlEditor.resultsPosition', undefined, vscode.ConfigurationTarget.Global);
    await reconnectAndRun(session, conn.id, 'sqlite');

    // Untitled queries (New Query) in the SQL editor.
    const untitled = await vscode.workspace.openTextDocument({ language: 'sql', content: 'select 3 as three;\n' });
    await api.bindings.set(untitled, { connectionId: conn.id });
    let untitledSession;
    try {
      await vscode.commands.executeCommand('vscode.openWith', untitled.uri, 'dbclient.sqlEditor');
      untitledSession = await until(() => api.sqlEditors.sessions.get(untitled.uri.toString()), 'untitled SQL editor', 8000);
      await untitledSession.loaded;
    } catch (err) {
      console.log(`  untitled documents: not supported (${err.message})`);
    }
    if (untitledSession) {
      assert.strictEqual((await untitledSession.pushState()).connectionId, conn.id, 'untitled editor keeps its binding');
      // Saving it in the SQL folder replaces the untitled tab: one tab, no text editor next to it.
      const { showInputBox } = vscode.window;
      vscode.window.showInputBox = async () => `smoke-saved-${run}`;
      try {
        await vscode.commands.executeCommand('dbclient.saveToSqlFolder', untitled.uri);
      } finally {
        vscode.window.showInputBox = showInputBox;
      }
      const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((tab) => tab.input?.uri?.toString() ?? '');
      await until(() => !tabs().includes(untitled.uri.toString()), 'untitled tab closed');
      const saved = tabs().filter((u) => u.includes(`smoke-saved-${run}`));
      assert.strictEqual(saved.length, 1, `one tab for the saved file: ${tabs().join(', ')}`);
      assert.ok(vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((tab) => tab.input?.uri?.toString() === saved[0]).input instanceof vscode.TabInputCustom, 'saved file opened in the SQL editor');
    }

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await until(() => !api.sqlEditors.sessions.size, 'SQL editor sessions closed');
    await api.manager.disconnect(conn.id);
    await api.store.delete(conn.id, []);
    api.sqlFiles.deleteAll(conn.id);
    console.log(`✓ sql editor: CodeMirror loaded, toolbar state, edit to document, results in the editor${untitledSession ? ', untitled queries' : ''}`);
  }

  // Tables (S6), completion with real objects (S4) and grid editing (S8) on one engine.
  const posted = [];
  const realPost = api.results.post.bind(api.results);
  api.results.post = (m) => {
    posted.push(m);
    realPost(m);
  };

  // The table flows below check the text editor; the DB Client SQL editor gets its own flow after them.
  const dbSettings = vscode.workspace.getConfiguration('dbclient');
  await dbSettings.update('sqlEditor.openByDefault', false, vscode.ConfigurationTarget.Global);

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
      assert.match(item.contextValue, /^table sql \w+$/, `${name}: table node`);
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
      assert.match(editorText(), /create table/i, `${name}: DDL (${editorText().slice(0, 120)})`);
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
      await api.results.answer(api.results, {
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
      await api.results.answer(api.results, { type: 'commit', editId: tab.edit.id, changes: [{ kind: 'delete', key: { [col('id')]: 99 } }] });
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

      // A row's context menu generates SQL in a bound editor, and it runs on the engine.
      assert.ok(roTab.source !== undefined && tab.source !== undefined, `${name}: results carry a row SQL source`);
      await api.results.answer(api.results, { type: 'rowSql', source: roTab.source, kind: 'delete', row: ['nobody'] });
      const loose = vscode.window.activeTextEditor;
      assert.match(loose.document.getText(), /No primary key[\s\S]*WHERE \S*name\S* = 'nobody';/i, `${name}: DELETE by every column`);
      await api.results.answer(api.results, { type: 'rowSql', source: tab.source, kind: 'update', row: done.rows.find((r) => idOf(r) === 1) });
      const generated = vscode.window.activeTextEditor;
      assert.notStrictEqual(generated, loose);
      assert.match(generated.document.getText(), /^UPDATE [\s\S]*'uno'[\s\S]*WHERE \S*id\S* = 1;\n$/i, `${name}: UPDATE by key`);
      assert.strictEqual(api.bindings.get(generated.document)?.connectionId, config.id, `${name}: generated SQL bound`);
      for (const editor of [loose, generated]) {
        await vscode.window.showTextDocument(editor.document);
        posted.length = 0;
        await vscode.commands.executeCommand('dbclient.runFile');
        const entry = await until(() => posted.find((m) => m.type === 'log')?.entry, `${name}: generated SQL ran`);
        assert.ok(entry.ok, `${name}: generated SQL runs (${entry.message})`);
      }
      console.log(`✓ ${name} row SQL: DELETE without key, UPDATE by key, both run`);
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

  // DB Client SQL editor (opt-in): tree actions, row SQL and Query History open or insert there,
  // and Open Data shows its results in the editor, not in the bottom panel.
  await dbSettings.update('sqlEditor.openByDefault', true, vscode.ConfigurationTarget.Global);
  {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-sqleditor-')), 'actions.db');
    const config = await addConnection('smoke-sqleditor-actions', 'sqlite', { file });
    const driver = await api.manager.connectSql(config.id);
    for (const sql of ['create table items (id integer primary key, name varchar(20))', tableRows('items')]) await driver.execute(sql, { maxRows: 1 });
    const channelPosts = [];
    let channelProto;
    try {
      let item = await rootOf(config);
      for (const label of ['Tables', 'items']) item = (await api.tree.getChildren(item)).find((c) => c.label === label);
      const activeSession = () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom ? api.sqlEditors.sessions.get(input.uri.toString()) : undefined;
      };
      const opened = async (command, arg, pattern, label) => {
        const before = activeSession();
        await vscode.commands.executeCommand(command, arg);
        const session = await until(() => {
          const active = activeSession();
          return active !== before && pattern.test(active?.document.getText() ?? '') ? active : undefined;
        }, `sql editor: ${label} opened in the SQL editor`);
        assert.strictEqual(api.bindings.get(session.document)?.connectionId, config.id, `sql editor: ${label} bound`);
        return session;
      };
      // Text tabs of documents bound to this connection (other flows may leave tabs of their own).
      const textTabs = () =>
        vscode.window.tabGroups.all
          .flatMap((g) => g.tabs)
          .filter((tab) => tab.input instanceof vscode.TabInputText)
          .map((tab) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === tab.input.uri.toString()))
          .filter((d) => d && api.bindings.get(d)?.connectionId === config.id)
          .map((d) => d.getText().slice(0, 40));

      await opened('dbclient.generateSelect', item, /^SELECT id, name\nFROM /i, 'SELECT template');
      await opened('dbclient.showDdl', item, /CREATE TABLE/i, 'DDL');
      await opened('dbclient.openSql', item, /^SELECT \* FROM /i, 'Open SQL');

      const first = [...api.sqlEditors.sessions.values()][0];
      channelProto = Object.getPrototypeOf(first.channel);
      const realChannelPost = channelProto.post;
      channelProto.post = function (m) {
        channelPosts.push({ sink: this, m });
        return realChannelPost.call(this, m);
      };
      channelProto.realPost = realChannelPost;
      posted.length = 0;
      const data = await opened('dbclient.openData', item, /^SELECT \* FROM /i, 'Open Data');
      const tab = await until(() => channelPosts.find((p) => p.sink === data.channel && p.m.type === 'result')?.m.tab, 'sql editor: Open Data result in the editor');
      assert.ok(tab.edit, 'sql editor: editable grid');
      assert.ok(!posted.some((m) => m.type === 'result'), 'sql editor: no result in the bottom panel');

      await api.results.answer(data.channel, { type: 'rowSql', source: tab.source, kind: 'delete', row: tab.rows[0] });
      await until(() => (activeSession() !== data && /^DELETE /i.test(activeSession()?.document.getText() ?? '') ? true : undefined), 'sql editor: row SQL opened in the SQL editor');

      // Query History from the palette inserts at the caret of the active SQL editor.
      const target = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
      await api.bindings.set(target, { connectionId: config.id });
      await vscode.commands.executeCommand('vscode.openWith', target.uri, 'dbclient.sqlEditor');
      await (await until(() => api.sqlEditors.sessions.get(target.uri.toString()), 'sql editor: history target')).loaded;
      await vscode.commands.executeCommand('dbclient.showHistory');
      await new Promise((r) => setTimeout(r, 300));
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await until(() => (/^SELECT \* FROM /i.test(target.getText()) ? true : undefined), 'sql editor: history inserted into the SQL editor', 5000);
      assert.deepStrictEqual(textTabs(), [], 'sql editor: no text editor tab opened');

      // Switching an unsaved query between the text and the SQL editor keeps one tab.
      const draft = await vscode.workspace.openTextDocument({ language: 'sql', content: 'select 1;\n' });
      await vscode.window.showTextDocument(draft);
      const tabsOfDraft = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((tab) => tab.input?.uri?.toString() === draft.uri.toString());
      await vscode.commands.executeCommand('dbclient.openSqlEditor', draft.uri);
      await until(() => (tabsOfDraft().length === 1 && tabsOfDraft()[0].input instanceof vscode.TabInputCustom ? true : undefined), 'sql editor: text tab replaced by the SQL editor');
      const draftSession = await until(() => api.sqlEditors.sessions.get(draft.uri.toString()), 'sql editor: draft session');
      await draftSession.receive({ type: 'openAsText' });
      await until(() => (tabsOfDraft().length === 1 && tabsOfDraft()[0].input instanceof vscode.TabInputText ? true : undefined), 'sql editor: SQL editor replaced by the text tab');
      assert.ok(draft.isDirty && !draft.isClosed, 'sql editor: unsaved query kept while switching');
      console.log('✓ sql editor actions: templates, DDL, Open SQL, Open Data (results in the editor), row SQL, history insert, one tab when switching editors');
    } finally {
      if (channelProto?.realPost) {
        channelProto.post = channelProto.realPost;
        delete channelProto.realPost;
      }
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.manager.disconnect(config.id);
      await api.store.delete(config.id, []);
      api.history.clear(config.id);
      await dbSettings.update('sqlEditor.openByDefault', undefined, vscode.ConfigurationTarget.Global);
    }
  }

  if (env.DBCLIENT_PG_HOST) {
    await sqlEngine({
      name: 'postgres',
      type: 'postgres',
      options: { host: env.DBCLIENT_PG_HOST, port: 5432, database: env.DBCLIENT_PG_DATABASE, user: env.DBCLIENT_PG_USER },
      password: env.DBCLIENT_PG_PASSWORD,
      ok: 'select 1 as one, now()',
      sleep: 'select pg_sleep(10)',
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
      sleep: 'select sleep(10)',
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
      sleep: "waitfor delay '00:00:10'",
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
      sleep: 'select count(*) from all_objects a, all_objects b, all_objects c',
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
