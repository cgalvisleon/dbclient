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
}

export function activate(context: vscode.ExtensionContext): DbClientInternals {
  initIcons(context.extensionUri);
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
  const bindings = new DocumentBindings(context.workspaceState, manager, (uri) => sqlLocations.owners(uri.fsPath));
  const results = new ResultsView(context.extensionUri);
  const history = new QueryHistory(vscode.Uri.joinPath(context.globalStorageUri, 'history').fsPath, () =>
    Math.max(0, Math.floor(vscode.workspace.getConfiguration('dbclient').get<number>('historySize', 500))),
  );
  const historyPicker = new HistoryPicker(manager, bindings, history);
  const catalog = new CatalogCache(manager);
  const runner = new SqlRunner(manager, bindings, results, history, catalog);
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
    vscode.languages.registerCompletionItemProvider(sqlDocs, new SqlCompletionProvider(manager, bindings, catalog), '.', ' '),
    vscode.languages.registerCodeLensProvider([...sqlDocs, ...redisDocs], new ConnectionCodeLens(bindings, manager)),
    vscode.languages.registerCodeLensProvider(sqlDocs, new RunCodeLens(bindings, manager)),
    vscode.languages.registerCompletionItemProvider(redisDocs, new RedisCompletionProvider(manager, bindings), ' ', ':'),
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

  /** Connection id from a tree item, or asked with a quick pick when run from the palette. */
  const connectionOf = async (item?: ConnectionItem | NodeItem): Promise<string | undefined> => {
    if (item) {
      return item.connectionId;
    }
    const picked = await vscode.window.showQuickPick(
      store.list().map((c) => ({ label: c.name, description: manager.factoryOf(c).label, id: c.id })),
      { placeHolder: vscode.l10n.t('Select a connection') },
    );
    return picked?.id;
  };

  command('dbclient.addConnection', (item?: FolderItem) =>
    openConnectionForm(context.extensionUri, manager, undefined, item instanceof FolderItem ? item.folderId : undefined),
  );

  // ---------- folders ----------

  const askFolderName = (value = '') =>
    vscode.window.showInputBox({
      prompt: vscode.l10n.t('Folder name'),
      value,
      validateInput: (v) => (v.trim() ? undefined : vscode.l10n.t('Folder name is required.')),
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
      { label: `$(root-folder) ${vscode.l10n.t('Top level')}`, id: undefined as string | undefined },
      ...store
        .listFolders()
        .filter((f) => !below(f.id))
        .map((f) => ({ label: `$(folder) ${store.folderPath(f.id)}`, id: f.id as string | undefined }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
    return vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Move to folder') });
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
    const remove = vscode.l10n.t('Delete');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete folder "{0}"? Its connections and subfolders move up one level; nothing else is deleted.', folder.name),
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
        { placeHolder: vscode.l10n.t('Folder to color') },
      );
      folder = picked && store.getFolder(picked.id);
    }
    if (!folder) {
      return;
    }
    if (!color) {
      const current = folder.color ?? 'blue';
      const picked = await vscode.window.showQuickPick(
        CONNECTION_COLORS.map((c) => ({ label: `${COLOR_DOTS[c]} ${colorLabel(c)}`, description: c === current ? vscode.l10n.t('current') : undefined, color: c })),
        { placeHolder: vscode.l10n.t('Icon color for "{0}"', folder.name) },
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
    const remove = vscode.l10n.t('Delete');
    const saved = sqlFiles.list(id).length;
    const external = sqlLocations.of(id).filter((l) => l.kind !== 'internal').length;
    const answer = await vscode.window.showWarningMessage(
      saved
        ? vscode.l10n.t('Delete connection "{0}"? Its saved password and its {1} saved SQL files are removed too.', config.name, saved)
        : vscode.l10n.t('Delete connection "{0}"? Its saved password is removed too.', config.name),
      {
        modal: true,
        detail: external ? vscode.l10n.t('Linked folders and other save locations are not touched.') : undefined,
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
        vscode.window.showInformationMessage(vscode.l10n.t('There are no connections to export.'));
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
        title: vscode.l10n.t('Export Connections'),
      });
      if (!target) {
        return;
      }
      await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8'));
      vscode.window.showInformationMessage(
        vscode.l10n.t('Exported {0} connections to {1}. Passwords and other secrets are not included.', data.connections.length, target.fsPath),
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
        title: folder ? vscode.l10n.t('Import Connections into "{0}"', folder.name) : vscode.l10n.t('Import Connections'),
      })
    )?.[0];
    if (!source) {
      return;
    }
    const data = parseExport(Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8'));
    if (!mode) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t('Merge'), detail: vscode.l10n.t('Add the connections; existing ones are kept and identical ones skipped.'), mode: 'merge' as const },
          { label: vscode.l10n.t('Replace'), detail: vscode.l10n.t('Make the list exactly the file: connections not in it are deleted.'), mode: 'replace' as const },
        ],
        { title: vscode.l10n.t('Import {0} connections', data.connections.length) },
      );
      if (!picked) {
        return;
      }
      mode = picked.mode;
      if (mode === 'replace') {
        const keep = new Set(data.connections.map((c) => c.id));
        const removed = store.list().filter((c) => !keep.has(c.id));
        if (removed.length) {
          const replace = vscode.l10n.t('Replace');
          const answer = await vscode.window.showWarningMessage(
            vscode.l10n.t('Delete {0} connections that are not in the file?', removed.length),
            {
              modal: true,
              detail: `${removed.map((c) => c.name).join(', ')}\n\n${vscode.l10n.t('Their saved passwords and saved SQL files are deleted too; linked folders are not touched.')}`,
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
        ? vscode.l10n.t('{0} imported into "{1}"', result.added.length + result.renamed.length, folder.name)
        : vscode.l10n.t('{0} imported', result.added.length + result.renamed.length),
    ];
    if (result.renamed.length) {
      parts.push(vscode.l10n.t('{0} as copies ({1})', result.renamed.length, result.renamed.join(', ')));
    }
    if (result.skipped.length) {
      parts.push(vscode.l10n.t('{0} already present', result.skipped.length));
    }
    if (result.removed.length) {
      parts.push(vscode.l10n.t('{0} deleted', result.removed.length));
    }
    if (result.invalid.length) {
      parts.push(vscode.l10n.t('{0} ignored (unknown engine): {1}', result.invalid.length, result.invalid.join(', ')));
    }
    vscode.window.showInformationMessage(
      `${parts.join(' · ')}. ${vscode.l10n.t('Passwords are not part of the file: enter them with Edit Connection where needed.')}`,
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
      { placeHolder: vscode.l10n.t('SQL connection') },
    );
    return picked?.id;
  };

  /**
   * Folder for a new file: the clicked location/subfolder, else the save location; when the
   * connection has several locations the user may pick another one (the save location first).
   */
  const targetDir = async (connectionId: string, item?: SqlItem): Promise<string | undefined> => {
    if (item instanceof SqlLocationItem || item instanceof SqlDirItem) {
      return item.dir;
    }
    const locations = sqlLocations.of(connectionId).filter((l) => l.path);
    if (locations.length < 2) {
      return sqlLocations.saveDir(connectionId);
    }
    const env = sqlLocations.env();
    const items = locations
      .sort((a, b) => Number(b.isSave) - Number(a.isSave))
      .map((l) => ({
        label: `${l.isSave ? '$(star-full) ' : ''}${l.kind === 'internal' ? vscode.l10n.t('Saved (extension storage)') : l.label}`,
        description: l.raw ? displayPath(l.raw, env) : undefined,
        dir: l.path!,
      }));
    return (await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Where to save the file') }))?.dir;
  };

  const askFileName = (dir: string, value?: string) =>
    vscode.window.showInputBox({
      prompt: vscode.l10n.t('SQL file name'),
      value: value ?? sqlFiles.nextNameIn(dir),
      validateInput: (v) => {
        try {
          sqlFileName(v);
          return undefined;
        } catch {
          return vscode.l10n.t('Enter a valid file name.');
        }
      },
    });

  /** Opens a file created for a connection and binds it explicitly (its folder may be shared or unlinked). */
  const openBound = async (file: string, connectionId: string, database?: string) => {
    const doc = await vscode.workspace.openTextDocument(file);
    await bindings.set(doc, { connectionId, database });
    await vscode.window.showTextDocument(doc);
  };

  command('dbclient.newSqlFile', async (item?: SqlItem) => {
    const id = await sqlConnectionOf(item);
    const dir = id && (await targetDir(id, item));
    if (!id || !dir) {
      return;
    }
    const name = await askFileName(dir);
    if (name) {
      await openBound(sqlFiles.createIn(dir, name), id, item instanceof NodeItem ? item.node.database : undefined);
    }
  });

  // Saves the active SQL editor (usually an untitled query) into a location of its connection.
  command('dbclient.saveToSqlFolder', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      vscode.window.showWarningMessage(vscode.l10n.t('Open a SQL editor first.'));
      return;
    }
    const doc = editor.document;
    const binding = bindings.get(doc) ?? (await bindings.pick(doc));
    if (!binding) {
      return;
    }
    if (!doc.isUntitled && sqlLocations.owners(doc.uri.fsPath).includes(binding.connectionId)) {
      await doc.save();
      return;
    }
    const dir = await targetDir(binding.connectionId);
    if (!dir) {
      return;
    }
    const name = await askFileName(dir, doc.isUntitled ? undefined : path.basename(doc.uri.fsPath, '.sql'));
    if (!name) {
      return;
    }
    const file = sqlFiles.createIn(dir, name, doc.getText());
    if (doc.isUntitled) {
      // Close the untitled original without the "save changes?" prompt.
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    await openBound(file, binding.connectionId, binding.database);
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
      await vscode.window.showTextDocument(open);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.window.showTextDocument(vscode.Uri.file(target));
    }
  });

  command('dbclient.deleteSqlFile', async (item?: SqlFileItem) => {
    if (!item) {
      return;
    }
    const remove = vscode.l10n.t('Delete');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete "{0}"?', path.basename(item.file)),
      { modal: true, detail: item.file },
      remove,
    );
    if (answer === remove) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === item.file);
      if (open) {
        await vscode.window.showTextDocument(open);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
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
        { label: asVariable, description: vscode.l10n.t('Relative to whichever project is open'), value: asVariable },
        { label: folder, description: vscode.l10n.t('This exact folder'), value: folder },
      ],
      { placeHolder: vscode.l10n.t('The folder is inside the open project. How should it be stored?') },
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
      openLabel: vscode.l10n.t('Link Folder'),
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
    vscode.window.setStatusBarMessage(vscode.l10n.t('Unlinked {0}; its files were not touched.', item.location.label), 4000);
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
        label: `${l.isSave ? '$(star-full) ' : ''}${l.kind === 'internal' ? vscode.l10n.t('Saved (extension storage)') : l.label}`,
        description: l.raw ? displayPath(l.raw, env) : undefined,
        raw: l.kind === 'internal' ? null : l.raw!,
      })),
      { label: `$(folder-opened) ${vscode.l10n.t('Other folder…')}`, description: undefined, raw: undefined as string | null | undefined },
    ];
    const choice = await vscode.window.showQuickPick(options, { placeHolder: vscode.l10n.t('Where new SQL files of this connection are saved') });
    if (!choice) {
      return;
    }
    let raw = choice.raw;
    if (raw === undefined) {
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: vscode.l10n.t('Save Here') });
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
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Testing {0}…', config.name) },
      async () => {
        try {
          await manager.test(config, await store.getSecrets(id, manager.factoryOf(config).fields));
          vscode.window.showInformationMessage(vscode.l10n.t('{0}: connection succeeded.', config.name));
        } catch (err) {
          vscode.window.showErrorMessage(vscode.l10n.t('{0}: {1}', config.name, (err as Error).message));
        }
      },
    );
  });

  command('dbclient.connect', async (item?: ConnectionItem) => {
    const id = await connectionOf(item);
    if (id) {
      await vscode.window.withProgress(
        { location: { viewId: 'dbclient.connections' }, title: vscode.l10n.t('Connecting…') },
        () => manager.connect(id),
      );
    }
  });

  command('dbclient.disconnect', async (item?: ConnectionItem) => {
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

  command('dbclient.showHistory', (item?: ConnectionItem) => historyPicker.show(item?.connectionId));

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
      vscode.window.showWarningMessage(vscode.l10n.t('Open a SQL or Redis editor first.'));
    }
  });

  const run = (mode: 'auto' | 'file') => {
    const editor = vscode.window.activeTextEditor;
    return editor?.document.languageId === 'redis' ? redisRunner.run(editor, mode) : runner.run(editor, mode);
  };
  command('dbclient.run', () => run('auto'));
  command('dbclient.runFile', () => run('file'));
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
    command(`dbclient.results.${name}`, (cell?: { seq?: number; row?: number; col?: number }) => {
      if (cell?.seq !== undefined && cell.row !== undefined) {
        results.post({ type: 'rowAction', action, seq: cell.seq, row: cell.row, col: cell.col ?? 0 });
      }
    });
  }
  command('dbclient.cancelQuery', () => runner.cancel(vscode.window.activeTextEditor));

  return { store, manager, tree, dragAndDrop, bindings, sqlFiles, sqlLocations, history, catalog, results };
}

export function deactivate(): void {
  // Disposables registered in activate() close every open session.
}
