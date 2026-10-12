import oracledb from 'oracledb';
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
    return `${o.host || 'localhost'}:${o.port || 1521}/${o.service || 'FREEPDB1'}`;
  }

  private get credentials() {
    return { user: String(this.config.options.user || ''), password: this.secrets.password, connectString: this.connectString };
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
  ],
  create: (config, secrets) => new OracleDriver(config, secrets),
};
