import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { DbNode, DriverCategory, NodeKind } from '../drivers/types';
import { icon, IconName } from '../icons';

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

const CONNECTION_IMAGES: Record<DriverCategory, [IconName, IconName]> = {
  sql: ['database', 'database-connect'],
  kv: ['server', 'server-connect'],
  pubsub: ['cloud-database', 'cloud-database'],
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

export class ConnectionItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    manager: ConnectionManager,
  ) {
    const config = manager.config(connectionId);
    const factory = manager.factoryOf(config);
    const connected = manager.isConnected(connectionId);
    super(config.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `conn:${connectionId}`;
    const o = config.options;
    const target = o.file ? path.basename(String(o.file)) : o.servers ? String(o.servers) : o.host ? `${o.host}${o.port ? `:${o.port}` : ''}` : '';
    this.description = [factory.label, target].filter(Boolean).join(' · ');
    this.tooltip = `${config.name}\n${factory.label} · ${o.file ?? o.servers ?? `${target}${o.database ? `/${o.database}` : ''}`}`;
    this.iconPath = icon(CONNECTION_IMAGES[factory.category][connected ? 1 : 0]);
    if (connected) {
      this.description = `● ${this.description}`;
    }
    this.contextValue = `connection ${factory.category} ${connected ? 'connected' : 'disconnected'}`;
  }
}

export class NodeItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly node: DbNode,
    category: string,
  ) {
    super(
      node.label,
      node.expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `conn:${connectionId}:${node.path}`;
    this.description = node.description;
    this.tooltip = node.tooltip;
    const image = IMAGES[node.kind];
    this.iconPath = image ? icon(image) : new vscode.ThemeIcon(ICONS[node.kind]);
    this.contextValue = `${node.kind} ${category}`;
    if (node.kind === 'key') {
      this.command = { command: 'dbclient.openValue', title: vscode.l10n.t('Open Value'), arguments: [this] };
    }
  }
}

/** A user folder that groups connections (not to be confused with a driver's `folder` nodes). */
export class FolderItem extends vscode.TreeItem {
  constructor(
    readonly folderId: string,
    name: string,
    count: number,
  ) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${folderId}`;
    this.iconPath = icon('explorer');
    this.description = count ? String(count) : undefined;
    this.contextValue = 'connectionFolder';
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string, icon = 'warning') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = message;
  }
}

export type TreeNode = ConnectionItem | NodeItem | FolderItem | MessageItem;

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

  constructor(private readonly manager: ConnectionManager) {
    this.subscriptions = [
      manager.store.onDidChange(() => this.refresh()),
      // Re-rendering the root keeps item ids, so expanded state survives connect/disconnect.
      manager.onDidChangeState(() => this.refresh()),
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
          return new FolderItem(f.id, f.name, inside.connections.length + inside.folders.length);
        }),
        ...connections.map((c) => {
          const item = new ConnectionItem(c.id, this.manager);
          this.roots.set(c.id, item);
          return item;
        }),
      ];
    }
    if (element instanceof MessageItem) {
      return [];
    }
    const id = element.connectionId;
    try {
      const category = this.manager.factoryOf(this.manager.config(id)).category;
      const driver = await this.manager.connect(id);
      const nodes = await driver.children(element instanceof NodeItem ? element.node : undefined);
      if (!nodes.length) {
        return [new MessageItem(vscode.l10n.t('(empty)'), 'circle-slash')];
      }
      return nodes.map((n) => new NodeItem(id, n, category));
    } catch (err) {
      return [new MessageItem((err as Error).message)];
    }
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
