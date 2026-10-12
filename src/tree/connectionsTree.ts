import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { DbNode, NodeKind } from '../drivers/types';

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
    this.description = [factory.label, o.host && `${o.host}${o.port ? `:${o.port}` : ''}`].filter(Boolean).join(' · ');
    this.tooltip = `${config.name}\n${this.description}${o.database ? `/${o.database}` : ''}`;
    this.iconPath = new vscode.ThemeIcon('database', connected ? new vscode.ThemeColor('charts.green') : undefined);
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
    this.iconPath = new vscode.ThemeIcon(ICONS[node.kind]);
    this.contextValue = `${node.kind} ${category}`;
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string, icon = 'warning') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = message;
  }
}

export type TreeNode = ConnectionItem | NodeItem | MessageItem;

export class ConnectionsTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly manager: ConnectionManager) {
    this.subscriptions = [
      manager.store.onDidChange(() => this.refresh()),
      // Re-rendering the root keeps item ids, so expanded state survives connect/disconnect.
      manager.onDidChangeState(() => this.refresh()),
    ];
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return this.manager.store.list().map((c) => new ConnectionItem(c.id, this.manager));
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
