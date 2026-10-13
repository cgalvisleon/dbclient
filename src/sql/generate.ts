import { ColumnInfo, ParamStatement, ParamValue, TableInfo } from '../drivers/types';
import { placeholder, qualifiedName, quoteIdent } from './identifiers';

// SQL text built from table metadata: tree actions (SELECT/INSERT/UPDATE/DELETE templates,
// open data, structure, DDL) and the parameterized DML that commits grid edits.

const NUMERIC = /\b(int|integer|smallint|bigint|tinyint|mediumint|serial|bigserial|smallserial|number|numeric|decimal|dec|float|double|real|money|smallmoney|binary_float|binary_double|int2|int4|int8|float4|float8|bit)\b/i;
const BOOLEAN = /^(bool|boolean)$/i;
const TEMPORAL = /\b(date|time|timestamp|datetime|datetime2|smalldatetime|datetimeoffset|timestamptz|timetz)\b/i;

/** A literal that fits the column, for templates the user then edits. */
export function sampleValue(column: ColumnInfo, dialect: string): string {
  const type = column.type.replace(/\(.*$/, '').trim();
  if (BOOLEAN.test(type)) {
    return dialect === 'postgres' ? 'FALSE' : '0';
  }
  if (TEMPORAL.test(type)) {
    return 'CURRENT_TIMESTAMP';
  }
  if (NUMERIC.test(type)) {
    return '0';
  }
  return "''";
}

const q = (name: string, dialect: string) => quoteIdent(name, dialect);

export function selectTemplate(info: TableInfo, dialect: string): string {
  const columns = info.columns.map((c) => q(c.name, dialect)).join(', ') || '*';
  return `SELECT ${columns}\nFROM ${qualifiedName(info.ref, dialect)};`;
}

/** What "Open Data" runs: every column, so the grid can map and edit them. */
export function openDataSql(info: Pick<TableInfo, 'ref'>, dialect: string): string {
  return `SELECT * FROM ${qualifiedName(info.ref, dialect)}`;
}

export function insertTemplate(info: TableInfo, dialect: string): string {
  const names = info.columns.map((c) => q(c.name, dialect)).join(', ');
  const values = info.columns.map((c) => sampleValue(c, dialect)).join(', ');
  return `INSERT INTO ${qualifiedName(info.ref, dialect)} (${names})\nVALUES (${values});`;
}

/** WHERE by primary key; without one, by the first column and a comment asking to adjust it. */
function whereTemplate(info: TableInfo, dialect: string): string {
  const keys = info.primaryKey.length ? info.primaryKey : info.columns.slice(0, 1).map((c) => c.name);
  const conditions = keys.map((k) => {
    const column = info.columns.find((c) => c.name === k) ?? { name: k, type: '', nullable: true, primaryKey: false };
    return `${q(k, dialect)} = ${sampleValue(column, dialect)}`;
  });
  const note = info.primaryKey.length ? '' : '-- No primary key: adjust the condition.\n';
  return `${note}WHERE ${conditions.join('\n  AND ')}`;
}

export function updateTemplate(info: TableInfo, dialect: string): string {
  const keys = new Set(info.primaryKey);
  const sets = info.columns.filter((c) => !keys.has(c.name));
  const assignments = (sets.length ? sets : info.columns).map((c) => `${q(c.name, dialect)} = ${sampleValue(c, dialect)}`);
  return `UPDATE ${qualifiedName(info.ref, dialect)}\nSET ${assignments.join(',\n    ')}\n${whereTemplate(info, dialect)};`;
}

export function deleteTemplate(info: TableInfo, dialect: string): string {
  return `DELETE FROM ${qualifiedName(info.ref, dialect)}\n${whereTemplate(info, dialect)};`;
}

/** Rows for the Structure result tabs: columns, then indexes. */
export function structureTables(info: TableInfo): { title: string; columns: string[]; rows: (string | null)[][] }[] {
  const name = [info.ref.schema, info.ref.name].filter(Boolean).join('.');
  return [
    {
      title: `${name} · columns`,
      columns: ['Column', 'Type', 'Nullable', 'Default', 'Primary key'],
      rows: info.columns.map((c) => [
        c.name,
        c.type,
        c.nullable ? 'YES' : 'NO',
        c.default ?? null,
        c.primaryKey ? String(info.primaryKey.indexOf(c.name) + 1) : '',
      ]),
    },
    {
      title: `${name} · indexes`,
      columns: ['Index', 'Columns', 'Unique', 'Primary'],
      rows: info.indexes.map((i) => [i.name, i.columns.join(', '), i.unique ? 'YES' : 'NO', i.primary ? 'YES' : 'NO']),
    },
  ];
}

/** CREATE TABLE from metadata, for engines without a DDL function; extra constraints and index statements are appended. */
export function createTableSql(info: TableInfo, dialect: string, extra: { constraints?: string[]; indexes?: string[] } = {}): string {
  const lines = info.columns.map(
    (c) => `  ${q(c.name, dialect)} ${c.type}${c.default !== undefined ? ` DEFAULT ${c.default}` : ''}${c.nullable ? '' : ' NOT NULL'}`,
  );
  const constraints = extra.constraints ?? (info.primaryKey.length ? [`PRIMARY KEY (${info.primaryKey.map((k) => q(k, dialect)).join(', ')})`] : []);
  lines.push(...constraints.map((c) => `  ${c}`));
  const table = `CREATE TABLE ${qualifiedName(info.ref, dialect)} (\n${lines.join(',\n')}\n);`;
  const indexes =
    extra.indexes ??
    info.indexes
      .filter((i) => !i.primary)
      .map((i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name, dialect)} ON ${qualifiedName(info.ref, dialect)} (${i.columns.map((c) => q(c, dialect)).join(', ')});`);
  return [table, ...indexes].join('\n\n');
}

export interface GridChange {
  kind: 'update' | 'insert' | 'delete';
  /** Primary key values of the row as it was read (update, delete). */
  key?: Record<string, ParamValue>;
  /** New values by column name (update: changed cells; insert: the cells the user set). */
  values?: Record<string, ParamValue>;
}

function bindValue(value: ParamValue, dialect: string): ParamValue {
  return typeof value === 'boolean' && dialect !== 'postgres' ? (value ? 1 : 0) : value;
}

/** Parameterized DML for grid edits; updates and deletes must hit exactly one row. */
export function gridStatements(info: TableInfo, dialect: string, changes: GridChange[]): ParamStatement[] {
  const table = qualifiedName(info.ref, dialect);
  const typeOf = (name: string) => info.columns.find((c) => c.name === name)?.type;
  return changes.map((change) => {
    const params: ParamValue[] = [];
    const types: (string | undefined)[] = [];
    const bind = (column: string, value: ParamValue) => {
      params.push(bindValue(value, dialect));
      types.push(typeOf(column));
      return placeholder(params.length, dialect);
    };
    const where = () => {
      if (!info.primaryKey.length || !change.key) {
        throw new Error(`${info.ref.name} has no primary key; rows cannot be identified.`);
      }
      return info.primaryKey.map((k) => {
        if (!(k in change.key!)) {
          throw new Error(`Missing primary key column ${k}.`);
        }
        return `${q(k, dialect)} = ${bind(k, change.key![k])}`;
      }).join(' AND ');
    };
    const values = Object.entries(change.values ?? {});
    switch (change.kind) {
      case 'update': {
        const set = values.map(([k, v]) => `${q(k, dialect)} = ${bind(k, v)}`).join(', ');
        return { sql: `UPDATE ${table} SET ${set} WHERE ${where()}`, params, types, expect: 1 };
      }
      case 'delete':
        return { sql: `DELETE FROM ${table} WHERE ${where()}`, params, types, expect: 1 };
      case 'insert': {
        if (!values.length) {
          const sql = dialect === 'mysql' ? `INSERT INTO ${table} () VALUES ()` : dialect === 'oracle'
            ? `INSERT INTO ${table} (${q(info.columns[0].name, dialect)}) VALUES (DEFAULT)`
            : `INSERT INTO ${table} DEFAULT VALUES`;
          return { sql, params, types, expect: 1 };
        }
        const names = values.map(([k]) => q(k, dialect)).join(', ');
        const marks = values.map(([k, v]) => bind(k, v)).join(', ');
        return { sql: `INSERT INTO ${table} (${names}) VALUES (${marks})`, params, types, expect: 1 };
      }
    }
  });
}

/** Whether a declared column type holds dates or times (drivers bind ISO strings as dates for these). */
export function isTemporalType(type: string | undefined): boolean {
  return Boolean(type && TEMPORAL.test(type));
}
