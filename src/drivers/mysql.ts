import * as mysql from 'mysql2';
import { checkCount } from './params';
import { sslFields, tlsOptions } from './tls';
import { sshFields } from './sshTunnel';
import {
  Catalog,
  ConnectionConfig,
  ConnectionSecrets,
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

const FOLDERS: { name: string; kind: NodeKind }[] = [
  { name: 'Tables', kind: 'table' },
  { name: 'Views', kind: 'view' },
  { name: 'Functions', kind: 'function' },
  { name: 'Procedures', kind: 'procedure' },
  { name: 'Triggers', kind: 'trigger' },
  { name: 'Indexes', kind: 'index' },
];

const SYSTEM = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

// Node paths are `db/folder/name`, each segment URI-encoded.
const makePath = (...segments: string[]) => segments.map(encodeURIComponent).join('/');
const splitPath = (path: string) => path.split('/').map(decodeURIComponent);

// mysql2 type ids → names, for the grid's column tooltips.
const TYPE_NAMES = new Map<number, string>(
  Object.entries((mysql as unknown as { Types: Record<string, number> }).Types).map(([name, id]) => [id, name.toLowerCase()]),
);

export class MysqlDriver implements SqlDriver {
  readonly type = 'mysql';
  readonly dialect = 'mysql';

  private pool?: mysql.Pool;
  private readonly sessions = new Map<string, Promise<mysql.Connection>>();

  constructor(
    private readonly config: ConnectionConfig,
    private readonly secrets: ConnectionSecrets,
  ) {}

  private get defaultDatabase(): string {
    return String(this.config.options.database || '');
  }

  private connectionOptions(database?: string): mysql.ConnectionOptions {
    const o = this.config.options;
    return {
      host: String(o.host || 'localhost'),
      port: Number(o.port || 3306),
      user: o.user ? String(o.user) : undefined,
      password: this.secrets.password,
      database: database || this.defaultDatabase || undefined,
      connectTimeout: 10000,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      ssl: tlsOptions(o, this.secrets, String(o.host || 'localhost')) as mysql.ConnectionOptions['ssl'],
    };
  }

  private metadata(): mysql.Pool {
    if (!this.pool) {
      this.pool = mysql.createPool({ ...this.connectionOptions(), connectionLimit: 2 });
      this.pool.on('connection', (c) => c.on('error', () => undefined));
    }
    return this.pool;
  }

  private async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.metadata().promise().query(sql, params);
    return rows as T[];
  }

  private session(database = this.defaultDatabase): Promise<mysql.Connection> {
    let session = this.sessions.get(database);
    if (!session) {
      session = new Promise<mysql.Connection>((resolve, reject) => {
        const connection = mysql.createConnection(this.connectionOptions(database));
        connection.on('error', () => this.sessions.delete(database));
        connection.connect((err) => (err ? reject(err) : resolve(connection)));
      });
      session.catch(() => this.sessions.delete(database));
      this.sessions.set(database, session);
    }
    return session;
  }

  async connect(): Promise<void> {
    await this.query('select 1');
  }

  async disconnect(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const pool = this.pool;
    this.pool = undefined;
    await Promise.allSettled([
      ...sessions.map(async (s) => (await s).destroy()),
      pool ? pool.promise().end() : Promise.resolve(),
    ]);
  }

  async children(parent?: DbNode): Promise<DbNode[]> {
    if (!parent) {
      const rows = await this.query<{ name: string }>('select schema_name as name from information_schema.schemata order by schema_name');
      return rows.map((r) => ({
        kind: 'database' as const,
        label: r.name,
        path: makePath(r.name),
        expandable: true,
        database: r.name,
        description: r.name === this.defaultDatabase ? 'default' : SYSTEM.has(r.name) ? 'system' : undefined,
      }));
    }
    const [db, folder, name] = splitPath(parent.path);
    const node = (kind: NodeKind, label: string, description?: string, expandable = false): DbNode => ({
      kind,
      label,
      path: makePath(db, folder, label),
      expandable,
      database: db,
      description,
    });
    switch (parent.kind) {
      case 'database':
        return FOLDERS.map((f) => ({ kind: 'folder' as const, label: f.name, path: makePath(db, f.name), expandable: true, database: db }));
      case 'folder':
        switch (folder) {
          case 'Tables':
          case 'Views': {
            const rows = await this.query<{ name: string }>(
              'select table_name as name from information_schema.tables where table_schema = ? and table_type in (?) order by table_name',
              [db, folder === 'Tables' ? ['BASE TABLE', 'SYSTEM VIEW'] : ['VIEW']],
            );
            return rows.map((r) => ({ ...node(folder === 'Tables' ? 'table' : 'view', r.name, undefined, true), meta: { name: r.name } }));
          }
          case 'Functions':
          case 'Procedures': {
            const rows = await this.query<{ name: string; returns: string | null }>(
              `select routine_name as name, dtd_identifier as returns from information_schema.routines
                where routine_schema = ? and routine_type = ? order by routine_name`,
              [db, folder === 'Functions' ? 'FUNCTION' : 'PROCEDURE'],
            );
            return rows.map((r) => node(folder === 'Functions' ? 'function' : 'procedure', r.name, r.returns ?? undefined));
          }
          case 'Triggers': {
            const rows = await this.query<{ name: string; tbl: string; timing: string; event: string }>(
              `select trigger_name as name, event_object_table as tbl, action_timing as timing, event_manipulation as event
                 from information_schema.triggers where trigger_schema = ? order by trigger_name`,
              [db],
            );
            return rows.map((r) => node('trigger', r.name, `${r.timing} ${r.event} ON ${r.tbl}`));
          }
          case 'Indexes': {
            const rows = await this.query<{ name: string; tbl: string; uniq: number }>(
              `select distinct index_name as name, table_name as tbl, 1 - non_unique as uniq
                 from information_schema.statistics where table_schema = ? order by table_name, index_name`,
              [db],
            );
            return rows.map((r) => ({ ...node('index', `${r.tbl}.${r.name}`, r.uniq ? `${r.tbl} · unique` : r.tbl) }));
          }
        }
        return [];
      case 'table':
      case 'view': {
        const rows = await this.query<{ name: string; type: string; nullable: string; ckey: string }>(
          `select column_name as name, column_type as type, is_nullable as nullable, column_key as ckey
             from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position`,
          [db, name],
        );
        return rows.map((r) => ({
          kind: 'column' as const,
          label: r.name,
          path: makePath(db, 'Columns', name, r.name),
          expandable: false,
          database: db,
          description: `${r.type}${r.ckey === 'PRI' ? ' · PK' : ''}${r.nullable === 'NO' ? ' · not null' : ''}`,
        }));
      }
      default:
        return [];
    }
  }

  // In MySQL a "schema" is a database: `ref.schema` (from `db.table`) wins over `ref.database`.
  private databaseOf(ref: { database?: string; schema?: string }): string {
    return ref.schema || ref.database || this.defaultDatabase;
  }

  async catalog(database?: string): Promise<Catalog> {
    const db = database || this.defaultDatabase;
    if (!db) {
      return { tables: [] };
    }
    const rows = await this.query<{ name: string; type: string }>(
      'select table_name as name, table_type as type from information_schema.tables where table_schema = ? order by table_name',
      [db],
    );
    return { tables: rows.map((r) => ({ name: r.name, kind: r.type === 'VIEW' ? ('view' as const) : ('table' as const) })) };
  }

  async describe(ref: TableRef): Promise<TableInfo | undefined> {
    const db = this.databaseOf(ref);
    const tables = await this.query<{ type: string }>(
      'select table_type as type from information_schema.tables where table_schema = ? and table_name = ?',
      [db, ref.name],
    );
    if (!tables.length) {
      return undefined;
    }
    const [columns, stats] = await Promise.all([
      this.query<{ name: string; type: string; nullable: string; def: string | null; ckey: string }>(
        `select column_name as name, column_type as type, is_nullable as nullable, column_default as def, column_key as ckey
           from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position`,
        [db, ref.name],
      ),
      this.query<{ name: string; col: string; uniq: number }>(
        `select index_name as name, column_name as col, 1 - non_unique as uniq
           from information_schema.statistics where table_schema = ? and table_name = ?
          order by index_name = 'PRIMARY' desc, index_name, seq_in_index`,
        [db, ref.name],
      ),
    ]);
    const indexes = new Map<string, { name: string; columns: string[]; unique: boolean; primary: boolean }>();
    for (const s of stats) {
      const index = indexes.get(s.name) ?? { name: s.name, columns: [], unique: Boolean(Number(s.uniq)), primary: s.name === 'PRIMARY' };
      index.columns.push(s.col);
      indexes.set(s.name, index);
    }
    const primaryKey = indexes.get('PRIMARY')?.columns ?? [];
    return {
      ref: { database: db, name: ref.name },
      kind: tables[0].type === 'VIEW' ? 'view' : 'table',
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable === 'YES',
        primaryKey: primaryKey.includes(c.name),
        default: c.def ?? undefined,
      })),
      primaryKey,
      indexes: [...indexes.values()],
    };
  }

  async ddl(ref: TableRef): Promise<string> {
    const info = await this.describe(ref);
    if (!info) {
      throw new Error(`${ref.name} not found.`);
    }
    const name = `\`${this.databaseOf(ref).replace(/`/g, '``')}\`.\`${ref.name.replace(/`/g, '``')}\``;
    const rows = await this.query<Record<string, string>>(`show create ${info.kind === 'view' ? 'view' : 'table'} ${name}`);
    return `${rows[0][info.kind === 'view' ? 'Create View' : 'Create Table']};`;
  }

  async transaction(database: string | undefined, statements: ParamStatement[]): Promise<number[]> {
    // FOUND_ROWS: an UPDATE that sets the same values still counts the row it matched.
    const connection = mysql.createConnection({ ...this.connectionOptions(database), flags: ['FOUND_ROWS'] }).promise();
    const counts: number[] = [];
    try {
      await connection.beginTransaction();
      for (const s of statements) {
        let count: number;
        try {
          const [result] = await connection.query(s.sql, s.params);
          count = (result as mysql.ResultSetHeader).affectedRows;
        } catch (err) {
          throw toStatementError(err as mysql.QueryError);
        }
        checkCount(s, count);
        counts.push(count);
      }
      await connection.commit();
      return counts;
    } catch (err) {
      await connection.rollback().catch(() => undefined);
      throw err;
    } finally {
      await connection.end().catch(() => undefined);
    }
  }

  async execute(sql: string, options: QueryOptions): Promise<StatementResult[]> {
    const connection = await this.session(options.database);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let fields: mysql.FieldPacket[] | undefined;
      const rows: unknown[][] = [];
      let header: mysql.ResultSetHeader | undefined;
      let truncated = false;
      let killing: Promise<void> = Promise.resolve();

      const query = connection.query({ sql, rowsAsArray: true });
      query.on('fields', (f: mysql.FieldPacket[]) => (fields = f));
      query.on('result', (row: unknown) => {
        if (!fields) {
          header = row as mysql.ResultSetHeader;
          return;
        }
        if (rows.length < options.maxRows) {
          rows.push(row as unknown[]);
        } else if (!truncated) {
          // Stop the server from streaming the rest; the interruption error is expected.
          truncated = true;
          killing = this.kill(connection.threadId);
        }
      });
      query.on('error', (err: mysql.QueryError) => {
        if (truncated && err.errno === 1317) {
          return;
        }
        reject(toStatementError(err));
      });
      query.on('end', async () => {
        const durationMs = Date.now() - started;
        // The KILL must land before the next statement starts on this session, or it would hit that one.
        await killing;
        resolve([
          {
            sql,
            command: fields ? 'SELECT' : sql.trim().split(/\s+/)[0].toUpperCase(),
            columns: (fields ?? []).map((f) => ({ name: f.name, type: f.columnType !== undefined ? TYPE_NAMES.get(f.columnType) : undefined })),
            rows,
            rowCount: fields ? (truncated ? null : rows.length) : (header?.affectedRows ?? null),
            truncated,
            durationMs,
          },
        ]);
      });
    });
  }

  private async kill(threadId: number | null): Promise<void> {
    if (threadId) {
      await this.metadata().promise().query(`KILL QUERY ${Number(threadId)}`).catch(() => undefined);
    }
  }

  async cancel(database?: string): Promise<void> {
    const session = this.sessions.get(database || this.defaultDatabase);
    if (session) {
      await this.kill((await session).threadId);
    }
  }
}

function toStatementError(err: mysql.QueryError): StatementError {
  // MySQL reports syntax errors as "... near '...' at line N".
  const line = /at line (\d+)\s*$/.exec(err.message);
  return new StatementError(err.message, undefined, err.code, line ? Number(line[1]) : undefined);
}

export const mysqlFactory: DriverFactory = {
  type: 'mysql',
  label: 'MySQL / MariaDB',
  category: 'sql',
  dialect: 'mysql',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' },
    { key: 'port', label: 'Port', kind: 'number', required: true, default: 3306 },
    { key: 'database', label: 'Database', kind: 'text', placeholder: 'optional' },
    { key: 'user', label: 'User', kind: 'text', required: true, default: 'root' },
    { key: 'password', label: 'Password', kind: 'password', secret: true },
    ...sslFields(),
    ...sshFields(),
  ],
  create: (config, secrets) => new MysqlDriver(config, secrets),
};
