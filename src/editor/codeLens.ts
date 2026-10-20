import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { DocumentBindings } from './bindings';
import { splitStatements } from './statements';

/** "▶ Run" above each statement of SQL editors that are bound to a connection. */
export class RunCodeLens implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  constructor(
    private readonly bindings: DocumentBindings,
    private readonly manager: ConnectionManager,
  ) {
    const emitter = new vscode.EventEmitter<void>();
    bindings.onDidChange(() => emitter.fire());
    vscode.workspace.onDidChangeConfiguration((e) => (e.affectsConfiguration('dbclient.codeLens') || e.affectsConfiguration('dbclient.connectionLens')) && emitter.fire());
    this.onDidChangeCodeLenses = emitter.event;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const binding = this.bindings.get(doc);
    if (!vscode.workspace.getConfiguration('dbclient').get<boolean>('codeLens', true) || !binding || doc.languageId !== 'sql') {
      return [];
    }
    const dialect = this.manager.factoryOf(this.manager.config(binding.connectionId)).dialect;
    // Line 0 holds the toolbar when it is shown; its Statement button covers that statement.
    const toolbar = vscode.workspace.getConfiguration('dbclient').get<boolean>('connectionLens', true);
    return splitStatements(doc.getText(), dialect).filter((stmt) => !toolbar || doc.positionAt(stmt.start).line > 0).map((stmt) => {
      const start = doc.positionAt(stmt.start);
      return new vscode.CodeLens(new vscode.Range(start, start), {
        title: `$(play) ${vscode.l10n.t('Run')}`,
        command: 'dbclient.runAt',
        arguments: [doc.uri, stmt.start],
      });
    });
  }
}

/**
 * First line of SQL and Redis editors, NetBeans style: "Connection:" with the editor's connection
 * as a drop-down, then icon buttons for every editor action (run all / statement / selection,
 * stop while a query runs, connect or disconnect, history, save, copy, paste, export, import).
 */
export class ConnectionCodeLens implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  constructor(
    private readonly bindings: DocumentBindings,
    manager: ConnectionManager,
    private readonly runner: { isRunning(doc: vscode.TextDocument): boolean; onDidChangeRunning: vscode.Event<void> },
  ) {
    const emitter = new vscode.EventEmitter<void>();
    bindings.onDidChange(() => emitter.fire());
    manager.onDidChangeState(() => emitter.fire());
    manager.store.onDidChange(() => emitter.fire());
    runner.onDidChangeRunning(() => emitter.fire());
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('dbclient.connectionLens') && emitter.fire());
    this.onDidChangeCodeLenses = emitter.event;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('dbclient').get<boolean>('connectionLens', true)) {
      return [];
    }
    const top = new vscode.Range(0, 0, 0, 0);
    const lens = (title: string, command: string, tooltip?: string, args?: unknown[]) => new vscode.CodeLens(top, { title, command, tooltip, arguments: args });
    const sql = doc.languageId === 'sql';
    const binding = this.bindings.get(doc);
    const connection = binding && { connectionId: binding.connectionId };
    const info = binding && this.bindings.describe(binding);

    const selector = info
      ? lens(
          `${vscode.l10n.t('Connection:')} $(${info.connected ? 'database' : 'debug-disconnect'}) ${info.label} $(chevron-down)`,
          'dbclient.selectConnection',
          `${info.engine} · ${info.connected ? vscode.l10n.t('connected') : vscode.l10n.t('not connected')} · ${vscode.l10n.t('Click to choose the connection and database')}`,
        )
      : lens(`${vscode.l10n.t('Connection:')} $(database) ${vscode.l10n.t('Select connection')} $(chevron-down)`, 'dbclient.selectConnection', vscode.l10n.t('Click to choose the connection and database'));

    const buttons = [
      lens('$(run-all)', 'dbclient.runFile', vscode.l10n.t('Run every statement of the file')),
      lens('$(play)', 'dbclient.runStatement', sql ? vscode.l10n.t('Run the statement at the cursor') : vscode.l10n.t('Run the command at the cursor')),
      lens('$(list-selection)', 'dbclient.runSelection', vscode.l10n.t('Run the selected statements')),
      sql && this.runner.isRunning(doc) && lens('$(debug-stop)', 'dbclient.cancelQuery', vscode.l10n.t('Stop the running query')),
      info &&
        (info.connected
          ? lens('$(debug-disconnect)', 'dbclient.disconnect', vscode.l10n.t('Disconnect'), [connection])
          : lens('$(plug)', 'dbclient.connect', vscode.l10n.t('Connect'), [connection])),
      lens('$(history)', 'dbclient.showHistory', vscode.l10n.t('Query History…'), connection && [connection]),
      sql && lens('$(save)', 'dbclient.saveToSqlFolder', vscode.l10n.t('Save in the SQL folder of the connection')),
      lens('$(copy)', 'dbclient.copyQuery', vscode.l10n.t('Copy the selection, or the whole file when nothing is selected')),
      lens('$(clippy)', 'dbclient.pasteQuery', vscode.l10n.t('Paste at the cursor')),
      lens('$(export)', 'dbclient.exportQuery', vscode.l10n.t('Save the content to a file of your choice')),
      lens('$(go-to-file)', 'dbclient.importQuery', vscode.l10n.t('Insert a file at the cursor')),
    ];
    return [selector, ...buttons.filter((b): b is vscode.CodeLens => !!b)];
  }
}
