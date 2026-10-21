import { TREE_WORDS } from './words';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { DbNode, NodeKind } from '../drivers/types';
import { connectionIcon, DEFAULT_SHAPES, folderIcon, icon, IconName } from '../icons';
import { SqlLocations } from '../connections/sqlLocations';
import { displayPath, isInside, listDir, SqlLocation } from '../store/sqlLocations';
import { t } from '../l10n';

/** Image icons from img/ for the main node kinds; the rest use codicons from ICONS. */
const IMAGES: Partial<Record<NodeKind, IconName>> = {
  database: 'database',
  schema: 'explorer',
  folder: 'explorer',
  table: 'table',
  view: 'results',
  key: 'authentication',
  stream: 'cloud-database',
  info: 'info',
};

const ICONS: Record<NodeKind, string> = {
  database: 'database',
  schema: 'symbol-namespace',
  folder: 'folder',
  table: 'table',
  view: 'eye',
  function: 'symbol-function',
  procedure: 'symbol-method',
  index: 'list-ordered',
  column: 'symbol-field',
  trigger: 'zap',
  sequence: 'symbol-number',
  package: 'package',
  key: 'key',
  stream: 'pulse',
  consumer: 'person',
  subscription: 'broadcast',
  info: 'info',
};

/**
 * Id prefix of a connection's items. `session` grows with each disconnect: new ids make VS Code
 * forget the expanded state, so a disconnected connection shows collapsed.
 */
const connectionKey = (connectionId: string, session: number) => `conn:${connectionId}${session ? `#${session}` : ''}`;

export class ConnectionItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    manager: ConnectionManager,
    session = 0,
  ) {
    const config = manager.config(connectionId);
    const factory = manager.factoryOf(config);
    const connected = manager.isConnected(connectionId);
    super(config.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = connectionKey(connectionId, session);
    const o = config.options;
    const target = o.file ? path.basename(String(o.file)) : o.servers ? String(o.servers) : o.jdbcUrl ? String(o.jdbcUrl).replace(/^jdbc:oracle:\w+:@?/i, '') : o.host ? `${o.host}${o.port ? `:${o.port}` : ''}` : '';
    this.description = [factory.label, target].filter(Boolean).join(' · ');
    this.tooltip = `${config.name}\n${factory.label} · ${o.file ?? o.servers ?? `${target}${o.database ? `/${o.database}` : ''}`}`;
    this.iconPath = connectionIcon(config.icon, config.color, connected, DEFAULT_SHAPES[factory.category]);
    if (connected) {
      this.description = `● ${this.description}`;
    }
    this.contextValue = `connection ${factory.category} ${connected ? 'connected' : 'disconnected'}`;
  }
}

const treeWords = new Set(TREE_WORDS);
const translated = (text: string | undefined) => (text && treeWords.has(text) ? t(text) : text);

export class NodeItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly node: DbNode,
    category: string,
    dialect = '',
    session = 0,
  ) {
    super(
      translated(node.label)!,
      node.expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `${connectionKey(connectionId, session)}:${node.path}`;
    this.description = translated(node.description);
    this.tooltip = node.tooltip;
    const image = IMAGES[node.kind];
    this.iconPath = image ? icon(image) : new vscode.ThemeIcon(ICONS[node.kind]);
    // `<kind> <category> <dialect>`: menus match kinds and categories, drops also the engine.
    this.contextValue = `${node.kind} ${category}${dialect ? ` ${dialect}` : ''}`;
    if (node.kind === 'key') {
      this.command = { command: 'dbclient.openValue', title: t('Open Value'), arguments: [this] };
    }
  }
}

/** A user folder that groups connections (not to be confused with a driver's `folder` nodes). */
export class FolderItem extends vscode.TreeItem {
  constructor(
    readonly folderId: string,
    name: string,
    count: number,
    color?: string,
  ) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${folderId}`;
    this.iconPath = folderIcon(color);
    this.description = count ? String(count) : undefined;
    this.contextValue = 'connectionFolder';
  }
}

/** The "SQL" node of a SQL connection: its saved files, or one child per location when folders are linked. */
export class SqlFolderItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    description: string,
  ) {
    super('SQL', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `sqlfiles:${connectionId}`;
    this.iconPath = icon('sql-file');
    this.description = description;
    this.tooltip = t('SQL files of this connection');
    this.contextValue = 'sqlFolder';
  }
}

/** One location of a connection's SQL files: its internal folder, a linked folder or the save location. */
export class SqlLocationItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly location: SqlLocation,
    display: string,
  ) {
    const missing = !location.path;
    super(location.kind === 'internal' ? t('Saved') : location.label, missing ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `sqlloc:${connectionId}:${location.kind}:${location.raw ?? ''}`;
    const notes = [location.isSave ? t('save location') : undefined, missing ? t('needs an open workspace') : undefined];
    this.description = [location.kind === 'internal' ? undefined : display, ...notes].filter(Boolean).join(' · ');
    this.tooltip = location.path ?? location.raw;
    this.iconPath = missing ? new vscode.ThemeIcon('warning') : location.isSave ? icon('import') : icon('explorer');
    this.contextValue = `sqlLocation ${location.kind}${location.isSave ? ' save' : ''}${missing ? ' missing' : ''}`;
  }

  get dir(): string | undefined {
    return this.location.path;
  }
}

/** A subfolder inside a SQL location. */
export class SqlDirItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly dir: string,
    name: string,
  ) {
    super(name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `sqldir:${connectionId}:${dir}`;
    this.resourceUri = vscode.Uri.file(dir);
    this.iconPath = vscode.ThemeIcon.Folder;
    this.contextValue = 'sqlDir';
  }
}

/** The "SQL" node of a database: SQL files that run against that database of the connection. */
export class DatabaseSqlItem extends SqlDirItem {
  constructor(
    connectionId: string,
    readonly database: string,
    dir: string,
    count: number,
  ) {
    super(connectionId, dir, 'SQL');
    this.id = `sqldb:${connectionId}:${database}`;
    this.resourceUri = undefined;
    this.iconPath = icon('sql-file');
    this.description = String(count);
    this.tooltip = t('SQL files of database {0}', database);
  }
}

export class SqlFileItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly file: string,
    name: string,
    private readonly modified: number,
  ) {
    super(name.replace(/\.sql$/i, ''), vscode.TreeItemCollapsibleState.None);
    this.id = `sqlfile:${file}`;
    this.resourceUri = vscode.Uri.file(file);
    this.iconPath = icon('query');
    this.tooltip = file;
    this.command = { command: 'vscode.open', title: t('Open'), arguments: [vscode.Uri.file(file)] };
    this.setDirty(vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.fsPath === file));
  }

  /** Unsaved changes in an open editor show as "● unsaved" and enable the inline Save button. */
  setDirty(dirty: boolean): void {
    this.description = dirty ? `● ${t('unsaved')}` : new Date(this.modified).toLocaleString();
    this.contextValue = dirty ? 'sqlFile dirty' : 'sqlFile';
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string, icon = 'warning') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = message;
  }
}

export type TreeNode =
  | ConnectionItem
  | NodeItem
  | FolderItem
  | SqlFolderItem
  | SqlLocationItem
  | SqlDirItem
  | SqlFileItem
  | MessageItem;

const DRAG_MIME = 'application/vnd.code.tree.dbclient.connections';

/** Drag connections and folders onto a folder (or a connection inside it, or empty space for the top level). */
export class ConnectionsDragAndDrop implements vscode.TreeDragAndDropController<TreeNode> {
  readonly dragMimeTypes = [DRAG_MIME];
  readonly dropMimeTypes = [DRAG_MIME];

  constructor(private readonly manager: ConnectionManager) {}

  handleDrag(source: readonly TreeNode[], data: vscode.DataTransfer): void {
    const items = source
      .map((s) => (s instanceof FolderItem ? { folder: s.folderId } : s instanceof ConnectionItem ? { connection: s.connectionId } : undefined))
      .filter(Boolean);
    if (items.length) {
      data.set(DRAG_MIME, new vscode.DataTransferItem(items));
    }
  }

  async handleDrop(target: TreeNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const items = data.get(DRAG_MIME)?.value as { folder?: string; connection?: string }[] | undefined;
    if (!items?.length) {
      return;
    }
    let folderId: string | undefined;
    if (target instanceof FolderItem) {
      folderId = target.folderId;
    } else if (target instanceof ConnectionItem) {
      folderId = this.manager.store.get(target.connectionId)?.folderId;
    } else if (target) {
      // Nodes inside a connection are not drop targets.
      return;
    }
    const store = this.manager.store;
    try {
      for (const item of items) {
        if (item.folder) {
          store.moveFolder(item.folder, folderId);
        } else if (item.connection) {
          store.moveConnection(item.connection, folderId);
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  }
}

export class ConnectionsTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private readonly roots = new Map<string, ConnectionItem>();
  private readonly sqlFolders = new Map<string, SqlFolderItem>();
  /** SQL nodes of databases by connection, refreshed when that connection's files change. */
  private readonly databaseFolders = new Map<string, Map<string, DatabaseSqlItem>>();
  /** Disconnects per connection, part of its items' ids (see `connectionKey`). */
  private readonly sessions = new Map<string, number>();
  /** File items last shown, by path, to flip their unsaved mark. */
  private readonly fileItems = new Map<string, SqlFileItem>();

  constructor(
    private readonly manager: ConnectionManager,
    private readonly sqlLocations: SqlLocations,
  ) {
    this.subscriptions = [
      // Only the SQL node of the affected connections (its summary is on the node itself).
      sqlLocations.onDidChange((ids) => {
        if (!ids) {
          this.refresh();
          return;
        }
        for (const id of ids) {
          const folder = this.sqlFolders.get(id);
          if (folder && this.manager.store.get(id)) {
            folder.description = this.sqlSummary(id);
            this.changed.fire(folder);
          }
          for (const item of this.databaseFolders.get(id)?.values() ?? []) {
            item.description = String(listDir(item.dir).files.length);
            this.changed.fire(item);
          }
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => this.markDirty(e.document)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.markDirty(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.markDirty(doc)),
      manager.store.onDidChange(() => this.refresh()),
      // Re-rendering the root keeps item ids, so expanded state survives connecting; a disconnect
      // gives that connection's items new ids, so its detail collapses.
      manager.onDidChangeState((id) => {
        if (!manager.isConnected(id)) {
          this.sessions.set(id, (this.sessions.get(id) ?? 0) + 1);
        }
        this.refresh();
      }),
      // Only that connection's subtree, so other connections are not re-queried.
      manager.onDidChangeContent((id) => {
        const item = this.roots.get(id);
        this.changed.fire(item);
      }),
    ];
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** Re-reads one node (and its expanded descendants) from the database. */
  refreshItem(item: ConnectionItem | NodeItem): void {
    this.changed.fire(item instanceof ConnectionItem ? (this.roots.get(item.connectionId) ?? item) : item);
  }

  private markDirty(doc: vscode.TextDocument): void {
    const item = doc.uri.scheme === 'file' ? this.fileItems.get(doc.uri.fsPath) : undefined;
    const dirty = doc.isDirty && !doc.isClosed;
    if (item && item.contextValue !== (dirty ? 'sqlFile dirty' : 'sqlFile')) {
      item.setDirty(dirty);
      this.changed.fire(item);
    }
  }

  private sqlSummary(connectionId: string): string {
    const locations = this.sqlLocations.of(connectionId);
    return locations.length === 1
      ? String(listDir(locations[0].path!).files.length)
      : t('{0} locations', locations.length);
  }

  /** Subfolders and .sql files of a folder in a SQL location. */
  private sqlEntries(connectionId: string, dir: string): TreeNode[] {
    const listing = listDir(dir);
    if (listing.missing) {
      // The internal folder (and each database folder) is only created with its first file.
      return isInside(dir, this.sqlLocations.files.dir(connectionId))
        ? [new MessageItem(t('No SQL files yet'), 'circle-slash')]
        : [new MessageItem(t('Folder not found: {0}', dir))];
    }
    const nodes: TreeNode[] = [
      ...listing.folders.map((f) => new SqlDirItem(connectionId, f.path, f.name)),
      ...listing.files.map((f) => {
        const item = new SqlFileItem(connectionId, f.path, f.name, f.modified);
        this.fileItems.set(f.path, item);
        return item;
      }),
    ];
    if (listing.truncated) {
      nodes.push(new MessageItem(t('Showing the first {0} entries', nodes.length), 'info'));
    }
    return nodes.length ? nodes : [new MessageItem(t('No SQL files yet'), 'circle-slash')];
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element || element instanceof FolderItem) {
      const store = this.manager.store;
      const { folders, connections } = store.childrenOf(element?.folderId);
      return [
        ...folders.map((f) => {
          const inside = store.childrenOf(f.id);
          return new FolderItem(f.id, f.name, inside.connections.length + inside.folders.length, f.color);
        }),
        ...connections.map((c) => {
          const item = new ConnectionItem(c.id, this.manager, this.sessions.get(c.id));
          this.roots.set(c.id, item);
          return item;
        }),
      ];
    }
    if (element instanceof MessageItem || element instanceof SqlFileItem) {
      return [];
    }
    if (element instanceof SqlFolderItem) {
      const locations = this.sqlLocations.of(element.connectionId);
      if (locations.length === 1) {
        // Only the internal folder: show its files directly, as before folders could be linked.
        const listing = listDir(locations[0].path!);
        return listing.files.length || listing.folders.length
          ? this.sqlEntries(element.connectionId, locations[0].path!)
          : [new MessageItem(t('No saved SQL files yet'), 'circle-slash')];
      }
      const env = this.sqlLocations.env();
      return locations.map((l) => new SqlLocationItem(element.connectionId, l, l.raw ? displayPath(l.raw, env) : ''));
    }
    if (element instanceof SqlLocationItem || element instanceof SqlDirItem) {
      return element.dir ? this.sqlEntries(element.connectionId, element.dir) : [];
    }
    const id = element.connectionId;
    const factory = this.manager.factoryOf(this.manager.config(id));
    const category = factory.category;
    // SQL connections list their saved files first; they are available even when offline.
    const head: TreeNode[] = [];
    if (element instanceof ConnectionItem && category === 'sql') {
      const folder = new SqlFolderItem(id, this.sqlSummary(id));
      this.sqlFolders.set(id, folder);
      head.push(folder);
    }
    if (element instanceof NodeItem && element.node.kind === 'database' && category === 'sql' && element.node.database) {
      const database = element.node.database;
      const dir = this.sqlLocations.files.databaseDir(id, database);
      const folder = new DatabaseSqlItem(id, database, dir, listDir(dir).files.length);
      const byDatabase = this.databaseFolders.get(id) ?? new Map<string, DatabaseSqlItem>();
      byDatabase.set(database, folder);
      this.databaseFolders.set(id, byDatabase);
      head.push(folder);
    }
    try {
      const driver = await this.manager.connect(id);
      const nodes = await driver.children(element instanceof NodeItem ? element.node : undefined);
      if (!nodes.length) {
        return [...head, new MessageItem(t('(empty)'), 'circle-slash')];
      }
      return [...head, ...nodes.map((n) => new NodeItem(id, n, category, factory.dialect, this.sessions.get(id)))];
    } catch (err) {
      return [...head, new MessageItem((err as Error).message)];
    }
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
