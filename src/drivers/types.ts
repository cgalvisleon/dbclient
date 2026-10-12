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
}

/** Secret values keyed by `FieldSpec.key`; kept out of the JSON store. */
export type ConnectionSecrets = Record<string, string | undefined>;

/** Describes one input of the connection form, so the form never knows about engines. */
export interface FieldSpec {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'password' | 'checkbox' | 'select';
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  choices?: string[];
  /** Stored in SecretStorage instead of the JSON file. */
  secret?: boolean;
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
}

export interface Driver {
  readonly type: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Children of `parent`, or the top level below the connection when omitted. */
  children(parent?: DbNode): Promise<DbNode[]>;
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

/** Error raised by a statement, with the 1-based character offset inside it when the engine reports one. */
export class StatementError extends Error {
  constructor(
    message: string,
    readonly position?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'StatementError';
  }
}

export interface SqlDriver extends Driver {
  readonly dialect: string;
  /** Executes one statement on the session of `options.database` (session state such as SET or BEGIN persists). */
  execute(sql: string, options: QueryOptions): Promise<StatementResult>;
  /** Cancels whatever is running on that session. */
  cancel(database?: string): Promise<void>;
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
