import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { checkCount } from './params';
import {
  Catalog,
  ConnectionConfig,
  DbNode,
  DriverFactory,
  NodeKind,
  ParamStatement,
  QueryOptions,
  SqlDriver,
  StatementError,
  StatementResult,
  TableInfo,
  TableRef,
} from './types';

const FOLDERS: { name: string; kind: NodeKind; type: string }[] = [
  { name: 'Tables', kind: 'table', type: 'table' },
  { name: 'Views', kind: 'view', type: 'view' },
  { name: 'Indexes', kind: 'index', type: 'index' },
  { name: 'Triggers', kind: 'trigger', type: 'trigger' },
];

const makePath = (...segments: string[]) => segments.map(encodeURIComponent).join('/');
const splitPath = (path: string) => path.split('/').map(decodeURIComponent);

// node:sqlite exists from Node 22.13 (VS Code ≥ 1.101, Cursor); columns()/setReturnArrays() from 22.16/24.
type ModernStatement = Omit<StatementSync, 'columns' | 'setReturnArrays'> & {
  columns?(): { name: string | null; declaredType?: string | null }[];
  setReturnArrays?(enabled: boolean): void;
};

function loadSqlite(): typeof import('node:sqlite') {
  try {
    // Plain require so the bundler leaves the built-in module alone.
    return require('node:sqlite');
  } catch {
    throw new Error(`SQLite needs an editor running Node 22.13 or newer (this one runs Node ${process.versions.node}).`);
  }
}

/** SQLite through Node's built-in driver: no native modules to ship. Runs synchronously on the extension host. */
export class SqliteDriver implements SqlDriver {
  readonly type = 'sqlite';
  readonly dialect = 'sqlite';
  private db?: DatabaseSync;

  constructor(private readonly config: ConnectionConfig) {}

  private get file(): string {
    return String(this.config.options.file || '');
  }

  private open(): DatabaseSync {
    if (!this.db) {
      if (!this.file) {
        throw new Error('No database file configured.');
      }
      const { DatabaseSync } = loadSqlite();
      this.db = new DatabaseSync(this.file, { readOnly: Boolean(this.config.options.readOnly) } as never);
    }
    return this.db;
  }

  private all<T>(sql: string, ...params: (string | number)[]): T[] {
    return this.open().prepare(sql).all(...params) as T[];
  }

  async connect(): Promise<void> {
    this.all('select 1');
  }

  async disconnect(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  async children(parent?: DbNode): Promise<DbNode[]> {
    if (!parent) {
      return FOLDERS.map((f) => ({ kind: 'folder' as const, label: f.name, path: makePath(f.name), expandable: true }));
    }
    const [folder, name] = splitPath(parent.path);
    if (parent.kind === 'folder') {
      const spec = FOLDERS.find((f) => f.name === folder)!;
      const rows = this.all<{ name: string; tbl: string }>(
        "select name, tbl_name as tbl from sqlite_schema where type = ? and name not like 'sqlite\\_%' escape '\\' order by name",
        spec.type,
      );
      return rows.map((r) => ({
        kind: spec.kind,
        label: r.name,
        path: makePath(folder, r.name),
        expandable: spec.kind === 'table' || spec.kind === 'view',
        description: spec.kind === 'index' || spec.kind === 'trigger' ? r.tbl : undefined,
        meta: spec.kind === 'table' || spec.kind === 'view' ? { name: r.name } : undefined,
      }));
    }
    if (parent.kind === 'table' || parent.kind === 'view') {
      const rows = this.all<{ name: string; type: string; notnull: number; pk: number }>(
        'select name, type, "notnull", pk from pragma_table_info(?) order by cid',
        name,
      );
      return rows.map((r) => ({
        kind: 'column' as const,
        label: r.name,
        path: makePath('Columns', name, r.name),
        expandable: false,
        description: `${r.type || 'any'}${r.pk ? ' · PK' : ''}${r.notnull ? ' · not null' : ''}`,
      }));
    }
    return [];
  }

  async catalog(): Promise<Catalog> {
    const rows = this.all<{ name: string; type: 'table' | 'view' }>(
      "select name, type from sqlite_schema where type in ('table', 'view') and name not like 'sqlite\\_%' escape '\\' order by name",
    );
    return { tables: rows.map((r) => ({ name: r.name, kind: r.type })) };
  }

  async describe(ref: TableRef): Promise<TableInfo | undefined> {
    const found = this.all<{ name: string; type: string }>(
      "select name, type from sqlite_schema where type in ('table', 'view') and name = ? collate nocase",
      ref.name,
    )[0];
    if (!found) {
      return undefined;
    }
    const columns = this.all<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(
      'select name, type, "notnull", dflt_value, pk from pragma_table_info(?) order by cid',
      found.name,
    );
    const primaryKey = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const indexes = this.all<{ name: string; unique: number; origin: string }>('select name, "unique", origin from pragma_index_list(?)', found.name).map((i) => ({
      name: i.name,
      columns: this.all<{ name: string }>('select name from pragma_index_info(?) order by seqno', i.name).map((c) => c.name),
      unique: Boolean(i.unique),
      primary: i.origin === 'pk',
    }));
    return {
      ref: { name: found.name },
      kind: found.type === 'view' ? 'view' : 'table',
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type || 'any',
        nullable: !c.notnull && c.pk === 0,
        primaryKey: c.pk > 0,
        default: c.dflt_value ?? undefined,
      })),
      primaryKey,
      indexes: indexes.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name)),
    };
  }

  async ddl(ref: TableRef): Promise<string> {
    const rows = this.all<{ sql: string }>(
      `select sql from sqlite_schema
        where (name = ? collate nocase and type in ('table', 'view')) or (tbl_name = ? collate nocase and type in ('index', 'trigger') and sql is not null)
        order by case type when 'table' then 0 when 'view' then 0 when 'index' then 1 else 2 end, name`,
      ref.name,
      ref.name,
    );
    if (!rows.length) {
      throw new Error(`${ref.name} not found.`);
    }
    return rows.map((r) => `${r.sql};`).join('\n\n');
  }

  async transaction(_database: string | undefined, statements: ParamStatement[]): Promise<number[]> {
    // A connection of its own, so an open transaction in the editor's session is not mixed in.
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(this.file);
    const counts: number[] = [];
    try {
      db.exec('begin immediate');
      for (const s of statements) {
        let count: number;
        try {
          count = Number(db.prepare(s.sql).run(...(s.params as (string | number | null)[])).changes);
        } catch (err) {
          throw new StatementError((err as Error).message);
        }
        checkCount(s, count);
        counts.push(count);
      }
      db.exec('commit');
      return counts;
    } catch (err) {
      try {
        db.exec('rollback');
      } catch {
        // Not in a transaction (begin failed).
      }
      throw err;
    } finally {
      db.close();
    }
  }

  async execute(sql: string, options: QueryOptions): Promise<StatementResult[]> {
    const db = this.open();
    const started = Date.now();
    try {
      const stmt = db.prepare(sql) as unknown as ModernStatement;
      const declared = stmt.columns?.();
      const returnsRows = declared ? declared.length > 0 : /^\s*(select|with|pragma|values|explain)\b/i.test(sql) || /\breturning\b/i.test(sql);
      if (!returnsRows) {
        const info = stmt.run();
        return [{ sql, command: sql.trim().split(/\s+/)[0].toUpperCase(), columns: [], rows: [], rowCount: Number(info.changes), truncated: false, durationMs: Date.now() - started }];
      }
      stmt.setReturnArrays?.(true);
      const rows: unknown[][] = [];
      let names = declared?.map((c) => c.name ?? '?');
      let truncated = false;
      for (const row of stmt.iterate()) {
        if (rows.length >= options.maxRows) {
          truncated = true;
          break;
        }
        if (Array.isArray(row)) {
          rows.push(row);
        } else {
          // Older Node: rows are objects, so duplicate column names collapse.
          names ??= Object.keys(row as object);
          rows.push(Object.values(row as object));
        }
      }
      return [
        {
          sql,
          command: 'SELECT',
          columns: (names ?? []).map((n, i) => ({ name: n, type: declared?.[i]?.declaredType ?? undefined })),
          rows,
          rowCount: truncated ? null : rows.length,
          truncated,
          durationMs: Date.now() - started,
        },
      ];
    } catch (err) {
      const e = err as { message?: string; errcode?: number; code?: string };
      throw new StatementError(e.message ?? String(err), undefined, e.errcode !== undefined ? String(e.errcode) : e.code);
    }
  }

  async cancel(): Promise<void> {
    // Statements run synchronously; there is nothing to interrupt from here.
  }
}

export const sqliteFactory: DriverFactory = {
  type: 'sqlite',
  label: 'SQLite',
  category: 'sql',
  dialect: 'sqlite',
  fields: [
    { key: 'file', label: 'Database file', kind: 'file', required: true, hint: 'Created if it does not exist.' },
    { key: 'readOnly', label: 'Read only', kind: 'checkbox', default: false },
  ],
  create: (config) => new SqliteDriver(config),
};
