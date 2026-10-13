import * as sql from 'mssql';
import { createTableSql } from '../sql/generate';
import { bindTemporal, checkCount } from './params';
import { SSL_SECTION, tlsOptions } from './tls';
import { sshFields } from './sshTunnel';
import {
  Catalog,
  ConnectionConfig,
  ConnectionSecrets,
  DbNode,
  DriverFactory,
  NodeKind,
  ParamStatement,
  ParamValue,
  QueryOptions,
  SqlDriver,
  StatementError,
  StatementResult,
  TableInfo,
  TableRef,
} from './types';

const FOLDERS: { name: string; kind: NodeKind; types: string[] }[] = [
  { name: 'Tables', kind: 'table', types: ['U'] },
  { name: 'Views', kind: 'view', types: ['V'] },
  { name: 'Functions', kind: 'function', types: ['FN', 'IF', 'TF'] },
  { name: 'Procedures', kind: 'procedure', types: ['P'] },
  { name: 'Triggers', kind: 'trigger', types: ['TR'] },
  { name: 'Indexes', kind: 'index', types: [] },
];

// Node paths are `db/schema/folder/name`, each segment URI-encoded.
const makePath = (...segments: string[]) => segments.map(encodeURIComponent).join('/');
const splitPath = (path: string) => path.split('/').map(decodeURIComponent);
const quote = (name: string) => `[${name.replace(/]/g, ']]')}]`;

interface ColumnMeta {
  name: string;
  type?: { declaration?: string; name?: string };
}

export class MssqlDriver implements SqlDriver {
  readonly type = 'mssql';
  readonly dialect = 'mssql';

  private pool?: Promise<sql.ConnectionPool>;
  // One single-connection pool per database, so SET, temp tables and BEGIN TRAN persist.
  private readonly sessions = new Map<string, Promise<sql.ConnectionPool>>();
  private readonly running = new Map<string, sql.Request>();

  constructor(
    private readonly config: ConnectionConfig,
    private readonly secrets: ConnectionSecrets,
  ) {}

  private get defaultDatabase(): string {
    return String(this.config.options.database || 'master');
  }

  private poolConfig(database: string, max: number): sql.config {
    const o = this.config.options;
    return {
      server: String(o.host || 'localhost'),
      port: Number(o.port || 1433),
      user: o.user ? String(o.user) : undefined,
      password: this.secrets.password,
      database,
      connectionTimeout: 10000,
      requestTimeout: 0,
      options: {
        encrypt: Boolean(o.encrypt),
        trustServerCertificate: o.trustServerCertificate !== false,
        appName: 'dbclient',
        // A CA file to check the server certificate against; through an SSH tunnel, the real host name.
        cryptoCredentialsDetails: o.encrypt && o.sslCa ? { ca: tlsOptions({ ...o, ssl: 'verify-full' }, {})?.ca } : undefined,
        serverName: o.tlsServername ? String(o.tlsServername) : undefined,
      },
      pool: { min: 0, max, idleTimeoutMillis: max === 1 ? 2 ** 31 - 1 : 30000 },
    };
  }

  private open(database: string, max: number): Promise<sql.ConnectionPool> {
    const pool = new sql.ConnectionPool(this.poolConfig(database, max));
    pool.on('error', () => undefined);
    return pool.connect();
  }

  private metadata(): Promise<sql.ConnectionPool> {
    if (!this.pool) {
      this.pool = this.open(this.defaultDatabase, 2);
      this.pool.catch(() => (this.pool = undefined));
    }
    return this.pool;
  }

  private session(database = this.defaultDatabase): Promise<sql.ConnectionPool> {
    let session = this.sessions.get(database);
    if (!session) {
      session = this.open(database, 1);
      session.catch(() => this.sessions.delete(database));
      this.sessions.set(database, session);
    }
    return session;
  }

  private async query<T>(text: string, params: Record<string, string> = {}): Promise<T[]> {
    const request = (await this.metadata()).request();
    for (const [k, v] of Object.entries(params)) {
      request.input(k, sql.NVarChar, v);
    }
    return (await request.query<T>(text)).recordset;
  }

  async connect(): Promise<void> {
    await this.query('select 1 as ok');
  }

  async disconnect(): Promise<void> {
    const pools = [...this.sessions.values(), ...(this.pool ? [this.pool] : [])];
    this.sessions.clear();
    this.pool = undefined;
    await Promise.allSettled(pools.map(async (p) => (await p).close()));
  }

  async children(parent?: DbNode): Promise<DbNode[]> {
    if (!parent) {
      const rows = await this.query<{ name: string }>('select name from sys.databases where state = 0 and has_dbaccess(name) = 1 order by name');
      return rows.map((r) => ({
        kind: 'database' as const,
        label: r.name,
        path: makePath(r.name),
        expandable: true,
        database: r.name,
        description: r.name === this.defaultDatabase ? 'default' : ['master', 'model', 'msdb', 'tempdb'].includes(r.name) ? 'system' : undefined,
      }));
    }
    const [db, schema, folder, name] = splitPath(parent.path);
    const sys = (view: string) => `${quote(db)}.sys.${view}`;
    switch (parent.kind) {
      case 'database': {
        const rows = await this.query<{ name: string }>(
          `select s.name from ${sys('schemas')} s
            where s.name not in ('sys', 'INFORMATION_SCHEMA', 'guest') and s.name not like 'db[_]%'
            order by case when s.name = 'dbo' then 0 else 1 end, s.name`,
        );
        return rows.map((r) => ({ kind: 'schema' as const, label: r.name, path: makePath(db, r.name), expandable: true, database: db }));
      }
      case 'schema':
        return FOLDERS.map((f) => ({ kind: 'folder' as const, label: f.name, path: makePath(db, schema, f.name), expandable: true, database: db }));
      case 'folder': {
        const spec = FOLDERS.find((f) => f.name === folder)!;
        if (folder === 'Indexes') {
          const rows = await this.query<{ name: string; tbl: string; uniq: boolean }>(
            `select i.name, t.name as tbl, i.is_unique as uniq from ${sys('indexes')} i
               join ${sys('tables')} t on t.object_id = i.object_id
               join ${sys('schemas')} s on s.schema_id = t.schema_id
              where s.name = @schema and i.name is not null order by t.name, i.name`,
            { schema },
          );
          return rows.map((r) => this.leaf('index', db, schema, folder, `${r.tbl}.${r.name}`, r.uniq ? `${r.tbl} · unique` : r.tbl));
        }
        const rows = await this.query<{ name: string }>(
          `select o.name from ${sys('objects')} o join ${sys('schemas')} s on s.schema_id = o.schema_id
            where s.name = @schema and o.type in (${spec.types.map((t) => `'${t}'`).join(', ')}) and o.is_ms_shipped = 0
            order by o.name`,
          { schema },
        );
        return rows.map((r) => ({
          ...this.leaf(spec.kind, db, schema, folder, r.name),
          expandable: spec.kind === 'table' || spec.kind === 'view',
          meta: spec.kind === 'table' || spec.kind === 'view' ? { schema, name: r.name } : undefined,
        }));
      }
      case 'table':
      case 'view': {
        const rows = await this.query<{ name: string; type: string; nullable: boolean; pk: number }>(
          `select c.name, type_name(c.user_type_id) +
                  case when type_name(c.user_type_id) in ('varchar', 'nvarchar', 'char', 'nchar', 'varbinary')
                       then '(' + case when c.max_length = -1 then 'max'
                                       else cast(case when type_name(c.user_type_id) like 'n%' then c.max_length / 2 else c.max_length end as varchar) end + ')'
                       when type_name(c.user_type_id) in ('decimal', 'numeric')
                       then '(' + cast(c.precision as varchar) + ',' + cast(c.scale as varchar) + ')'
                       else '' end as type,
                  c.is_nullable as nullable,
                  (select count(*) from ${sys('index_columns')} ic join ${sys('indexes')} i on i.object_id = ic.object_id and i.index_id = ic.index_id
                    where i.is_primary_key = 1 and ic.object_id = c.object_id and ic.column_id = c.column_id) as pk
             from ${sys('columns')} c
            where c.object_id = object_id(@name)
            order by c.column_id`,
          { name: `${quote(db)}.${quote(schema)}.${quote(name)}` },
        );
        return rows.map((r) => ({
          kind: 'column' as const,
          label: r.name,
          path: makePath(db, schema, 'Columns', name, r.name),
          expandable: false,
          database: db,
          description: `${r.type}${r.pk ? ' · PK' : ''}${r.nullable ? '' : ' · not null'}`,
        }));
      }
      default:
        return [];
    }
  }

  private leaf(kind: NodeKind, db: string, schema: string, folder: string, label: string, description?: string): DbNode {
    return { kind, label, path: makePath(db, schema, folder, label), expandable: false, database: db, description };
  }

  async catalog(database?: string): Promise<Catalog> {
    const db = database || this.defaultDatabase;
    const [rows, current] = await Promise.all([
      this.query<{ schema: string; name: string; type: string }>(
        `select s.name as [schema], o.name, rtrim(o.type) as type
           from ${quote(db)}.sys.objects o join ${quote(db)}.sys.schemas s on s.schema_id = o.schema_id
          where o.type in ('U', 'V') and o.is_ms_shipped = 0
          order by s.name, o.name`,
      ),
      this.query<{ s: string }>('select schema_name() as s'),
    ]);
    return {
      defaultSchema: current[0]?.s ?? 'dbo',
      tables: rows.map((r) => ({ schema: r.schema, name: r.name, kind: r.type === 'V' ? ('view' as const) : ('table' as const) })),
    };
  }

  async describe(ref: TableRef): Promise<TableInfo | undefined> {
    const db = ref.database || this.defaultDatabase;
    // `[db]..[name]` resolves an unqualified name through the user's default schema.
    const objectName = `${quote(db)}.${ref.schema ? quote(ref.schema) : ''}.${quote(ref.name)}`;
    const found = await this.query<{ id: number; schema: string; type: string }>(
      `select o.object_id as id, s.name as [schema], rtrim(o.type) as type
         from ${quote(db)}.sys.objects o join ${quote(db)}.sys.schemas s on s.schema_id = o.schema_id
        where o.object_id = object_id(@name) and o.type in ('U', 'V')`,
      { name: objectName },
    );
    if (!found.length) {
      return undefined;
    }
    const { id, schema, type } = found[0];
    const sys = (view: string) => `${quote(db)}.sys.${view}`;
    const [columns, indexRows] = await Promise.all([
      this.query<{ name: string; type: string; nullable: boolean; def: string | null; ident: string | null }>(
        `select c.name, type_name(c.user_type_id) +
                case when type_name(c.user_type_id) in ('varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary')
                     then '(' + case when c.max_length = -1 then 'max'
                                     else cast(case when type_name(c.user_type_id) like 'n%' then c.max_length / 2 else c.max_length end as varchar) end + ')'
                     when type_name(c.user_type_id) in ('decimal', 'numeric')
                     then '(' + cast(c.precision as varchar) + ',' + cast(c.scale as varchar) + ')'
                     else '' end as type,
                c.is_nullable as nullable, d.definition as def,
                case when ic.column_id is not null
                     then 'IDENTITY(' + cast(ic.seed_value as varchar) + ',' + cast(ic.increment_value as varchar) + ')' end as ident
           from ${sys('columns')} c
           left join ${sys('default_constraints')} d on d.object_id = c.default_object_id
           left join ${sys('identity_columns')} ic on ic.object_id = c.object_id and ic.column_id = c.column_id
          where c.object_id = ${Number(id)}
          order by c.column_id`,
      ),
      this.query<{ name: string; col: string; uniq: boolean; prim: boolean }>(
        `select i.name, c.name as col, i.is_unique as uniq, i.is_primary_key as prim
           from ${sys('indexes')} i
           join ${sys('index_columns')} ic on ic.object_id = i.object_id and ic.index_id = i.index_id and ic.key_ordinal > 0
           join ${sys('columns')} c on c.object_id = ic.object_id and c.column_id = ic.column_id
          where i.object_id = ${Number(id)} and i.name is not null
          order by i.is_primary_key desc, i.name, ic.key_ordinal`,
      ),
    ]);
    const indexes = new Map<string, { name: string; columns: string[]; unique: boolean; primary: boolean }>();
    for (const r of indexRows) {
      const index = indexes.get(r.name) ?? { name: r.name, columns: [], unique: r.uniq, primary: r.prim };
      index.columns.push(r.col);
      indexes.set(r.name, index);
    }
    const primaryKey = [...indexes.values()].find((i) => i.primary)?.columns ?? [];
    return {
      ref: { database: db, schema, name: ref.name },
      kind: type === 'V' ? 'view' : 'table',
      columns: columns.map((c) => ({
        name: c.name,
        type: c.ident ? `${c.type} ${c.ident}` : c.type,
        nullable: c.nullable,
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
    const db = info.ref.database!;
    if (info.kind === 'view') {
      const rows = await this.query<{ def: string }>(
        `select m.definition as def from ${quote(db)}.sys.sql_modules m where m.object_id = object_id(@name)`,
        { name: `${quote(db)}.${quote(info.ref.schema!)}.${quote(info.ref.name)}` },
      );
      return `${(rows[0]?.def ?? '').trim()}\nGO`;
    }
    const pk = info.indexes.find((i) => i.primary);
    return createTableSql(info, 'mssql', {
      constraints: pk ? [`CONSTRAINT ${quote(pk.name)} PRIMARY KEY (${pk.columns.map(quote).join(', ')})`] : [],
    });
  }

  async transaction(database: string | undefined, statements: ParamStatement[]): Promise<number[]> {
    const pool = await this.open(database || this.defaultDatabase, 1);
    const transaction = new sql.Transaction(pool);
    const counts: number[] = [];
    let begun = false;
    try {
      await transaction.begin();
      begun = true;
      for (const s of statements) {
        const request = new sql.Request(transaction);
        s.params.forEach((value, i) => bindParam(request, `p${i + 1}`, value, s.types?.[i]));
        let count: number;
        try {
          count = (await request.query(s.sql)).rowsAffected[0] ?? 0;
        } catch (err) {
          throw toStatementError(err as sql.RequestError);
        }
        checkCount(s, count);
        counts.push(count);
      }
      await transaction.commit();
      return counts;
    } catch (err) {
      if (begun) {
        await transaction.rollback().catch(() => undefined);
      }
      throw err;
    } finally {
      await pool.close().catch(() => undefined);
    }
  }

  async execute(text: string, options: QueryOptions): Promise<StatementResult[]> {
    const database = options.database || this.defaultDatabase;
    const pool = await this.session(database);
    const request = pool.request();
    request.stream = true;
    request.arrayRowMode = true;
    this.running.set(database, request);
    const started = Date.now();
    const results: StatementResult[] = [];
    let current: StatementResult | undefined;
    let truncated = false;

    try {
      await new Promise<void>((resolve, reject) => {
        request.on('recordset', (columns: ColumnMeta[] | Record<string, ColumnMeta>) => {
          const list = Array.isArray(columns) ? columns : Object.values(columns);
          current = {
            sql: text,
            command: 'SELECT',
            columns: list.map((c) => ({ name: c.name, type: c.type?.declaration ?? c.type?.name })),
            rows: [],
            rowCount: 0,
            truncated: false,
            durationMs: 0,
          };
          results.push(current);
        });
        request.on('row', (row: unknown[]) => {
          if (!current) {
            return;
          }
          if (current.rows.length < options.maxRows) {
            current.rows.push(row);
          } else if (!truncated) {
            truncated = current.truncated = true;
            request.cancel();
          }
        });
        request.on('rowsaffected', (count: number) => {
          // Affected-row counts that follow a result set belong to it (SELECT row counts).
          if (current && current.rowCount === current.rows.length && !current.truncated) {
            current.rowCount = count;
            current = undefined;
            return;
          }
          results.push({ sql: text, command: 'DML', columns: [], rows: [], rowCount: count, truncated: false, durationMs: 0 });
        });
        request.on('error', (err: sql.RequestError) => {
          if (truncated && err.code === 'ECANCEL') {
            return;
          }
          reject(toStatementError(err));
        });
        request.on('done', () => resolve());
        // A batch (not sp_executesql) so #temp tables and SET options outlive the call.
        void request.batch(text);
      });
    } finally {
      this.running.delete(database);
    }
    const durationMs = Date.now() - started;
    for (const r of results) {
      r.durationMs = durationMs;
      if (r.truncated) {
        r.rowCount = null;
      } else if (r.columns.length) {
        r.rowCount = r.rows.length;
      }
    }
    return results.length ? results : [{ sql: text, command: firstWord(text), columns: [], rows: [], rowCount: null, truncated: false, durationMs }];
  }

  async cancel(database?: string): Promise<void> {
    this.running.get(database || this.defaultDatabase)?.cancel();
  }
}

function bindParam(request: sql.Request, name: string, value: ParamValue, type: string | undefined): void {
  const bound = bindTemporal(value, type);
  if (bound instanceof Date) {
    request.input(name, sql.DateTime2, bound);
  } else if (typeof bound === 'number') {
    // mssql would bind every integer as INT; larger ones need BIGINT, fractions FLOAT.
    request.input(name, !Number.isInteger(bound) ? sql.Float : Math.abs(bound) > 2147483647 ? sql.BigInt : sql.Int, bound);
  } else if (typeof bound === 'boolean') {
    request.input(name, sql.Bit, bound);
  } else {
    request.input(name, sql.NVarChar, bound);
  }
}

function firstWord(text: string): string {
  return text.trim().split(/\s+/)[0].toUpperCase();
}

function toStatementError(err: sql.RequestError): StatementError {
  const info = (err as unknown as { originalError?: { info?: { lineNumber?: number; number?: number } } }).originalError?.info;
  const line = (err as unknown as { lineNumber?: number }).lineNumber ?? info?.lineNumber;
  return new StatementError(err.message, undefined, info?.number !== undefined ? String(info.number) : err.code, line || undefined);
}

export const mssqlFactory: DriverFactory = {
  type: 'mssql',
  label: 'SQL Server',
  category: 'sql',
  dialect: 'mssql',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' },
    { key: 'port', label: 'Port', kind: 'number', required: true, default: 1433 },
    { key: 'database', label: 'Database', kind: 'text', required: true, default: 'master' },
    { key: 'user', label: 'User', kind: 'text', required: true, default: 'sa' },
    { key: 'password', label: 'Password', kind: 'password', secret: true },
    { key: 'encrypt', label: 'Encrypt', kind: 'checkbox', default: false, section: SSL_SECTION },
    {
      key: 'trustServerCertificate',
      label: 'Trust server certificate',
      kind: 'checkbox',
      default: true,
      section: SSL_SECTION,
      showWhen: { field: 'encrypt', values: [true] },
      hint: 'Off: the certificate and host name are checked (against the CA file when given).',
    },
    { key: 'sslCa', label: 'CA certificate', kind: 'file', section: SSL_SECTION, showWhen: { field: 'encrypt', values: [true] }, placeholder: 'PEM file (optional: system CAs otherwise)' },
    ...sshFields(),
  ],
  create: (config, secrets) => new MssqlDriver(config, secrets),
};
