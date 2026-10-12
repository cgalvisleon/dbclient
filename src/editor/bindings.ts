import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';

export interface Binding {
  connectionId: string;
  /** Database to run against; the connection's default when omitted. */
  database?: string;
}

const STATE_KEY = 'dbclient.bindings';

/**
 * Which connection each SQL document runs against. Saved files keep their binding per
 * workspace; untitled documents only for the session. Shown and changed via the status bar.
 */
export class DocumentBindings implements vscode.Disposable {
  private readonly bindings: Map<string, Binding>;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly status: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly state: vscode.Memento,
    private readonly manager: ConnectionManager,
  ) {
    this.bindings = new Map(Object.entries(state.get<Record<string, Binding>>(STATE_KEY, {})));
    this.status = vscode.window.createStatusBarItem('dbclient.connection', vscode.StatusBarAlignment.Left, 100);
    this.status.name = 'DB Client Connection';
    this.status.command = 'dbclient.selectConnection';
    this.subscriptions.push(
      this.status,
      this.changed,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.isUntitled) {
          this.bindings.delete(doc.uri.toString());
        }
      }),
      manager.store.onDidChange(() => this.prune()),
      manager.onDidChangeState(() => this.updateStatus()),
    );
    this.updateStatus();
  }

  get(doc: vscode.TextDocument): Binding | undefined {
    const binding = this.bindings.get(doc.uri.toString());
    return binding && this.manager.store.get(binding.connectionId) ? binding : undefined;
  }

  async set(doc: vscode.TextDocument, binding: Binding): Promise<void> {
    this.bindings.set(doc.uri.toString(), binding);
    await this.save();
    this.changed.fire(doc.uri);
    this.updateStatus();
  }

  /** Asks the user for a SQL connection (and database) and binds `doc` to it. */
  async pick(doc: vscode.TextDocument): Promise<Binding | undefined> {
    const current = this.get(doc);
    const items = this.manager.store
      .list()
      .filter((c) => this.manager.factoryOf(c).category === 'sql')
      .map((c) => ({
        label: c.name,
        description: [this.manager.factoryOf(c).label, c.options.database].filter(Boolean).join(' · '),
        detail: c.id === current?.connectionId ? vscode.l10n.t('current') : undefined,
        id: c.id,
      }));
    if (!items.length) {
      const add = vscode.l10n.t('Add Connection');
      if ((await vscode.window.showInformationMessage(vscode.l10n.t('There are no SQL connections yet.'), add)) === add) {
        await vscode.commands.executeCommand('dbclient.addConnection');
      }
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Connection for this editor') });
    if (!picked) {
      return undefined;
    }
    const binding: Binding = { connectionId: picked.id };
    await this.set(doc, binding);
    return binding;
  }

  private async prune(): Promise<void> {
    let removed = false;
    for (const [uri, binding] of this.bindings) {
      if (!this.manager.store.get(binding.connectionId)) {
        this.bindings.delete(uri);
        removed = true;
      }
    }
    if (removed) {
      await this.save();
    }
    this.updateStatus();
  }

  private save(): Thenable<void> {
    const persistent = [...this.bindings].filter(([uri]) => !uri.startsWith('untitled:'));
    return this.state.update(STATE_KEY, Object.fromEntries(persistent));
  }

  private updateStatus(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'sql') {
      this.status.hide();
      return;
    }
    const binding = this.get(doc);
    if (!binding) {
      this.status.text = `$(database) ${vscode.l10n.t('Select connection')}`;
      this.status.tooltip = vscode.l10n.t('Choose the connection this SQL editor runs against');
    } else {
      const config = this.manager.config(binding.connectionId);
      const db = binding.database ?? config.options.database;
      const connected = this.manager.isConnected(binding.connectionId);
      this.status.text = `$(${connected ? 'database' : 'debug-disconnect'}) ${config.name}${db ? ` / ${db}` : ''}`;
      this.status.tooltip = vscode.l10n.t('Connection for this editor (click to change)');
    }
    this.status.show();
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
  }
}
