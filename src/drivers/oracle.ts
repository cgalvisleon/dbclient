import oracledb from 'oracledb';
import { bindTemporal, checkCount } from './params';
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

const FOLDERS: { name: string; kind: NodeKind; type: string }[] = [
  { name: 'Tables', kind: 'table', type: 'TABLE' },
  { name: 'Views', kind: 'view', type: 'VIEW' },
  { name: 'Functions', kind: 'function', type: 'FUNCTION' },
  { name: 'Procedures', kind: 'procedure', type: 'PROCEDURE' },
  { name: 'Packages', kind: 'package', type: 'PACKAGE' },
  { name: 'Triggers', kind: 'trigger', type: 'TRIGGER' },
  { name: 'Sequences', kind: 'sequence', type: 'SEQUENCE' },
  { name: 'Indexes', kind: 'index', type: 'INDEX' },
];

const PLSQL_BLOCK = /^(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE\s+BODY)\b|DECLARE\b|BEGIN\b)/i;

// Node paths are `schema/folder/name`, each segment URI-encoded.
const makePath = (...segments: string[]) => segments.map(encodeURIComponent).join('/');
const splitPath = (path: string) => path.split('/').map(decodeURIComponent);

// LOBs come back as strings/buffers so they can be shown and exported.
const fetchTypeHandler = (meta: oracledb.Metadata<unknown>) => {
  if (meta.dbType === oracledb.DB_TYPE_CLOB || meta.dbType === oracledb.DB_TYPE_NCLOB) {
    return { type: oracledb.STRING };
  }
  if (meta.dbType === oracledb.DB_TYPE_BLOB) {
    return { type: oracledb.BUFFER };
  }
  return undefined;
};

export class OracleDriver implements SqlDriver {
  readonly type = 'oracle';
  readonly dialect = 'oracle';

  private pool?: Promise<oracledb.Pool>;
  // One dedicated connection per schema; `database` in this driver means CURRENT_SCHEMA.
  private readonly sessions = new Map<string, Promise<oracledb.Connection>>();
  private user = '';

  constructor(
    private readonly config: ConnectionConfig,
    private readonly secrets: ConnectionSecrets,
  ) {}

  private get connectString(): string {
    const o = this.config.options;
    const address = `${o.host || 'localhost'}:${o.port || 1521}/${o.service || 'FREEPDB1'}`;
    return tlsOptions(o, this.secrets) ? `tcps://${address}` : address;
  }

  private get credentials(): oracledb.ConnectionAttributes {
    const o = this.config.options;
    const credentials: oracledb.ConnectionAttributes = { user: String(o.user || ''), password: this.secrets.password, connectString: this.connectString };
    const tls = tlsOptions(o, this.secrets);
    if (tls) {
      // Thin mode reads one PEM "wallet" as certificate, key and CA at once, so a CA file only
      // works together with a client certificate and key; without any, the system CAs are used.
      if (tls.ca && !(tls.cert && tls.key)) {
        throw new Error('Oracle (thin mode) uses a CA file only together with a client certificate and key. Leave all three empty to use the system CAs.');
      }
      const pem = [tls.cert, tls.ca, tls.key].filter(Boolean).map(String).join('\n');
      if (pem) {
        credentials.walletContent = pem;
        credentials.walletPassword = tls.passphrase;
      }
      credentials.sslServerDNMatch = o.ssl === 'verify-full';
    }
    return credentials;
  }

  private get autoCommit(): boolean {
    return this.config.options.autoCommit !== false;
  }

  private metadata(): Promise<oracledb.Pool> {
    if (!this.pool) {
      this.pool = oracledb.createPool({ ...this.credentials, poolMin: 0, poolMax: 2, poolTimeout: 60 });
      this.pool.catch(() => (this.pool = undefined));
    }
    return this.pool;
  }

  private async query<T>(text: string, binds: oracledb.BindParameters = []): Promise<T[]> {
    const connection = await (await this.metadata()).getConnection();
    try {
      const result = await connection.execute<T>(text, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return result.rows ?? [];
    } finally {
      await connection.close();
    }
  }

  private session(schema?: string): Promise<oracledb.Connection> {
    const key = schema || '';
    let session = this.sessions.get(key);
    if (!session) {
      session = (async () => {
        const connection = await oracledb.getConnection(this.credentials);
        if (schema && schema.toUpperCase() !== this.user) {
          await connection.execute(`alter session set current_schema = "${schema.replace(/"/g, '')}"`);
        }
        return connection;
      })();
      session.catch(() => this.sessions.delete(key));
      this.sessions.set(key, session);
    }
    return session;
  }

  async connect(): Promise<void> {
    const rows = await this.query<{ U: string }>('select user as u from dual');
    this.user = rows[0]?.U ?? String(this.config.options.user || '').toUpperCase();
  }

  async disconnect(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const pool = this.pool;
    this.pool = undefined;
    await Promise.allSettled([
      ...sessions.map(async (s) => (await s).close()),
      pool ? pool.then((p) => p.close(0)) : Promise.resolve(),
    ]);
  }

  async children(parent?: DbNode): Promise<DbNode[]> {
    if (!parent) {
      let rows: { NAME: string }[];
      try {
        rows = await this.query(`select username as name from all_users where oracle_maintained = 'N' or username = user order by username`);
      } catch {
        rows = await this.query('select username as name from all_users order by username');
      }
      return rows.map((r) => ({
        kind: 'schema' as const,
        label: r.NAME,
        path: makePath(r.NAME),
        expandable: true,
        database: r.NAME,
        description: r.NAME === this.user ? 'default' : undefined,
      }));
    }
    const [schema, folder, name] = splitPath(parent.path);
    switch (parent.kind) {
      case 'schema':
        return FOLDERS.map((f) => ({ kind: 'folder' as const, label: f.name, path: makePath(schema, f.name), expandable: true, database: schema }));
      case 'folder': {
        const spec = FOLDERS.find((f) => f.name === folder)!;
        if (folder === 'Indexes') {
          const rows = await this.query<{ NAME: string; TBL: string; UNIQ: string }>(
            'select index_name as name, table_name as tbl, uniqueness as uniq from all_indexes where owner = :1 order by table_name, index_name',
            [schema],
          );
          return rows.map((r) => this.leaf('index', schema, folder, r.NAME, r.UNIQ === 'UNIQUE' ? `${r.TBL} · unique` : r.TBL));
        }
        const rows = await this.query<{ NAME: string; STATUS: string }>(
          `select object_name as name, status from all_objects
            where owner = :1 and object_type = :2 and object_name not like 'BIN$%' order by object_name`,
          [schema, spec.type],
        );
        return rows.map((r) => ({
          ...this.leaf(spec.kind, schema, folder, r.NAME, r.STATUS === 'INVALID' ? 'invalid' : undefined),
          expandable: spec.kind === 'table' || spec.kind === 'view',
          meta: spec.kind === 'table' || spec.kind === 'view' ? { schema, name: r.NAME } : undefined,
        }));
      }
      case 'table':
      case 'view': {
        const rows = await this.query<{ NAME: string; TYPE: string; NULLABLE: string; PK: number }>(
          `select c.column_name as name,
                  c.data_type || case when c.data_type in ('VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'RAW') then '(' || c.char_length || ')'
                                      when c.data_type = 'NUMBER' and c.data_precision is not null then '(' || c.data_precision || ',' || c.data_scale || ')'
                                      else '' end as type,
                  c.nullable,
                  (select count(*) from all_constraints k join all_cons_columns kc on kc.owner = k.owner and kc.constraint_name = k.constraint_name
                    where k.owner = c.owner and k.table_name = c.table_name and k.constraint_type = 'P' and kc.column_name = c.column_name) as pk
             from all_tab_columns c
            where c.owner = :1 and c.table_name = :2
            order by c.column_id`,
          [schema, name],
        );
        return rows.map((r) => ({
          kind: 'column' as const,
          label: r.NAME,
          path: makePath(schema, 'Columns', name, r.NAME),
          expandable: false,
          database: schema,
          description: `${r.TYPE}${r.PK ? ' · PK' : ''}${r.NULLABLE === 'N' ? ' · not null' : ''}`,
        }));
      }
      default:
        return [];
    }
  }

  private leaf(kind: NodeKind, schema: string, folder: string, label: string, description?: string): DbNode {
    return { kind, label, path: makePath(schema, folder, label), expandable: false, database: schema, description };
  }

  private ownerOf(ref: { database?: string; schema?: string }): string {
    return ref.schema || ref.database || this.user || String(this.config.options.user || '').toUpperCase();
  }

  async catalog(database?: string): Promise<Catalog> {
    const owner = this.ownerOf({ database });
    const rows = await this.query<{ NAME: string; TYPE: string }>(
      `select object_name as name, object_type as type from all_objects
        where owner = :1 and object_type in ('TABLE', 'VIEW') and object_name not like 'BIN$%'
        order by object_name`,
      [owner],
    );
    return { defaultSchema: owner, tables: rows.map((r) => ({ schema: owner, name: r.NAME, kind: r.TYPE === 'VIEW' ? ('view' as const) : ('table' as const) })) };
  }

  /** Owner and name as stored: exact first, then upper case (unquoted identifiers). */
  private async locate(ref: TableRef): Promise<{ owner: string; name: string; type: string } | undefined> {
    const owner = this.ownerOf(ref);
    const rows = await this.query<{ OWNER: string; NAME: string; TYPE: string }>(
      `select owner, object_name as name, object_type as type from all_objects
        where owner in (:o, upper(:o)) and object_name in (:n, upper(:n)) and object_type in ('TABLE', 'VIEW')
        order by case when owner = :o then 0 else 1 end, case when object_name = :n then 0 else 1 end`,
      { o: owner, n: ref.name },
    );
    return rows[0] && { owner: rows[0].OWNER, name: rows[0].NAME, type: rows[0].TYPE };
  }

  async describe(ref: TableRef): Promise<TableInfo | undefined> {
    const found = await this.locate(ref);
    if (!found) {
      return undefined;
    }
    const { owner, name, type } = found;
    const [columns, keyColumns, indexRows] = await Promise.all([
      this.query<{ NAME: string; TYPE: string; NULLABLE: string; DEF: string | null }>(
        `select column_name as name,
                data_type || case when data_type in ('VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'RAW') then '(' || char_length || ')'
                                  when data_type = 'NUMBER' and data_precision is not null then '(' || data_precision || ',' || data_scale || ')'
                                  else '' end as type,
                nullable, data_default as def
           from all_tab_columns where owner = :1 and table_name = :2 order by column_id`,
        [owner, name],
      ),
      this.query<{ COL: string; IDX: string }>(
        `select kc.column_name as col, k.index_name as idx from all_constraints k
           join all_cons_columns kc on kc.owner = k.owner and kc.constraint_name = k.constraint_name
          where k.owner = :1 and k.table_name = :2 and k.constraint_type = 'P' order by kc.position`,
        [owner, name],
      ),
      this.query<{ NAME: string; COL: string; UNIQ: string }>(
        `select i.index_name as name, c.column_name as col, i.uniqueness as uniq from all_indexes i
           join all_ind_columns c on c.index_owner = i.owner and c.index_name = i.index_name
          where i.table_owner = :1 and i.table_name = :2 order by i.index_name, c.column_position`,
        [owner, name],
      ),
    ]);
    const primaryKey = keyColumns.map((k) => k.COL);
    const pkIndex = keyColumns[0]?.IDX;
    const indexes = new Map<string, { name: string; columns: string[]; unique: boolean; primary: boolean }>();
    for (const r of indexRows) {
      const index = indexes.get(r.NAME) ?? { name: r.NAME, columns: [], unique: r.UNIQ === 'UNIQUE', primary: r.NAME === pkIndex };
      index.columns.push(r.COL);
      indexes.set(r.NAME, index);
    }
    return {
      ref: { database: ref.database, schema: owner, name },
      kind: type === 'VIEW' ? 'view' : 'table',
      columns: columns.map((c) => ({
        name: c.NAME,
        type: c.TYPE,
        nullable: c.NULLABLE === 'Y',
        primaryKey: primaryKey.includes(c.NAME),
        default: c.DEF?.trim() || undefined,
      })),
      primaryKey,
      indexes: [...indexes.values()].sort((a, b) => Number(b.primary) - Number(a.primary)),
    };
  }

  async ddl(ref: TableRef): Promise<string> {
    const info = await this.describe(ref);
    if (!info) {
      throw new Error(`${ref.name} not found.`);
    }
    const connection = await (await this.metadata()).getConnection();
    const get = async (kind: string, name: string) => {
      const result = await connection.execute<{ DDL: string }>(
        'select dbms_metadata.get_ddl(:1, :2, :3) as ddl from dual',
        [kind, name, info.ref.schema!],
        { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { DDL: { type: oracledb.STRING } } },
      );
      return `${(result.rows?.[0]?.DDL ?? '').trim()};`;
    };
    try {
      const parts = [await get(info.kind === 'view' ? 'VIEW' : 'TABLE', info.ref.name)];
      for (const index of info.indexes.filter((i) => !i.primary)) {
        parts.push(await get('INDEX', index.name));
      }
      return parts.join('\n\n');
    } finally {
      await connection.close();
    }
  }

  async transaction(_database: string | undefined, statements: ParamStatement[]): Promise<number[]> {
    // Statements are qualified with the owner, so the connection's default schema does not matter.
    const connection = await oracledb.getConnection(this.credentials);
    const counts: number[] = [];
    try {
      for (const s of statements) {
        let count: number;
        try {
          const binds = s.params.map((v, i) => bindTemporal(v, s.types?.[i]));
          count = (await connection.execute(s.sql, binds as oracledb.BindParameters, { autoCommit: false })).rowsAffected ?? 0;
        } catch (err) {
          throw toStatementError(err);
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
      await connection.close().catch(() => undefined);
    }
  }

  async execute(text: string, options: QueryOptions): Promise<StatementResult[]> {
    const connection = await this.session(options.database);
    // PL/SQL blocks need their final `;`, which the statement splitter strips.
    const statement = PLSQL_BLOCK.test(text) && !/;\s*$/.test(text) ? `${text};` : text;
    const started = Date.now();
    let result: oracledb.Result<unknown[]>;
    try {
      result = await connection.execute<unknown[]>(statement, [], {
        resultSet: true,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        autoCommit: this.autoCommit,
        fetchTypeHandler,
      });
    } catch (err) {
      throw toStatementError(err);
    }
    if (result.resultSet) {
      let rows: unknown[][];
      try {
        rows = await result.resultSet.getRows(options.maxRows + 1);
      } finally {
        await result.resultSet.close();
      }
      const truncated = rows.length > options.maxRows;
      if (truncated) {
        rows = rows.slice(0, options.maxRows);
      }
      return [
        {
          sql: text,
          command: 'SELECT',
          columns: (result.metaData ?? []).map((m) => ({ name: m.name, type: m.dbTypeName })),
          rows,
          rowCount: truncated ? null : rows.length,
          truncated,
          durationMs: Date.now() - started,
        },
      ];
    }
    return [
      {
        sql: text,
        command: text.trim().split(/\s+/)[0].toUpperCase(),
        columns: [],
        rows: [],
        rowCount: result.rowsAffected ?? null,
        truncated: false,
        durationMs: Date.now() - started,
      },
    ];
  }

  async cancel(database?: string): Promise<void> {
    const session = this.sessions.get(database || '');
    if (session) {
      await (await session).break();
    }
  }
}

function toStatementError(err: unknown): StatementError {
  const e = err as { message?: string; offset?: number; errorNum?: number; code?: string };
  // `offset` is 0-based and only meaningful for parse errors (0 also means "unknown").
  return new StatementError(e.message ?? String(err), e.offset ? e.offset + 1 : undefined, e.code ?? (e.errorNum ? `ORA-${e.errorNum}` : undefined));
}

export const oracleFactory: DriverFactory = {
  type: 'oracle',
  label: 'Oracle',
  category: 'sql',
  dialect: 'oracle',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' },
    { key: 'port', label: 'Port', kind: 'number', required: true, default: 1521 },
    { key: 'service', label: 'Service name', kind: 'text', required: true, default: 'FREEPDB1' },
    { key: 'user', label: 'User', kind: 'text', required: true },
    { key: 'password', label: 'Password', kind: 'password', secret: true },
    { key: 'autoCommit', label: 'Auto-commit', kind: 'checkbox', default: true },
    ...sslFields(),
    ...sshFields(),
  ],
  create: (config, secrets) => new OracleDriver(config, secrets),
};
