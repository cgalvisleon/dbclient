import * as vscode from 'vscode';
import { CatalogCache } from '../connections/catalog';
import { ConnectionManager } from '../connections/manager';
import { TableInfo, TableRef } from '../drivers/types';
import { canCascade, deleteTemplate, DropTarget, dropSql, insertTemplate, openDataSql, selectTemplate, structureTables, updateTemplate } from '../sql/generate';
import { qualifiedName } from '../sql/identifiers';
import { NodeItem } from '../tree/connectionsTree';
import { ResultsView } from '../webviews/resultsView';
import { DocumentBindings } from './bindings';
import { showSqlDocument } from './sqlDocument';
import { RunTarget, SqlRunner } from './sqlRunner';
import { t } from '../l10n';

export type TemplateKind = 'select' | 'insert' | 'update' | 'delete';

const TEMPLATES: Record<TemplateKind, (info: TableInfo, dialect: string) => string> = {
  select: selectTemplate,
  insert: insertTemplate,
  update: updateTemplate,
  delete: deleteTemplate,
};

/** NetBeans-style actions on table and view nodes: open data, structure, DDL, SQL templates and drop. */
export class TableActions {
  constructor(
    private readonly manager: ConnectionManager,
    private readonly bindings: DocumentBindings,
    private readonly catalog: CatalogCache,
    private readonly results: ResultsView,
    private readonly runner: SqlRunner,
  ) {}

  private refOf(item: NodeItem): TableRef {
    return { database: item.node.database, schema: item.node.meta?.schema, name: item.node.meta?.name ?? item.node.label };
  }

  private dialectOf(item: NodeItem): string {
    return this.manager.factoryOf(this.manager.config(item.connectionId)).dialect ?? 'ansi';
  }

  private async info(item: NodeItem): Promise<TableInfo> {
    const ref = this.refOf(item);
    const info = await this.catalog.describe(item.connectionId, ref);
    if (!info) {
      throw new Error(t('{0} no longer exists. Refresh the tree.', ref.name));
    }
    return info;
  }

  /** New SQL editor bound to the node's connection and database (the DB Client SQL editor when dbclient.sqlEditor.openByDefault is on). */
  private async open(item: NodeItem, content: string): Promise<RunTarget> {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `${content}\n` });
    await this.bindings.set(doc, { connectionId: item.connectionId, database: item.node.database });
    return showSqlDocument(doc);
  }

  /** Opens `SELECT * FROM table` in an editor and runs it; the result grid is editable for tables with a primary key. */
  async openData(item: NodeItem): Promise<void> {
    const editor = await this.open(item, openDataSql({ ref: this.refOf(item) }, this.dialectOf(item)));
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await this.runner.run(editor, 'file');
  }

  /** Opens the same `SELECT * FROM table` as Open Data, without running it. */
  async openSql(item: NodeItem): Promise<void> {
    const editor = await this.open(item, openDataSql({ ref: this.refOf(item) }, this.dialectOf(item)));
    const end = editor.document.lineAt(0).range.end;
    editor.selection = new vscode.Selection(end, end);
  }

  async showStructure(item: NodeItem): Promise<void> {
    const info = await this.info(item);
    const pageSize = vscode.workspace.getConfiguration('dbclient').get<number>('pageSize', 100);
    await this.results.reveal();
    this.results.post({ type: 'run', title: this.manager.config(item.connectionId).name, pageSize });
    for (const table of structureTables(info)) {
      this.results.post({
        type: 'result',
        tab: {
          title: table.title,
          sql: `-- ${table.title}`,
          columns: table.columns.map((name) => ({ name })),
          rows: table.rows,
          rowCount: table.rows.length,
          truncated: false,
          durationMs: 0,
        },
      });
    }
    // Show the columns tab first.
    this.results.post({ type: 'select', tab: -2 });
  }

  async showDdl(item: NodeItem): Promise<void> {
    const ref = (await this.info(item)).ref;
    const ddl = await (await this.manager.connectSql(item.connectionId)).ddl(ref);
    await this.open(item, ddl);
  }

  async generate(item: NodeItem, kind: TemplateKind): Promise<void> {
    const info = await this.info(item);
    await this.open(item, TEMPLATES[kind](info, this.dialectOf(item)));
  }

  /** Table, view or schema a node drops; undefined for nodes that cannot be dropped. */
  private dropTarget(item: NodeItem): DropTarget | undefined {
    const node = item.node;
    switch (node.kind) {
      case 'table':
      case 'view':
        return { kind: node.kind === 'view' && node.meta?.materialized ? 'materialized' : node.kind, schema: node.meta?.schema, name: node.meta?.name ?? node.label };
      case 'schema':
        return { kind: 'schema', name: node.label };
      case 'database':
        // MySQL databases are its schemas; other engines' databases are not dropped from the tree.
        return this.dialectOf(item) === 'mysql' && node.database ? { kind: 'schema', name: node.database } : undefined;
      default:
        return undefined;
    }
  }

  private dropQuestion(target: DropTarget, dialect: string): string {
    const name = qualifiedName(target, dialect);
    switch (target.kind) {
      case 'table':
        return t('Drop table {0}? Its data is lost.', name);
      case 'view':
        return t('Drop view {0}?', name);
      case 'materialized':
        return t('Drop materialized view {0}?', name);
      case 'schema':
        return dialect === 'mysql'
          ? t('Drop database {0} with all its tables and data?', name)
          : dialect === 'oracle'
            ? t('Drop user {0} and its schema?', name)
            : t('Drop schema {0}?', name);
    }
  }

  /** Drops a table, view or schema after confirming (schemas also ask for their name), then refreshes the connection. */
  async drop(item: NodeItem): Promise<void> {
    const target = this.dropTarget(item);
    if (!target) {
      return;
    }
    const dialect = this.dialectOf(item);
    const drop = t('Drop');
    const cascade = t('Drop with CASCADE');
    const cascades = canCascade(target, dialect);
    const answer = await vscode.window.showWarningMessage(
      this.dropQuestion(target, dialect),
      {
        modal: true,
        detail: [
          dropSql(target, dialect),
          cascades ? t('CASCADE also drops the objects that depend on it.') : undefined,
          t('This cannot be undone.'),
        ].filter(Boolean).join('\n\n'),
      },
      ...(cascades ? [drop, cascade] : [drop]),
    );
    if (!answer) {
      return;
    }
    if (target.kind === 'schema') {
      const typed = await vscode.window.showInputBox({
        title: this.dropQuestion(target, dialect),
        prompt: t('Type {0} to confirm.', target.name),
        validateInput: (value) => (value === target.name ? undefined : t('Type {0} to confirm.', target.name)),
      });
      if (typed !== target.name) {
        return;
      }
    }
    const sql = dropSql(target, dialect, answer === cascade);
    const id = item.connectionId;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Dropping {0}…', target.name) },
        async () => {
          const driver = await this.manager.connectSql(id);
          // A MySQL database is dropped from the connection's default one, not from inside itself.
          const database = target.kind === 'schema' && dialect === 'mysql' ? undefined : item.node.database;
          await driver.transaction(database, [{ sql, params: [] }]);
        },
      );
    } catch (err) {
      vscode.window.showErrorMessage(t('Could not drop {0}: {1}', target.name, (err as Error).message));
      return;
    } finally {
      this.catalog.invalidate(id);
      this.manager.contentChangedOf(id);
    }
    vscode.window.setStatusBarMessage(t('Dropped {0}.', qualifiedName(target, dialect)), 4000);
  }
}
