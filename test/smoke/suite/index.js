// Runs inside the extension host. Plain assertions; any throw fails the run.
const assert = require('assert');
const vscode = require('vscode');

const env = process.env;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await wait(100);
  }
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('cgalvisleon.dbclient');
  assert.ok(ext, 'extension found');
  const api = await ext.activate();

  const commands = await vscode.commands.getCommands(true);
  const pkg = ext.packageJSON;
  for (const c of pkg.contributes.commands) {
    assert.ok(commands.includes(c.command), `command registered: ${c.command}`);
  }
  console.log(`✓ ${pkg.contributes.commands.length} commands registered`);

  if (!env.DBCLIENT_PG_HOST) {
    console.log('- DBCLIENT_PG_HOST not set: skipping the Postgres flow');
    return;
  }

  // C3: centralized store
  const config = await api.store.save({
    name: 'smoke',
    type: 'postgres',
    options: { host: env.DBCLIENT_PG_HOST, port: Number(env.DBCLIENT_PG_PORT || 5432), database: env.DBCLIENT_PG_DATABASE, user: env.DBCLIENT_PG_USER },
  });
  console.log(`✓ store file ${api.store.file}`);

  // C1: tree connects on expand and lists databases > schemas > folders
  const roots = await api.tree.getChildren();
  const conn = roots.find((r) => r.connectionId === config.id);
  assert.ok(conn, 'connection in tree');
  const dbs = await api.tree.getChildren(conn);
  assert.ok(dbs.length > 0 && dbs[0].node, `databases listed: ${dbs.map((d) => d.label).join(', ')}`);
  assert.ok(api.manager.isConnected(config.id), 'connected after expanding');
  const defaultDb = dbs.find((d) => d.node.description === 'default');
  const schemas = await api.tree.getChildren(defaultDb);
  const pub = schemas.find((s) => s.label === 'public');
  const folders = await api.tree.getChildren(pub);
  assert.deepStrictEqual(folders.map((f) => f.label), ['Tables', 'Views', 'Functions', 'Procedures', 'Indexes']);
  console.log(`✓ tree: ${dbs.length} databases, ${schemas.length} schemas, folders ok`);

  // S1/S3: bound editor, completion and code lenses
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: 'select 1 as one, now();\nselect nope from pg_class;\n' });
  await vscode.window.showTextDocument(doc);
  await api.bindings.set(doc, { connectionId: config.id });

  const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(2, 0));
  const labels = completions.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  assert.ok(labels.includes('GENERATE_SERIES') && labels.includes('SELECT') && labels.includes('jsonb'), 'postgres completion items');
  console.log(`✓ completion: ${labels.length} items for the postgres dialect`);

  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
  assert.strictEqual(lenses.filter((l) => l.command && l.command.command === 'dbclient.runAt').length, 2, 'one Run lens per statement');
  console.log('✓ code lens per statement');

  // S1/S2/S7: run the file; the 2nd statement fails with a positioned diagnostic
  await vscode.commands.executeCommand('dbclient.runFile');
  const diags = await until(() => {
    const d = vscode.languages.getDiagnostics(doc.uri);
    return d.length ? d : undefined;
  }, 'error diagnostic');
  assert.match(diags[0].message, /nope/);
  assert.strictEqual(diags[0].range.start.line, 1);
  assert.strictEqual(doc.getText(diags[0].range), 'nope');
  console.log(`✓ run file: error mapped to line ${diags[0].range.start.line + 1}, col ${diags[0].range.start.character + 1}`);

  // Running the first statement only clears the diagnostic.
  const editor = vscode.window.activeTextEditor;
  editor.selection = new vscode.Selection(0, 3, 0, 3);
  await vscode.commands.executeCommand('dbclient.run');
  assert.strictEqual(vscode.languages.getDiagnostics(doc.uri).length, 0, 'diagnostics cleared after a clean run');
  console.log('✓ run statement under the caret');

  await vscode.commands.executeCommand('dbclient.disconnect', conn);
  assert.ok(!api.manager.isConnected(config.id), 'disconnected');
  await api.store.delete(config.id, []);
  console.log('✓ disconnect and delete');
};
