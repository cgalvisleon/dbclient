import * as vscode from 'vscode';
import { CatalogCache } from '../connections/catalog';
import { ConnectionManager } from '../connections/manager';
import { ParamValue, StatementResult, TableInfo } from '../drivers/types';
import { editMapping, resultColumnMapping } from '../sql/editable';
import { GridChange, gridStatements, rowSql, RowSqlKind } from '../sql/generate';
import { singleTableSelect } from '../sql/parse';
import { toCell } from '../webviews/cells';
import { ResultsSink, ResultsView } from '../webviews/resultsView';
import { Binding, DocumentBindings } from './bindings';
import { showSqlDocument } from './sqlDocument';
import { t } from '../l10n';

export interface GridEdit {
  id: number;
  /** Table column behind each result column; null = read-only. */
  columns: (string | null)[];
  key: number[];
  table: string;
}

interface EditContext {
  connectionId: string;
  database?: string;
  dialect: string;
  info: TableInfo;
  sql: string;
  /** Table column behind each result column. */
  columns: (string | null)[];
  table: string;
}

/** A change as the grid sends it: values by result column index. */
export interface GridRowChange {
  kind: GridChange['kind'];
  key?: Record<number, ParamValue>;
  values?: Record<number, ParamValue>;
}

const MAX_CONTEXTS = 200;

/**
 * Makes single-table results editable (NetBeans-style): decides which result columns map to
 * table columns, and turns the grid's pending changes into parameterized DML committed in one
 * transaction on a connection of its own; then re-runs the query to show the saved rows.
 * Any single-table result (editable or not) can also turn one of its rows into SQL.
 */
export class GridEditor {
  private readonly contexts = new Map<number, EditContext>();
  private nextId = 1;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly catalog: CatalogCache,
    results: ResultsView,
    private readonly bindings: DocumentBindings,
  ) {
    results.onCommit((sink, editId, changes) => this.commit(sink, editId, changes));
    results.onRowSql((source, kind, row) => this.rowSql(source, kind, row));
  }

  /**
   * Edit info for a result, or a reason it stays read-only, plus `source` (for row SQL) when
   * its columns map onto one table; nothing when it is not a single-table SELECT.
   */
  async prepare(binding: Binding, dialect: string, sql: string, result: StatementResult): Promise<{ edit?: GridEdit; readOnly?: string; source?: number }> {
    const select = singleTableSelect(sql);
    if (!select || !result.columns.length) {
      return {};
    }
    try {
      const table = await this.catalog.resolve(binding.connectionId, binding.database, select.table.schema, select.table.name, select.table.quoted);
      const info = table && (await this.catalog.describe(binding.connectionId, { database: binding.database, schema: table.schema, name: table.name }));
      if (!info) {
        return {};
      }
      const names = result.columns.map((c) => c.name);
      const mapping = editMapping(select, names, info);
      const columns = 'reason' in mapping ? resultColumnMapping(select, names, info) : mapping.columns;
      if (!columns?.some(Boolean)) {
        return 'reason' in mapping ? { readOnly: mapping.reason } : {};
      }
      const id = this.nextId++;
      const tableName = [info.ref.schema, info.ref.name].filter(Boolean).join('.');
      this.contexts.set(id, { connectionId: binding.connectionId, database: binding.database, dialect, info, sql, columns, table: tableName });
      if (this.contexts.size > MAX_CONTEXTS) {
        this.contexts.delete(this.contexts.keys().next().value!);
      }
      return 'reason' in mapping ? { readOnly: mapping.reason, source: id } : { edit: { id, ...mapping, table: tableName }, source: id };
    } catch {
      return {};
    }
  }

  /** Opens an INSERT, UPDATE or DELETE of one result row (values by result column) in a new editor bound to the result's connection. */
  private async rowSql(source: number, kind: RowSqlKind, row: ParamValue[]): Promise<void> {
    const context = this.contexts.get(source);
    if (!context) {
      vscode.window.showWarningMessage(t('Run the query again to generate SQL from its rows.'));
      return;
    }
    const values: Record<string, ParamValue> = {};
    context.columns.forEach((column, i) => {
      if (column) {
        values[column] = row[i] ?? null;
      }
    });
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `${rowSql(kind, context.info, context.dialect, values)}\n` });
    await this.bindings.set(doc, { connectionId: context.connectionId, database: context.database });
    await showSqlDocument(doc);
  }

  private async commit(sink: ResultsSink, editId: number, changes: GridRowChange[]): Promise<void> {
    const context = this.contexts.get(editId);
    if (!context) {
      sink.post({ type: 'committed', editId, ok: false, message: t('These rows can no longer be saved; run the query again.') });
      return;
    }
    const { info, dialect, connectionId, database, columns, table } = context;
    // Result column index → table column name; read-only columns are dropped.
    const byName = (values?: Record<number, ParamValue>): Record<string, ParamValue> | undefined =>
      values &&
      Object.fromEntries(
        Object.entries(values)
          .filter(([i]) => columns[Number(i)])
          .map(([i, v]) => [columns[Number(i)]!, v]),
      );
    const config = this.manager.config(connectionId);
    const started = Date.now();
    try {
      const statements = gridStatements(
        info,
        dialect,
        changes.map((c) => ({ kind: c.kind, key: byName(c.key), values: byName(c.values) })),
      );
      const driver = await this.manager.connectSql(connectionId);
      await driver.transaction(database, statements);
      const counts = { insert: 0, update: 0, delete: 0 };
      changes.forEach((c) => counts[c.kind]++);
      sink.post({
        type: 'log',
        entry: {
          time: new Date().toLocaleTimeString(),
          connection: config.name,
          sql: statements.map((s) => s.sql).join(';\n').slice(0, 200),
          ok: true,
          message: t('Saved to {0}: {1} updated, {2} inserted, {3} deleted', table, counts.update, counts.insert, counts.delete),
          durationMs: Date.now() - started,
        },
      });
      // Show the rows as saved (generated keys, defaults, triggers).
      let refreshed: StatementResult | undefined;
      try {
        const maxRows = vscode.workspace.getConfiguration('dbclient').get<number>('maxRows', 5000);
        [refreshed] = await driver.execute(context.sql, { database, maxRows });
      } catch {
        refreshed = undefined;
      }
      sink.post({
        type: 'committed',
        editId,
        ok: true,
        rows: refreshed?.rows.map((r) => r.map(toCell)),
        rowCount: refreshed?.rowCount ?? undefined,
        truncated: refreshed?.truncated,
      });
    } catch (err) {
      const message = (err as Error).message;
      sink.post({ type: 'committed', editId, ok: false, message });
      sink.post({
        type: 'log',
        entry: { time: new Date().toLocaleTimeString(), connection: config.name, sql: `-- ${table}`, ok: false, message: t('Nothing was saved: {0}', message) },
      });
      vscode.window.showErrorMessage(t('Could not save the changes: {0}', message));
    }
  }
}
