import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionConfig, ConnectionSecrets, FieldSpec } from '../drivers/types';

/** The subset of vscode.SecretStorage the store needs (keeps it testable without vscode). */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

interface StoreFile {
  version: 1;
  connections: ConnectionConfig[];
}

/** Secret updates: a string sets the value, `null` deletes it, missing/undefined keeps it. */
export type SecretUpdate = Record<string, string | null | undefined>;

/**
 * User-level connection store: one JSON file in the extension's global storage, shared by
 * every window and workspace. Secrets live in SecretStorage under `dbclient.<id>.<field>`.
 */
export class ConnectionStore {
  private connections: ConnectionConfig[] = [];
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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read ${this.file}: ${(err as Error).message}`);
      }
      this.connections = [];
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data: StoreFile = { version: 1, connections: this.connections };
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
        const before = JSON.stringify(this.connections);
        this.load();
        if (JSON.stringify(this.connections) !== before) {
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
