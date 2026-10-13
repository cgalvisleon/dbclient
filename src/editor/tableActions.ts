import * as vscode from 'vscode';
import { CatalogCache } from '../connections/catalog';
import { ConnectionManager } from '../connections/manager';
import { TableInfo, TableRef } from '../drivers/types';
import { deleteTemplate, insertTemplate, openDataSql, selectTemplate, structureTables, updateTemplate } from '../sql/generate';
import { NodeItem } from '../tree/connectionsTree';
import { ResultsView } from '../webviews/resultsView';
import { DocumentBindings } from './bindings';
import { SqlRunner } from './sqlRunner';

export type TemplateKind = 'select' | 'insert' | 'update' | 'delete';

const TEMPLATES: Record<TemplateKind, (info: TableInfo, dialect: string) => string> = {
  select: selectTemplate,
  insert: insertTemplate,
  update: updateTemplate,
  delete: deleteTemplate,
};

/** NetBeans-style actions on table and view nodes: open data, structure, DDL and SQL templates. */
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
      throw new Error(vscode.l10n.t('{0} no longer exists. Refresh the tree.', ref.name));
    }
    return info;
  }

  /** New SQL editor bound to the node's connection and database. */
  private async open(item: NodeItem, content: string): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `${content}\n` });
    await this.bindings.set(doc, { connectionId: item.connectionId, database: item.node.database });
    return vscode.window.showTextDocument(doc);
  }

  /** Opens `SELECT * FROM table` in an editor and runs it; the result grid is editable for tables with a primary key. */
  async openData(item: NodeItem): Promise<void> {
    const editor = await this.open(item, openDataSql({ ref: this.refOf(item) }, this.dialectOf(item)));
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await this.runner.run(editor, 'file');
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
}
