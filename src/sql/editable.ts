import { TableInfo } from '../drivers/types';
import { findByName } from './identifiers';
import { SingleTableSelect } from './parse';

export interface EditMapping {
  /** Table column behind each result column; null for read-only (expressions, duplicates). */
  columns: (string | null)[];
  /** Result column index of each primary key column, in key order. */
  key: number[];
}

/**
 * Maps the result of a single-table SELECT onto the table, or explains why the grid stays
 * read-only. Rows are identified by primary key, so every key column must be in the result.
 */
export function editMapping(select: SingleTableSelect, resultColumns: string[], info: TableInfo): EditMapping | { reason: string } {
  const name = [info.ref.schema, info.ref.name].filter(Boolean).join('.');
  if (info.kind === 'view') {
    return { reason: `${name} is a view.` };
  }
  if (!info.primaryKey.length) {
    return { reason: `${name} has no primary key.` };
  }
  const columns = resultColumnMapping(select, resultColumns, info);
  if (!columns) {
    return { reason: 'The result columns cannot be matched to the table.' };
  }
  const key = info.primaryKey.map((k) => columns.indexOf(k));
  if (key.some((k) => k < 0)) {
    return { reason: `Include the primary key (${info.primaryKey.join(', ')}) in the result to edit it.` };
  }
  return { columns, key };
}

/**
 * Table column behind each result column of a single-table SELECT (null for expressions and
 * repeated columns: only the first copy counts); undefined when they cannot be matched.
 */
export function resultColumnMapping(select: SingleTableSelect, resultColumns: string[], info: TableInfo): (string | null)[] | undefined {
  let columns: (string | null)[];
  const stars = select.items.filter((i) => i && 'star' in i).length;
  if (stars === 1 && select.items.length === 1) {
    columns = resultColumns.map((c) => findByName(info.columns, c, (col) => col.name)?.name ?? null);
  } else if (stars === 0 && select.items.length === resultColumns.length) {
    columns = select.items.map((item) => (item && 'column' in item ? findByName(info.columns, item.column, (c) => c.name, item.quoted)?.name ?? null : null));
  } else {
    return undefined;
  }
  return columns.map((c, i) => (c && columns.indexOf(c) !== i ? null : c));
}
