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
 * First line of SQL and Redis editors: the connection the editor runs against, a way to change
 * it, and a small toolbar (run all / statement / selection, copy, paste, export, import).
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
    const lens = (title: string, command: string, tooltip?: string) => new vscode.CodeLens(top, { title, command, tooltip });
    const toolbar = [
      lens(`$(run-all) ${vscode.l10n.t('Run All')}`, 'dbclient.runFile', vscode.l10n.t('Run every statement of the file')),
      lens(`$(play) ${vscode.l10n.t('Statement')}`, 'dbclient.runStatement', vscode.l10n.t('Run the statement at the cursor')),
      lens(`$(list-selection) ${vscode.l10n.t('Selection')}`, 'dbclient.runSelection', vscode.l10n.t('Run the selected statements')),
      lens(`$(copy) ${vscode.l10n.t('Copy')}`, 'dbclient.copyQuery', vscode.l10n.t('Copy the selection, or the whole file when nothing is selected')),
      lens(`$(clippy) ${vscode.l10n.t('Paste')}`, 'dbclient.pasteQuery', vscode.l10n.t('Paste at the cursor')),
      lens(`$(export) ${vscode.l10n.t('Export')}`, 'dbclient.exportQuery', vscode.l10n.t('Save the content to a file of your choice')),
      lens(`$(go-to-file) ${vscode.l10n.t('Import')}`, 'dbclient.importQuery', vscode.l10n.t('Insert a file at the cursor')),
    ];
    const binding = this.bindings.get(doc);
    if (!binding) {
      return [lens(`$(database) ${vscode.l10n.t('Select connection')} $(chevron-down)`, 'dbclient.selectConnection'), ...toolbar];
    }
    const { label, engine, connected } = this.bindings.describe(binding);
    return [
      lens(
        `$(${connected ? 'database' : 'debug-disconnect'}) ${label} $(chevron-down)`,
        'dbclient.selectConnection',
        `${engine} · ${connected ? vscode.l10n.t('connected') : vscode.l10n.t('not connected')} · ${vscode.l10n.t('Click to choose the connection and database')}`,
      ),
      lens(vscode.l10n.t('Change Connection…'), 'dbclient.selectConnection'),
      ...toolbar,
    ];
  }
}
