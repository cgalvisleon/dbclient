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
        title: `$(play) ${vscode.l10n.t('Run')}`,
        command: 'dbclient.runAt',
        arguments: [doc.uri, stmt.start],
      });
    });
  }
}

/** First line of SQL and Redis editors: the connection the editor runs against, and a way to change it. */
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
      return [new vscode.CodeLens(top, { title: `$(database) ${vscode.l10n.t('Select connection')}`, command: 'dbclient.selectConnection' })];
    }
    const { label, engine, connected } = this.bindings.describe(binding);
    return [
      new vscode.CodeLens(top, {
        title: `$(${connected ? 'database' : 'debug-disconnect'}) ${label}`,
        tooltip: `${engine} · ${connected ? vscode.l10n.t('connected') : vscode.l10n.t('not connected')}`,
        command: 'dbclient.selectConnection',
      }),
      new vscode.CodeLens(top, { title: vscode.l10n.t('Change Connection…'), command: 'dbclient.selectConnection' }),
    ];
  }
}
