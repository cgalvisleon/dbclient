import * as vscode from 'vscode';
import { Catalog, CatalogTable, TableInfo, TableRef } from '../drivers/types';
import { findByName } from '../sql/identifiers';
import { ConnectionManager } from './manager';

const TTL_MS = 5 * 60_000;

interface Entry<T> {
  value: Promise<T>;
  at: number;
}

/**
 * Per-connection cache of tables (per database) and table descriptions, for completion and grid
 * editing. Only used while a connection is open; cleared on disconnect, refresh and DDL.
 */
export class CatalogCache implements vscode.Disposable {
  private readonly catalogs = new Map<string, Entry<Catalog>>();
  private readonly tables = new Map<string, Entry<TableInfo | undefined>>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly manager: ConnectionManager) {
    this.subscription = manager.onDidChangeState((id) => {
      if (!id || !manager.isConnected(id)) {
        this.invalidate(id);
      }
    });
  }

  private fresh<T>(map: Map<string, Entry<T>>, key: string, load: () => Promise<T>): Promise<T> {
    const hit = map.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      return hit.value;
    }
    const value = load();
    map.set(key, { value, at: Date.now() });
    value.catch(() => map.delete(key));
    return value;
  }

  catalog(connectionId: string, database?: string): Promise<Catalog> {
    return this.fresh(this.catalogs, `${connectionId}|${database ?? ''}`, async () =>
      (await this.manager.connectSql(connectionId)).catalog(database),
    );
  }

  describe(connectionId: string, ref: TableRef): Promise<TableInfo | undefined> {
    const key = `${connectionId}|${ref.database ?? ''}|${ref.schema ?? ''}|${ref.name}`;
    return this.fresh(this.tables, key, async () => (await this.manager.connectSql(connectionId)).describe(ref));
  }

  /**
   * Resolves a name as written in SQL (`name` or `schema.name`) to a catalog table: exact
   * case first, then case-insensitive; unqualified names prefer the default schema.
   */
  async resolve(connectionId: string, database: string | undefined, schema: string | undefined, name: string, quoted = false): Promise<CatalogTable | undefined> {
    const catalog = await this.catalog(connectionId, database);
    const inSchema = (s?: string) => catalog.tables.filter((t) => !s || (t.schema ?? '').toLowerCase() === s.toLowerCase());
    if (schema) {
      return findByName(inSchema(schema), name, (t) => t.name, quoted);
    }
    return findByName(inSchema(catalog.defaultSchema), name, (t) => t.name, quoted) ?? findByName(catalog.tables, name, (t) => t.name, quoted);
  }

  /** Drops everything cached for a connection (all when omitted), or for one of its databases. */
  invalidate(connectionId?: string, database?: string): void {
    for (const map of [this.catalogs, this.tables] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) {
        const [id, db] = key.split('|');
        if ((!connectionId || id === connectionId) && (database === undefined || db === database)) {
          map.delete(key);
        }
      }
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.invalidate();
  }
}
