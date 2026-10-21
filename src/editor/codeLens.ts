import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { DocumentBindings } from './bindings';
import { splitStatements } from './statements';
import { t } from '../l10n';

/** "▶ Run" above each statement of SQL editors that are bound to a connection. */
export class RunCodeLens implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  constructor(
    private readonly bindings: DocumentBindings,
    private readonly manager: ConnectionManager,
  ) {
    const emitter = new vscode.EventEmitter<void>();
    bindings.onDidChange(() => emitter.fire());
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('dbclient.codeLens') && emitter.fire());
    this.onDidChangeCodeLenses = emitter.event;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const binding = this.bindings.get(doc);
    if (!vscode.workspace.getConfiguration('dbclient').get<boolean>('codeLens', true) || !binding || doc.languageId !== 'sql') {
      return [];
    }
    const dialect = this.manager.factoryOf(this.manager.config(binding.connectionId)).dialect;
    return splitStatements(doc.getText(), dialect).map((stmt) => {
      const start = doc.positionAt(stmt.start);
      return new vscode.CodeLens(new vscode.Range(start, start), {
        title: `$(play) ${t('Run')}`,
        command: 'dbclient.runAt',
        arguments: [doc.uri, stmt.start],
      });
    });
  }
}

/**
 * First line of SQL and Redis editors: "Connection:" with the editor's connection and database,
 * a drop-down that picks another. The actions live in the editor title bar and its `…` menu.
 */
export class ConnectionCodeLens implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  constructor(
    private readonly bindings: DocumentBindings,
    manager: ConnectionManager,
  ) {
    const emitter = new vscode.EventEmitter<void>();
    bindings.onDidChange(() => emitter.fire());
    manager.onDidChangeState(() => emitter.fire());
    manager.store.onDidChange(() => emitter.fire());
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
    return [
      new vscode.CodeLens(top, {
        title: `${t('Connection:')} $(${connected ? 'database' : 'debug-disconnect'}) ${label} $(chevron-down)`,
        command: 'dbclient.selectConnection',
        tooltip: `${engine} · ${connected ? t('connected') : t('not connected')} · ${t('Click to choose the connection and database')}`,
      }),
    ];
  }
}
