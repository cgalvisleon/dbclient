import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionConfig, ConnectionFolder, ConnectionSecrets, FieldSpec } from '../drivers/types';

/** The subset of vscode.SecretStorage the store needs (keeps it testable without vscode). */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

interface StoreFile {
  version: 1;
  connections: ConnectionConfig[];
  folders?: ConnectionFolder[];
}

/** Secret updates: a string sets the value, `null` deletes it, missing/undefined keeps it. */
export type SecretUpdate = Record<string, string | null | undefined>;

/**
 * User-level connection store: one JSON file in the extension's global storage, shared by
 * every window and workspace. Secrets live in SecretStorage under `dbclient.<id>.<field>`.
 */
export class ConnectionStore {
  private connections: ConnectionConfig[] = [];
  private folders: ConnectionFolder[] = [];
  private readonly listeners = new Set<() => void>();
  private watcher?: fs.FSWatcher;

  constructor(
    readonly file: string,
    private readonly secrets: SecretStore,
  ) {
    this.load();
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoreFile;
      this.connections = Array.isArray(data.connections) ? data.connections : [];
      this.folders = Array.isArray(data.folders) ? data.folders : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read ${this.file}: ${(err as Error).message}`);
      }
      this.connections = [];
      this.folders = [];
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data: StoreFile = { version: 1, connections: this.connections, folders: this.folders };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Picks up edits made by other windows. */
  watch(): { dispose(): void } {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const base = path.basename(this.file);
    let timer: NodeJS.Timeout | undefined;
    this.watcher = fs.watch(path.dirname(this.file), (_event, name) => {
      if (name !== base) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        const snapshot = () => JSON.stringify([this.connections, this.folders]);
        const before = snapshot();
        this.load();
        if (snapshot() !== before) {
          this.emit();
        }
      }, 100);
    });
    return { dispose: () => this.watcher?.close() };
  }

  list(): ConnectionConfig[] {
    return [...this.connections].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ConnectionConfig | undefined {
    return this.connections.find((c) => c.id === id);
  }

  async getSecrets(id: string, fields: FieldSpec[]): Promise<ConnectionSecrets> {
    const result: ConnectionSecrets = {};
    for (const field of fields.filter((f) => f.secret)) {
      result[field.key] = await this.secrets.get(secretKey(id, field.key));
    }
    return result;
  }

  /** Creates (when `config.id` is empty) or replaces a connection. Returns the stored config. */
  async save(config: Omit<ConnectionConfig, 'id'> & { id?: string }, secrets: SecretUpdate = {}): Promise<ConnectionConfig> {
    const stored: ConnectionConfig = { ...config, id: config.id || randomUUID() };
    for (const [key, value] of Object.entries(secrets)) {
      if (value === null) {
        await this.secrets.delete(secretKey(stored.id, key));
      } else if (value !== undefined) {
        await this.secrets.store(secretKey(stored.id, key), value);
      }
    }
    const index = this.connections.findIndex((c) => c.id === stored.id);
    if (index >= 0) {
      this.connections[index] = stored;
    } else {
      this.connections.push(stored);
    }
    this.persist();
    this.emit();
    return stored;
  }

  async duplicate(id: string, fields: FieldSpec[]): Promise<ConnectionConfig> {
    const source = this.get(id);
    if (!source) {
      throw new Error(`Connection ${id} not found`);
    }
    const secrets = await this.getSecrets(id, fields);
    const names = new Set(this.connections.map((c) => c.name));
    let name = `${source.name} (copy)`;
    for (let n = 2; names.has(name); n++) {
      name = `${source.name} (copy ${n})`;
    }
    return this.save({ ...source, id: undefined, name, options: { ...source.options } }, secrets);
  }

  // ---------- folders ----------

  listFolders(): ConnectionFolder[] {
    return [...this.folders].sort((a, b) => a.name.localeCompare(b.name));
  }

  getFolder(id: string): ConnectionFolder | undefined {
    return this.folders.find((f) => f.id === id);
  }

  /** Direct children of a folder (or of the top level when `parentId` is undefined). */
  childrenOf(parentId: string | undefined): { folders: ConnectionFolder[]; connections: ConnectionConfig[] } {
    // Items pointing at a folder that no longer exists show at the top level.
    const parentOf = (folderId: string | undefined) => (folderId && this.getFolder(folderId) ? folderId : undefined);
    return {
      folders: this.listFolders().filter((f) => parentOf(f.parentId) === parentId),
      connections: this.list().filter((c) => parentOf(c.folderId) === parentId),
    };
  }

  /** "Parent / Child" path of a folder, for pickers. */
  folderPath(id: string): string {
    const names: string[] = [];
    for (let f = this.getFolder(id); f; f = f.parentId ? this.getFolder(f.parentId) : undefined) {
      names.unshift(f.name);
      if (names.length > 50) {
        break;
      }
    }
    return names.join(' / ');
  }

  createFolder(name: string, parentId?: string): ConnectionFolder {
    const folder: ConnectionFolder = { id: randomUUID(), name: name.trim(), parentId: parentId || undefined };
    if (!folder.name) {
      throw new Error('Folder name is required');
    }
    this.folders.push(folder);
    this.commit();
    return folder;
  }

  renameFolder(id: string, name: string): void {
    const folder = this.requireFolder(id);
    if (!name.trim()) {
      throw new Error('Folder name is required');
    }
    folder.name = name.trim();
    this.commit();
  }

  /** Moves a folder under another one (or to the top level); refuses to create cycles. */
  moveFolder(id: string, parentId: string | undefined): void {
    const folder = this.requireFolder(id);
    for (let p = parentId; p; p = this.getFolder(p)?.parentId) {
      if (p === id) {
        throw new Error('A folder cannot be moved inside itself');
      }
    }
    folder.parentId = parentId || undefined;
    this.commit();
  }

  /** Deletes a folder; its connections and subfolders move up to its parent. */
  deleteFolder(id: string): void {
    const folder = this.requireFolder(id);
    for (const c of this.connections.filter((c) => c.folderId === id)) {
      c.folderId = folder.parentId;
    }
    for (const f of this.folders.filter((f) => f.parentId === id)) {
      f.parentId = folder.parentId;
    }
    this.folders = this.folders.filter((f) => f.id !== id);
    this.commit();
  }

  moveConnection(id: string, folderId: string | undefined): void {
    const connection = this.get(id);
    if (!connection) {
      throw new Error(`Connection ${id} not found`);
    }
    if (folderId) {
      this.requireFolder(folderId);
    }
    connection.folderId = folderId || undefined;
    this.commit();
  }

  private requireFolder(id: string): ConnectionFolder {
    const folder = this.getFolder(id);
    if (!folder) {
      throw new Error(`Folder ${id} not found`);
    }
    return folder;
  }

  private commit(): void {
    this.persist();
    this.emit();
  }

  async delete(id: string, fields: FieldSpec[]): Promise<void> {
    for (const field of fields.filter((f) => f.secret)) {
      await this.secrets.delete(secretKey(id, field.key));
    }
    this.connections = this.connections.filter((c) => c.id !== id);
    this.persist();
    this.emit();
  }
}

function secretKey(id: string, field: string): string {
  return `dbclient.${id}.${field}`;
}
