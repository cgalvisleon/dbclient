import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RedisCompletionProvider } from './completion/redisCompletion';
import { SqlCompletionProvider } from './completion/sqlCompletion';
import { CatalogCache } from './connections/catalog';
import { ConnectionManager } from './connections/manager';
import { SqlLocations } from './connections/sqlLocations';
import { DocumentBindings, EDITOR_CATEGORIES } from './editor/bindings';
import { ConnectionCodeLens, RunCodeLens } from './editor/codeLens';
import { HistoryPicker } from './editor/historyPicker';
import { showSqlDocument, SQL_EDITOR_VIEW_TYPE, SqlEditorProvider } from './webviews/sqlEditor';
import { closeDocumentTabs, reopenWith } from './editor/tabs';
import { activeSqlEditorUri } from './editor/sqlDocument';
import { RedisRunner } from './editor/redisRunner';
import { SqlRunner } from './editor/sqlRunner';
import { TableActions, TemplateKind } from './editor/tableActions';
import { colorLabel, CONNECTION_COLORS, ConnectionColor, initIcons } from './icons';
import { allDrivers } from './drivers/registry';
import { ConnectionStore, ImportMode, parseExport } from './store/connectionStore';
import { QueryHistory } from './store/queryHistory';
import { sqlFileName, SqlFileStore } from './store/sqlFiles';
import { displayPath, expandPath, isInside } from './store/sqlLocations';
import {
  ConnectionItem,
  ConnectionsDragAndDrop,
  ConnectionsTree,
  FolderItem,
  NodeItem,
  SqlDirItem,
  SqlFileItem,
  SqlFolderItem,
  SqlLocationItem,
} from './tree/connectionsTree';
import { openConnectionForm } from './webviews/connectionForm';
import { NatsConsoles } from './webviews/natsConsole';
import { openValueViewer } from './webviews/redisValue';
import { openSettingsPanel } from './webviews/settings';
import { RESULTS_VIEW_ID, ResultsView, RowAction } from './webviews/resultsView';
import { loadLanguage, t } from './l10n';

/** Returned from activate() so the smoke test can drive the extension; not a public API. */
export interface DbClientInternals {
  store: ConnectionStore;
  manager: ConnectionManager;
  tree: ConnectionsTree;
  dragAndDrop: ConnectionsDragAndDrop;
  bindings: DocumentBindings;
  sqlFiles: SqlFileStore;
  sqlLocations: SqlLocations;
  history: QueryHistory;
  catalog: CatalogCache;
  results: ResultsView;
  sqlEditors: SqlEditorProvider;
}

export function activate(context: vscode.ExtensionContext): DbClientInternals {
  initIcons(context.extensionUri);
  loadLanguage(context.extensionPath);
  // Texts already shown (tree, editor bars, open panels) keep their language until the window reloads.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('dbclient.language')) {
        return;
      }
      loadLanguage(context.extensionPath);
      const reload = t('Reload Window');
      if ((await vscode.window.showInformationMessage(t('Reload the window to show DB Client in the new language everywhere.'), reload)) === reload) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),
  );
  const store = new ConnectionStore(vscode.Uri.joinPath(context.globalStorageUri, 'connections.json').fsPath, context.secrets);
  const manager = new ConnectionManager(store);
  const sqlRoot = () => {
    const custom = vscode.workspace.getConfiguration('dbclient').get<string>('sqlFolder', '').trim();
    return custom ? custom.replace(/^~(?=$|[\\/])/, os.homedir()) : vscode.Uri.joinPath(context.globalStorageUri, 'sql').fsPath;
  };
  const sqlFiles = new SqlFileStore(sqlRoot());
  const sqlLocations = new SqlLocations(manager, sqlFiles);
  const tree = new ConnectionsTree(manager, sqlLocations);
  const dragAndDrop = new ConnectionsDragAndDrop(manager);
  const bindings = new DocumentBindings(
    context.workspaceState,
    manager,
    (uri) => sqlLocations.owners(uri.fsPath),
    (uri, id) => sqlFiles.databaseOf(uri.fsPath, id),
  );
  const results = new ResultsView(context.extensionUri);
  const history = new QueryHistory(vscode.Uri.joinPath(context.globalStorageUri, 'history').fsPath, () =>
    Math.max(0, Math.floor(vscode.workspace.getConfiguration('dbclient').get<number>('historySize', 500))),
  );
  const historyPicker = new HistoryPicker(manager, bindings, history);
  const catalog = new CatalogCache(manager);
  const runner = new SqlRunner(manager, bindings, results, history, catalog);
  const sqlEditors = new SqlEditorProvider(context.extensionUri, { manager, bindings, runner, results, history: historyPicker });
  const tableActions = new TableActions(manager, bindings, catalog, results, runner);
  const redisRunner = new RedisRunner(manager, bindings, results, history);
  const natsConsoles = new NatsConsoles(context.extensionUri, manager);

  // Shows "Change Folder Color…" in the Command Palette only when there is a folder.
  const updateHasFolders = () => vscode.commands.executeCommand('setContext', 'dbclient.hasFolders', store.listFolders().length > 0);
  updateHasFolders();
  context.subscriptions.push(store.onDidChange(updateHasFolders));

  const sqlDocs: vscode.DocumentSelector = [{ language: 'sql' }];
  const redisDocs: vscode.DocumentSelector = [{ language: 'redis' }];
  context.subscriptions.push(
    store.watch(),
    sqlFiles.watch(),
    sqlLocations,
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('dbclient.sqlFolder') && sqlFiles.relocate(sqlRoot())),
    manager,
    tree,
    bindings,
    runner,
    catalog,
    redisRunner,
    natsConsoles,
    vscode.window.createTreeView('dbclient.connections', {
      treeDataProvider: tree,
      showCollapseAll: true,
      canSelectMany: true,
      dragAndDropController: dragAndDrop,
    }),
    vscode.window.registerWebviewViewProvider(RESULTS_VIEW_ID, results, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerCustomEditorProvider(SQL_EDITOR_VIEW_TYPE, sqlEditors, {
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.languages.registerCompletionItemProvider(sqlDocs, new SqlCompletionProvider(manager, bindings, catalog), '.', ' '),
    vscode.languages.registerCodeLensProvider([...sqlDocs, ...redisDocs], new ConnectionCodeLens(bindings, manager)),
    vscode.languages.registerCodeLensProvider(sqlDocs, new RunCodeLens(bindings, manager, runner)),
    vscode.languages.registerCompletionItemProvider(redisDocs, new RedisCompletionProvider(manager, bindings), ' ', ':'),
  );

  // Editor title bar: Connect or Disconnect, and Cancel, follow the active editor's connection and run.
  const updateEditorContext = () => {
    const doc = vscode.window.activeTextEditor?.document;
    const binding = doc && bindings.get(doc);
    void vscode.commands.executeCommand('setContext', 'dbclient.editorBound', Boolean(binding));
    void vscode.commands.executeCommand('setContext', 'dbclient.editorConnected', Boolean(binding && manager.isConnected(binding.connectionId)));
    void vscode.commands.executeCommand('setContext', 'dbclient.queryRunning', Boolean(doc && runner.isRunning(doc)));
  };
  updateEditorContext();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateEditorContext),
    bindings.onDidChange(updateEditorContext),
    manager.onDidChangeState(updateEditorContext),
    runner.onDidChangeRunning(updateEditorContext),
  );

  const command = (id: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (err) {
          vscode.window.showErrorMessage((err as Error).message);
        }
      }),
    );

  /** Connection id from a tree item, the editor's (title bar: a document URI), or asked with a quick pick from the palette. */
  const connectionOf = async (item?: ConnectionItem | NodeItem | vscode.Uri): Promise<string | undefined> => {
    if (item instanceof vscode.Uri) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === item.toString());
      const id = doc && bindings.get(doc)?.connectionId;
      if (id) {
        return id;
      }
    } else if (item) {
      return item.connectionId;
    }
    const picked = await vscode.window.showQuickPick(
      store.list().map((c) => ({ label: c.name, description: manager.factoryOf(c).label, id: c.id })),
      { placeHolder: t('Select a connection') },
    );
    return picked?.id;
  };

  command('dbclient.addConnection', (item?: FolderItem) =>
    openConnectionForm(context.extensionUri, manager, undefined, item instanceof FolderItem ? item.folderId : undefined),
  );

  // ---------- folders ----------

  const askFolderName = (value = '') =>
    vscode.window.showInputBox({
      prompt: t('Folder name'),
      value,
      validateInput: (v) => (v.trim() ? undefined : t('Folder name is required.')),
    });

  /** Quick pick of folders (plus the top level); `exclude` hides a folder and everything below it. */
  const pickFolder = async (exclude?: string): Promise<{ id: string | undefined } | undefined> => {
    const below = (id: string | undefined): boolean => {
      for (let f = id; f; f = store.getFolder(f)?.parentId) {
        if (f === exclude) {
          return true;
        }
      }
      return false;
    };
    const items = [
      { label: `$(root-folder) ${t('Top level')}`, id: undefined as string | undefined },
      ...store
        .listFolders()
        .filter((f) => !below(f.id))
        .map((f) => ({ label: `$(folder) ${store.folderPath(f.id)}`, id: f.id as string | undefined }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
    return vscode.window.showQuickPick(items, { placeHolder: t('Move to folder') });
  };

  command('dbclient.addFolder', async (item?: FolderItem) => {
    const name = await askFolderName();
    if (name) {
      store.createFolder(name, item instanceof FolderItem ? item.folderId : undefined);
    }
  });

  command('dbclient.renameFolder', async (item?: FolderItem) => {
    const folder = item && store.getFolder(item.folderId);
    if (!folder) {
      return;
    }
    const name = await askFolderName(folder.name);
    if (name) {
      store.renameFolder(folder.id, name);
    }
  });

  command('dbclient.deleteFolder', async (item?: FolderItem) => {
    const folder = item && store.getFolder(item.folderId);
    if (!folder) {
      return;
    }
    const remove = t('Delete');
    const answer = await vscode.window.showWarningMessage(
      t('Delete folder "{0}"? Its connections and subfolders move up one level; nothing else is deleted.', folder.name),
      { modal: true },
      remove,
    );
    if (answer === remove) {
      store.deleteFolder(folder.id);
    }
  });

  const COLOR_DOTS: Record<ConnectionColor, string> = { blue: '🔵', green: '🟢', red: '🔴', orange: '🟠', purple: '🟣', yellow: '🟡', gray: '⚪' };

  // `color` lets tests skip the picker.
  // From the tree (inline palette button or context menu) or the Command Palette, which asks
  // for the folder first.
  command('dbclient.setFolderColor', async (item?: FolderItem, color?: ConnectionColor) => {
    let folder = item instanceof FolderItem ? store.getFolder(item.folderId) : undefined;
    if (!folder && !item) {
      const picked = await vscode.window.showQuickPick(
        store
          .listFolders()
          .map((f) => ({ label: `$(folder) ${store.folderPath(f.id)}`, id: f.id }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        { placeHolder: t('Folder to color') },
      );
      folder = picked && store.getFolder(picked.id);
    }
    if (!folder) {
      return;
    }
    if (!color) {
      const current = folder.color ?? 'blue';
      const picked = await vscode.window.showQuickPick(
        CONNECTION_COLORS.map((c) => ({ label: `${COLOR_DOTS[c]} ${colorLabel(c)}`, description: c === current ? t('current') : undefined, color: c })),
        { placeHolder: t('Icon color for "{0}"', folder.name) },
      );
      color = picked?.color;
    }
    if (color && CONNECTION_COLORS.includes(color)) {
      store.setFolderColor(folder.id, color === 'blue' ? undefined : color);
    }
  });

  command('dbclient.moveToFolder', async (item?: ConnectionItem | FolderItem, selected?: (ConnectionItem | FolderItem)[]) => {
    const items = (selected?.length ? selected : item ? [item] : []).filter((i) => i instanceof ConnectionItem || i instanceof FolderItem);
    if (!items.length) {
      return;
    }
    const target = await pickFolder(items.length === 1 && items[0] instanceof FolderItem ? items[0].folderId : undefined);
    if (!target) {
      return;
    }
    for (const i of items) {
      if (i instanceof FolderItem) {
        store.moveFolder(i.folderId, target.id);
      } else {
        store.moveConnection(i.connectionId, target.id);
      }
    }
  });
  command('dbclient.showSettings', () =>
    openSettingsPanel(context, {
      paths: () => {
        const custom = vscode.workspace.getConfiguration('dbclient').get<string>('sqlFolder', '').trim();
        return {
          globalStorage: context.globalStorageUri.fsPath,
          connectionsFile: vscode.Uri.joinPath(context.globalStorageUri, 'connections.json').fsPath,
          historyDir: vscode.Uri.joinPath(context.globalStorageUri, 'history').fsPath,
          sqlFolder: sqlRoot(),
          sqlFolderCustom: !!custom,
        };
      },
      counts: () => ({ connections: store.list().length, folders: store.listFolders().length }),
    }),
  );

  command('dbclient.refresh', () => {
    catalog.invalidate();
    tree.refresh();
  });

  // One connection or node: re-reads schemas, tables, columns… changed outside the tree.
  command('dbclient.refreshNode', (item?: ConnectionItem | NodeItem) => {
    if (!item) {
      catalog.invalidate();
      tree.refresh();
      return;
    }
    catalog.invalidate(item.connectionId);
    tree.refreshItem(item);
  });

  command('dbclient.editConnection', async (item?: ConnectionItem) => {
    const id = await connectionOf(item);
    if (id) {
      await openConnectionForm(context.extensionUri, manager, id);
    }
  });

  command('dbclient.duplicateConnection', async (item?: ConnectionItem) => {
    const id = await connectionOf(item);
    if (id) {
      await store.duplicate(id, manager.factoryOf(manager.config(id)).fields);
    }
  });

  command('dbclient.deleteConnection', async (item?: ConnectionItem) => {
    const id = await connectionOf(item);
    if (!id) {
      return;
    }
    const config = manager.config(id);
    const remove = t('Delete');
    const saved = sqlFiles.list(id).length;
    const external = sqlLocations.of(id).filter((l) => l.kind !== 'internal').length;
    const answer = await vscode.window.showWarningMessage(
      saved
        ? t('Delete connection "{0}"? Its saved password and its {1} saved SQL files are removed too.', config.name, saved)
        : t('Delete connection "{0}"? Its saved password is removed too.', config.name),
      {
        modal: true,
        detail: external ? t('Linked folders and other save locations are not touched.') : undefined,
      },
      remove,
    );
    if (answer === remove) {
      await manager.disconnect(id);
      await store.delete(id, manager.factoryOf(config).fields);
      sqlFiles.deleteAll(id);
      history.clear(id);
    }
  });

  // ---------- export / import ----------

  const fieldsOf = (type: string) => allDrivers().find((d) => d.type === type)?.fields;

  // From the view title (everything), a folder (it and its subfolders) or connections (the
  // selected ones, without folders). The tree passes the selection second; tests pass `target`
  // (second or third) to skip the save dialog.
  command(
    'dbclient.exportConnections',
    async (item?: FolderItem | ConnectionItem, second?: vscode.Uri | unknown[], third?: vscode.Uri) => {
      let target = second instanceof vscode.Uri ? second : third;
      const selected = Array.isArray(second) ? second : [];
      const folderId = item instanceof FolderItem ? item.folderId : undefined;
      const connectionIds =
        item instanceof ConnectionItem
          ? [...new Set([item, ...selected].filter((i): i is ConnectionItem => i instanceof ConnectionItem).map((i) => i.connectionId))]
          : undefined;
      const data = store.exportData((type) => (fieldsOf(type) ?? []).filter((f) => f.secret).map((f) => f.key), folderId, connectionIds);
      if (!data.connections.length && !data.folders.length) {
        vscode.window.showInformationMessage(t('There are no connections to export.'));
        return;
      }
      const name = folderId
        ? store.getFolder(folderId)!.name
        : connectionIds?.length === 1
          ? data.connections[0].name
          : connectionIds
            ? 'dbclient-selected-connections'
            : 'dbclient-connections';
      target ??= await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `${name.replace(/[\\/:*?"<>|]+/g, '-')}.json`)),
        filters: { JSON: ['json'] },
        title: t('Export Connections'),
      });
      if (!target) {
        return;
      }
      await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8'));
      vscode.window.showInformationMessage(
        t('Exported {0} connections to {1}. Passwords and other secrets are not included.', data.connections.length, target.fsPath),
      );
    },
  );

  // From the view title, or a folder to import into it (merge only). Tests pass the file and
  // mode (`(uri, mode)`, or `(folder, undefined, uri)`) to skip the dialogs.
  command('dbclient.importConnections', async (first?: vscode.Uri | FolderItem, second?: ImportMode | unknown, third?: vscode.Uri) => {
    const folder = first instanceof FolderItem ? store.getFolder(first.folderId) : undefined;
    let source = first instanceof vscode.Uri ? first : third;
    let mode: ImportMode | undefined = folder ? 'merge' : second === 'merge' || second === 'replace' ? second : undefined;
    source ??= (
      await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ['json'] },
        title: folder ? t('Import Connections into "{0}"', folder.name) : t('Import Connections'),
      })
    )?.[0];
    if (!source) {
      return;
    }
    const data = parseExport(Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8'));
    if (!mode) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: t('Merge'), detail: t('Add the connections; existing ones are kept and identical ones skipped.'), mode: 'merge' as const },
          { label: t('Replace'), detail: t('Make the list exactly the file: connections not in it are deleted.'), mode: 'replace' as const },
        ],
        { title: t('Import {0} connections', data.connections.length) },
      );
      if (!picked) {
        return;
      }
      mode = picked.mode;
      if (mode === 'replace') {
        const keep = new Set(data.connections.map((c) => c.id));
        const removed = store.list().filter((c) => !keep.has(c.id));
        if (removed.length) {
          const replace = t('Replace');
          const answer = await vscode.window.showWarningMessage(
            t('Delete {0} connections that are not in the file?', removed.length),
            {
              modal: true,
              detail: `${removed.map((c) => c.name).join(', ')}\n\n${t('Their saved passwords and saved SQL files are deleted too; linked folders are not touched.')}`,
            },
            replace,
          );
          if (answer !== replace) {
            return;
          }
        }
      }
    }
    if (mode === 'replace') {
      const keep = new Set(data.connections.map((c) => c.id));
      await Promise.all(store.list().filter((c) => !keep.has(c.id)).map((c) => manager.disconnect(c.id)));
    }
    const result = await store.importData(data, mode, fieldsOf, folder?.id);
    for (const id of result.removed) {
      sqlFiles.deleteAll(id);
      history.clear(id);
    }
    const parts = [
      folder
        ? t('{0} imported into "{1}"', result.added.length + result.renamed.length, folder.name)
        : t('{0} imported', result.added.length + result.renamed.length),
    ];
    if (result.renamed.length) {
      parts.push(t('{0} as copies ({1})', result.renamed.length, result.renamed.join(', ')));
    }
    if (result.skipped.length) {
      parts.push(t('{0} already present', result.skipped.length));
    }
    if (result.removed.length) {
      parts.push(t('{0} deleted', result.removed.length));
    }
    if (result.invalid.length) {
      parts.push(t('{0} ignored (unknown engine): {1}', result.invalid.length, result.invalid.join(', ')));
    }
    vscode.window.showInformationMessage(
      `${parts.join(' · ')}. ${t('Passwords are not part of the file: enter them with Edit Connection where needed.')}`,
    );
  });

  // ---------- SQL files and their locations ----------

  type SqlItem = ConnectionItem | NodeItem | SqlFolderItem | SqlLocationItem | SqlDirItem;

  /** SQL connection from a tree item, or asked. */
  const sqlConnectionOf = async (item?: SqlItem): Promise<string | undefined> => {
    if (item) {
      return item.connectionId;
    }
    const picked = await vscode.window.showQuickPick(
      store
        .list()
        .filter((c) => manager.factoryOf(c).category === 'sql')
        .map((c) => ({ label: c.name, description: manager.factoryOf(c).label, id: c.id })),
      { placeHolder: t('SQL connection') },
    );
    return picked?.id;
  };

  /**
   * Folder for a new file: the clicked location/subfolder, else the save location; when the
   * connection has several locations the user may pick another one (the save location first).
   */
  /** Database a tree item stands for: a database node or its SQL folder (or a folder inside it). */
  const databaseOfItem = (item?: SqlItem): string | undefined =>
    item instanceof NodeItem ? item.node.database : item instanceof SqlDirItem ? sqlFiles.databaseOf(path.join(item.dir, 'x.sql'), item.connectionId) : undefined;

  const targetDir = async (connectionId: string, item?: SqlItem): Promise<string | undefined> => {
    if (item instanceof SqlLocationItem || item instanceof SqlDirItem) {
      return item.dir;
    }
    // A database node keeps its files in its own SQL folder.
    if (item instanceof NodeItem && item.node.kind === 'database' && item.node.database) {
      return sqlFiles.databaseDir(connectionId, item.node.database);
    }
    const locations = sqlLocations.of(connectionId).filter((l) => l.path);
    if (locations.length < 2) {
      return sqlLocations.saveDir(connectionId);
    }
    const env = sqlLocations.env();
    const items = locations
      .sort((a, b) => Number(b.isSave) - Number(a.isSave))
      .map((l) => ({
        label: `${l.isSave ? '$(star-full) ' : ''}${l.kind === 'internal' ? t('Saved (extension storage)') : l.label}`,
        description: l.raw ? displayPath(l.raw, env) : undefined,
        dir: l.path!,
      }));
    return (await vscode.window.showQuickPick(items, { placeHolder: t('Where to save the file') }))?.dir;
  };

  const askFileName = (dir: string, value?: string) =>
    vscode.window.showInputBox({
      prompt: t('SQL file name'),
      value: value ?? sqlFiles.nextNameIn(dir),
      validateInput: (v) => {
        try {
          sqlFileName(v);
          return undefined;
        } catch {
          return t('Enter a valid file name.');
        }
      },
    });

  /** Opens a file created for a connection and binds it explicitly (its folder may be shared or unlinked). */
  const openBound = async (file: string, connectionId: string, database?: string) => {
    const doc = await vscode.workspace.openTextDocument(file);
    await bindings.set(doc, { connectionId, database });
    await showSqlDocument(doc);
  };

  // Click on a SQL file of the tree (not in package.json: only the tree calls it).
  command('dbclient.openSqlFile', async (uri: vscode.Uri) => {
    await showSqlDocument(await vscode.workspace.openTextDocument(uri));
  });

  command('dbclient.newSqlFile', async (item?: SqlItem) => {
    const id = await sqlConnectionOf(item);
    const dir = id && (await targetDir(id, item));
    if (!id || !dir) {
      return;
    }
    const name = await askFileName(dir);
    if (name) {
      await openBound(sqlFiles.createIn(dir, name), id, databaseOfItem(item));
    }
  });

  // Saves the active SQL editor (usually an untitled query) into a location of its connection.
  // `uri` comes from the editor title bar or a DB Client SQL editor; otherwise the active text editor.
  command('dbclient.saveToSqlFolder', async (uri?: vscode.Uri) => {
    const doc = uri instanceof vscode.Uri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'sql') {
      vscode.window.showWarningMessage(t('Open a SQL editor first.'));
      return;
    }
    const binding = bindings.get(doc) ?? (await bindings.pick(doc));
    if (!binding) {
      return;
    }
    if (!doc.isUntitled && sqlLocations.owners(doc.uri.fsPath).includes(binding.connectionId)) {
      await doc.save();
      return;
    }
    // Bound to a database: its own SQL folder; otherwise the connection's save location.
    const dir = binding.database ? sqlFiles.databaseDir(binding.connectionId, binding.database) : await targetDir(binding.connectionId);
    if (!dir) {
      return;
    }
    const name = await askFileName(dir, doc.isUntitled ? undefined : path.basename(doc.uri.fsPath, '.sql'));
    if (!name) {
      return;
    }
    const file = sqlFiles.createIn(dir, name, doc.getText());
    if (doc.isUntitled) {
      // Close the untitled original (text or SQL editor tab) without the "save changes?" prompt.
      await closeDocumentTabs(doc.uri, true);
    }
    await openBound(file, binding.connectionId, binding.database);
  });

  // Inline Save on a file of the tree: saves its open editor.
  command('dbclient.saveSqlFile', async (item?: SqlFileItem) => {
    const doc = item && vscode.workspace.textDocuments.find((d) => d.uri.fsPath === item.file);
    if (doc?.isDirty) {
      await doc.save();
    } else if (item) {
      vscode.window.setStatusBarMessage(t('{0} has no unsaved changes.', path.basename(item.file)), 3000);
    }
  });

  command('dbclient.renameSqlFile', async (item?: SqlFileItem) => {
    if (!item) {
      return;
    }
    const name = await askFileName(path.dirname(item.file), path.basename(item.file, '.sql'));
    if (!name) {
      return;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === item.file);
    if (open?.isDirty) {
      await open.save();
    }
    const target = sqlFiles.rename(item.file, name);
    if (open) {
      // Reopen under the new name in place of the old tab.
      await closeDocumentTabs(open.uri);
      await showSqlDocument(await vscode.workspace.openTextDocument(target));
    }
  });

  command('dbclient.deleteSqlFile', async (item?: SqlFileItem) => {
    if (!item) {
      return;
    }
    const remove = t('Delete');
    const answer = await vscode.window.showWarningMessage(
      t('Delete "{0}"?', path.basename(item.file)),
      { modal: true, detail: item.file },
      remove,
    );
    if (answer === remove) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === item.file);
      if (open) {
        await closeDocumentTabs(open.uri, true);
      }
      sqlFiles.delete(item.file);
    }
  });

  command('dbclient.revealSqlFolder', async (item?: SqlItem) => {
    const id = await sqlConnectionOf(item);
    if (!id) {
      return;
    }
    const dir = item instanceof SqlLocationItem || item instanceof SqlDirItem ? item.dir : sqlLocations.saveDir(id);
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
    }
  });

  /**
   * Stored form of a picked folder: `${workspaceFolder}/…` when the user wants it relative to
   * the open project, else the absolute path. Undefined when the user cancels.
   */
  const storedPath = async (folder: string): Promise<string | undefined> => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws || !isInside(folder, ws)) {
      return folder;
    }
    const relative = path.relative(ws, folder).split(path.sep).join('/');
    const asVariable = relative ? `\${workspaceFolder}/${relative}` : '${workspaceFolder}';
    const choice = await vscode.window.showQuickPick(
      [
        { label: asVariable, description: t('Relative to whichever project is open'), value: asVariable },
        { label: folder, description: t('This exact folder'), value: folder },
      ],
      { placeHolder: t('The folder is inside the open project. How should it be stored?') },
    );
    return choice?.value;
  };

  command('dbclient.addSqlFolder', async (item?: SqlItem) => {
    const id = await sqlConnectionOf(item);
    if (!id) {
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: t('Link Folder'),
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!picked?.length) {
      return;
    }
    const current = manager.config(id).sqlLocations ?? [];
    const env = sqlLocations.env();
    const next = [...current];
    for (const uri of picked) {
      const stored = await storedPath(uri.fsPath);
      if (stored && !next.some((l) => expandPath(l.path, env) === expandPath(stored, env))) {
        next.push({ path: stored });
      }
    }
    store.patch(id, { sqlLocations: next });
  });

  command('dbclient.removeSqlFolder', async (item?: SqlLocationItem) => {
    if (!(item instanceof SqlLocationItem) || item.location.kind === 'internal') {
      return;
    }
    const config = manager.config(item.connectionId);
    const raw = item.location.raw!;
    if (item.location.kind === 'save') {
      // An unlinked save location: "removing" it means saving to the internal folder again.
      store.patch(item.connectionId, { sqlSaveLocation: undefined });
      return;
    }
    store.patch(item.connectionId, {
      sqlLocations: (config.sqlLocations ?? []).filter((l) => l.path !== raw),
      sqlSaveLocation: config.sqlSaveLocation === raw ? undefined : config.sqlSaveLocation,
    });
    vscode.window.setStatusBarMessage(t('Unlinked {0}; its files were not touched.', item.location.label), 4000);
  });

  command('dbclient.setSaveLocation', async (item?: SqlItem) => {
    const id = await sqlConnectionOf(item);
    if (!id) {
      return;
    }
    if (item instanceof SqlLocationItem) {
      store.patch(id, { sqlSaveLocation: item.location.kind === 'internal' ? undefined : item.location.raw });
      return;
    }
    const env = sqlLocations.env();
    const options = [
      ...sqlLocations.of(id).map((l) => ({
        label: `${l.isSave ? '$(star-full) ' : ''}${l.kind === 'internal' ? t('Saved (extension storage)') : l.label}`,
        description: l.raw ? displayPath(l.raw, env) : undefined,
        raw: l.kind === 'internal' ? null : l.raw!,
      })),
      { label: `$(folder-opened) ${t('Other folder…')}`, description: undefined, raw: undefined as string | null | undefined },
    ];
    const choice = await vscode.window.showQuickPick(options, { placeHolder: t('Where new SQL files of this connection are saved') });
    if (!choice) {
      return;
    }
    let raw = choice.raw;
    if (raw === undefined) {
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: t('Save Here') });
      raw = picked?.[0] ? await storedPath(picked[0].fsPath) : undefined;
      if (!raw) {
        return;
      }
    }
    store.patch(id, { sqlSaveLocation: raw ?? undefined });
  });

  command('dbclient.testConnection', async (item?: ConnectionItem) => {
    const id = await connectionOf(item);
    if (!id) {
      return;
    }
    const config = manager.config(id);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Testing {0}…', config.name) },
      async () => {
        try {
          await manager.test(config, await store.getSecrets(id, manager.factoryOf(config).fields));
          vscode.window.showInformationMessage(t('{0}: connection succeeded.', config.name));
        } catch (err) {
          vscode.window.showErrorMessage(t('{0}: {1}', config.name, (err as Error).message));
        }
      },
    );
  });

  command('dbclient.connect', async (item?: ConnectionItem | vscode.Uri) => {
    const id = await connectionOf(item);
    if (id) {
      await vscode.window.withProgress(
        { location: { viewId: 'dbclient.connections' }, title: t('Connecting…') },
        () => manager.connect(id),
      );
    }
  });

  command('dbclient.disconnect', async (item?: ConnectionItem | vscode.Uri) => {
    const id = await connectionOf(item);
    if (id) {
      await manager.disconnect(id);
    }
  });

  // SQL and Redis open a text editor bound to the connection; NATS opens its console.
  command('dbclient.newQuery', async (item?: ConnectionItem | NodeItem) => {
    const id = await connectionOf(item);
    if (!id) {
      return;
    }
    const category = manager.factoryOf(manager.config(id)).category;
    if (category === 'pubsub') {
      await natsConsoles.open(id);
      return;
    }
    const language = category === 'kv' ? 'redis' : 'sql';
    const content = category === 'kv' ? '# One command per line. Ctrl/Cmd+Enter runs the current line or the selection.\n' : '';
    const doc = await vscode.workspace.openTextDocument({ language, content });
    await bindings.set(doc, { connectionId: id, database: item instanceof NodeItem ? item.node.database : undefined });
    if (language === 'sql' && vscode.workspace.getConfiguration('dbclient').get<boolean>('sqlEditor.openByDefault', true)) {
      await showSqlDocument(doc);
      return;
    }
    const editor = await vscode.window.showTextDocument(doc);
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
  });

  // ---------- tables and views ----------

  command('dbclient.openData', (item: NodeItem) => tableActions.openData(item));
  command('dbclient.openSql', (item: NodeItem) => tableActions.openSql(item));
  command('dbclient.showStructure', (item: NodeItem) => tableActions.showStructure(item));
  command('dbclient.showDdl', (item: NodeItem) => tableActions.showDdl(item));
  command('dbclient.drop', (item: NodeItem) => tableActions.drop(item));
  for (const kind of ['select', 'insert', 'update', 'delete'] as TemplateKind[]) {
    command(`dbclient.generate${kind[0].toUpperCase()}${kind.slice(1)}`, (item: NodeItem) => tableActions.generate(item, kind));
  }

  command('dbclient.showHistory', (item?: ConnectionItem | vscode.Uri) => {
    if (item instanceof ConnectionItem) {
      return historyPicker.show(item.connectionId);
    }
    // While a DB Client SQL editor is the active tab: insert at its caret.
    const uri = activeSqlEditorUri();
    const session = uri && sqlEditors.sessions.get(uri.toString());
    return session ? historyPicker.show(session.historyTarget().connectionId, session.historyTarget()) : historyPicker.show();
  });

  command('dbclient.openConsole', async (item?: ConnectionItem | NodeItem) => {
    const id = await connectionOf(item);
    if (id) {
      await natsConsoles.open(id, item instanceof NodeItem ? item.node.meta?.subject : undefined);
    }
  });

  command('dbclient.unsubscribe', async (item?: NodeItem) => {
    const subscription = item?.node.meta?.id;
    if (item && subscription) {
      (await manager.connectPubSub(item.connectionId)).unsubscribe(Number(subscription));
    }
  });

  command('dbclient.openValue', (item?: NodeItem) => {
    const key = item?.node.meta?.key;
    if (item && key !== undefined) {
      openValueViewer(context.extensionUri, manager, item.connectionId, Number(item.node.meta?.db ?? 0), key);
    }
  });

  command('dbclient.selectConnection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && EDITOR_CATEGORIES[editor.document.languageId]) {
      await bindings.pick(editor.document);
    } else {
      vscode.window.showWarningMessage(t('Open a SQL or Redis editor first.'));
    }
  });

  const run = (mode: 'auto' | 'file') => {
    const editor = vscode.window.activeTextEditor;
    return editor?.document.languageId === 'redis' ? redisRunner.run(editor, mode) : runner.run(editor, mode);
  };
  command('dbclient.run', () => run('auto'));
  command('dbclient.runFile', () => run('file'));

  // Editor title toolbar: run all / the statement at the cursor / the selection; copy, paste, export, import.
  const queryEditor = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !EDITOR_CATEGORIES[editor.document.languageId]) {
      vscode.window.showWarningMessage(t('Open a SQL or Redis editor first.'));
      return undefined;
    }
    return editor;
  };
  command('dbclient.runStatement', async () => {
    const editor = queryEditor();
    if (!editor) {
      return;
    }
    if (editor.document.languageId === 'redis') {
      // Redis runs the cursor's line when nothing is selected.
      editor.selection = new vscode.Selection(editor.selection.active, editor.selection.active);
      await redisRunner.run(editor, 'auto');
    } else {
      await runner.run(editor, { offset: editor.document.offsetAt(editor.selection.active) });
    }
  });
  command('dbclient.runSelection', async () => {
    const editor = queryEditor();
    if (!editor) {
      return;
    }
    if (editor.selection.isEmpty) {
      vscode.window.showInformationMessage(t('Select the statements to run first.'));
      return;
    }
    await run('auto');
  });
  command('dbclient.copyQuery', async () => {
    const editor = queryEditor();
    if (editor) {
      // The selection, or the whole file when nothing is selected.
      const text = editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection);
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(editor.selection.isEmpty ? t('Copied the whole file.') : t('Copied the selection.'), 2000);
    }
  });
  command('dbclient.pasteQuery', async () => {
    const editor = queryEditor();
    const text = editor && (await vscode.env.clipboard.readText());
    if (editor && text) {
      await editor.edit((edit) => editor.selections.forEach((s) => edit.replace(s, text)));
    }
  });
  const queryFilters = (language: string): Record<string, string[]> => (language === 'redis' ? { Redis: ['redis', 'txt'] } : { SQL: ['sql', 'txt'] });
  command('dbclient.exportQuery', async () => {
    const editor = queryEditor();
    if (!editor) {
      return;
    }
    const doc = editor.document;
    const ext = doc.languageId === 'redis' ? 'redis' : 'sql';
    const name = doc.isUntitled ? `query.${ext}` : path.basename(doc.uri.fsPath);
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), name)), filters: queryFilters(doc.languageId) });
    if (target) {
      await vscode.workspace.fs.writeFile(target, Buffer.from(doc.getText(), 'utf8'));
      vscode.window.setStatusBarMessage(t('Saved {0}', target.fsPath), 3000);
    }
  });
  command('dbclient.importQuery', async () => {
    const editor = queryEditor();
    if (!editor) {
      return;
    }
    const [source] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: queryFilters(editor.document.languageId), openLabel: t('Import') })) ?? [];
    if (!source) {
      return;
    }
    const text = Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8');
    // Inserted at the cursor (replacing the selection), so the editor keeps its connection.
    await editor.edit((edit) => edit.replace(editor.selection, text));
  });
  command('dbclient.runAt', async (uri: vscode.Uri, offset: number) => {
    const editor = await vscode.window.showTextDocument(uri, { preserveFocus: false });
    await runner.run(editor, { offset });
  });
  // Context menu of a result cell; the webview's data-vscode-context says which cell.
  const rowActions: Record<string, RowAction> = {
    copyValue: 'copyValue',
    copyRow: 'copyRow',
    copyRowJson: 'copyRowJson',
    generateRowInsert: 'insert',
    generateRowUpdate: 'update',
    generateRowDelete: 'delete',
  };
  for (const [name, action] of Object.entries(rowActions)) {
    command(`dbclient.results.${name}`, (cell?: { seq?: number; row?: number; col?: number; document?: string }) => {
      if (cell?.seq !== undefined && cell.row !== undefined) {
        // `document` is set when the grid is embedded in a DB Client SQL editor.
        results.for(cell.document).post({ type: 'rowAction', action, seq: cell.seq, row: cell.row, col: cell.col ?? 0 });
      }
    });
  }
  // The DB Client SQL editor for a .sql document (the editor title's button, or the palette).
  command('dbclient.openSqlEditor', async (uri?: vscode.Uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      vscode.window.showWarningMessage(t('Open a SQL editor first.'));
      return;
    }
    await reopenWith(target, SQL_EDITOR_VIEW_TYPE);
  });
  // From the editor title bar (its document's URI), a statement's Cancel lens, or the palette.
  command('dbclient.cancelQuery', (uri?: vscode.Uri) => {
    const doc = uri instanceof vscode.Uri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : vscode.window.activeTextEditor?.document;
    return runner.cancel(doc);
  });

  return { store, manager, tree, dragAndDrop, bindings, sqlFiles, sqlLocations, history, catalog, results, sqlEditors };
}

export function deactivate(): void {
  // Disposables registered in activate() close every open session.
}
