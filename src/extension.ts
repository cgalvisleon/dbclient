import * as vscode from 'vscode';
import { SqlCompletionProvider } from './completion/sqlCompletion';
import { ConnectionManager } from './connections/manager';
import { DocumentBindings } from './editor/bindings';
import { RunCodeLens } from './editor/codeLens';
import { SqlRunner } from './editor/sqlRunner';
import { ConnectionStore } from './store/connectionStore';
import { ConnectionItem, ConnectionsTree, NodeItem } from './tree/connectionsTree';
import { openConnectionForm } from './webviews/connectionForm';
import { RESULTS_VIEW_ID, ResultsView } from './webviews/resultsView';

/** Returned from activate() so the smoke test can drive the extension; not a public API. */
export interface DbClientInternals {
  store: ConnectionStore;
  manager: ConnectionManager;
  tree: ConnectionsTree;
  bindings: DocumentBindings;
}

export function activate(context: vscode.ExtensionContext): DbClientInternals {
  const store = new ConnectionStore(vscode.Uri.joinPath(context.globalStorageUri, 'connections.json').fsPath, context.secrets);
  const manager = new ConnectionManager(store);
  const tree = new ConnectionsTree(manager);
  const bindings = new DocumentBindings(context.workspaceState, manager);
  const results = new ResultsView(context.extensionUri);
  const runner = new SqlRunner(manager, bindings, results);

  const sqlDocs: vscode.DocumentSelector = [{ language: 'sql' }];
  context.subscriptions.push(
    store.watch(),
    manager,
    tree,
    bindings,
    runner,
    vscode.window.createTreeView('dbclient.connections', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.window.registerWebviewViewProvider(RESULTS_VIEW_ID, results, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerCompletionItemProvider(sqlDocs, new SqlCompletionProvider(manager, bindings), '.', ' '),
    vscode.languages.registerCodeLensProvider(sqlDocs, new RunCodeLens(bindings)),
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

  command('dbclient.addConnection', () => openConnectionForm(context.extensionUri, manager));
  command('dbclient.refresh', () => tree.refresh());

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
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete connection "{0}"? Its saved password is removed too.', config.name),
      { modal: true },
      remove,
    );
    if (answer === remove) {
      await manager.disconnect(id);
      await store.delete(id, manager.factoryOf(config).fields);
    }
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

  command('dbclient.newQuery', async (item?: ConnectionItem | NodeItem) => {
    const id = await connectionOf(item);
    if (!id) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
    await bindings.set(doc, { connectionId: id, database: item instanceof NodeItem ? item.node.database : undefined });
    await vscode.window.showTextDocument(doc);
  });

  command('dbclient.selectConnection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId === 'sql') {
      await bindings.pick(editor.document);
    } else {
      vscode.window.showWarningMessage(vscode.l10n.t('Open a SQL editor first.'));
    }
  });

  command('dbclient.run', () => runner.run(vscode.window.activeTextEditor, 'auto'));
  command('dbclient.runFile', () => runner.run(vscode.window.activeTextEditor, 'file'));
  command('dbclient.runAt', async (uri: vscode.Uri, offset: number) => {
    const editor = await vscode.window.showTextDocument(uri, { preserveFocus: false });
    await runner.run(editor, { offset });
  });
  command('dbclient.cancelQuery', () => runner.cancel(vscode.window.activeTextEditor));

  return { store, manager, tree, bindings };
}

export function deactivate(): void {
  // Disposables registered in activate() close every open session.
}
