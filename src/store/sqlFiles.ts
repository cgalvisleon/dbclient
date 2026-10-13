import * as fs from 'fs';
import * as path from 'path';

export interface SqlFile {
  name: string;
  path: string;
  modified: number;
}

const INVALID = /[\\/:*?"<>|\u0000-\u001f]/g;

/** File-system-safe `.sql` file name from what the user typed. */
export function sqlFileName(name: string): string {
  const clean = name.trim().replace(INVALID, '-').replace(/\.sql$/i, '');
  if (!clean || clean === '.' || clean === '..') {
    throw new Error('Invalid file name');
  }
  return `${clean}.sql`;
}

/**
 * Saved `.sql` files per connection: `<root>/<connectionId>/*.sql`. The folder a file lives in
 * tells which connection it runs against. No vscode imports, so it is unit-testable.
 */
export class SqlFileStore {
  private readonly listeners = new Set<(connectionId: string | undefined) => void>();
  private watcher?: fs.FSWatcher;

  constructor(private root: string) {}

  get location(): string {
    return this.root;
  }

  /** Changes the root (setting changed); listeners get a full refresh. */
  relocate(root: string): void {
    if (path.resolve(root) === path.resolve(this.root)) {
      return;
    }
    this.root = root;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
      this.watch();
    }
    this.emit(undefined);
  }

  dir(connectionId: string): string {
    return path.join(this.root, connectionId);
  }

  onDidChange(listener: (connectionId: string | undefined) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(connectionId: string | undefined): void {
    this.listeners.forEach((l) => l(connectionId));
  }

  list(connectionId: string): SqlFile[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir(connectionId));
    } catch {
      return [];
    }
    return names
      .filter((n) => n.toLowerCase().endsWith('.sql'))
      .map((n) => {
        const file = path.join(this.dir(connectionId), n);
        return { name: n, path: file, modified: fs.statSync(file).mtimeMs };
      })
      // Compare without the extension so "report" sorts before "report 2".
      .sort((a, b) => a.name.slice(0, -4).localeCompare(b.name.slice(0, -4), undefined, { numeric: true }));
  }

  /** Creates a file in the connection's internal folder. */
  create(connectionId: string, name: string, content = ''): string {
    return this.createIn(this.dir(connectionId), name, content);
  }

  /** Creates a file in any folder, adding " 2", " 3"… when the name is taken. Returns its path. */
  createIn(dir: string, name: string, content = ''): string {
    fs.mkdirSync(dir, { recursive: true });
    const base = sqlFileName(name).slice(0, -4);
    let file = path.join(dir, `${base}.sql`);
    for (let n = 2; fs.existsSync(file); n++) {
      file = path.join(dir, `${base} ${n}.sql`);
    }
    fs.writeFileSync(file, content, { flag: 'wx' });
    this.emitFor(file);
    return file;
  }

  /** Next free "query N" name in the connection's internal folder. */
  nextName(connectionId: string): string {
    return this.nextNameIn(this.dir(connectionId));
  }

  /** Next free "query N" name in a folder. */
  nextNameIn(dir: string): string {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      // A folder that does not exist yet has every name free.
    }
    const taken = new Set(names.map((n) => n.toLowerCase()));
    let n = 1;
    while (taken.has(`query ${n}.sql`)) {
      n++;
    }
    return `query ${n}`;
  }

  rename(file: string, name: string): string {
    const target = path.join(path.dirname(file), sqlFileName(name));
    if (target !== file && fs.existsSync(target)) {
      throw new Error(`A file named "${path.basename(target)}" already exists`);
    }
    fs.renameSync(file, target);
    this.emitFor(target);
    return target;
  }

  delete(file: string): void {
    fs.rmSync(file, { force: true });
    this.emitFor(file);
  }

  /** Our own changes in the internal folder refresh right away; linked folders are covered by their watcher. */
  private emitFor(file: string): void {
    const id = this.connectionOf(file);
    if (id) {
      this.emit(id);
    }
  }

  /** Removes every saved file of a connection (when the connection is deleted). */
  deleteAll(connectionId: string): void {
    fs.rmSync(this.dir(connectionId), { recursive: true, force: true });
    this.emit(connectionId);
  }

  /** Connection a saved file belongs to, from its folder; undefined for files elsewhere. */
  connectionOf(file: string): string | undefined {
    const relative = path.relative(this.root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return undefined;
    }
    const parts = relative.split(path.sep);
    return parts.length === 2 && parts[1].toLowerCase().endsWith('.sql') ? parts[0] : undefined;
  }

  /** Notices files added, renamed or removed outside the extension (other windows, Finder). */
  watch(): { dispose(): void } {
    fs.mkdirSync(this.root, { recursive: true });
    let timer: NodeJS.Timeout | undefined;
    const pending = new Set<string | undefined>();
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, name) => {
        pending.add(name ? String(name).split(/[\\/]/)[0] || undefined : undefined);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const ids = [...pending];
          pending.clear();
          ids.includes(undefined) ? this.emit(undefined) : ids.forEach((id) => this.emit(id));
        }, 150);
      });
    } catch {
      // Recursive watching is unavailable on some platforms; the tree still refreshes on our own changes.
    }
    return { dispose: () => this.watcher?.close() };
  }
}

/** Watches folders linked to connections; reports the watched root under which something changed. */
export class FolderWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly onChange: (root: string) => void) {}

  /** Watches exactly `roots` from now on (missing folders are skipped until they exist). */
  update(roots: string[]): void {
    const wanted = new Set(roots.map((r) => path.resolve(r)));
    for (const [root, watcher] of this.watchers) {
      if (!wanted.has(root)) {
        watcher.close();
        this.watchers.delete(root);
      }
    }
    for (const root of wanted) {
      if (this.watchers.has(root)) {
        continue;
      }
      try {
        const watcher = fs.watch(root, { recursive: true }, () => {
          clearTimeout(this.timers.get(root));
          this.timers.set(root, setTimeout(() => this.onChange(root), 200));
        });
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(root);
        });
        this.watchers.set(root, watcher);
      } catch {
        // Missing or unwatchable folder: shown as such in the tree, retried on the next update.
      }
    }
  }

  dispose(): void {
    this.watchers.forEach((w) => w.close());
    this.watchers.clear();
    this.timers.forEach((t) => clearTimeout(t));
  }
}
