// Engine-agnostic contracts. Nothing in this folder may import `vscode`, so drivers
// stay unit-testable and the tree, editor and grid only ever talk to these types.

export type DriverCategory = 'sql' | 'kv' | 'pubsub';

/** Persisted (non-secret) part of a connection. */
export interface ConnectionConfig {
  id: string;
  name: string;
  type: string;
  /** Driver-specific values keyed by `FieldSpec.key` (host, port, database, ...). */
  options: Record<string, string | number | boolean | undefined>;
  /** Folder that groups the connection in the tree; top level when missing. */
  folderId?: string;
  /** Folders with .sql files linked to a SQL connection (absolute, `~/…` or `${workspaceFolder}/…`). */
  sqlLocations?: { path: string; label?: string }[];
  /** Where new .sql files are saved; the connection's internal folder when missing. */
  sqlSaveLocation?: string;
}

/** A user-defined folder of connections; folders nest through `parentId`. */
export interface ConnectionFolder {
  id: string;
  name: string;
  parentId?: string;
}

/** Secret values keyed by `FieldSpec.key`; kept out of the JSON store. */
export type ConnectionSecrets = Record<string, string | undefined>;

/** Describes one input of the connection form, so the form never knows about engines. */
export interface FieldSpec {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'password' | 'checkbox' | 'select' | 'file';
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  choices?: string[];
  /** Stored in SecretStorage instead of the JSON file. */
  secret?: boolean;
  /** Only shown (and used) while another field has one of these values. */
  showWhen?: { field: string; values: (string | boolean)[] };
  hint?: string;
  /** Heading the field is grouped under in the form (e.g. "SSL / TLS"); fields without one come first. */
  section?: string;
}

export type NodeKind =
  | 'database'
  | 'schema'
  | 'folder'
  | 'table'
  | 'view'
  | 'function'
  | 'procedure'
  | 'index'
  | 'column'
  | 'trigger'
  | 'sequence'
  | 'package'
  | 'key'
  | 'stream'
  | 'consumer'
  | 'subscription'
  | 'info';

/** A node below a connection in the tree. Paths are opaque to everything but the driver. */
export interface DbNode {
  kind: NodeKind;
  label: string;
  /** Unique within the connection; also used to rebuild tree item ids. */
  path: string;
  description?: string;
  tooltip?: string;
  expandable: boolean;
  /** Database this node belongs to, when the engine has several per server. */
  database?: string;
  /** Driver-specific values commands need (e.g. the full Redis key). */
  meta?: Record<string, string>;
}

export interface Driver {
  readonly type: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Children of `parent`, or the top level below the connection when omitted. */
  children(parent?: DbNode): Promise<DbNode[]>;
  /** Lets the tree refresh when the driver's own state changes (e.g. NATS subscriptions). */
  onDidChange?(listener: () => void): void;
}

export interface ResultColumn {
  name: string;
  /** Engine type name when known (e.g. `int4`, `text`). */
  type?: string;
}

export interface StatementResult {
  /** Statement as executed. */
  sql: string;
  /** Command tag (`SELECT`, `UPDATE`, ...). */
  command?: string;
  columns: ResultColumn[];
  rows: unknown[][];
  /** Rows affected for DML, rows returned for queries. */
  rowCount: number | null;
  /** More rows existed than `maxRows`; `rows` was cut. */
  truncated: boolean;
  durationMs: number;
}

export interface QueryOptions {
  database?: string;
  maxRows: number;
}

/**
 * Error raised by a statement. `position` is the 1-based character offset inside the
 * statement and `line` the 1-based line inside it, when the engine reports either.
 */
export class StatementError extends Error {
  constructor(
    message: string,
    readonly position?: number,
    readonly code?: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = 'StatementError';
  }
}

/** A table or view. `database` is the engine's database (or Oracle schema session); `schema` its owner/namespace. */
export interface TableRef {
  database?: string;
  schema?: string;
  name: string;
}

export interface CatalogTable {
  schema?: string;
  name: string;
  kind: 'table' | 'view';
}

/** Tables and views of one database, for completion; unqualified names resolve in `defaultSchema`. */
export interface Catalog {
  defaultSchema?: string;
  tables: CatalogTable[];
}

export interface ColumnInfo {
  name: string;
  /** Declared type as the engine shows it (`varchar(20)`, `NUMBER(10,2)`). */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  default?: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface TableInfo {
  ref: TableRef;
  kind: 'table' | 'view';
  columns: ColumnInfo[];
  /** Primary key columns in key order; empty when there is none. */
  primaryKey: string[];
  indexes: IndexInfo[];
}

export type ParamValue = string | number | boolean | null;

/** One parameterized statement; placeholders follow the dialect (`$1`, `?`, `@p1`, `:1`). */
export interface ParamStatement {
  sql: string;
  params: ParamValue[];
  /** Declared column type per parameter, so drivers can bind dates as dates. */
  types?: (string | undefined)[];
  /** Rows the statement must affect; anything else rolls the transaction back. */
  expect?: number;
}

export interface SqlDriver extends Driver {
  readonly dialect: string;
  /** Tables and views of `database` (the connection's default when omitted). */
  catalog(database?: string): Promise<Catalog>;
  /** Columns, primary key and indexes; undefined when the table or view does not exist. */
  describe(ref: TableRef): Promise<TableInfo | undefined>;
  /** CREATE statement(s) of a table (with its indexes) or view. */
  ddl(ref: TableRef): Promise<string>;
  /**
   * Runs the statements in one transaction on a connection of its own (not the editor's
   * session) and commits; any error or unexpected row count rolls everything back.
   */
  transaction(database: string | undefined, statements: ParamStatement[]): Promise<number[]>;
  /**
   * Executes one statement (or batch) on the session of `options.database`; session state
   * such as SET or BEGIN persists. Returns one result per result set or affected-rows count.
   */
  execute(sql: string, options: QueryOptions): Promise<StatementResult[]>;
  /** Cancels whatever is running on that session. */
  cancel(database?: string): Promise<void>;
}

/** Key-value stores (Redis). Reads and edits go through raw commands. */
export interface KvDriver extends Driver {
  /** Runs one command on logical database `db`; replies keep the engine's shape (arrays, null, strings, numbers). */
  command(db: number, args: (string | number)[]): Promise<unknown>;
  /** Keys matching a glob pattern, stopping after `limit`. */
  scan(db: number, pattern: string, limit: number): Promise<{ keys: string[]; complete: boolean }>;
}

export interface PubSubMessage {
  subscription: number;
  subject: string;
  data: string;
  headers?: Record<string, string[]>;
  reply?: string;
  time: string;
}

export interface Subscription {
  id: number;
  subject: string;
  queue?: string;
  received: number;
}

/** Publish/subscribe brokers (NATS). */
export interface PubSubDriver extends Driver {
  publish(subject: string, data: string, headers?: Record<string, string>, reply?: string): Promise<void>;
  request(subject: string, data: string, headers: Record<string, string> | undefined, timeoutMs: number): Promise<PubSubMessage>;
  subscribe(subject: string, queue: string | undefined, onMessage: (message: PubSubMessage) => void): Subscription;
  unsubscribe(id: number): void;
  subscriptions(): Subscription[];
}

export interface DriverFactory {
  readonly type: string;
  readonly label: string;
  readonly category: DriverCategory;
  /** Dialect used for SQL completion before (or without) connecting. */
  readonly dialect?: string;
  readonly fields: FieldSpec[];
  create(config: ConnectionConfig, secrets: ConnectionSecrets): Driver;
}

export function isSqlDriver(driver: Driver): driver is SqlDriver {
  return typeof (driver as SqlDriver).execute === 'function';
}

export function isKvDriver(driver: Driver): driver is KvDriver {
  return typeof (driver as KvDriver).command === 'function';
}

export function isPubSubDriver(driver: Driver): driver is PubSubDriver {
  return typeof (driver as PubSubDriver).publish === 'function';
}
