import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { DriverCategory } from '../drivers/types';
import { t } from '../l10n';

export interface Binding {
  connectionId: string;
  /** Database to run against; the connection's default when omitted. */
  database?: string;
}

const STATE_KEY = 'dbclient.bindings';

/** Editor languages that run against a connection, and the driver category each one needs. */
export const EDITOR_CATEGORIES: Record<string, DriverCategory> = { sql: 'sql', redis: 'kv' };

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
    /** Connections implied by where a file is saved (SQL locations); several ids mean a tie. */
    private readonly impliedConnections: (uri: vscode.Uri) => string[] = () => [],
    /** Database implied by where a file is saved (a database's SQL folder). */
    private readonly impliedDatabase: (uri: vscode.Uri, connectionId: string) => string | undefined = () => undefined,
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
    let binding = this.bindings.get(doc.uri.toString());
    if (!binding && doc.uri.scheme === 'file') {
      const implied = this.impliedConnections(doc.uri);
      // A tie (folder linked to several connections) is resolved once with pick() and remembered.
      binding = implied.length === 1 ? { connectionId: implied[0], database: this.impliedDatabase(doc.uri, implied[0]) } : undefined;
    }
    const config = binding && this.manager.store.get(binding.connectionId);
    // A binding only counts when the connection still exists and suits the editor's language.
    return config && this.manager.factoryOf(config).category === EDITOR_CATEGORIES[doc.languageId] ? binding : undefined;
  }

  async set(doc: vscode.TextDocument, binding: Binding): Promise<void> {
    this.bindings.set(doc.uri.toString(), binding);
    await this.save();
    this.changed.fire(doc.uri);
    this.updateStatus();
  }

  /** Asks the user for a connection suited to the editor's language and binds `doc` to it. */
  async pick(doc: vscode.TextDocument): Promise<Binding | undefined> {
    const current = this.get(doc);
    const category = EDITOR_CATEGORIES[doc.languageId];
    const tie = doc.uri.scheme === 'file' ? this.impliedConnections(doc.uri) : [];
    const items = this.manager.store
      .list()
      .filter((c) => this.manager.factoryOf(c).category === category && (tie.length < 2 || tie.includes(c.id)))
      .map((c) => ({
        label: c.name,
        description: [this.manager.factoryOf(c).label, c.options.database ?? c.options.host ?? c.options.jdbcUrl].filter(Boolean).join(' · '),
        detail: c.id === current?.connectionId ? t('current') : undefined,
        id: c.id,
      }));
    if (!items.length) {
      const add = t('Add Connection');
      const message = category === 'kv' ? t('There are no Redis connections yet.') : t('There are no SQL connections yet.');
      if ((await vscode.window.showInformationMessage(message, add)) === add) {
        await vscode.commands.executeCommand('dbclient.addConnection');
      }
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder:
        tie.length > 1
          ? t('This file is in a folder linked to several connections; choose one (it is remembered)')
          : t('Connection for this editor'),
    });
    if (!picked) {
      return undefined;
    }
    // Picking the same SQL connection again keeps the database it was opened on.
    const binding: Binding = { connectionId: picked.id, database: category === 'sql' && current?.connectionId === picked.id ? current.database : undefined };
    if (category === 'sql') {
      const databases = await this.databasesOf(picked.id);
      if (databases.length > 1) {
        const config = this.manager.config(picked.id);
        const selected = binding.database ?? config.options.database;
        const inUse = current?.connectionId === picked.id ? selected : undefined;
        const items = databases.map((name) => ({
          label: name,
          description: [name === config.options.database ? t('default') : undefined, name === inUse ? t('current') : undefined].filter(Boolean).join(' · '),
        }));
        const quick = vscode.window.createQuickPick<(typeof items)[number]>();
        quick.items = items;
        quick.placeholder = t('Database of {0} for this editor', config.name);
        quick.activeItems = items.filter((i) => i.label === selected);
        const db = await new Promise<string | undefined>((resolve) => {
          quick.onDidAccept(() => resolve(quick.selectedItems[0]?.label));
          quick.onDidHide(() => resolve(undefined));
          quick.show();
        });
        quick.dispose();
        if (db === undefined) {
          return undefined;
        }
        // The connection's own database stays implicit, so editing the connection later still applies.
        binding.database = db === config.options.database ? undefined : db;
      }
    }
    if (category === 'kv') {
      const config = this.manager.config(picked.id);
      const dbs = Array.from({ length: 16 }, (_, i) => ({ label: `db${i}`, db: String(i), picked: i === Number(config.options.db ?? 0) }));
      const db = await vscode.window.showQuickPick(dbs, { placeHolder: t('Redis database') });
      if (!db) {
        return undefined;
      }
      binding.database = db.db;
    }
    if (current && current.connectionId === binding.connectionId && current.database === binding.database) {
      return current;
    }
    if (current) {
      const from = this.describe(current).label;
      const to = this.describe(binding).label;
      const change = t('Change Connection');
      const answer = await vscode.window.showWarningMessage(
        t('Change the connection of this editor from {0} to {1}?', from, to),
        { modal: true, detail: t('From now on its statements run against {0}.', to) },
        change,
      );
      if (answer !== change) {
        return current;
      }
    }
    await this.set(doc, binding);
    vscode.window.setStatusBarMessage(t('This editor now runs against {0}.', this.describe(binding).label), 4000);
    return binding;
  }

  /** Databases of an open SQL connection (its top-level `database` nodes); empty when closed or single-database. */
  async openDatabases(connectionId: string): Promise<string[]> {
    if (!this.manager.isConnected(connectionId)) {
      return [];
    }
    try {
      const driver = await this.manager.connect(connectionId);
      return (await driver.children()).filter((n) => n.kind === 'database' && n.database).map((n) => n.database!);
    } catch {
      return [];
    }
  }

  /** Databases of a SQL connection from its top-level tree nodes; empty when offline or single-database. */
  private async databasesOf(connectionId: string): Promise<string[]> {
    try {
      const driver = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t('Connecting to {0}…', this.manager.config(connectionId).name) },
        () => this.manager.connect(connectionId),
      );
      return (await driver.children()).filter((n) => n.kind === 'database' && n.database).map((n) => n.database!);
    } catch {
      return [];
    }
  }

  /** "connection / database" for a binding, the engine and whether the connection is open. */
  describe(binding: Binding): { label: string; engine: string; connected: boolean } {
    const config = this.manager.config(binding.connectionId);
    const db = config.type === 'redis' ? `db${binding.database ?? config.options.db ?? 0}` : (binding.database ?? config.options.database);
    return {
      label: `${config.name}${db ? ` / ${db}` : ''}`,
      engine: this.manager.factoryOf(config).label,
      connected: this.manager.isConnected(binding.connectionId),
    };
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
    if (!doc || !EDITOR_CATEGORIES[doc.languageId]) {
      this.status.hide();
      return;
    }
    const binding = this.get(doc);
    if (!binding) {
      this.status.text = `$(database) ${t('Select connection')}`;
      this.status.tooltip = t('Choose the connection this SQL editor runs against');
    } else {
      const { label, engine, connected } = this.describe(binding);
      this.status.text = `$(${connected ? 'database' : 'debug-disconnect'}) ${label}`;
      this.status.tooltip = t('Connection for this editor: {0} ({1}, {2}). Click to change.', label, engine, connected ? t('connected') : t('not connected'));
    }
    this.status.show();
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
  }
}
