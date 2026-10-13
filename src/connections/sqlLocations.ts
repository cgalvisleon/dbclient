import * as os from 'os';
import * as vscode from 'vscode';
import { FolderWatcher, SqlFileStore } from '../store/sqlFiles';
import { isInside, locationsOf, ownersOf, PathEnv, saveDirOf, SqlLocation } from '../store/sqlLocations';
import { ConnectionManager } from './manager';

/** Resolves and watches the .sql locations of every SQL connection. */
export class SqlLocations implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<string[] | undefined>();
  /** Connection ids whose SQL files changed; undefined means "refresh all". */
  readonly onDidChange = this.changed.event;
  private readonly watcher: FolderWatcher;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly manager: ConnectionManager,
    readonly files: SqlFileStore,
  ) {
    this.watcher = new FolderWatcher((root) => this.changed.fire(this.connectionsUsing(root)));
    this.subscriptions = [
      manager.store.onDidChange(() => this.rewatch()),
      files.onDidChange((id) => this.changed.fire(id ? [id] : undefined)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rewatch();
        this.changed.fire(undefined);
      }),
    ];
    this.rewatch();
  }

  env(): PathEnv {
    return { home: os.homedir(), workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath };
  }

  private sqlConnections() {
    return this.manager.store.list().filter((c) => this.manager.factoryOf(c).category === 'sql');
  }

  of(connectionId: string): SqlLocation[] {
    return locationsOf(this.manager.config(connectionId), this.files.dir(connectionId), this.env());
  }

  saveDir(connectionId: string): string {
    return saveDirOf(this.manager.config(connectionId), this.files.dir(connectionId), this.env());
  }

  /** Connections a file belongs to by location (most specific wins; several ids = tie). */
  owners(file: string): string[] {
    const roots = this.sqlConnections().flatMap((c) =>
      this.of(c.id)
        .filter((l) => l.path)
        .map((l) => ({ connectionId: c.id, root: l.path! })),
    );
    return ownersOf(file, roots);
  }

  private connectionsUsing(root: string): string[] {
    return this.sqlConnections()
      .filter((c) => this.of(c.id).some((l) => l.path && (isInside(l.path, root) || isInside(root, l.path))))
      .map((c) => c.id);
  }

  private rewatch(): void {
    const roots = this.sqlConnections().flatMap((c) =>
      this.of(c.id)
        .filter((l) => l.kind !== 'internal' && l.path)
        .map((l) => l.path!),
    );
    this.watcher.update(roots);
  }

  dispose(): void {
    this.watcher.dispose();
    this.subscriptions.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
