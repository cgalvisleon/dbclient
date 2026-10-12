import * as vscode from 'vscode';
import { RedisCompletionProvider } from './completion/redisCompletion';
import { SqlCompletionProvider } from './completion/sqlCompletion';
import { ConnectionManager } from './connections/manager';
import { DocumentBindings, EDITOR_CATEGORIES } from './editor/bindings';
import { RunCodeLens } from './editor/codeLens';
import { RedisRunner } from './editor/redisRunner';
import { SqlRunner } from './editor/sqlRunner';
import { initIcons } from './icons';
import { ConnectionStore } from './store/connectionStore';
import { ConnectionItem, ConnectionsTree, NodeItem } from './tree/connectionsTree';
import { openConnectionForm } from './webviews/connectionForm';
import { NatsConsoles } from './webviews/natsConsole';
import { openValueViewer } from './webviews/redisValue';
import { RESULTS_VIEW_ID, ResultsView } from './webviews/resultsView';

/** Returned from activate() so the smoke test can drive the extension; not a public API. */
export interface DbClientInternals {
  store: ConnectionStore;
  manager: ConnectionManager;
  tree: ConnectionsTree;
  bindings: DocumentBindings;
}

export function activate(context: vscode.ExtensionContext): DbClientInternals {
  initIcons(context.extensionUri);
  const store = new ConnectionStore(vscode.Uri.joinPath(context.globalStorageUri, 'connections.json').fsPath, context.secrets);
  const manager = new ConnectionManager(store);
  const tree = new ConnectionsTree(manager);
  const bindings = new DocumentBindings(context.workspaceState, manager);
  const results = new ResultsView(context.extensionUri);
  const runner = new SqlRunner(manager, bindings, results);
  const redisRunner = new RedisRunner(manager, bindings, results);
  const natsConsoles = new NatsConsoles(context.extensionUri, manager);

  const sqlDocs: vscode.DocumentSelector = [{ language: 'sql' }];
  const redisDocs: vscode.DocumentSelector = [{ language: 'redis' }];
  context.subscriptions.push(
    store.watch(),
    manager,
    tree,
    bindings,
    runner,
    redisRunner,
    natsConsoles,
    vscode.window.createTreeView('dbclient.connections', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.window.registerWebviewViewProvider(RESULTS_VIEW_ID, results, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerCompletionItemProvider(sqlDocs, new SqlCompletionProvider(manager, bindings), '.', ' '),
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
  command('dbclient.cancelQuery', () => runner.cancel(vscode.window.activeTextEditor));

  return { store, manager, tree, bindings };
}

export function deactivate(): void {
  // Disposables registered in activate() close every open session.
}
