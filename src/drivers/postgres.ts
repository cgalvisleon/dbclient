import { Client, ClientConfig, DatabaseError, FieldDef, Pool } from 'pg';
import Cursor from 'pg-cursor';
import {
  ConnectionConfig,
  ConnectionSecrets,
  DbNode,
  DriverFactory,
  NodeKind,
  QueryOptions,
  SqlDriver,
  StatementError,
  StatementResult,
} from './types';

const FOLDERS: { name: string; kind: NodeKind }[] = [
  { name: 'Tables', kind: 'table' },
  { name: 'Views', kind: 'view' },
  { name: 'Functions', kind: 'function' },
  { name: 'Procedures', kind: 'procedure' },
  { name: 'Indexes', kind: 'index' },
];

// Node paths are `db/schema/folder/name`, each segment URI-encoded.
function makePath(...segments: string[]): string {
  return segments.map(encodeURIComponent).join('/');
}

function splitPath(path: string): string[] {
  return path.split('/').map(decodeURIComponent);
}

interface CursorInternals {
  _result?: { fields?: FieldDef[]; command?: string; rowCount?: number | null };
}

export class PostgresDriver implements SqlDriver {
  readonly type = 'postgres';
  readonly dialect = 'postgres';

  // Pools serve the tree's metadata queries; sessions are one dedicated client per
  // database so SET, BEGIN and temp tables survive between editor runs.
  private readonly pools = new Map<string, Pool>();
  private readonly sessions = new Map<string, Promise<Client>>();
  private typeNames?: Promise<Map<number, string>>;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly secrets: ConnectionSecrets,
  ) {}

  private get defaultDatabase(): string {
    return String(this.config.options.database || 'postgres');
  }

  private clientConfig(database?: string): ClientConfig {
    const o = this.config.options;
    return {
      host: String(o.host || 'localhost'),
      port: Number(o.port || 5432),
      user: o.user ? String(o.user) : undefined,
      password: this.secrets.password,
      database: database || this.defaultDatabase,
      application_name: 'dbclient',
      connectionTimeoutMillis: 10000,
    };
  }

  private pool(database = this.defaultDatabase): Pool {
    let pool = this.pools.get(database);
    if (!pool) {
      pool = new Pool({ ...this.clientConfig(database), max: 2, idleTimeoutMillis: 30000 });
      // An idle client dying (server restart) must not crash the extension host.
      pool.on('error', () => undefined);
      this.pools.set(database, pool);
    }
    return pool;
  }

  private session(database = this.defaultDatabase): Promise<Client> {
    let session = this.sessions.get(database);
    if (!session) {
      session = (async () => {
        const client = new Client(this.clientConfig(database));
        client.on('error', () => this.sessions.delete(database));
        client.on('end', () => this.sessions.delete(database));
        await client.connect();
        return client;
      })();
      session.catch(() => this.sessions.delete(database));
      this.sessions.set(database, session);
    }
    return session;
  }

  async connect(): Promise<void> {
    await this.pool().query('select 1');
  }

  async disconnect(): Promise<void> {
    const sessions = [...this.sessions.values()];
    const pools = [...this.pools.values()];
    this.sessions.clear();
    this.pools.clear();
    this.typeNames = undefined;
    await Promise.allSettled([
      ...sessions.map(async (s) => (await s).end()),
      ...pools.map((p) => p.end()),
    ]);
  }

  async children(parent?: DbNode): Promise<DbNode[]> {
    if (!parent) {
      return this.databases();
    }
    const [db, schema, folder, name] = splitPath(parent.path);
    switch (parent.kind) {
      case 'database':
        return this.schemas(db);
      case 'schema':
        return FOLDERS.map((f) => ({
          kind: 'folder' as const,
          label: f.name,
          path: makePath(db, schema, f.name),
          expandable: true,
          database: db,
        }));
      case 'folder':
        return this.objects(db, schema, folder);
      case 'table':
      case 'view':
        return this.columns(db, schema, name);
      default:
        return [];
    }
  }

  private async databases(): Promise<DbNode[]> {
    let names: string[];
    try {
      const { rows } = await this.pool().query<{ datname: string }>(
        'select datname from pg_database where not datistemplate and datallowconn order by datname',
      );
      names = rows.map((r) => r.datname);
    } catch {
      names = [this.defaultDatabase];
    }
    return names.map((db) => ({
      kind: 'database',
      label: db,
      path: makePath(db),
      expandable: true,
      database: db,
      description: db === this.defaultDatabase ? 'default' : undefined,
    }));
  }

  private async schemas(db: string): Promise<DbNode[]> {
    const { rows } = await this.pool(db).query<{ nspname: string }>(
      `select nspname from pg_namespace
        where nspname not like 'pg\\_%' and nspname <> 'information_schema'
        order by nspname`,
    );
    return rows.map((r) => ({
      kind: 'schema',
      label: r.nspname,
      path: makePath(db, r.nspname),
      expandable: true,
      database: db,
    }));
  }

  private async objects(db: string, schema: string, folder: string): Promise<DbNode[]> {
    const pool = this.pool(db);
    const node = (kind: NodeKind, name: string, label = name, description?: string, expandable = false): DbNode => ({
      kind,
      label,
      path: makePath(db, schema, folder, name),
      expandable,
      database: db,
      description,
    });

    switch (folder) {
      case 'Tables':
      case 'Views': {
        const kinds = folder === 'Tables' ? ['r', 'p', 'f'] : ['v', 'm'];
        const { rows } = await pool.query<{ relname: string; relkind: string }>(
          `select c.relname, c.relkind from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = $1 and c.relkind = any($2)
            order by c.relname`,
          [schema, kinds],
        );
        return rows.map((r) =>
          node(
            folder === 'Tables' ? 'table' : 'view',
            r.relname,
            r.relname,
            r.relkind === 'm' ? 'materialized' : r.relkind === 'p' ? 'partitioned' : r.relkind === 'f' ? 'foreign' : undefined,
            true,
          ),
        );
      }
      case 'Functions':
      case 'Procedures': {
        const kind = folder === 'Functions' ? 'f' : 'p';
        const { rows } = await pool.query<{ proname: string; args: string; result: string | null }>(
          `select p.proname, pg_get_function_identity_arguments(p.oid) as args,
                  case when p.prokind = 'f' then pg_get_function_result(p.oid) end as result
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = $1 and p.prokind = $2
            order by p.proname, args`,
          [schema, kind],
        );
        return rows.map((r) =>
          node(
            folder === 'Functions' ? 'function' : 'procedure',
            `${r.proname}(${r.args})`,
            `${r.proname}(${r.args})`,
            r.result ?? undefined,
          ),
        );
      }
      case 'Indexes': {
        const { rows } = await pool.query<{ index: string; table: string }>(
          `select i.relname as index, t.relname as table
             from pg_index x
             join pg_class i on i.oid = x.indexrelid
             join pg_class t on t.oid = x.indrelid
             join pg_namespace n on n.oid = i.relnamespace
            where n.nspname = $1
            order by i.relname`,
          [schema],
        );
        return rows.map((r) => node('index', r.index, r.index, r.table));
      }
      default:
        return [];
    }
  }

  private async columns(db: string, schema: string, relation: string): Promise<DbNode[]> {
    const { rows } = await this.pool(db).query<{ attname: string; type: string; notnull: boolean; pk: boolean }>(
      `select a.attname, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
              exists (select 1 from pg_index x
                       where x.indrelid = c.oid and x.indisprimary and a.attnum = any(x.indkey)) as pk
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
      [schema, relation],
    );
    return rows.map((r) => ({
      kind: 'column',
      label: r.attname,
      path: makePath(db, schema, 'Columns', relation, r.attname),
      expandable: false,
      database: db,
      description: `${r.type}${r.pk ? ' · PK' : ''}${r.notnull ? ' · not null' : ''}`,
    }));
  }

  private resolveTypeNames(): Promise<Map<number, string>> {
    if (!this.typeNames) {
      this.typeNames = this.pool()
        .query<{ oid: number; typname: string }>('select oid::int as oid, typname from pg_type')
        .then(({ rows }) => new Map(rows.map((r) => [r.oid, r.typname])))
        .catch(() => new Map());
    }
    return this.typeNames;
  }

  async execute(sql: string, options: QueryOptions): Promise<StatementResult> {
    const client = await this.session(options.database);
    const started = Date.now();
    const cursor = client.query(new Cursor<unknown[]>(sql, undefined, { rowMode: 'array' }));
    let rows: unknown[][];
    try {
      rows = await cursor.read(options.maxRows + 1);
    } catch (err) {
      await cursor.close().catch(() => undefined);
      throw toStatementError(err);
    }
    const truncated = rows.length > options.maxRows;
    if (truncated) {
      rows = rows.slice(0, options.maxRows);
    }
    const result = (cursor as unknown as CursorInternals)._result ?? {};
    await cursor.close().catch(() => undefined);
    const durationMs = Date.now() - started;

    const fields = result.fields ?? [];
    const typeNames = fields.length ? await this.resolveTypeNames() : new Map<number, string>();
    return {
      sql,
      command: result.command,
      columns: fields.map((f) => ({ name: f.name, type: typeNames.get(f.dataTypeID) })),
      rows,
      rowCount: truncated ? null : fields.length ? rows.length : (result.rowCount ?? null),
      truncated,
      durationMs,
    };
  }

  async cancel(database?: string): Promise<void> {
    const session = this.sessions.get(database || this.defaultDatabase);
    if (!session) {
      return;
    }
    const pid = (await session as unknown as { processID?: number }).processID;
    if (pid) {
      await this.pool(database).query('select pg_cancel_backend($1)', [pid]);
    }
  }
}

function toStatementError(err: unknown): StatementError {
  if (err instanceof DatabaseError) {
    const position = err.position ? Number(err.position) : undefined;
    const detail = [err.detail, err.hint && `Hint: ${err.hint}`].filter(Boolean).join('\n');
    return new StatementError(detail ? `${err.message}\n${detail}` : err.message, position, err.code);
  }
  return new StatementError(err instanceof Error ? err.message : String(err));
}

export const postgresFactory: DriverFactory = {
  type: 'postgres',
  label: 'PostgreSQL',
  category: 'sql',
  dialect: 'postgres',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' },
    { key: 'port', label: 'Port', kind: 'number', required: true, default: 5432 },
    { key: 'database', label: 'Database', kind: 'text', required: true, default: 'postgres' },
    { key: 'user', label: 'User', kind: 'text', required: true, default: 'postgres' },
    { key: 'password', label: 'Password', kind: 'password', secret: true },
  ],
  create: (config, secrets) => new PostgresDriver(config, secrets),
};
