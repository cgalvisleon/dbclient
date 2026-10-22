import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { DocumentBindings } from './bindings';
import { splitStatements } from './statements';
import { t } from '../l10n';

/** What the Run lenses need from the SQL runner. */
export interface RunningQueries {
  readonly onDidChangeRunning: vscode.Event<void>;
  runningAt(doc: vscode.TextDocument): number | undefined;
}

/**
 * "▶ Run" above each statement of SQL editors that are bound to a connection; while a query runs,
 * the statement being executed shows "Running…" and "■ Cancel" instead.
 */
export class RunCodeLens implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  constructor(
    private readonly bindings: DocumentBindings,
    private readonly manager: ConnectionManager,
    private readonly runner: RunningQueries,
  ) {
    const emitter = new vscode.EventEmitter<void>();
    bindings.onDidChange(() => emitter.fire());
    runner.onDidChangeRunning(() => emitter.fire());
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('dbclient.codeLens') && emitter.fire());
    this.onDidChangeCodeLenses = emitter.event;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const binding = this.bindings.get(doc);
    if (!vscode.workspace.getConfiguration('dbclient').get<boolean>('codeLens', true) || !binding || doc.languageId !== 'sql') {
      return [];
    }
    const dialect = this.manager.factoryOf(this.manager.config(binding.connectionId)).dialect;
    const statements = splitStatements(doc.getText(), dialect);
    const running = this.runner.runningAt(doc);
    // The statement holding the running offset (edits during the run may have moved it).
    const current = running === undefined ? undefined : (statements.find((s) => running >= s.start && running < s.terminatorEnd) ?? statements.find((s) => s.start >= running));
    return statements.flatMap((stmt) => {
      const start = doc.positionAt(stmt.start);
      const range = new vscode.Range(start, start);
      if (stmt === current) {
        return [
          new vscode.CodeLens(range, { title: `$(loading~spin) ${t('Running…')}`, command: '' }),
          new vscode.CodeLens(range, {
            title: `$(debug-stop) ${t('Cancel')}`,
            command: 'dbclient.cancelQuery',
            tooltip: t('Stop the running query'),
            arguments: [doc.uri],
          }),
        ];
      }
      return [
        new vscode.CodeLens(range, {
          title: `$(play) ${t('Run')}`,
          command: 'dbclient.runAt',
          arguments: [doc.uri, stmt.start],
        }),
      ];
    });
  }
}

/**
 * First line of SQL and Redis editors: "Connection:" with the editor's connection and database,
 * a drop-down that picks another, then the buttons of the DB Client SQL editor's toolbar (run,
 * connect/disconnect, history, save, copy, paste, export, import) and, last, one that reopens the
 * file in that editor. The commands act on the active editor, which is the one clicked.
 */
export class ConnectionCodeLens implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  constructor(
    private readonly bindings: DocumentBindings,
    manager: ConnectionManager,
    private readonly runner: RunningQueries & { isRunning(doc: vscode.TextDocument): boolean },
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
    const binding = this.bindings.get(doc);
    if (!binding) {
      return [
        new vscode.CodeLens(top, {
          title: `${t('Connection:')} $(database) ${t('Select connection')} $(chevron-down)`,
          command: 'dbclient.selectConnection',
          tooltip: t('Click to choose the connection and database'),
        }),
      ];
    }
    const { label, engine, connected } = this.bindings.describe(binding);
    const sql = doc.languageId === 'sql';
    const button = (icon: string, tooltip: string, command: string, args: unknown[] = []) =>
      new vscode.CodeLens(top, { title: `$(${icon})`, tooltip, command, arguments: args });
    const running = this.runner.isRunning(doc);
    return [
      new vscode.CodeLens(top, {
        title: `${t('Connection:')} $(${connected ? 'database' : 'debug-disconnect'}) ${label} $(chevron-down)`,
        command: 'dbclient.selectConnection',
        tooltip: `${engine} · ${connected ? t('connected') : t('not connected')} · ${t('Click to choose the connection and database')}`,
      }),
      button('run-all', t('Run every statement of the file'), 'dbclient.runFile'),
      button('play', t('Run the statement at the cursor'), 'dbclient.runStatement'),
      button('list-selection', t('Run the selected statements'), 'dbclient.runSelection'),
      ...(running ? [button('debug-stop', t('Stop the running query'), 'dbclient.cancelQuery', [doc.uri])] : []),
      connected ? button('debug-disconnect', t('Disconnect'), 'dbclient.disconnect', [doc.uri]) : button('plug', t('Connect'), 'dbclient.connect', [doc.uri]),
      button('history', t('Query History…'), 'dbclient.showHistory'),
      ...(sql ? [button('save', t('Save in the SQL folder of the connection'), 'dbclient.saveToSqlFolder', [doc.uri])] : []),
      button('copy', t('Copy the selection, or the whole file when nothing is selected'), 'dbclient.copyQuery'),
      button('clippy', t('Paste at the cursor'), 'dbclient.pasteQuery'),
      button('export', t('Save the content to a file of your choice'), 'dbclient.exportQuery'),
      button('go-to-file', t('Insert a file at the cursor'), 'dbclient.importQuery'),
      ...(sql ? [button('layout-panel', t('Open in the DB Client SQL editor'), 'dbclient.openSqlEditor', [doc.uri])] : []),
    ];
  }
}
