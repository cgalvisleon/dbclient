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

/** File written by Export Connections…: configuration only, never secrets. */
export interface ExportFile {
  format: 'dbclient-connections';
  version: 1;
  exportedAt: string;
  folders: ConnectionFolder[];
  connections: ConnectionConfig[];
}

export type ImportMode = 'merge' | 'replace';

export interface ImportResult {
  added: string[];
  /** Imported under a new id and name because a different connection already used them. */
  renamed: string[];
  /** Already present with the same configuration. */
  skipped: string[];
  /** Replace mode: local connections that were not in the file (secrets deleted). */
  removed: string[];
  /** Entries ignored: unknown engine or malformed. */
  invalid: string[];
}

/** Reads an export file, or a raw connections.json; throws on anything else. */
export function parseExport(text: string): { folders: ConnectionFolder[]; connections: ConnectionConfig[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Not a JSON file: ${(err as Error).message}`);
  }
  const d = data as Partial<ExportFile> | null;
  if (!d || typeof d !== 'object' || !Array.isArray(d.connections) || (d.format !== undefined && d.format !== 'dbclient-connections')) {
    throw new Error('Not a DB Client connections file.');
  }
  return { folders: Array.isArray(d.folders) ? d.folders : [], connections: d.connections };
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

  /** Changes some fields of a connection (secrets untouched); `undefined` values remove the field. */
  patch(id: string, changes: Partial<Omit<ConnectionConfig, 'id'>>): ConnectionConfig {
    const connection = this.get(id);
    if (!connection) {
      throw new Error(`Connection ${id} not found`);
    }
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) {
        delete (connection as unknown as Record<string, unknown>)[key];
      } else {
        (connection as unknown as Record<string, unknown>)[key] = value;
      }
    }
    this.commit();
    return connection;
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

  // ---------- export / import ----------

  /**
   * Connections and folders to export: everything, one folder with its subfolders (that folder
   * becomes top level), or some connections without folders. Secret option keys are dropped
   * even if an old entry has them.
   */
  exportData(secretKeysOf: (type: string) => string[], folderId?: string, connectionIds?: string[]): ExportFile {
    let folders = this.folders;
    let connections = this.connections;
    if (connectionIds) {
      const ids = new Set(connectionIds);
      folders = [];
      connections = this.connections.filter((c) => ids.has(c.id)).map((c) => ({ ...c, folderId: undefined }));
    } else if (folderId) {
      const ids = new Set([this.requireFolder(folderId).id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const f of this.folders) {
          if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
            ids.add(f.id);
            grew = true;
          }
        }
      }
      folders = this.folders.filter((f) => ids.has(f.id)).map((f) => (f.id === folderId ? { ...f, parentId: undefined } : f));
      connections = this.connections.filter((c) => c.folderId && ids.has(c.folderId));
    }
    return {
      format: 'dbclient-connections',
      version: 1,
      exportedAt: new Date().toISOString(),
      folders: folders.map((f) => ({ ...f })),
      connections: connections.map((c) => {
        const secret = new Set(secretKeysOf(c.type));
        return { ...c, options: Object.fromEntries(Object.entries(c.options).filter(([k]) => !secret.has(k))) };
      }),
    };
  }

  /**
   * Imports an export. Ids are kept when free, so a backup restored on the same machine finds
   * its saved passwords and SQL files again. Merge never loses anything: identical connections
   * are skipped and a different one with the same id or name is added as a renamed copy.
   * Replace also removes local connections missing from the file (and their secrets).
   * `targetFolderId` (merge only) puts the file's top-level folders and connections inside
   * that folder instead of the top level.
   */
  async importData(
    data: { folders: ConnectionFolder[]; connections: ConnectionConfig[] },
    mode: ImportMode,
    fieldsOf: (type: string) => FieldSpec[] | undefined,
    targetFolderId?: string,
  ): Promise<ImportResult> {
    if (targetFolderId) {
      if (mode === 'replace') {
        throw new Error('Replace imports the whole list; it cannot target a folder.');
      }
      this.requireFolder(targetFolderId);
    }
    const result: ImportResult = { added: [], renamed: [], skipped: [], removed: [], invalid: [] };
    const valid = data.connections.filter((c) => {
      const ok = c && typeof c.name === 'string' && typeof c.type === 'string' && fieldsOf(c.type) && c.options && typeof c.options === 'object';
      if (!ok) {
        result.invalid.push(String(c?.name ?? '?'));
      }
      return ok;
    });

    if (mode === 'replace') {
      const keep = new Set(valid.map((c) => c.id).filter(Boolean));
      for (const c of this.connections.filter((c) => !keep.has(c.id))) {
        await this.deleteSecrets(c.id, fieldsOf(c.type) ?? []);
        result.removed.push(c.id);
      }
      this.connections = this.connections.filter((c) => keep.has(c.id));
      this.folders = [];
    }

    // Folders: reuse an existing one with the same name under the same parent, else create.
    const folderIds = new Map<string, string>();
    const pending = data.folders.filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string' && f.name.trim());
    for (let progress = true; pending.length && progress; ) {
      progress = false;
      for (const f of [...pending]) {
        if (f.parentId && pending.some((p) => p.id === f.parentId)) {
          continue; // parent first
        }
        const parentId = f.parentId ? folderIds.get(f.parentId) : targetFolderId;
        const existing = this.folders.find((x) => x.name === f.name && x.parentId === parentId);
        const id = existing?.id ?? (this.getFolder(f.id) ? randomUUID() : f.id);
        if (!existing) {
          this.folders.push({ id, name: f.name.trim(), parentId });
        }
        folderIds.set(f.id, id);
        pending.splice(pending.indexOf(f), 1);
        progress = true;
      }
    }

    // Same settings, whatever the id or folder.
    const same = (a: ConnectionConfig, b: ConnectionConfig) =>
      stableJson({ ...a, id: undefined, folderId: undefined }) === stableJson({ ...b, id: undefined, folderId: undefined });
    for (const source of valid) {
      const secret = new Set((fieldsOf(source.type) ?? []).filter((f) => f.secret).map((f) => f.key));
      const incoming: ConnectionConfig = {
        ...source,
        id: source.id || randomUUID(),
        options: Object.fromEntries(Object.entries(source.options).filter(([k]) => !secret.has(k))),
        folderId: (source.folderId && folderIds.get(source.folderId)) || targetFolderId,
      };
      if (!incoming.folderId) {
        delete incoming.folderId;
      }
      const byId = this.get(incoming.id);
      if (byId && same(byId, incoming)) {
        byId.folderId = incoming.folderId;
        result.skipped.push(incoming.name);
        continue;
      }
      if (mode === 'replace' && byId) {
        // Same connection, new settings: update in place so its secrets still match.
        Object.assign(byId, incoming);
        result.added.push(incoming.name);
        continue;
      }
      const sameName = this.connections.find((c) => c.name === incoming.name && (c.folderId ?? '') === (incoming.folderId ?? ''));
      if (sameName && same(sameName, incoming)) {
        result.skipped.push(incoming.name);
        continue;
      }
      if (byId || sameName) {
        if (byId) {
          incoming.id = randomUUID();
        }
        if (sameName) {
          const names = new Set(this.connections.map((c) => c.name));
          let name = `${incoming.name} (imported)`;
          for (let n = 2; names.has(name); n++) {
            name = `${incoming.name} (imported ${n})`;
          }
          incoming.name = name;
        }
        result.renamed.push(incoming.name);
      } else {
        result.added.push(incoming.name);
      }
      this.connections.push(incoming);
    }
    this.commit();
    return result;
  }

  private async deleteSecrets(id: string, fields: FieldSpec[]): Promise<void> {
    for (const field of fields.filter((f) => f.secret)) {
      await this.secrets.delete(secretKey(id, field.key));
    }
  }

  async delete(id: string, fields: FieldSpec[]): Promise<void> {
    await this.deleteSecrets(id, fields);
    this.connections = this.connections.filter((c) => c.id !== id);
    this.persist();
    this.emit();
  }
}

/** JSON with sorted keys and without undefined values, for comparing configurations. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function secretKey(id: string, field: string): string {
  return `dbclient.${id}.${field}`;
}
