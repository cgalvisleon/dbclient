/**
 * Disk usage queries per dialect, in MB (2 decimals) so the grid sorts and exports them as numbers.
 * Pure: the tree action opens the SQL in a bound editor and runs it.
 */

/** What to measure: every database of the server, one database, one schema or one table. */
export type DiskUsageTarget =
  | { kind: 'server' }
  | { kind: 'database'; database: string }
  | { kind: 'schema'; database?: string; schema: string }
  | { kind: 'table'; database?: string; schema?: string; name: string };

export interface DiskUsageOptions {
  /** Oracle: the connected user. Its own schema reads USER_* views; other schemas need DBA_* (DBA privileges). */
  currentUser?: string;
}

const DIALECTS: Record<DiskUsageTarget['kind'], string[]> = {
  server: ['postgres', 'mysql', 'mssql', 'sqlite'],
  database: ['postgres', 'mysql', 'mssql'],
  schema: ['postgres', 'mssql', 'oracle'],
  table: ['postgres', 'mysql', 'mssql', 'oracle'],
};

export function supportsDiskUsage(kind: DiskUsageTarget['kind'], dialect: string): boolean {
  return DIALECTS[kind].includes(dialect);
}

function lit(value: string, dialect: string): string {
  const quoted = `'${value.replace(/'/g, "''")}'`;
  return dialect === 'mssql' ? `N${quoted}` : dialect === 'mysql' ? quoted.replace(/\\/g, '\\\\') : quoted;
}

const statements = (...sql: string[]): string => sql.map((s) => `${s};`).join('\n\n');

/** SQL that reports the space `target` uses on disk, or undefined when the dialect cannot measure it. */
export function diskUsageSql(target: DiskUsageTarget, dialect: string, options: DiskUsageOptions = {}): string | undefined {
  if (!supportsDiskUsage(target.kind, dialect)) {
    return undefined;
  }
  switch (dialect) {
    case 'postgres':
      return postgres(target);
    case 'mysql':
      return mysql(target);
    case 'mssql':
      return mssql(target);
    case 'oracle':
      return oracle(target, options);
    case 'sqlite':
      return sqlite();
    default:
      return undefined;
  }
}

function postgres(target: DiskUsageTarget): string {
  const mb = (bytes: string) => `round(${bytes} / 1048576.0, 2)`;
  const userSchemas = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'";
  const tables = (where: string) =>
    [
      `SELECT n.nspname AS "schema", c.relname AS "table", NULLIF(c.reltuples, -1)::bigint AS "rows",`,
      `  ${mb('pg_total_relation_size(c.oid)')} AS total_mb, ${mb('pg_table_size(c.oid)')} AS data_mb, ${mb('pg_indexes_size(c.oid)')} AS index_mb`,
      `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace`,
      `WHERE c.relkind IN ('r', 'p', 'm') AND ${where}`,
      `ORDER BY pg_total_relation_size(c.oid) DESC, 1, 2`,
    ].join('\n');
  switch (target.kind) {
    case 'server':
      return statements(
        `SELECT datname AS "database", ${mb('pg_database_size(datname)')} AS total_mb\nFROM pg_database\nWHERE datallowconn\nORDER BY pg_database_size(datname) DESC, 1`,
      );
    case 'database':
      return statements(
        `SELECT current_database() AS "database", ${mb('pg_database_size(current_database())')} AS total_mb`,
        tables(userSchemas),
      );
    case 'schema': {
      const where = `n.nspname = ${lit(target.schema, 'postgres')}`;
      return statements(
        `SELECT n.nspname AS "schema", ${mb('coalesce(sum(pg_total_relation_size(c.oid)), 0)')} AS total_mb\nFROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'm')\nWHERE ${where}\nGROUP BY n.nspname`,
        tables(where),
      );
    }
    case 'table':
      return statements(tables(`n.nspname = ${lit(target.schema ?? 'public', 'postgres')} AND c.relname = ${lit(target.name, 'postgres')}`));
  }
}

function mysql(target: DiskUsageTarget): string {
  const mb = (bytes: string) => `ROUND(${bytes} / 1048576, 2)`;
  const tables = (where: string) =>
    [
      'SELECT table_schema AS `database`, table_name AS `table`, table_rows AS `rows`,',
      `  ${mb('data_length + index_length')} AS total_mb, ${mb('data_length')} AS data_mb, ${mb('index_length')} AS index_mb, ${mb('data_free')} AS free_mb`,
      'FROM information_schema.tables',
      `WHERE table_type = 'BASE TABLE' AND ${where}`,
      'ORDER BY data_length + index_length DESC, table_name',
    ].join('\n');
  const totals = (where: string) =>
    [
      'SELECT table_schema AS `database`, COUNT(*) AS `tables`,',
      `  ${mb('SUM(data_length + index_length)')} AS total_mb, ${mb('SUM(data_length)')} AS data_mb, ${mb('SUM(index_length)')} AS index_mb`,
      'FROM information_schema.tables',
      `WHERE table_type = 'BASE TABLE'${where ? ` AND ${where}` : ''}`,
      'GROUP BY table_schema',
      'ORDER BY SUM(data_length + index_length) DESC, table_schema',
    ].join('\n');
  switch (target.kind) {
    case 'server':
      return statements(totals(''));
    case 'database': {
      const where = `table_schema = ${lit(target.database, 'mysql')}`;
      return statements(totals(where), tables(where));
    }
    case 'schema':
      return statements(tables(`table_schema = ${lit(target.schema, 'mysql')}`));
    case 'table':
      return statements(tables(`table_schema = ${lit(target.schema ?? target.database ?? '', 'mysql')} AND table_name = ${lit(target.name, 'mysql')}`));
  }
}

function mssql(target: DiskUsageTarget): string {
  const mb = (pages: string) => `CAST(${pages} * 8 / 1024.0 AS DECIMAL(18, 2))`;
  const data = 'SUM(CASE WHEN p.index_id < 2 THEN p.in_row_data_page_count + p.lob_used_page_count + p.row_overflow_used_page_count ELSE 0 END)';
  const tables = (where: string) =>
    [
      'SELECT s.name AS [schema], t.name AS [table], SUM(CASE WHEN p.index_id < 2 THEN p.row_count ELSE 0 END) AS [rows],',
      `  ${mb('SUM(p.reserved_page_count)')} AS total_mb, ${mb(data)} AS data_mb, ${mb(`(SUM(p.used_page_count) - ${data})`)} AS index_mb,`,
      `  ${mb('(SUM(p.reserved_page_count) - SUM(p.used_page_count))')} AS unused_mb`,
      'FROM sys.dm_db_partition_stats p',
      'JOIN sys.tables t ON t.object_id = p.object_id',
      'JOIN sys.schemas s ON s.schema_id = t.schema_id',
      ...(where ? [`WHERE ${where}`] : []),
      'GROUP BY s.name, t.name',
      'ORDER BY SUM(p.reserved_page_count) DESC, s.name, t.name',
    ].join('\n');
  const size = (type?: number) => `SUM(${type === undefined ? '' : `CASE WHEN type = ${type} THEN `}CAST(size AS BIGINT)${type === undefined ? '' : ' ELSE 0 END'})`;
  switch (target.kind) {
    case 'server':
      return statements(
        [
          `SELECT DB_NAME(database_id) AS [database], ${mb(size())} AS total_mb, ${mb(size(0))} AS data_file_mb, ${mb(size(1))} AS log_file_mb`,
          'FROM sys.master_files',
          'GROUP BY database_id',
          `ORDER BY ${size()} DESC, 1`,
        ].join('\n'),
      );
    case 'database':
      return statements(
        `SELECT DB_NAME() AS [database], ${mb(size())} AS total_mb, ${mb(size(0))} AS data_file_mb, ${mb(size(1))} AS log_file_mb\nFROM sys.database_files`,
        tables(''),
      );
    case 'schema': {
      const where = `s.name = ${lit(target.schema, 'mssql')}`;
      return statements(
        [
          `SELECT s.name AS [schema], ${mb('ISNULL(SUM(p.reserved_page_count), 0)')} AS total_mb`,
          'FROM sys.schemas s',
          'LEFT JOIN sys.tables t ON t.schema_id = s.schema_id',
          'LEFT JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id',
          `WHERE ${where}`,
          'GROUP BY s.name',
        ].join('\n'),
        tables(where),
      );
    }
    case 'table':
      return statements(tables(`s.name = ${lit(target.schema ?? 'dbo', 'mssql')} AND t.name = ${lit(target.name, 'mssql')}`));
  }
}

function oracle(target: DiskUsageTarget, options: DiskUsageOptions): string {
  const owner = target.kind === 'schema' ? target.schema : target.kind === 'table' ? (target.schema ?? target.database ?? '') : '';
  const own = !owner || owner.toUpperCase() === options.currentUser?.toUpperCase();
  const view = (name: string) => `${own ? 'user' : 'dba'}_${name}`;
  const and = (predicate: string) => (own ? '' : ` AND ${predicate}`);
  const mb = (bytes: string) => `ROUND(${bytes} / 1048576, 2)`;
  const where = [...(own ? [] : [`t.owner = ${lit(owner, 'oracle')}`]), ...(target.kind === 'table' ? [`t.table_name = ${lit(target.name, 'oracle')}`] : [])];
  const tables = [
    `SELECT table_name AS "table", num_rows AS "rows",`,
    `  ${mb('data_b + index_b + lob_b')} AS "total_mb", ${mb('data_b')} AS "data_mb", ${mb('index_b')} AS "index_mb", ${mb('lob_b')} AS "lob_mb"`,
    'FROM (',
    '  SELECT t.table_name, t.num_rows,',
    `    NVL((SELECT SUM(s.bytes) FROM ${view('segments')} s WHERE s.segment_name = t.table_name AND s.segment_type LIKE 'TABLE%'${and('s.owner = t.owner')}), 0) AS data_b,`,
    `    NVL((SELECT SUM(s.bytes) FROM ${view('segments')} s JOIN ${view('indexes')} i ON i.index_name = s.segment_name${and('i.owner = s.owner')} WHERE i.table_name = t.table_name${and('i.table_owner = t.owner')}), 0) AS index_b,`,
    `    NVL((SELECT SUM(s.bytes) FROM ${view('segments')} s JOIN ${view('lobs')} l ON l.segment_name = s.segment_name${and('l.owner = s.owner')} WHERE l.table_name = t.table_name${and('l.owner = t.owner')}), 0) AS lob_b`,
    `  FROM ${view('tables')} t${where.length ? `\n  WHERE ${where.join(' AND ')}` : ''}`,
    ')',
    'ORDER BY data_b + index_b + lob_b DESC, table_name',
  ].join('\n');
  if (target.kind === 'table') {
    return statements(tables);
  }
  return statements(
    `SELECT ${lit(owner.toUpperCase(), 'oracle')} AS "schema", ${mb('NVL(SUM(bytes), 0)')} AS "total_mb"\nFROM ${view('segments')}${own ? '' : `\nWHERE owner = ${lit(owner, 'oracle')}`}`,
    tables,
  );
}

/** SQLite: the whole file (node:sqlite is built without the dbstat table, so there is no per-table size). */
function sqlite(): string {
  return statements(
    [
      'SELECT ROUND(c.page_count * s.page_size / 1048576.0, 2) AS total_mb, ROUND(f.freelist_count * s.page_size / 1048576.0, 2) AS free_mb,',
      '  c.page_count AS pages, s.page_size AS page_size',
      'FROM pragma_page_count() c, pragma_page_size() s, pragma_freelist_count() f',
    ].join('\n'),
  );
}
